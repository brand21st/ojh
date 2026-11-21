import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ hasAdminClient: () => true, createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { POST } from "./route";

const secret = "whsec_test";
function hook(body: unknown, sign = secret) {
  const raw = JSON.stringify(body);
  return new NextRequest("https://postbus.test/api/webhooks/razorpayx", {
    method: "POST",
    body: raw,
    headers: { "x-razorpay-signature": createHmac("sha256", sign).update(raw).digest("hex") },
  });
}
const payout = (event: string, entity: Record<string, unknown>) => ({ event, payload: { payout: { entity: { id: "pout_1", ...entity } } } });

beforeEach(() => { vi.stubEnv("RAZORPAYX_WEBHOOK_SECRET", secret); rpc.mockResolvedValue({ data: "PAID", error: null }); });
afterEach(() => { vi.unstubAllEnvs(); rpc.mockReset(); });

describe("RazorpayX payout webhook", () => {
  it("rejects a bad signature without touching the database", async () => {
    const res = await POST(hook(payout("payout.processed", { status: "processed" }), "wrong"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("settles processed payouts with the UTR", async () => {
    const res = await POST(hook(payout("payout.processed", { status: "processed", utr: "UTR555" })));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("affiliate_provider_settle", { p_provider_id: "pout_1", p_event: "processed", p_utr: "UTR555", p_reason: "" });
  });

  it("uses the entity status for payout.updated and passes failure reasons", async () => {
    await POST(hook(payout("payout.updated", { status: "failed", status_details: { description: "VPA invalid" } })));
    expect(rpc).toHaveBeenCalledWith("affiliate_provider_settle", expect.objectContaining({ p_event: "failed", p_reason: "VPA invalid" }));
  });

  it("ignores in-flight and unrelated events", async () => {
    await POST(hook(payout("payout.queued", { status: "queued" })));
    await POST(hook({ event: "payment.captured", payload: {} }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 500 so Razorpay retries when recording fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    expect((await POST(hook(payout("payout.processed", { status: "processed" })))).status).toBe(500);
  });
});
