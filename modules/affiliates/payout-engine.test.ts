import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/security/crypto", () => ({ decryptSecret: () => JSON.stringify({ name: "Ravi", upi: "ravi@okicici" }) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { istDate, runPayoutEngine, type PayoutClient } from "./payout-engine";

type Tables = Record<string, unknown>;
function fakeDb(tables: Tables, rpc: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { rpc: [string, Record<string, unknown>][]; upserts: unknown[] } = { rpc: [], upserts: [] };
  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const filters: [string, unknown][] = [];
      for (const m of ["select", "order", "limit", "lt", "is"]) builder[m] = () => builder;
      builder.eq = (k: string, v: unknown) => { filters.push([k, v]); return builder; };
      const resolve = () => {
        const data = tables[table];
        return typeof data === "function" ? (data as (f: [string, unknown][]) => unknown)(filters) : data;
      };
      builder.single = async () => ({ data: resolve(), error: null });
      builder.maybeSingle = builder.single;
      builder.upsert = async (row: unknown) => { calls.upserts.push(row); return { data: null, error: null }; };
      builder.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: resolve(), error: null }).then(ok);
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) { calls.rpc.push([name, args]); return { data: rpc(name, args), error: null }; },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

function client(over: Partial<PayoutClient> = {}): PayoutClient {
  return {
    razorpayxConfigured: () => true,
    ensureFundAccount: vi.fn(async () => ({ contactId: "cont_1", fundAccountId: "fa_new" })),
    createPayout: vi.fn(async () => ({ id: "pout_1", status: "processing", utr: null, failureReason: null })),
    fetchPayout: vi.fn(async () => ({ id: "pout_old", status: "processed", utr: "UTR77", failureReason: null })),
    settlementEvent: (s: string) => (["processed", "failed", "rejected", "cancelled", "reversed"].includes(s) ? (s as "processed") : null),
    ...over,
  };
}

const approved = { id: "req-1", affiliate_id: "aff-1", account_id: "acct-1", amount_paise: 425000 };
const dec5 = new Date("2026-12-05T03:00:00Z"); // 08:30 IST on the 5th

beforeEach(() => { vi.stubEnv("POSTBUS_AFFILIATES_ENABLED", "true"); vi.stubEnv("POSTBUS_AFFILIATE_PAYOUTS_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());

describe("payout engine", () => {
  it("does nothing when payouts are disabled", async () => {
    vi.stubEnv("POSTBUS_AFFILIATE_PAYOUTS_ENABLED", "false");
    const c = client();
    const { db, calls } = fakeDb({}, () => null);
    expect((await runPayoutEngine(db, { now: dec5, client: c })).skipped).toBe("PAYOUTS_DISABLED");
    expect(calls.rpc).toHaveLength(0);
    expect(c.createPayout).not.toHaveBeenCalled();
  });

  it("polls in-flight payouts even when automation is off, but sends nothing", async () => {
    const c = client();
    const { db, calls } = fakeDb({
      affiliate_payout_requests: (f: [string, unknown][]) => (f.some(([k, v]) => k === "status" && v === "PROCESSING") ? [{ id: "r0", provider_payout_id: "pout_old" }] : [approved]),
      affiliate_settings: { auto_payout_enabled: false, auto_payout_day: 5 },
    }, () => "PAID");
    const result = await runPayoutEngine(db, { now: dec5, client: c });
    expect(result).toMatchObject({ polled: 1, sent: 0, skipped: "AUTO_PAYOUT_OFF" });
    expect(calls.rpc).toEqual([["affiliate_provider_settle", { p_provider_id: "pout_old", p_event: "processed", p_utr: "UTR77", p_reason: "" }]]);
    expect(c.createPayout).not.toHaveBeenCalled();
  });

  it("does not create monthly requests before the payout day (IST)", async () => {
    const { db, calls } = fakeDb({ affiliate_payout_requests: [], affiliate_settings: { auto_payout_enabled: true, auto_payout_day: 5 } }, () => 0);
    await runPayoutEngine(db, { now: new Date("2026-12-04T17:00:00Z"), client: client() }); // 22:30 IST on the 4th
    expect(calls.rpc.map(([n]) => n)).not.toContain("affiliate_auto_request_payouts");
    await runPayoutEngine(db, { now: new Date("2026-12-04T19:00:00Z"), client: client() }); // 00:30 IST on the 5th
    expect(calls.rpc).toContainEqual(["affiliate_auto_request_payouts", { p_month: "2026-12-01" }]);
  });

  it("sends approved payouts with the request id as idempotency key and marks them processing", async () => {
    const c = client();
    const { db, calls } = fakeDb({
      affiliate_payout_requests: (f: [string, unknown][]) => (f.some(([, v]) => v === "PROCESSING") ? [] : [approved]),
      affiliate_settings: { auto_payout_enabled: true, auto_payout_day: 5 },
      affiliate_razorpay_accounts: null,
      affiliate_payout_accounts: { id: "acct-1", encrypted_details: "enc" },
    }, (name) => (name === "affiliate_auto_request_payouts" ? 1 : null));
    const result = await runPayoutEngine(db, { now: dec5, client: c });
    expect(result).toMatchObject({ created: 1, sent: 1, failed: 0 });
    expect(c.ensureFundAccount).toHaveBeenCalledWith({ name: "Ravi", upi: "ravi@okicici", referenceId: "acct-1" });
    expect(c.createPayout).toHaveBeenCalledWith(expect.objectContaining({ fundAccountId: "fa_new", amountPaise: 425000, idempotencyKey: "req-1" }));
    expect(calls.upserts).toEqual([{ account_id: "acct-1", contact_id: "cont_1", fund_account_id: "fa_new" }]);
    expect(calls.rpc).toContainEqual(["affiliate_mark_processing", { p_id: "req-1", p_provider_id: "pout_1", p_provider_status: "processing" }]);
  });

  it("reuses a cached fund account and records send failures for retry", async () => {
    const c = client({ createPayout: vi.fn(async () => { throw new Error("Insufficient balance"); }) });
    const { db, calls } = fakeDb({
      affiliate_payout_requests: (f: [string, unknown][]) => (f.some(([, v]) => v === "PROCESSING") ? [] : [approved]),
      affiliate_settings: { auto_payout_enabled: true, auto_payout_day: 28 },
      affiliate_razorpay_accounts: { fund_account_id: "fa_cached" },
    }, (name) => (name === "affiliate_record_send_failure" ? "FAILED" : null));
    const result = await runPayoutEngine(db, { now: dec5, client: c });
    expect(c.ensureFundAccount).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(calls.rpc).toContainEqual(["affiliate_record_send_failure", { p_id: "req-1", p_reason: "Insufficient balance", p_max_attempts: 3 }]);
  });

  it("computes India dates across the UTC midnight boundary", () => {
    expect(istDate(new Date("2026-11-30T19:00:00Z"))).toEqual({ year: 2026, month: 12, day: 1 });
  });
});
