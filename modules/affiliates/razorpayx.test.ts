import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/razorpay/config", () => ({ getRazorpayCredentials: vi.fn(async () => ({ keyId: "rzp_fallback", secret: "fallback-secret" })) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { createPayout, ensureFundAccount, fetchPayout, payoutNarration, razorpayxConfigured, settlementEvent } from "./razorpayx";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RAZORPAYX_ACCOUNT_NUMBER", "2323230000000000");
  vi.stubEnv("RAZORPAYX_KEY_ID", "rzp_x");
  vi.stubEnv("RAZORPAYX_KEY_SECRET", "super-secret-value");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); fetchMock.mockReset(); });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("RazorpayX client", () => {
  it("is not configured without an account number", () => {
    vi.stubEnv("RAZORPAYX_ACCOUNT_NUMBER", "");
    expect(razorpayxConfigured()).toBe(false);
  });

  it("creates a UPI payout with the idempotency header and account number", async () => {
    fetchMock.mockResolvedValue(ok({ id: "pout_1", status: "processing", utr: null }));
    const payout = await createPayout({ fundAccountId: "fa_1", amountPaise: 425000, idempotencyKey: "req-1", narration: "PostBus partner Dec-2026!", referenceId: "req-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/payouts");
    expect(init.headers["X-Payout-Idempotency"]).toBe("req-1");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ account_number: "2323230000000000", amount: 425000, currency: "INR", mode: "UPI", purpose: "payout", fund_account_id: "fa_1" });
    expect(body.narration).toBe("PostBus partner Dec2026");
    expect(payout).toEqual({ id: "pout_1", status: "processing", utr: null, failureReason: null });
  });

  it("refuses to send without an account number", async () => {
    vi.stubEnv("RAZORPAYX_ACCOUNT_NUMBER", "");
    await expect(createPayout({ fundAccountId: "fa_1", amountPaise: 100, idempotencyKey: "k", narration: "x", referenceId: "k" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the secret in errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { description: "bad key super-secret-value", code: "BAD_REQUEST_ERROR" } }) });
    await expect(fetchPayout("pout_9")).rejects.toThrow(/\[redacted\]/);
  });

  it("creates a contact then a VPA fund account", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "cont_1" })).mockResolvedValueOnce(ok({ id: "fa_9" }));
    expect(await ensureFundAccount({ name: "Ravi", upi: "ravi@okicici", referenceId: "acct-1" })).toEqual({ contactId: "cont_1", fundAccountId: "fa_9" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ contact_id: "cont_1", account_type: "vpa", vpa: { address: "ravi@okicici" } });
  });

  it("maps provider statuses and reads failure reasons", async () => {
    expect(settlementEvent("processed")).toBe("processed");
    expect(settlementEvent("queued")).toBeNull();
    fetchMock.mockResolvedValue(ok({ id: "pout_2", status: "failed", status_details: { description: "Beneficiary VPA invalid" } }));
    expect((await fetchPayout("pout_2")).failureReason).toBe("Beneficiary VPA invalid");
    await expect(fetchPayout("../x")).rejects.toThrow();
    expect(payoutNarration("@@@")).toBe("PostBus Partner payout");
  });
});
