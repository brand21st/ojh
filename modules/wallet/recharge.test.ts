import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const razorpay = vi.hoisted(() => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: vi.fn(),
  fetchRazorpayOrderPayments: vi.fn(),
}));
const config = vi.hoisted(() => ({ getRazorpayConfig: vi.fn() }));
const signature = vi.hoisted(() => ({ verifyOrderCheckoutSignature: vi.fn() }));
const audit = vi.hoisted(() => ({ writeBillingAudit: vi.fn(), writeSubscriptionHistory: vi.fn() }));

vi.mock("@/modules/razorpay/client", () => razorpay);
vi.mock("@/modules/razorpay/config", () => config);
vi.mock("@/modules/razorpay/signature", () => signature);
vi.mock("@/modules/billing/audit", () => audit);

import { startWalletRecharge, verifyWalletRecharge } from "@/modules/wallet/recharge";
import { recoverPendingRecharges } from "@/modules/wallet/reconcile";
import { quoteRecharge, validateRechargeAmount } from "@/modules/wallet/recharge-quote";

const ORG = "30000000-0000-4000-8000-000000000001";

function fakeDb(rpcResult: Record<string, unknown> = { status: "CREATED", taxablePaise: 84746, taxPaise: 15254, creditMicros: "847460000" }, settings: Record<string, unknown> | null = null) {
  const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    rpc,
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        lt: () => chain,
        gt: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({
            data: table === "wallet_recharge_orders" ? [{ razorpay_order_id: "order_old", amount_paise: 100000, organization_id: ORG }] : [],
            error: null,
          }),
        maybeSingle: async () => ({ data: settings, error: null }),
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return { eq: async () => ({ error: null }) };
        },
      });
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, rpc, updates };
}

beforeEach(() => {
  vi.stubEnv("WALLET_ENABLED", "true");
  config.getRazorpayConfig.mockResolvedValue({ keyId: "rzp_test_key", keySecret: "secret" });
  signature.verifyOrderCheckoutSignature.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("recharge quote", () => {
  it("splits Rs 1,000 at 18% the way the subscription GST engine does", () => {
    const q = quoteRecharge(100000, 1800);
    expect(q).toMatchObject({ taxablePaise: 84746, taxPaise: 15254, cgstPaise: 7627, sgstPaise: 7627, igstPaise: 0 });
    expect(q.creditMicros).toBe(BigInt(847_460_000));
    expect(quoteRecharge(10000, 0).taxPaise).toBe(0);
  });

  it("accepts only whole rupees inside the limits", () => {
    const limits = { minPaise: 10000, maxPaise: 5000000 };
    expect(validateRechargeAmount(10000, limits).ok).toBe(true);
    expect(validateRechargeAmount(10050, limits).ok).toBe(false);
    expect(validateRechargeAmount(9900, limits)).toMatchObject({ ok: false, message: expect.stringContaining("₹100") });
    expect(validateRechargeAmount("10000", limits).ok).toBe(false);
    expect(validateRechargeAmount(Number.NaN, limits).ok).toBe(false);
  });
});

describe("startWalletRecharge", () => {
  it("is closed while the wallet flag is off", async () => {
    vi.stubEnv("WALLET_ENABLED", "");
    const { db } = fakeDb();
    await expect(
      startWalletRecharge(db, { organizationId: ORG, organizationName: "M", userId: "u", amountPaise: 10000 })
    ).rejects.toThrow(/not open/);
    expect(razorpay.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("rejects an amount before creating any Razorpay order", async () => {
    const { db } = fakeDb();
    await expect(
      startWalletRecharge(db, { organizationId: ORG, organizationName: "M", userId: "u", amountPaise: 5000 })
    ).rejects.toThrow(/between/);
    expect(razorpay.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("creates the order and records it through the database function", async () => {
    razorpay.createRazorpayOrder.mockResolvedValue({ id: "order_new" });
    const { db, rpc } = fakeDb();
    const result = await startWalletRecharge(db, {
      organizationId: ORG,
      organizationName: "Merchant",
      email: "m@example.com",
      userId: "user-1",
      amountPaise: 100000,
    });
    expect(razorpay.createRazorpayOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 100000, notes: { kind: "wallet_recharge", organization_id: ORG } })
    );
    expect(rpc).toHaveBeenCalledWith("wallet_create_recharge_order", {
      p_org: ORG,
      p_razorpay_order_id: "order_new",
      p_amount_paise: 100000,
      p_created_by: "user-1",
    });
    expect(result).toMatchObject({ razorpayOrderId: "order_new", keyId: "rzp_test_key", taxPaise: 15254, creditMicros: "847460000" });
  });
});

describe("verifyWalletRecharge", () => {
  const input = { organizationId: ORG, userId: "u", razorpayOrderId: "order_w", razorpayPaymentId: "pay_1", signature: "sig" };

  it("refuses a bad signature without asking Razorpay", async () => {
    signature.verifyOrderCheckoutSignature.mockReturnValue(false);
    const { db, rpc } = fakeDb();
    await expect(verifyWalletRecharge(db, input)).rejects.toThrow(/signature/);
    expect(razorpay.fetchRazorpayPayment).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a payment that belongs to another order", async () => {
    razorpay.fetchRazorpayPayment.mockResolvedValue({ order_id: "order_other", status: "captured", amount: 100000, currency: "INR" });
    const { db, rpc } = fakeDb();
    await expect(verifyWalletRecharge(db, input)).rejects.toThrow(/different order/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("waits for the webhook when the payment is only authorized", async () => {
    razorpay.fetchRazorpayPayment.mockResolvedValue({ order_id: "order_w", status: "authorized", amount: 100000, currency: "INR" });
    const { db, rpc } = fakeDb();
    expect(await verifyWalletRecharge(db, input)).toEqual({ status: "PENDING" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("credits a captured payment for this tenant only", async () => {
    razorpay.fetchRazorpayPayment.mockResolvedValue({ order_id: "order_w", status: "captured", amount: 100000, currency: "INR", method: "card" });
    const { db, rpc } = fakeDb({ status: "CREDITED", rechargeOrderId: "rc", walletId: "w", organizationId: ORG, walletStatus: "ACTIVE", balanceMicros: "847460000", reservedMicros: "0", availableMicros: "847460000" });
    const result = await verifyWalletRecharge(db, input);
    expect(rpc).toHaveBeenCalledWith("wallet_fulfill_recharge", {
      p_razorpay_order_id: "order_w",
      p_razorpay_payment_id: "pay_1",
      p_amount_paise: 100000,
      p_method: "card",
      p_expected_org: ORG,
    });
    expect(result).toEqual({ status: "CREDITED", duplicate: false, balanceMicros: "847460000", invoiceNumber: null });
    expect(rpc).toHaveBeenCalledWith("wallet_issue_recharge_invoice", { p_recharge_order_id: "rc" });
  });

  it("turns a wrong tenant or amount into an error", async () => {
    razorpay.fetchRazorpayPayment.mockResolvedValue({ order_id: "order_w", status: "captured", amount: 100000, currency: "INR" });
    await expect(verifyWalletRecharge(fakeDb({ status: "FORBIDDEN" }).db, input)).rejects.toThrow(/does not belong/);
    await expect(verifyWalletRecharge(fakeDb({ status: "AMOUNT_MISMATCH" }).db, input)).rejects.toThrow(/does not match/);
  });
});

describe("recoverPendingRecharges", () => {
  it("credits a captured payment the webhook never delivered", async () => {
    razorpay.fetchRazorpayOrderPayments.mockResolvedValue([
      { id: "pay_failed", status: "failed", amount: 100000, currency: "INR" },
      { id: "pay_ok", status: "captured", amount: 100000, currency: "INR", method: "upi" },
    ]);
    const { db, rpc, updates } = fakeDb({ status: "CREDITED" });
    expect(await recoverPendingRecharges(db)).toEqual({ checked: 1, credited: 1 });
    expect(rpc).toHaveBeenCalledWith("wallet_fulfill_recharge", expect.objectContaining({ p_razorpay_payment_id: "pay_ok", p_expected_org: ORG }));
    expect(updates[0]).toHaveProperty("last_checked_at");
  });

  it("only marks the order checked when nothing was captured", async () => {
    razorpay.fetchRazorpayOrderPayments.mockResolvedValue([]);
    const { db, rpc, updates } = fakeDb();
    expect(await recoverPendingRecharges(db)).toEqual({ checked: 1, credited: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });
});
