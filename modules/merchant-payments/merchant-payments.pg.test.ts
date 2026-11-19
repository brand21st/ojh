import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { razorpayHmacHex } from "@/modules/razorpay/signature";
import {
  activeMerchantGateway,
  disconnectMerchantRazorpay,
  getIntegrationView,
  saveMerchantRazorpay,
  setMerchantRazorpayEnabled,
  verifyMerchantRazorpay,
} from "./integration";
import {
  assertOnlinePaymentAvailable,
  confirmStorefrontPayment,
  createStorefrontPayment,
  newPaymentToken,
  pendingOnlinePaymentMeta,
  reconcileOpenAttemptsForIntegration,
  resumeStorefrontPayment,
  storefrontPaymentState,
  sweepOpenStorefrontPayments,
} from "./payments";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { MerchantRazorpayAuthError, type MerchantRazorpayCredentials, type MerchantRazorpayPayment } from "./razorpay";
import { handleMerchantRazorpayWebhook } from "./webhook";
import { BASE_SCHEMA, pgSupabase } from "./pg-supabase.testkit";

const orgA = "60000000-0000-4000-8000-00000000000a";
const orgB = "60000000-0000-4000-8000-00000000000b";
const userA = "61000000-0000-4000-8000-00000000000a";
const KEY_A = { keyId: "rzp_test_AAAAaaaa1111", keySecret: "secretAAAA1111", webhookSecret: "whsec_A_123456" };
const KEY_B = { keyId: "rzp_test_BBBBbbbb2222", keySecret: "secretBBBB2222", webhookSecret: "whsec_B_123456" };
const KEY_A2 = { keyId: "rzp_test_CCCCcccc3333", keySecret: "secretCCCC3333" };

let db: PGlite;
let admin: ReturnType<typeof pgSupabase>;

/** In-memory stand-in for each merchant's Razorpay account, keyed by Key ID. */
type Account = { orders: Map<string, { id: string; amount: number }>; payments: Map<string, MerchantRazorpayPayment>; timeout?: boolean };
const accounts = new Map<string, Account>();
let orderSeq = 0;
const validSecrets = new Map([
  [KEY_A.keyId, KEY_A.keySecret],
  [KEY_B.keyId, KEY_B.keySecret],
  [KEY_A2.keyId, KEY_A2.keySecret],
]);

function account(keyId: string) {
  if (!accounts.has(keyId)) accounts.set(keyId, { orders: new Map(), payments: new Map() });
  return accounts.get(keyId)!;
}

function fakeClient(creds: MerchantRazorpayCredentials) {
  const auth = () => {
    if (validSecrets.get(creds.keyId) !== creds.keySecret) throw new MerchantRazorpayAuthError();
    if (account(creds.keyId).timeout) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Razorpay did not respond in time. Please try again.");
  };
  return {
    keyId: creds.keyId,
    verify: async () => {
      auth();
      return { count: 0 };
    },
    createOrder: async (input: { amountPaise: number }) => {
      auth();
      const id = `order_T${++orderSeq}`;
      account(creds.keyId).orders.set(id, { id, amount: input.amountPaise });
      return { id, amount: input.amountPaise, currency: "INR", status: "created" };
    },
    fetchOrder: async (id: string) => {
      auth();
      const order = account(creds.keyId).orders.get(id);
      return { id, amount: order?.amount ?? 0, currency: "INR", status: "created" };
    },
    fetchOrderPayments: async (orderId: string) => {
      auth();
      return { items: [...account(creds.keyId).payments.values()].filter((payment) => payment.order_id === orderId) };
    },
    fetchPayment: async (id: string) => {
      auth();
      const payment = account(creds.keyId).payments.get(id);
      if (!payment) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "The id provided does not exist");
      return payment;
    },
  };
}
const deps = { client: fakeClient as never };

function pay(keyId: string, orderId: string, id: string, amount: number, status = "captured", method = "upi") {
  const payment: MerchantRazorpayPayment & { created_at: number } = { id, order_id: orderId, amount, currency: "INR", status, method, created_at: Date.now() };
  account(keyId).payments.set(id, payment);
  return payment;
}

async function connect(org: string, keys: { keyId: string; keySecret: string; webhookSecret?: string }, enable = true) {
  await saveMerchantRazorpay(admin, { organizationId: org, userId: userA }, { mode: "TEST", ...keys }, deps);
  if (enable) await setMerchantRazorpayEnabled(admin, { organizationId: org, userId: userA }, true);
}

let orderNo = 0;
async function newOrder(org: string, total = 499) {
  const id = `62000000-0000-4000-8000-${String(++orderNo).padStart(12, "0")}`;
  await db.query("insert into orders(id, organization_id, total_amount, order_number) values ($1, $2, $3, $4)", [id, org, total, `WA-${orderNo}`]);
  return id;
}

async function startPayment(org: string, total = 499, kind: "FULL" | "COD_ADVANCE" = "FULL", due = total) {
  const orderId = await newOrder(org, total);
  const token = newPaymentToken();
  const session = await createStorefrontPayment(admin, { organizationId: org, orderId, orderNumber: "WA-1", kind, amountDue: due, orderTotal: total, token }, deps);
  return { orderId, token, session };
}

async function order(id: string) {
  return (await db.query<{ status: string; payment_status: string; amount_paid: string; cod_amount: string }>("select status, payment_status, amount_paid, cod_amount from orders where id = $1", [id])).rows[0];
}

async function webhook(token: string, secret: string, body: Record<string, unknown>, eventId = `evt_${Math.random()}`) {
  const rawBody = JSON.stringify(body);
  return handleMerchantRazorpayWebhook(admin, { token, rawBody, signature: razorpayHmacHex(rawBody, secret), eventId }, deps);
}

async function webhookToken(org: string) {
  return (await db.query<{ webhook_token: string }>("select webhook_token from merchant_payment_integrations where organization_id = $1", [org])).rows[0].webhook_token;
}

describe("merchant razorpay payments (service + real schema)", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(readFileSync("supabase/migrations/20261120090000_merchant_razorpay_payments.sql", "utf8"));
    admin = pgSupabase(db);
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    accounts.clear();
    await db.exec(`
      delete from merchant_payment_webhook_events; delete from merchant_storefront_payments; delete from merchant_payment_integrations;
      delete from orders; delete from organizations; delete from idempotency_keys; delete from notifications; delete from audit_logs;
      insert into organizations values ('${orgA}'), ('${orgB}');
    `);
  });

  describe("connecting an account", () => {
    it("verifies, encrypts and masks valid test keys", async () => {
      const view = await saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", ...KEY_A }, deps);
      expect(view).toMatchObject({ status: "CONNECTED", mode: "TEST", keyIdHint: "rzp_test_••••1111", hasKeySecret: true, hasWebhookSecret: true, enabled: false });
      const serialized = JSON.stringify(view);
      for (const secret of [KEY_A.keyId, KEY_A.keySecret, KEY_A.webhookSecret]) expect(serialized).not.toContain(secret);
      expect(view.webhookUrl).toMatch(/\/api\/webhooks\/merchant\/razorpay\/[a-f0-9]{48}$/);
      const raw = JSON.stringify((await db.query("select * from merchant_payment_integrations")).rows);
      for (const secret of [KEY_A.keyId, KEY_A.keySecret, KEY_A.webhookSecret]) expect(raw).not.toContain(secret);
      const audit = JSON.stringify((await db.query("select * from audit_logs")).rows);
      expect(audit).not.toContain(KEY_A.keySecret);
    });

    it("rejects invalid keys without saving anything", async () => {
      await expect(
        saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", keyId: KEY_A.keyId, keySecret: "wrongSecret999" }, deps)
      ).rejects.toThrow(/rejected/);
      await expect(saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", keyId: "not-a-key", keySecret: "x" }, deps)).rejects.toThrow(/valid Razorpay Key ID/);
      expect((await db.query("select * from merchant_payment_integrations")).rows).toHaveLength(0);
    });

    it("refuses a live key in test mode and a test key in live mode", async () => {
      await expect(
        saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", keyId: "rzp_live_LLLLllll9999", keySecret: "secretLLLL" }, deps)
      ).rejects.toThrow(/Live Key ID, but Test mode/);
      await expect(saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "LIVE", ...KEY_A }, deps)).rejects.toThrow(/Test Key ID, but Live mode/);
    });

    it("needs a webhook secret before online checkout can be turned on", async () => {
      const view = await saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", keyId: KEY_A.keyId, keySecret: KEY_A.keySecret }, deps);
      expect(view.status).toBe("CONFIGURATION_REQUIRED");
      await expect(setMerchantRazorpayEnabled(admin, { organizationId: orgA, userId: userA }, true)).rejects.toThrow(/webhook secret/);
      const done = await saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", webhookSecret: KEY_A.webhookSecret }, deps);
      expect(done.status).toBe("CONNECTED");
      expect((await setMerchantRazorpayEnabled(admin, { organizationId: orgA, userId: userA }, true)).enabled).toBe(true);
    });

    it("replacing keys with another account reconciles old attempts, turns checkout off and asks for that account's webhook secret", async () => {
      await connect(orgA, KEY_A);
      const { session } = await startPayment(orgA);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_old1", 49900);
      const integration = (await db.query("select * from merchant_payment_integrations where organization_id = $1", [orgA])).rows[0] as never;
      const view = await saveMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, { mode: "TEST", ...KEY_A2 }, {
        ...deps,
        reconcileOpen: () => reconcileOpenAttemptsForIntegration(admin, integration, deps),
      });
      expect(view).toMatchObject({ status: "CONFIGURATION_REQUIRED", enabled: false, keyIdHint: "rzp_test_••••3333", hasWebhookSecret: false });
      const row = (await db.query<{ payment_status: string }>("select payment_status from merchant_storefront_payments")).rows[0];
      expect(row.payment_status).toBe("PAID");
    });

    it("marks stored keys that Razorpay starts rejecting and switches checkout off", async () => {
      await connect(orgA, KEY_A);
      validSecrets.set(KEY_A.keyId, "rotatedInRazorpay");
      try {
        const view = await verifyMerchantRazorpay(admin, { organizationId: orgA, userId: userA }, deps);
        expect(view).toMatchObject({ verified: false, status: "VERIFICATION_FAILED", enabled: false });
      } finally {
        validSecrets.set(KEY_A.keyId, KEY_A.keySecret);
      }
    });

    it("disconnect wipes keys, rotates the webhook URL and keeps payment history", async () => {
      await connect(orgA, KEY_A);
      const before = await webhookToken(orgA);
      await startPayment(orgA);
      const view = await disconnectMerchantRazorpay(admin, { organizationId: orgA, userId: userA });
      expect(view).toMatchObject({ status: "NOT_CONNECTED", enabled: false, keyIdHint: null, hasKeySecret: false });
      expect(await webhookToken(orgA)).not.toBe(before);
      const row = (await db.query<{ encrypted_key_secret: string | null }>("select encrypted_key_secret from merchant_payment_integrations")).rows[0];
      expect(row.encrypted_key_secret).toBeNull();
      expect((await db.query("select * from merchant_storefront_payments")).rows).toHaveLength(1);
      expect((await webhook(before, KEY_A.webhookSecret, { event: "payment.captured" })).status).toBe(404);
    });
  });

  describe("tenant isolation and no platform fallback", () => {
    it("keeps each merchant on its own account", async () => {
      await connect(orgA, KEY_A);
      await connect(orgB, KEY_B);
      expect((await getIntegrationView(admin, orgA)).keyIdHint).toBe("rzp_test_••••1111");
      expect((await getIntegrationView(admin, orgB)).keyIdHint).toBe("rzp_test_••••2222");
      const a = await startPayment(orgA);
      const b = await startPayment(orgB);
      expect(a.session.keyId).toBe(KEY_A.keyId);
      expect(b.session.keyId).toBe(KEY_B.keyId);
      expect(account(KEY_A.keyId).orders.has(a.session.razorpayOrderId)).toBe(true);
      expect(account(KEY_B.keyId).orders.has(a.session.razorpayOrderId)).toBe(false);
    });

    it("fails safely with no merchant configuration even when PostBus billing keys exist", async () => {
      process.env.RAZORPAY_KEY_ID = "rzp_live_PLATFORMplatform";
      process.env.RAZORPAY_KEY_SECRET = "platformSecret";
      try {
        await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available for this store/);
        await expect(activeMerchantGateway(admin, orgA)).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONNECTED" });
        const orderId = await newOrder(orgA);
        await expect(
          createStorefrontPayment(admin, { organizationId: orgA, orderId, orderNumber: null, kind: "FULL", amountDue: 499, orderTotal: 499, token: newPaymentToken() }, deps)
        ).rejects.toThrow(/not available for this store/);
      } finally {
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.RAZORPAY_KEY_SECRET;
      }
    });

    it("stops new online payments when the merchant disables checkout", async () => {
      await connect(orgA, KEY_A);
      await setMerchantRazorpayEnabled(admin, { organizationId: orgA, userId: userA }, false);
      await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available/);
    });

    it("never lets merchant B's buyer or webhook touch merchant A's payment", async () => {
      await connect(orgA, KEY_A);
      await connect(orgB, KEY_B);
      const a = await startPayment(orgA);
      // Merchant B's store link cannot address A's order, even with A's token.
      await expect(storefrontPaymentState(admin, { organizationId: orgB, orderId: a.orderId, token: a.token }, deps)).rejects.toThrow(/Payment not found/);
      // A captured payment for A's order sent to B's webhook (signed with B's secret) is ignored.
      const payment = pay(KEY_A.keyId, a.session.razorpayOrderId, "pay_cross", 49900);
      const outcome = await webhook(await webhookToken(orgB), KEY_B.webhookSecret, { event: "payment.captured", payload: { payment: { entity: payment } } });
      expect(outcome.body).toMatchObject({ ignored: true, result: "not_storefront_payment" });
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
    });
  });

  describe("checkout callback", () => {
    it("marks the order paid only after the signature and Razorpay's own record agree", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA);
      expect(session).toMatchObject({ amountPaise: 49900, currency: "INR", mode: "TEST" });
      expect(JSON.stringify(session)).not.toContain(KEY_A.keySecret);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_ok1", 49900);
      const signature = razorpayHmacHex(`${session.razorpayOrderId}|pay_ok1`, KEY_A.keySecret);
      const state = await confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_ok1", signature }, deps);
      expect(state).toMatchObject({ status: "PAID", method: "upi" });
      expect(await order(orderId)).toMatchObject({ status: "READY", payment_status: "PAID", amount_paid: "499.00" });
      // Duplicate callback (double click, retry) is a no-op.
      const again = await confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_ok1", signature }, deps);
      expect(again.status).toBe("PAID");
      const notices = (await db.query("select * from notifications where type = 'storefront.online_payment_received'")).rows;
      expect(notices.length).toBeLessThanOrEqual(1);
    });

    it("rejects a forged signature and a wrong attempt token", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_ok2", 49900);
      const forged = razorpayHmacHex(`${session.razorpayOrderId}|pay_ok2`, "attacker-secret");
      await expect(
        confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_ok2", signature: forged }, deps)
      ).rejects.toThrow(/could not be verified/);
      const good = razorpayHmacHex(`${session.razorpayOrderId}|pay_ok2`, KEY_A.keySecret);
      await expect(
        confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token: newPaymentToken(), razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_ok2", signature: good }, deps)
      ).rejects.toThrow(/Payment not found/);
      expect((await order(orderId)).payment_status).toBe("PENDING");
    });

    it("refuses a payment made for a different Razorpay order", async () => {
      await connect(orgA, KEY_A);
      const first = await startPayment(orgA);
      const second = await startPayment(orgA);
      pay(KEY_A.keyId, second.session.razorpayOrderId, "pay_other", 49900);
      const signature = razorpayHmacHex(`${first.session.razorpayOrderId}|pay_other`, KEY_A.keySecret);
      await expect(
        confirmStorefrontPayment(admin, { organizationId: orgA, orderId: first.orderId, token: first.token, razorpayOrderId: first.session.razorpayOrderId, razorpayPaymentId: "pay_other", signature }, deps)
      ).rejects.toThrow(/does not belong to this order/);
    });

    it("refuses an amount or currency mismatch and leaves the order unpaid", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_low", 100);
      const signature = razorpayHmacHex(`${session.razorpayOrderId}|pay_low`, KEY_A.keySecret);
      await expect(
        confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_low", signature }, deps)
      ).rejects.toThrow(/does not match/);
      const usd = { ...pay(KEY_A.keyId, session.razorpayOrderId, "pay_usd", 49900), currency: "USD" };
      account(KEY_A.keyId).payments.set("pay_usd", usd);
      await expect(
        confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_usd", signature: razorpayHmacHex(`${session.razorpayOrderId}|pay_usd`, KEY_A.keySecret) }, deps)
      ).rejects.toThrow(/does not match/);
      expect((await order(orderId)).payment_status).toBe("PENDING");
    });

    it("records a failed payment and lets the customer retry on the same Razorpay order", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_fail", 49900, "failed");
      expect((await storefrontPaymentState(admin, { organizationId: orgA, orderId, token }, deps)).status).toBe("FAILED");
      const resumed = await resumeStorefrontPayment(admin, { organizationId: orgA, orderId, token }, deps);
      expect(resumed.session?.razorpayOrderId).toBe(session.razorpayOrderId);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_retry", 49900);
      const signature = razorpayHmacHex(`${session.razorpayOrderId}|pay_retry`, KEY_A.keySecret);
      expect((await confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_retry", signature }, deps)).status).toBe("PAID");
    });

    it("keeps a cancelled checkout pending and creates no duplicate attempt", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token } = await startPayment(orgA);
      expect((await storefrontPaymentState(admin, { organizationId: orgA, orderId, token }, deps)).status).toBe("CREATED");
      await expect(
        createStorefrontPayment(admin, { organizationId: orgA, orderId, orderNumber: null, kind: "FULL", amountDue: 499, orderTotal: 499, token: newPaymentToken() }, deps)
      ).rejects.toThrow();
      expect((await db.query("select * from merchant_storefront_payments where order_id = $1", [orderId])).rows).toHaveLength(1);
    });

    it("lets the customer start payment later when Razorpay timed out at order time", async () => {
      await connect(orgA, KEY_A);
      const orderId = await newOrder(orgA);
      const token = newPaymentToken();
      await db.query("update orders set metadata = $2 where id = $1", [
        orderId,
        JSON.stringify({ storefront: { onlinePayment: pendingOnlinePaymentMeta({ kind: "FULL", amountDue: 499, orderTotal: 499, token }) } }),
      ]);
      account(KEY_A.keyId).timeout = true;
      await expect(resumeStorefrontPayment(admin, { organizationId: orgA, orderId, token }, deps)).rejects.toThrow(/did not respond in time/);
      account(KEY_A.keyId).timeout = false;
      await expect(resumeStorefrontPayment(admin, { organizationId: orgA, orderId, token: newPaymentToken() }, deps)).rejects.toThrow(/Payment not found/);
      const resumed = await resumeStorefrontPayment(admin, { organizationId: orgA, orderId, token }, deps);
      expect(resumed.session).toMatchObject({ amountPaise: 49900, keyId: KEY_A.keyId });
    });

    it("settles a COD advance as a partial payment", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA, 1000, "COD_ADVANCE", 200);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_adv", 20000);
      const signature = razorpayHmacHex(`${session.razorpayOrderId}|pay_adv`, KEY_A.keySecret);
      await confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_adv", signature }, deps);
      expect(await order(orderId)).toMatchObject({ status: "READY", payment_status: "PARTIAL", amount_paid: "200.00", cod_amount: "800.00" });
    });
  });

  describe("webhooks and reconciliation", () => {
    it("rejects an unknown URL and an invalid signature", async () => {
      await connect(orgA, KEY_A);
      expect((await webhook("f".repeat(48), KEY_A.webhookSecret, { event: "payment.captured" })).status).toBe(404);
      expect((await webhook(await webhookToken(orgA), "wrong-secret", { event: "payment.captured" })).status).toBe(400);
    });

    it("confirms a payment when the webhook arrives before the browser callback, and dedupes repeats", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token, session } = await startPayment(orgA);
      const payment = pay(KEY_A.keyId, session.razorpayOrderId, "pay_wh1", 49900);
      const hook = await webhookToken(orgA);
      const first = await webhook(hook, KEY_A.webhookSecret, { event: "payment.captured", payload: { payment: { entity: payment } } }, "evt_1");
      expect(first.body).toMatchObject({ success: true, result: "paid" });
      expect((await webhook(hook, KEY_A.webhookSecret, { event: "payment.captured", payload: { payment: { entity: payment } } }, "evt_1")).body).toMatchObject({ duplicate: true });
      // A different event id for the same payment (order.paid) is processed but changes nothing.
      expect((await webhook(hook, KEY_A.webhookSecret, { event: "order.paid", payload: { payment: { entity: payment } } }, "evt_2")).body).toMatchObject({ result: "already_paid" });
      // The late browser callback still succeeds.
      const signature = razorpayHmacHex(`${session.razorpayOrderId}|pay_wh1`, KEY_A.keySecret);
      expect((await confirmStorefrontPayment(admin, { organizationId: orgA, orderId, token, razorpayOrderId: session.razorpayOrderId, razorpayPaymentId: "pay_wh1", signature }, deps)).status).toBe("PAID");
      // A delayed payment.failed for an earlier attempt cannot undo the payment.
      const failed = pay(KEY_A.keyId, session.razorpayOrderId, "pay_wh0", 49900, "failed");
      expect((await webhook(hook, KEY_A.webhookSecret, { event: "payment.failed", payload: { payment: { entity: failed } } }, "evt_3")).body).toMatchObject({ ignored: true });
      expect((await order(orderId)).payment_status).toBe("PAID");
      const events = (await db.query<{ processing_status: string }>("select processing_status from merchant_payment_webhook_events order by received_at")).rows;
      expect(events.map((event) => event.processing_status)).toEqual(["PROCESSED", "PROCESSED", "IGNORED"]);
    });

    it("ignores payments on the merchant's account that PostBus did not create", async () => {
      await connect(orgA, KEY_A);
      const outside = { id: "pay_shop", order_id: "order_elsewhere", amount: 100, currency: "INR", status: "captured" };
      const outcome = await webhook(await webhookToken(orgA), KEY_A.webhookSecret, { event: "payment.captured", payload: { payment: { entity: outside } } });
      expect(outcome).toMatchObject({ status: 200, body: { ignored: true } });
    });

    it("recovers a captured payment when both callback and webhook were lost", async () => {
      await connect(orgA, KEY_A);
      const { orderId, session } = await startPayment(orgA);
      pay(KEY_A.keyId, session.razorpayOrderId, "pay_lost", 49900);
      await db.query("update merchant_storefront_payments set created_at = now() - interval '20 minutes'");
      expect(await sweepOpenStorefrontPayments(admin, deps)).toMatchObject({ checked: 1, failed: 0 });
      expect((await order(orderId)).payment_status).toBe("PAID");
    });

    it("keeps working when Razorpay times out during a status check", async () => {
      await connect(orgA, KEY_A);
      const { orderId, token } = await startPayment(orgA);
      account(KEY_A.keyId).timeout = true;
      expect((await storefrontPaymentState(admin, { organizationId: orgA, orderId, token }, deps)).status).toBe("CREATED");
    });

    it("marks a full refund from the refund webhook", async () => {
      await connect(orgA, KEY_A);
      const { orderId, session } = await startPayment(orgA);
      const payment = pay(KEY_A.keyId, session.razorpayOrderId, "pay_ref", 49900);
      const hook = await webhookToken(orgA);
      await webhook(hook, KEY_A.webhookSecret, { event: "payment.captured", payload: { payment: { entity: payment } } });
      account(KEY_A.keyId).payments.set("pay_ref", { ...payment, status: "refunded" });
      const outcome = await webhook(hook, KEY_A.webhookSecret, { event: "refund.processed", payload: { refund: { entity: { payment_id: "pay_ref" } } } });
      expect(outcome.body).toMatchObject({ result: "refunded" });
      expect((await order(orderId)).payment_status).toBe("REFUNDED");
    });
  });
});
