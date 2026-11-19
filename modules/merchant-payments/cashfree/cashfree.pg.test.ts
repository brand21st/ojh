import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_SCHEMA, pgSupabase } from "../pg-supabase.testkit";
import { saveMerchantRazorpay, setMerchantRazorpayEnabled } from "../integration";
import { newPaymentToken } from "../payments";
import {
  assertOnlinePaymentAvailable,
  createStorefrontPayment,
  pendingOnlinePaymentMeta,
  resumeStorefrontPayment,
  storefrontPaymentState,
  sweepOpenMerchantPayments,
  verifyCashfreeStorefrontPayment,
} from "../checkout";
import { ensureDefaultProvider, gatewayOverview, resolveCheckoutProvider, setDefaultProvider } from "../gateway";
import {
  CashfreeAuthError,
  CashfreeConflictError,
  CashfreeForbiddenError,
  CashfreeNotFoundError,
  CashfreeUnavailableError,
  type CashfreeOrder,
  type CashfreePayment,
  type CreateCashfreeOrderInput,
  type MerchantCashfreeCredentials,
} from "./client";
import {
  disconnectMerchantCashfree,
  getCashfreeView,
  saveMerchantCashfree,
  setMerchantCashfreeEnabled,
  verifyMerchantCashfree,
} from "./integration";
import { createCashfreePayment, reconcileOpenCashfreeAttempts, type CashfreeCheckoutSession } from "./payments";
import { cashfreeWebhookSignature, handleMerchantCashfreeWebhook } from "./webhook";

const orgA = "70000000-0000-4000-8000-00000000000a";
const orgB = "70000000-0000-4000-8000-00000000000b";
const userA = "71000000-0000-4000-8000-00000000000a";
const actorA = { organizationId: orgA, userId: userA };
const actorB = { organizationId: orgB, userId: userA };

const CF_A = { clientId: "TESTAAAA1111aaaa", clientSecret: "cfsk_ma_test_secretAAAA1111" };
const CF_B = { clientId: "TESTBBBB2222bbbb", clientSecret: "cfsk_ma_test_secretBBBB2222" };
const CF_A2 = { clientId: "TESTCCCC3333cccc", clientSecret: "cfsk_ma_test_secretCCCC3333" };
const CF_LIVE = { clientId: "LIVEDDDD4444dddd", clientSecret: "cfsk_ma_prod_secretDDDD4444" };
const RZP_A = { keyId: "rzp_test_AAAAaaaa1111", keySecret: "secretAAAA1111", webhookSecret: "whsec_A_123456" };

let db: PGlite;
let admin: ReturnType<typeof pgSupabase>;

// ---------------------------------------------------------------------------------------------
// In-memory stand-in for each merchant's Cashfree account, keyed by environment + Client ID.

type Account = {
  orders: Map<string, CashfreeOrder & { notifyUrl: string; returnUrl: string | null; idempotencyKey: string; customer: CreateCashfreeOrderInput["customer"] }>;
  payments: CashfreePayment[];
  timeout?: boolean;
  forbidden?: boolean;
  /** Lose the response of the next create (Cashfree created it, PostBus never heard back). */
  loseNextCreate?: boolean;
  /** Return a tampered amount on getOrder. */
  tamperAmount?: boolean;
};
const accounts = new Map<string, Account>();
const valid = new Map<string, string>([
  [`TEST:${CF_A.clientId}`, CF_A.clientSecret],
  [`TEST:${CF_B.clientId}`, CF_B.clientSecret],
  [`TEST:${CF_A2.clientId}`, CF_A2.clientSecret],
  [`LIVE:${CF_LIVE.clientId}`, CF_LIVE.clientSecret],
]);
const calls: Array<{ account: string; op: string }> = [];
let paymentSeq = 0;

function acct(mode: string, clientId: string) {
  const key = `${mode}:${clientId}`;
  if (!accounts.has(key)) accounts.set(key, { orders: new Map(), payments: [] });
  return accounts.get(key)!;
}

function fakeCashfree(creds: MerchantCashfreeCredentials) {
  const key = `${creds.mode}:${creds.clientId}`;
  const auth = (op: string) => {
    calls.push({ account: key, op });
    const account = acct(creds.mode, creds.clientId);
    if (account.timeout) throw new CashfreeUnavailableError(true);
    if (valid.get(key) !== creds.clientSecret) throw new CashfreeAuthError();
    if (account.forbidden) throw new CashfreeForbiddenError("Payment Gateway is not activated for this account.");
    return account;
  };
  const view = (order: Account["orders"] extends Map<string, infer V> ? V : never, tamper = false): CashfreeOrder => ({
    order_id: order.order_id,
    cf_order_id: order.cf_order_id,
    order_amount: tamper ? order.order_amount + 1 : order.order_amount,
    order_currency: order.order_currency,
    order_status: order.order_status,
    payment_session_id: order.order_status === "ACTIVE" ? `session_${order.order_id}_${Date.now()}` : null,
    order_tags: order.order_tags,
  });
  return {
    mode: creds.mode,
    verify: async () => {
      auth("verify");
      return { ok: true as const };
    },
    createOrder: async (input: CreateCashfreeOrderInput) => {
      const account = auth("createOrder");
      if (account.orders.has(input.orderId)) throw new CashfreeConflictError("order_already_exists");
      const order = {
        order_id: input.orderId,
        cf_order_id: String(1000 + account.orders.size),
        order_amount: Number((input.amountPaise / 100).toFixed(2)),
        order_currency: "INR",
        order_status: "ACTIVE",
        order_tags: input.tags,
        notifyUrl: input.notifyUrl,
        returnUrl: input.returnUrl ?? null,
        idempotencyKey: input.idempotencyKey,
        customer: input.customer,
      };
      account.orders.set(input.orderId, order);
      if (account.loseNextCreate) {
        account.loseNextCreate = false;
        throw new CashfreeUnavailableError(true);
      }
      return view(order);
    },
    getOrder: async (orderId: string) => {
      const account = auth("getOrder");
      const order = account.orders.get(orderId);
      if (!order) throw new CashfreeNotFoundError();
      return view(order, account.tamperAmount);
    },
    getOrderPayments: async (orderId: string) => {
      const account = auth("getOrderPayments");
      return account.payments.filter((payment) => payment.order_id === orderId);
    },
  };
}
const deps = { client: fakeCashfree as never };
const cf = { cashfreeClient: fakeCashfree as never };

/** Records a payment attempt on the merchant's Cashfree account. */
function cfPay(clientId: string, orderId: string, status: string, amount: number, mode = "TEST", extra: Partial<CashfreePayment> = {}) {
  const account = acct(mode, clientId);
  const payment: CashfreePayment = {
    cf_payment_id: String(5000 + ++paymentSeq),
    order_id: orderId,
    payment_status: status,
    payment_amount: amount,
    payment_currency: "INR",
    payment_group: "upi",
    payment_message: status === "SUCCESS" ? "Transaction success" : "Payment did not complete",
    payment_time: new Date(Date.now() + paymentSeq * 1000).toISOString(),
    ...extra,
  };
  account.payments.push(payment);
  if (status === "SUCCESS") {
    const order = account.orders.get(orderId);
    if (order) order.order_status = "PAID";
  }
  return payment;
}

// ---------------------------------------------------------------------------------------------

async function connectCashfree(actor: typeof actorA, creds = CF_A, enable = true, mode: "TEST" | "LIVE" = "TEST") {
  await saveMerchantCashfree(admin, actor, { mode, ...creds }, deps);
  if (enable) {
    await setMerchantCashfreeEnabled(admin, actor, true);
    await ensureDefaultProvider(admin, actor, "CASHFREE");
  }
}

let orderNo = 0;
async function newOrder(org: string, total = 499) {
  const id = `72000000-0000-4000-8000-${String(++orderNo).padStart(12, "0")}`;
  await db.query("insert into orders(id, organization_id, total_amount, order_number) values ($1, $2, $3, $4)", [id, org, total, `WA-${orderNo}`]);
  return id;
}

async function startPayment(org: string, total = 499, kind: "FULL" | "COD_ADVANCE" = "FULL", due = total) {
  const orderId = await newOrder(org, total);
  const token = newPaymentToken();
  const session = (await createCashfreePayment(
    admin,
    { organizationId: org, orderId, orderNumber: `WA-${orderNo}`, kind, amountDue: due, orderTotal: total, token, customer: { name: "Asha Kumar", phone: "+91 98765 43210" } },
    deps
  )) as CashfreeCheckoutSession;
  return { orderId, token, session };
}

async function order(id: string) {
  return (
    await db.query<{ status: string; payment_status: string; amount_paid: string | null; cod_amount: string | null; metadata: Record<string, unknown> }>(
      "select status, payment_status, amount_paid, cod_amount, metadata from orders where id = $1",
      [id]
    )
  ).rows[0];
}

async function attempt(orderId: string) {
  return (
    await db.query<{ payment_status: string; cashfree_payment_id: string | null; needs_review: boolean; review_reason: string | null; extra_payment_ids: string[]; provider: string }>(
      "select payment_status, cashfree_payment_id, needs_review, review_reason, extra_payment_ids, provider from merchant_storefront_payments where order_id = $1",
      [orderId]
    )
  ).rows[0];
}

async function cashfreeToken(org: string) {
  return (await db.query<{ webhook_token: string }>("select webhook_token from merchant_payment_integrations where organization_id = $1 and provider = 'CASHFREE'", [org])).rows[0]
    .webhook_token;
}

let tsSeq = 0;
async function webhook(token: string, secret: string, body: Record<string, unknown>, opts: { idempotencyKey?: string | null; badSignature?: boolean } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(1_790_000_000_000 + ++tsSeq);
  const signature = opts.badSignature ? cashfreeWebhookSignature(timestamp, rawBody, "wrong-secret-value") : cashfreeWebhookSignature(timestamp, rawBody, secret);
  return handleMerchantCashfreeWebhook(
    admin,
    { token, rawBody, signature, timestamp, idempotencyKey: opts.idempotencyKey === undefined ? `idem_${Math.random()}` : opts.idempotencyKey },
    deps
  );
}

function successEvent(cashfreeOrderId: string, payment: CashfreePayment, type = "PAYMENT_SUCCESS_WEBHOOK") {
  return {
    data: { order: { order_id: cashfreeOrderId, order_amount: payment.payment_amount, order_currency: "INR" }, payment },
    event_time: new Date().toISOString(),
    type,
  };
}

describe("merchant cashfree payments (service + real schema)", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(`
      alter table public.orders add column customer_id uuid;
      create table public.customers(id uuid primary key, organization_id uuid not null, name text, phone text, email text);
    `);
    await db.exec(readFileSync("supabase/migrations/20261120090000_merchant_razorpay_payments.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261120100000_merchant_cashfree_payments.sql", "utf8"));
    admin = pgSupabase(db);
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    accounts.clear();
    calls.length = 0;
    await db.exec(`
      delete from merchant_payment_webhook_events; delete from merchant_storefront_payments; delete from merchant_payment_integrations;
      delete from merchant_payment_settings; delete from customers;
      delete from orders; delete from organizations; delete from idempotency_keys; delete from notifications; delete from audit_logs;
      insert into organizations values ('${orgA}'), ('${orgB}');
    `);
  });

  describe("connecting an account", () => {
    it("verifies, encrypts and masks valid sandbox credentials", async () => {
      const view = await saveMerchantCashfree(admin, actorA, { mode: "TEST", ...CF_A }, deps);
      expect(view).toMatchObject({ status: "CONNECTED", mode: "TEST", environment: "Sandbox", clientIdHint: "TEST••••aaaa", hasClientSecret: true, enabled: false });
      expect(view.webhookUrl).toMatch(/\/api\/webhooks\/merchant\/cashfree\/[a-f0-9]{48}$/);
      const serialized = JSON.stringify(view);
      for (const secret of [CF_A.clientId, CF_A.clientSecret]) expect(serialized).not.toContain(secret);
      const raw = JSON.stringify((await db.query("select * from merchant_payment_integrations")).rows);
      for (const secret of [CF_A.clientId, CF_A.clientSecret]) expect(raw).not.toContain(secret);
      expect(JSON.stringify((await db.query("select * from audit_logs")).rows)).not.toContain(CF_A.clientSecret);
      // The credential check is read-only.
      expect(calls.every((call) => call.op === "verify")).toBe(true);
    });

    it("rejects invalid credentials and saves nothing", async () => {
      await expect(saveMerchantCashfree(admin, actorA, { mode: "TEST", clientId: CF_A.clientId, clientSecret: "cfsk_ma_test_wrongwrongwrong" }, deps)).rejects.toThrow(
        /rejected these credentials/
      );
      await expect(saveMerchantCashfree(admin, actorA, { mode: "TEST", clientId: "x", clientSecret: "y" }, deps)).rejects.toThrow(/Client ID/);
      expect((await db.query("select * from merchant_payment_integrations")).rows).toHaveLength(0);
    });

    it("explains a Sandbox / Production mix-up instead of calling the keys invalid", async () => {
      // Secret without an environment marker, so only Cashfree itself can tell.
      valid.set(`TEST:TESTEEEE5555eeee`, "plainSecretEEEE5555");
      await expect(saveMerchantCashfree(admin, actorA, { mode: "LIVE", clientId: "TESTEEEE5555eeee", clientSecret: "plainSecretEEEE5555" }, deps)).rejects.toThrow(
        /Sandbox credentials, but Production is selected/
      );
      // Secret markers are caught before any network call.
      calls.length = 0;
      await expect(saveMerchantCashfree(admin, actorA, { mode: "TEST", ...CF_LIVE }, deps)).rejects.toThrow(/Production secret, but Sandbox is selected/);
      expect(calls).toHaveLength(0);
      const live = await saveMerchantCashfree(admin, actorA, { mode: "LIVE", ...CF_LIVE }, deps);
      expect(live).toMatchObject({ mode: "LIVE", environment: "Production", status: "CONNECTED" });
      expect(calls.some((call) => call.account.startsWith("LIVE:"))).toBe(true);
    });

    it("gives clear errors for an unactivated account and for Cashfree timeouts", async () => {
      acct("TEST", CF_A.clientId).forbidden = true;
      await expect(saveMerchantCashfree(admin, actorA, { mode: "TEST", ...CF_A }, deps)).rejects.toThrow(/not activated.*Complete your Cashfree account activation/);
      acct("TEST", CF_A.clientId).forbidden = false;
      acct("TEST", CF_A.clientId).timeout = true;
      await expect(saveMerchantCashfree(admin, actorA, { mode: "TEST", ...CF_A }, deps)).rejects.toThrow(/did not respond in time/);
      expect((await db.query("select * from merchant_payment_integrations")).rows).toHaveLength(0);
    });

    it("replacing credentials reconciles old attempts with the old account and turns checkout off", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      await saveMerchantCashfree(admin, actorA, { mode: "TEST", ...CF_A2 }, { ...deps, reconcileOpen: (row) => reconcileOpenCashfreeAttempts(admin, row, deps) });
      expect((await order(a.orderId)).payment_status).toBe("PAID");
      const view = await getCashfreeView(admin, orgA);
      expect(view).toMatchObject({ clientIdHint: "TEST••••cccc", enabled: false, status: "CONNECTED" });
      await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available/);
    });

    it("marks credentials Cashfree starts rejecting and switches checkout off", async () => {
      await connectCashfree(actorA);
      valid.set(`TEST:${CF_A.clientId}`, "rotated-elsewhere-secret");
      try {
        const view = await verifyMerchantCashfree(admin, actorA, deps);
        expect(view).toMatchObject({ verified: false, status: "VERIFICATION_FAILED", enabled: false });
        await expect(setMerchantCashfreeEnabled(admin, actorA, true)).rejects.toThrow(/Verify your Cashfree credentials/);
      } finally {
        valid.set(`TEST:${CF_A.clientId}`, CF_A.clientSecret);
      }
    });

    it("disconnect wipes credentials, rotates the webhook URL and keeps payment history", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const oldToken = await cashfreeToken(orgA);
      const view = await disconnectMerchantCashfree(admin, actorA);
      expect(view).toMatchObject({ status: "NOT_CONNECTED", enabled: false, clientIdHint: null, webhookUrl: null });
      const row = (await db.query<{ encrypted_key_id: string | null; encrypted_key_secret: string | null }>("select * from merchant_payment_integrations where provider = 'CASHFREE'")).rows[0];
      expect(row.encrypted_key_id).toBeNull();
      expect(row.encrypted_key_secret).toBeNull();
      expect(await attempt(a.orderId)).toBeTruthy();
      expect((await webhook(oldToken, CF_A.clientSecret, { type: "PAYMENT_SUCCESS_WEBHOOK" })).status).toBe(404);
    });
  });

  describe("default gateway selection", () => {
    it("makes the first enabled gateway the default", async () => {
      await connectCashfree(actorA);
      expect(await resolveCheckoutProvider(admin, orgA)).toBe("CASHFREE");
      expect((await gatewayOverview(admin, orgA)).defaultProvider).toBe("CASHFREE");
    });

    it("routes new checkouts to the chosen gateway when both are connected", async () => {
      await saveMerchantRazorpay(admin, actorA, { mode: "TEST", ...RZP_A }, {
        client: (() => ({ verify: async () => ({}) })) as never,
      });
      await setMerchantRazorpayEnabled(admin, actorA, true);
      await ensureDefaultProvider(admin, actorA, "RAZORPAY");
      await connectCashfree(actorA);
      expect(await resolveCheckoutProvider(admin, orgA)).toBe("RAZORPAY");
      await setDefaultProvider(admin, actorA, "CASHFREE");
      expect(await assertOnlinePaymentAvailable(admin, orgA)).toBe("CASHFREE");
    });

    it("never switches gateways silently when the chosen one is unavailable", async () => {
      await saveMerchantRazorpay(admin, actorA, { mode: "TEST", ...RZP_A }, { client: (() => ({ verify: async () => ({}) })) as never });
      await setMerchantRazorpayEnabled(admin, actorA, true);
      await connectCashfree(actorA);
      await setDefaultProvider(admin, actorA, "CASHFREE");
      await setMerchantCashfreeEnabled(admin, actorA, false);
      expect(await resolveCheckoutProvider(admin, orgA)).toBeNull();
      await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available/);
      const overview = await gatewayOverview(admin, orgA);
      expect(overview.activeProvider).toBeNull();
      expect(overview.notice).toMatch(/Cashfree is your default gateway/);
      // An order placed earlier for Cashfree is not moved to Razorpay either.
      const orderId = await newOrder(orgA);
      await expect(
        createStorefrontPayment(admin, { provider: "RAZORPAY", organizationId: orgA, orderId, orderNumber: null, kind: "FULL", amountDue: 499, orderTotal: 499, token: newPaymentToken() })
      ).rejects.toThrow(/not available/);
    });

    it("refuses an unverified or disabled gateway as default", async () => {
      await connectCashfree(actorA, CF_A, false);
      await expect(setDefaultProvider(admin, actorA, "CASHFREE")).rejects.toThrow(/Connect, verify and enable Cashfree/);
      await expect(setDefaultProvider(admin, actorA, "RAZORPAY")).rejects.toThrow(/enable Razorpay/);
    });
  });

  describe("tenant isolation and no platform fallback", () => {
    it("keeps each merchant on its own Cashfree account", async () => {
      await connectCashfree(actorA, CF_A);
      await connectCashfree(actorB, CF_B);
      const a = await startPayment(orgA);
      const b = await startPayment(orgB);
      expect(acct("TEST", CF_A.clientId).orders.has(a.session.cashfreeOrderId)).toBe(true);
      expect(acct("TEST", CF_B.clientId).orders.has(a.session.cashfreeOrderId)).toBe(false);
      expect(acct("TEST", CF_B.clientId).orders.has(b.session.cashfreeOrderId)).toBe(true);
    });

    it("fails safely with no merchant configuration even with platform keys in the environment", async () => {
      process.env.RAZORPAY_KEY_ID = "rzp_live_PLATFORMplatform";
      process.env.CASHFREE_CLIENT_ID = "PLATFORM";
      process.env.CASHFREE_CLIENT_SECRET = "platform-secret";
      try {
        await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available for this store/);
        const orderId = await newOrder(orgA);
        await expect(
          createCashfreePayment(admin, { organizationId: orgA, orderId, orderNumber: null, kind: "FULL", amountDue: 499, orderTotal: 499, token: newPaymentToken(), customer: { phone: "9876543210" } }, deps)
        ).rejects.toThrow(/not available for this store/);
        expect(calls).toHaveLength(0);
      } finally {
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.CASHFREE_CLIENT_ID;
        delete process.env.CASHFREE_CLIENT_SECRET;
      }
    });

    it("never lets merchant B's buyer or webhook touch merchant A's payment", async () => {
      await connectCashfree(actorA, CF_A);
      await connectCashfree(actorB, CF_B);
      const a = await startPayment(orgA);
      await expect(storefrontPaymentState(admin, { organizationId: orgB, orderId: a.orderId, token: a.token }, cf)).rejects.toThrow(/Payment not found/);
      const payment = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      // A's order id sent to B's webhook, correctly signed with B's secret: ignored.
      const outcome = await webhook(await cashfreeToken(orgB), CF_B.clientSecret, successEvent(a.session.cashfreeOrderId, payment));
      expect(outcome.body).toMatchObject({ ignored: true, result: "not_storefront_payment" });
      // B's secret on A's webhook URL: rejected.
      expect((await webhook(await cashfreeToken(orgA), CF_B.clientSecret, successEvent(a.session.cashfreeOrderId, payment))).status).toBe(400);
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
    });

    it("a Razorpay webhook token never resolves on the Cashfree route", async () => {
      await saveMerchantRazorpay(admin, actorA, { mode: "TEST", ...RZP_A }, { client: (() => ({ verify: async () => ({}) })) as never });
      const rzpToken = (await db.query<{ webhook_token: string }>("select webhook_token from merchant_payment_integrations where provider = 'RAZORPAY'")).rows[0].webhook_token;
      expect((await webhook(rzpToken, RZP_A.webhookSecret, { type: "PAYMENT_SUCCESS_WEBHOOK" })).status).toBe(404);
    });
  });

  describe("checkout", () => {
    it("creates the Cashfree order in rupees on the merchant's account with a per-merchant notify URL", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA, 1234.5);
      const created = acct("TEST", CF_A.clientId).orders.get(a.session.cashfreeOrderId)!;
      expect(created.order_amount).toBe(1234.5);
      expect(a.session).toMatchObject({ provider: "CASHFREE", environment: "sandbox", amountPaise: 123450, currency: "INR", mode: "TEST" });
      expect(a.session.cashfreeOrderId).toMatch(/^pb_[a-f0-9]{32}$/);
      expect(a.session.paymentSessionId).toBeTruthy();
      expect(created.notifyUrl).toBe(`${(await getCashfreeView(admin, orgA)).webhookUrl}`);
      expect(created.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(created.customer).toMatchObject({ phone: "9876543210", name: "Asha Kumar" });
      expect(JSON.stringify(a.session)).not.toContain(CF_A.clientSecret);
    });

    it("marks the order paid only after Cashfree's own records agree, once", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const ref = { organizationId: orgA, orderId: a.orderId, token: a.token };
      // Checkout closed but nothing paid yet: still pending.
      expect((await verifyCashfreeStorefrontPayment(admin, ref, cf)).status).toBe("CREATED");
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      await db.exec("update merchant_storefront_payments set last_reconciled_at = null");
      const state = await verifyCashfreeStorefrontPayment(admin, ref, cf);
      expect(state).toMatchObject({ status: "PAID", amountPaise: 49900, method: "upi" });
      const paid = await order(a.orderId);
      expect(paid).toMatchObject({ status: "READY", payment_status: "PAID" });
      expect(Number(paid.amount_paid)).toBe(499);
      expect((paid.metadata as { storefront: { onlinePayment: Record<string, unknown> } }).storefront.onlinePayment).toMatchObject({
        provider: "CASHFREE",
        cashfreeOrderId: a.session.cashfreeOrderId,
      });
      await db.exec("update merchant_storefront_payments set last_reconciled_at = null");
      await verifyCashfreeStorefrontPayment(admin, ref, cf);
      expect((await db.query("select * from idempotency_keys where key like 'merchant_payment:paid_notice:%'")).rows).toHaveLength(1);
    });

    it("rejects a wrong attempt token", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      await expect(verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: newPaymentToken() }, cf)).rejects.toThrow(/Payment not found/);
    });

    it("records a failed attempt and lets the customer retry on the same Cashfree order", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const ref = { organizationId: orgA, orderId: a.orderId, token: a.token };
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "FAILED", 499, "TEST", { error_details: { error_description: "Bank declined" } });
      expect(await verifyCashfreeStorefrontPayment(admin, ref, cf)).toMatchObject({ status: "FAILED", failureReason: "Bank declined" });
      const resumed = await resumeStorefrontPayment(admin, ref, cf);
      expect(resumed.session).toMatchObject({ provider: "CASHFREE", cashfreeOrderId: a.session.cashfreeOrderId });
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      await db.exec("update merchant_storefront_payments set last_reconciled_at = null");
      expect((await verifyCashfreeStorefrontPayment(admin, ref, cf)).status).toBe("PAID");
      expect((await db.query("select * from merchant_storefront_payments")).rows).toHaveLength(1);
    });

    it("keeps a dropped checkout pending as cancelled and resumable", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const ref = { organizationId: orgA, orderId: a.orderId, token: a.token };
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "USER_DROPPED", 499);
      expect((await verifyCashfreeStorefrontPayment(admin, ref, cf)).status).toBe("CANCELLED");
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
      expect((await resumeStorefrontPayment(admin, ref, cf)).session).not.toBeNull();
    });

    it("shows a pending bank payment as processing and settles it later via the sweep", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const ref = { organizationId: orgA, orderId: a.orderId, token: a.token };
      const pending = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "PENDING", 499);
      expect((await verifyCashfreeStorefrontPayment(admin, ref, cf)).status).toBe("PROCESSING");
      expect((await resumeStorefrontPayment(admin, ref, cf)).session).toBeNull();
      pending.payment_status = "SUCCESS";
      acct("TEST", CF_A.clientId).orders.get(a.session.cashfreeOrderId)!.order_status = "PAID";
      await db.exec("update merchant_storefront_payments set created_at = now() - interval '20 minutes', last_reconciled_at = null");
      const swept = await sweepOpenMerchantPayments(admin, cf);
      expect(swept.cashfree).toMatchObject({ checked: 1, failed: 0 });
      expect((await order(a.orderId)).payment_status).toBe("PAID");
      expect((await storefrontPaymentState(admin, ref, cf)).status).toBe("PAID");
    });

    it("refuses an amount or currency mismatch and leaves the order unpaid", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 1);
      await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf);
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
      expect(await attempt(a.orderId)).toMatchObject({ payment_status: "CREATED", needs_review: true });

      const b = await startPayment(orgA);
      cfPay(CF_A.clientId, b.session.cashfreeOrderId, "SUCCESS", 499, "TEST", { payment_currency: "USD" });
      await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: b.orderId, token: b.token }, cf);
      expect((await order(b.orderId)).payment_status).toBe("PENDING");
    });

    it("refuses to settle when Cashfree's order record does not match the stored amount", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      acct("TEST", CF_A.clientId).tamperAmount = true;
      await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf);
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
    });

    it("adopts the Cashfree order when the first create response was lost (duplicate checkout request)", async () => {
      await connectCashfree(actorA);
      const orderId = await newOrder(orgA);
      const token = newPaymentToken();
      const input = { organizationId: orgA, orderId, orderNumber: "WA-1", kind: "FULL" as const, amountDue: 499, orderTotal: 499, token, customer: { phone: "9876543210" } };
      acct("TEST", CF_A.clientId).loseNextCreate = true;
      await expect(createCashfreePayment(admin, input, deps)).rejects.toThrow(/did not respond/);
      const session = await createCashfreePayment(admin, input, deps);
      expect(session.cashfreeOrderId).toMatch(/^pb_/);
      expect(acct("TEST", CF_A.clientId).orders.size).toBe(1);
      // A third request for the same order is refused, not double-created.
      await expect(createCashfreePayment(admin, input, deps)).rejects.toThrow(/already being prepared/);
    });

    it("lets the customer start payment later when Cashfree was down at order time", async () => {
      await connectCashfree(actorA);
      const orderId = await newOrder(orgA);
      const token = newPaymentToken();
      const meta = pendingOnlinePaymentMeta({ provider: "CASHFREE", kind: "FULL", amountDue: 499, orderTotal: 499, token });
      await db.query("update orders set metadata = $2 where id = $1", [orderId, JSON.stringify({ storefront: { onlinePayment: meta } })]);
      await db.query("insert into customers(id, organization_id, name, phone) values ($1, $2, 'Ravi', '9123456780')", ["73000000-0000-4000-8000-000000000001", orgA]);
      await db.query("update orders set customer_id = $2 where id = $1", [orderId, "73000000-0000-4000-8000-000000000001"]);
      // Placed while Cashfree was down: no attempt yet. Resume starts it from the stored order.
      const resumed = await resumeStorefrontPayment(admin, { organizationId: orgA, orderId, token }, cf);
      expect(resumed.session).toMatchObject({ provider: "CASHFREE", amountPaise: 49900 });
      const created = acct("TEST", CF_A.clientId).orders.get((resumed.session as CashfreeCheckoutSession).cashfreeOrderId)!;
      expect(created.customer.phone).toBe("9123456780");
      expect((await attempt(orderId)).provider).toBe("CASHFREE");
      // Someone else's token for the same order is refused.
      const other = await newOrder(orgA);
      await db.query("update orders set metadata = $2 where id = $1", [other, JSON.stringify({ storefront: { onlinePayment: meta } })]);
      await expect(resumeStorefrontPayment(admin, { organizationId: orgA, orderId: other, token: newPaymentToken() }, cf)).rejects.toThrow(/Payment not found/);
    });

    it("settles a COD advance as a partial payment", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA, 999, "COD_ADVANCE", 100);
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 100);
      await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf);
      const settled = await order(a.orderId);
      expect(settled).toMatchObject({ status: "READY", payment_status: "PARTIAL" });
      expect(Number(settled.amount_paid)).toBe(100);
      expect(Number(settled.cod_amount)).toBe(899);
    });

    it("keeps the first successful payment and flags an extra one for refund", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const first = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      const second = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf);
      expect(await attempt(a.orderId)).toMatchObject({
        payment_status: "PAID",
        cashfree_payment_id: String(first.cf_payment_id),
        needs_review: true,
        extra_payment_ids: [String(second.cf_payment_id)],
      });
    });

    it("stops new Cashfree checkouts when disabled but still verifies an in-flight payment", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      await setMerchantCashfreeEnabled(admin, actorA, false);
      await expect(assertOnlinePaymentAvailable(admin, orgA)).rejects.toThrow(/not available/);
      await expect(resumeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf)).rejects.toThrow(/not available/);
      cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      expect((await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf)).status).toBe("PAID");
    });
  });

  describe("webhooks", () => {
    it("rejects an unknown URL, a missing timestamp and an invalid signature", async () => {
      await connectCashfree(actorA);
      expect((await webhook("f".repeat(48), CF_A.clientSecret, { type: "PAYMENT_SUCCESS_WEBHOOK" })).status).toBe(404);
      expect((await webhook("../../etc", CF_A.clientSecret, { type: "PAYMENT_SUCCESS_WEBHOOK" })).status).toBe(404);
      const token = await cashfreeToken(orgA);
      expect((await webhook(token, CF_A.clientSecret, { type: "PAYMENT_SUCCESS_WEBHOOK" }, { badSignature: true })).status).toBe(400);
      const outcome = await handleMerchantCashfreeWebhook(admin, { token, rawBody: "{}", signature: cashfreeWebhookSignature("", "{}", CF_A.clientSecret), timestamp: "", idempotencyKey: null }, deps);
      expect(outcome.status).toBe(400);
    });

    it("verifies against the raw bytes, not re-serialised JSON", async () => {
      await connectCashfree(actorA);
      const token = await cashfreeToken(orgA);
      const rawBody = '{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"payment":{"payment_amount":170.00}}}';
      const timestamp = "1790000000999";
      const signature = cashfreeWebhookSignature(timestamp, JSON.stringify(JSON.parse(rawBody)), CF_A.clientSecret);
      expect((await handleMerchantCashfreeWebhook(admin, { token, rawBody, signature, timestamp, idempotencyKey: null }, deps)).status).toBe(400);
      const good = cashfreeWebhookSignature(timestamp, rawBody, CF_A.clientSecret);
      expect((await handleMerchantCashfreeWebhook(admin, { token, rawBody, signature: good, timestamp, idempotencyKey: null }, deps)).status).toBe(200);
    });

    it("settles the order when the webhook arrives before the customer returns, and dedupes repeats", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const payment = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      const token = await cashfreeToken(orgA);
      const first = await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, payment), { idempotencyKey: "idem-1" });
      expect(first).toMatchObject({ status: 200, body: { result: "paid" } });
      expect((await order(a.orderId)).payment_status).toBe("PAID");
      const again = await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, payment), { idempotencyKey: "idem-1" });
      expect(again.body).toMatchObject({ duplicate: true });
      expect((await getCashfreeView(admin, orgA)).lastWebhookAt).toBeTruthy();
      // Customer comes back afterwards: already paid, nothing changes, one notification.
      expect((await verifyCashfreeStorefrontPayment(admin, { organizationId: orgA, orderId: a.orderId, token: a.token }, cf)).status).toBe("PAID");
      expect((await db.query("select * from idempotency_keys where key like 'merchant_payment:paid_notice:%'")).rows).toHaveLength(1);
      const stored = JSON.stringify((await db.query("select * from merchant_payment_webhook_events")).rows);
      expect(stored).not.toContain("9876543210");
    });

    it("never undoes a verified payment with a late failure or drop webhook", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const success = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      const token = await cashfreeToken(orgA);
      await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, success));
      const failed = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "FAILED", 499);
      const dropped = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "USER_DROPPED", 499);
      await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, failed, "PAYMENT_FAILED_WEBHOOK"));
      await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, dropped, "PAYMENT_USER_DROPPED_WEBHOOK"));
      expect(await attempt(a.orderId)).toMatchObject({ payment_status: "PAID", cashfree_payment_id: String(success.cf_payment_id) });
      expect((await order(a.orderId)).payment_status).toBe("PAID");
    });

    it("does not trust the webhook body: Cashfree's API decides", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const real = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "FAILED", 499);
      // Correctly signed (e.g. replayed or crafted by someone holding the secret) but claims success.
      const outcome = await webhook(await cashfreeToken(orgA), CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, { ...real, payment_status: "SUCCESS" }));
      expect(outcome.body).toMatchObject({ result: "failed" });
      expect((await order(a.orderId)).payment_status).toBe("PENDING");
    });

    it("ignores payments on the merchant's account that PostBus did not create, and unrelated events", async () => {
      await connectCashfree(actorA);
      const token = await cashfreeToken(orgA);
      const outside = cfPay(CF_A.clientId, "their_own_website_order", "SUCCESS", 10);
      expect((await webhook(token, CF_A.clientSecret, successEvent("their_own_website_order", outside))).body).toMatchObject({ ignored: true, result: "not_storefront_payment" });
      expect((await webhook(token, CF_A.clientSecret, { type: "SETTLEMENT_WEBHOOK", data: {} })).body).toMatchObject({ ignored: true });
    });

    it("returns 500 while Cashfree is unreachable so the retry can succeed", async () => {
      await connectCashfree(actorA);
      const a = await startPayment(orgA);
      const payment = cfPay(CF_A.clientId, a.session.cashfreeOrderId, "SUCCESS", 499);
      const token = await cashfreeToken(orgA);
      acct("TEST", CF_A.clientId).timeout = true;
      const failed = await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, payment), { idempotencyKey: "idem-retry" });
      expect(failed.status).toBe(500);
      acct("TEST", CF_A.clientId).timeout = false;
      const retried = await webhook(token, CF_A.clientSecret, successEvent(a.session.cashfreeOrderId, payment), { idempotencyKey: "idem-retry" });
      expect(retried).toMatchObject({ status: 200, body: { result: "paid" } });
      const event = (await db.query<{ attempts: number; processing_status: string }>("select attempts, processing_status from merchant_payment_webhook_events")).rows[0];
      expect(event).toMatchObject({ attempts: 2, processing_status: "PROCESSED" });
    });
  });
});
