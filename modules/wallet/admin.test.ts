import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({ refund: vi.fn(), audit: vi.fn() }));
vi.mock("@/modules/razorpay/client", () => ({ refundRazorpayPayment: (...a: unknown[]) => h.refund(...a) }));
vi.mock("@/modules/billing/audit", () => ({ writeBillingAudit: (...a: unknown[]) => h.audit(...a) }));

import { handleAdminWallet } from "@/modules/wallet/admin";

const ORG = "30000000-0000-4000-8000-000000000001";
const ctx = { userId: "10000000-0000-4000-8000-000000000001", email: "admin@test" };
const PIN = "246810";

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/admin/wallet/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function fakeDb(options: { rpc?: Record<string, unknown>; tables?: Record<string, unknown>; counts?: Record<string, number> } = {}) {
  const rpc = vi.fn(async (fn: string) => ({ data: options.rpc?.[fn] ?? { status: "OK" }, error: null }));
  const updates: Array<{ table: string; values: unknown }> = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) {
          const counted = { eq: () => counted, is: async () => ({ count: options.counts?.[table] ?? 0 }) };
          return counted;
        }
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      maybeSingle: async () => ({ data: options.tables?.[table] ?? null, error: null }),
      update: (values: unknown) => {
        updates.push({ table, values });
        return { eq: async () => ({ error: null }) };
      },
    });
    return chain;
  });
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, updates };
}

beforeEach(() => vi.stubEnv("ADMIN_ACCOUNT_ACTION_PIN", PIN));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const adjust = { kind: "PROMO", amountRupees: "250.50", reason: "Diwali promotional credit", idempotencyKey: "60000000-0000-4000-8000-000000000001" };

describe("admin wallet actions", () => {
  it("refuses a wrong PIN before touching the wallet", async () => {
    const { db, rpc } = fakeDb();
    await expect(handleAdminWallet(req("POST", `wallets/${ORG}/adjust`, { ...adjust, pin: "000000" }), db, ctx, ["wallets", ORG, "adjust"], "POST")).rejects.toThrow(/PIN/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("needs a real reason", async () => {
    const { db } = fakeDb();
    await expect(
      handleAdminWallet(req("POST", `wallets/${ORG}/adjust`, { ...adjust, reason: "x", pin: PIN }), db, ctx, ["wallets", ORG, "adjust"], "POST")
    ).rejects.toThrow();
  });

  it("converts rupees to exact micros and records who did it", async () => {
    const { db, rpc } = fakeDb({ rpc: { wallet_admin_adjust: { status: "ADJUSTED", adjustmentId: "a1", walletId: "w", organizationId: ORG, walletStatus: "ACTIVE", balanceMicros: "250500000", reservedMicros: "0", availableMicros: "250500000" } } });
    const result = await handleAdminWallet(req("POST", `wallets/${ORG}/adjust`, { ...adjust, pin: PIN }), db, ctx, ["wallets", ORG, "adjust"], "POST");
    expect(rpc).toHaveBeenCalledWith("wallet_admin_adjust", expect.objectContaining({
      p_org: ORG,
      p_kind: "PROMO",
      p_amount_micros: "250500000",
      p_admin_user_id: ctx.userId,
      p_admin_email: "admin@test",
    }));
    expect(result).toEqual({ status: "ADJUSTED", balanceMicros: "250500000" });
    expect(h.audit).toHaveBeenCalledWith(db, expect.objectContaining({ actorId: ctx.userId, actorType: "SUPER_ADMIN", action: "wallet.adjust.promo" }));
  });

  it("will not turn WhatsApp billing on without a Utility rate", async () => {
    const { db, updates } = fakeDb({ counts: { wallet_pricing_rules: 0 } });
    await expect(
      handleAdminWallet(req("PATCH", "settings", { pin: PIN, reason: "Go live with WhatsApp billing", whatsappBillingEnabled: true }), db, ctx, ["settings"], "PATCH")
    ).rejects.toThrow(/Utility rate/);
    expect(updates).toHaveLength(0);
  });

  it("saves settings in paise, basis points and micros", async () => {
    const { db, updates } = fakeDb({ counts: { wallet_pricing_rules: 1 } });
    await handleAdminWallet(
      req("PATCH", "settings", {
        pin: PIN,
        reason: "Update recharge limits and GST",
        rechargeMinRupees: 200,
        rechargePresetsRupees: [500, 200, 500],
        gstRatePercent: 18,
        signupPromoRupees: "50",
        whatsappBillingEnabled: true,
      }),
      db,
      ctx,
      ["settings"],
      "PATCH"
    );
    expect(updates[0]).toEqual({
      table: "platform_settings",
      values: {
        wallet_recharge_min_paise: 20000,
        wallet_recharge_presets_paise: [20000, 50000],
        wallet_gst_rate_bps: 1800,
        wallet_signup_promo_micros: "50000000",
        wallet_whatsapp_billing_enabled: true,
      },
    });
  });

  it("prices a rule from rupees and percentages", async () => {
    const { db, rpc } = fakeDb({ rpc: { wallet_set_pricing_rule: { status: "OK", ruleId: "r1" } } });
    await handleAdminWallet(
      req("POST", "pricing", { pin: PIN, service: "whatsapp", whatsappCategory: "UTILITY", countryCode: "in", perUnitRupees: "0.115", markupPercent: 20 }),
      db,
      ctx,
      ["pricing"],
      "POST"
    );
    expect(rpc).toHaveBeenCalledWith("wallet_set_pricing_rule", {
      p_admin_user_id: ctx.userId,
      p_rule: expect.objectContaining({
        service: "whatsapp",
        whatsappCategory: "UTILITY",
        countryCode: "IN",
        perUnitMicros: "115000",
        markupBps: 2000,
        aiFeature: "*",
        per1kInputTokensMicros: "0",
      }),
    });
  });

  it("refunds no more than is left on a recharge", async () => {
    const order = { id: "60000000-0000-4000-8000-000000000002", razorpay_payment_id: "pay_1", amount_paise: 100000, refunded_paise: 60000, status: "PARTIALLY_REFUNDED" };
    const { db } = fakeDb({ tables: { wallet_recharge_orders: order } });
    const body = { pin: PIN, reason: "Customer asked for money back", rechargeOrderId: order.id };
    await expect(
      handleAdminWallet(req("POST", `wallets/${ORG}/refund-recharge`, { ...body, amountRupees: "400.01" }), db, ctx, ["wallets", ORG, "refund-recharge"], "POST")
    ).rejects.toThrow(/At most ₹400.00/);
    h.refund.mockResolvedValue({ id: "rfnd_1" });
    const result = await handleAdminWallet(req("POST", `wallets/${ORG}/refund-recharge`, { ...body, amountRupees: "400" }), db, ctx, ["wallets", ORG, "refund-recharge"], "POST");
    expect(h.refund).toHaveBeenCalledWith("pay_1", 40000);
    expect(result).toMatchObject({ status: "REFUND_REQUESTED", razorpayRefundId: "rfnd_1" });
  });
});
