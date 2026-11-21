import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleWalletRazorpayEvent } from "@/modules/wallet/webhooks";
import { processRazorpayEvent } from "@/modules/billing/webhooks";

type Call = { fn: string; args: Record<string, unknown> };

/** Just enough of a Supabase client: one recharge order lookup and RPC capture. */
function fakeDb(options: {
  recharge?: { razorpay_order_id?: string; razorpay_payment_id?: string } | null;
  lookupError?: { code: string; message: string };
  rpcResult?: Record<string, unknown>;
}) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const db = {
    from(table: string) {
      tables.push(table);
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return chain;
        },
        maybeSingle: async () => {
          if (table !== "wallet_recharge_orders") return { data: null, error: null };
          if (options.lookupError) return { data: null, error: options.lookupError };
          const row = options.recharge;
          const match =
            row &&
            Object.entries(filters).every(([column, value]) => (row as Record<string, string>)[column] === value);
          return { data: match ? { id: "rc-1" } : null, error: null };
        },
      };
      return chain;
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: options.rpcResult ?? { status: "CREDITED" }, error: null };
    }),
  };
  return { db: db as unknown as SupabaseClient, calls, tables };
}

const captured = (overrides: Record<string, unknown> = {}) => ({
  event: "payment.captured",
  payload: {
    payment: {
      entity: { id: "pay_1", order_id: "order_w", amount: 100000, currency: "INR", status: "captured", method: "upi", ...overrides },
    },
  },
});

describe("handleWalletRazorpayEvent", () => {
  it("credits a captured wallet payment with the amount Razorpay reports", async () => {
    const { db, calls } = fakeDb({ recharge: { razorpay_order_id: "order_w" } });
    const result = await handleWalletRazorpayEvent(db, captured());
    expect(result).toMatchObject({ processed: true, wallet: true, status: "CREDITED" });
    expect(calls).toEqual([
      {
        fn: "wallet_fulfill_recharge",
        args: { p_razorpay_order_id: "order_w", p_razorpay_payment_id: "pay_1", p_amount_paise: 100000, p_method: "upi", p_expected_org: null },
      },
    ]);
  });

  it("leaves payments that are not wallet recharges alone", async () => {
    const { db, calls } = fakeDb({ recharge: null });
    expect(await handleWalletRazorpayEvent(db, captured())).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("treats a missing wallet table as not a wallet event", async () => {
    const { db } = fakeDb({ lookupError: { code: "PGRST205", message: "missing" } });
    expect(await handleWalletRazorpayEvent(db, captured())).toBeNull();
  });

  it("fails loudly on other lookup errors so Razorpay retries", async () => {
    const { db } = fakeDb({ lookupError: { code: "57014", message: "timeout" } });
    await expect(handleWalletRazorpayEvent(db, captured())).rejects.toThrow(/lookup failed/);
  });

  it("ignores non-INR and not-yet-captured payments without crediting", async () => {
    const usd = fakeDb({ recharge: { razorpay_order_id: "order_w" } });
    expect(await handleWalletRazorpayEvent(usd.db, captured({ currency: "USD" }))).toMatchObject({ ignored: true });
    const authorized = fakeDb({ recharge: { razorpay_order_id: "order_w" } });
    expect(await handleWalletRazorpayEvent(authorized.db, captured({ status: "authorized" }))).toMatchObject({ ignored: true });
    expect([...usd.calls, ...authorized.calls]).toHaveLength(0);
  });

  it("reports an amount mismatch as ignored", async () => {
    const { db } = fakeDb({ recharge: { razorpay_order_id: "order_w" }, rpcResult: { status: "AMOUNT_MISMATCH" } });
    expect(await handleWalletRazorpayEvent(db, captured({ amount: 1 }))).toMatchObject({ ignored: true });
  });

  it("marks a failed payment and reverses a processed refund", async () => {
    const failed = fakeDb({ recharge: { razorpay_order_id: "order_w" }, rpcResult: { status: "FAILED" } });
    await handleWalletRazorpayEvent(failed.db, {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_x", order_id: "order_w", error_description: "Card declined" } } },
    });
    expect(failed.calls[0]).toEqual({
      fn: "wallet_mark_recharge_failed",
      args: { p_razorpay_order_id: "order_w", p_reason: "Card declined" },
    });

    const refund = fakeDb({ recharge: { razorpay_payment_id: "pay_1" }, rpcResult: { status: "REVERSED" } });
    await handleWalletRazorpayEvent(refund.db, {
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 5000 } } },
    });
    expect(refund.calls[0]).toEqual({
      fn: "wallet_reverse_recharge",
      args: { p_razorpay_payment_id: "pay_1", p_refund_id: "rfnd_1", p_refund_paise: 5000 },
    });
  });

  it("does nothing for events it does not own", async () => {
    const { db, tables } = fakeDb({ recharge: { razorpay_order_id: "order_w" } });
    expect(await handleWalletRazorpayEvent(db, { event: "subscription.charged", payload: {} })).toBeNull();
    expect(tables).toHaveLength(0);
  });
});

describe("processRazorpayEvent wallet routing", () => {
  it("handles a wallet recharge before any subscription lookup", async () => {
    const { db, tables, calls } = fakeDb({ recharge: { razorpay_order_id: "order_w" } });
    const result = await processRazorpayEvent(db, captured(), "evt_1");
    expect(result).toMatchObject({ wallet: true, processed: true });
    expect(tables).toEqual(["wallet_recharge_orders"]);
    expect(calls.map((c) => c.fn)).toEqual(["wallet_fulfill_recharge"]);
  });
});
