import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CASHFREE_API_VERSION,
  CashfreeAuthError,
  CashfreeConflictError,
  CashfreeForbiddenError,
  CashfreeUnavailableError,
  cashfreeAmountToPaise,
  merchantCashfreeClient,
  paiseToCashfreeAmount,
} from "./client";
import { cashfreeClientIdHint, cashfreeFingerprint, validateCashfreeCredentials } from "./credentials";
import { attemptStatusOf, cashfreeIdempotencyKey, cashfreeOrderIdFor, cashfreePhone, safeCashfreeReturnUrl } from "./payments";
import { cashfreeWebhookSignature, verifyCashfreeWebhookSignature } from "./webhook";

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("cashfree client", () => {
  it("never mixes environments: TEST → sandbox, LIVE → production, with the documented headers", async () => {
    const sandbox = fetchReturning(404, { message: "order not found", code: "order_not_found" });
    await merchantCashfreeClient({ clientId: "TESTabc123", clientSecret: "cfsk_ma_test_xyz123456789", mode: "TEST" }, sandbox as never).verify();
    const [url, init] = sandbox.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders/postbus_credential_check");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "x-client-id": "TESTabc123", "x-client-secret": "cfsk_ma_test_xyz123456789", "x-api-version": CASHFREE_API_VERSION });

    const production = fetchReturning(404, {});
    await merchantCashfreeClient({ clientId: "LIVEabc123", clientSecret: "cfsk_ma_prod_xyz123456789", mode: "LIVE" }, production as never).verify();
    expect((production.mock.calls[0] as unknown as [string])[0]).toBe("https://api.cashfree.com/pg/orders/postbus_credential_check");
    expect(CASHFREE_API_VERSION).toBe("2026-01-01");
  });

  it("creates orders in rupees (not paise) with an idempotency key and no secrets in the body", async () => {
    const fetchImpl = fetchReturning(200, { order_id: "pb_1", order_amount: 499, order_currency: "INR", order_status: "ACTIVE", payment_session_id: "session_x" });
    const client = merchantCashfreeClient({ clientId: "TESTabc123", clientSecret: "cfsk_ma_test_xyz123456789", mode: "TEST" }, fetchImpl as never);
    await client.createOrder({
      orderId: "pb_1",
      amountPaise: 49950,
      customer: { id: "pbcust", phone: "9876543210", name: "Al" },
      notifyUrl: "https://app.example/api/webhooks/merchant/cashfree/abc",
      returnUrl: null,
      note: "PostBus order WA-1",
      tags: { postbus_order_id: "o1" },
      idempotencyKey: "11111111-2222-4333-a444-555555555555",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ order_id: "pb_1", order_amount: 499.5, order_currency: "INR", customer_details: { customer_id: "pbcust", customer_phone: "9876543210" } });
    // Names shorter than Cashfree's 3-character minimum are omitted rather than rejected.
    expect(body.customer_details.customer_name).toBeUndefined();
    expect(body.order_meta).toEqual({ notify_url: "https://app.example/api/webhooks/merchant/cashfree/abc" });
    expect(String(init.body)).not.toContain("cfsk_");
    expect(init.headers).toMatchObject({ "x-idempotency-key": "11111111-2222-4333-a444-555555555555" });
  });

  it("maps Cashfree errors to specific, safe errors", async () => {
    const creds = { clientId: "TESTabc123", clientSecret: "cfsk_ma_test_xyz123456789", mode: "TEST" as const };
    await expect(merchantCashfreeClient(creds, fetchReturning(401, { message: "authentication Failed" }) as never).verify()).rejects.toBeInstanceOf(CashfreeAuthError);
    await expect(merchantCashfreeClient(creds, fetchReturning(403, { message: "feature not activated" }) as never).verify()).rejects.toBeInstanceOf(CashfreeForbiddenError);
    await expect(merchantCashfreeClient(creds, fetchReturning(409, { code: "order_already_exists" }) as never).getOrder("x")).rejects.toBeInstanceOf(CashfreeConflictError);
    await expect(merchantCashfreeClient(creds, fetchReturning(503, {}) as never).getOrder("x")).rejects.toBeInstanceOf(CashfreeUnavailableError);
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    await expect(merchantCashfreeClient(creds, timeout as never).verify()).rejects.toThrow(/did not respond in time/);
    // A provider message that echoes key material is never passed through.
    await expect(merchantCashfreeClient(creds, fetchReturning(400, { message: "bad x-client-secret cfsk_ma_test_xyz" }) as never).getOrder("x")).rejects.toThrow(
      /Cashfree request failed \(400\)/
    );
  });

  it("refuses to exist without the merchant's own credentials", () => {
    expect(() => merchantCashfreeClient({ clientId: "", clientSecret: "", mode: "TEST" })).toThrow(/not configured/);
  });

  it("converts money exactly between paise and rupees", () => {
    expect(paiseToCashfreeAmount(49900)).toBe(499);
    expect(paiseToCashfreeAmount(10015)).toBe(100.15);
    expect(paiseToCashfreeAmount(1)).toBe(0.01);
    expect(() => paiseToCashfreeAmount(0)).toThrow();
    expect(() => paiseToCashfreeAmount(1.5)).toThrow();
    expect(cashfreeAmountToPaise(170.0)).toBe(17000);
    expect(cashfreeAmountToPaise("1234.56")).toBe(123456);
    expect(cashfreeAmountToPaise(0.1 + 0.2)).toBe(30);
    expect(Number.isNaN(cashfreeAmountToPaise(null))).toBe(true);
  });
});

describe("cashfree webhook signature", () => {
  it("is Base64 HMAC-SHA256 of timestamp + raw body with the client secret", () => {
    const raw = '{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"payment":{"payment_amount":170.00}}}';
    const expected = createHmac("sha256", "secret_key_value").update(`1617695238078${raw}`).digest("base64");
    expect(cashfreeWebhookSignature("1617695238078", raw, "secret_key_value")).toBe(expected);
    expect(verifyCashfreeWebhookSignature({ timestamp: "1617695238078", rawBody: raw, signature: expected, clientSecret: "secret_key_value" })).toBe(true);
    expect(verifyCashfreeWebhookSignature({ timestamp: "1617695238079", rawBody: raw, signature: expected, clientSecret: "secret_key_value" })).toBe(false);
    expect(verifyCashfreeWebhookSignature({ timestamp: "1617695238078", rawBody: raw.replace("170.00", "170"), signature: expected, clientSecret: "secret_key_value" })).toBe(false);
    expect(verifyCashfreeWebhookSignature({ timestamp: "1617695238078", rawBody: raw, signature: expected, clientSecret: "other" })).toBe(false);
    expect(verifyCashfreeWebhookSignature({ timestamp: "", rawBody: raw, signature: expected, clientSecret: "secret_key_value" })).toBe(false);
  });
});

describe("cashfree helpers", () => {
  it("validates credentials and environment markers", () => {
    expect(validateCashfreeCredentials({ clientId: " TESTabc123 ", clientSecret: " cfsk_ma_test_abcdefghijkl ", mode: "TEST" })).toEqual({
      clientId: "TESTabc123",
      clientSecret: "cfsk_ma_test_abcdefghijkl",
    });
    expect(() => validateCashfreeCredentials({ clientId: "TESTabc123", clientSecret: "cfsk_ma_test_abcdefghijkl", mode: "LIVE" })).toThrow(/Sandbox/);
    expect(() => validateCashfreeCredentials({ clientId: "abc123", clientSecret: "cfsk_ma_prod_abcdefghijkl", mode: "TEST" })).toThrow(/Production secret/);
    expect(() => validateCashfreeCredentials({ clientId: "a b", clientSecret: "cfsk_ma_test_abcdefghijkl", mode: "TEST" })).toThrow(/Client ID/);
    expect(cashfreeClientIdHint("TESTabcd1234wxyz")).toBe("TEST••••wxyz");
    expect(cashfreeFingerprint("abc", "TEST")).not.toBe(cashfreeFingerprint("abc", "LIVE"));
  });

  it("builds Cashfree-compatible identifiers", () => {
    const id = cashfreeOrderIdFor("62000000-0000-4000-8000-000000000001");
    expect(id).toMatch(/^[A-Za-z0-9_-]{3,45}$/);
    expect(cashfreeIdempotencyKey("o", "x")).toBe(cashfreeIdempotencyKey("o", "x"));
    expect(cashfreeIdempotencyKey("o", "x")).not.toBe(cashfreeIdempotencyKey("o", "y"));
    expect(cashfreePhone("+91 98765-43210")).toBe("9876543210");
    expect(cashfreePhone("09876543210")).toBe("9876543210");
    expect(cashfreePhone("12345")).toBeNull();
  });

  it("sanitises the return URL", () => {
    expect(safeCashfreeReturnUrl("https://shop.example/store/acme?token=abc#x")).toBe("https://shop.example/store/acme?postbus_payment=return");
    expect(safeCashfreeReturnUrl("http://localhost:3000/s/acme")).toBe("http://localhost:3000/s/acme?postbus_payment=return");
    expect(safeCashfreeReturnUrl("http://evil.example/")).toBeNull();
    expect(safeCashfreeReturnUrl("javascript:alert(1)")).toBeNull();
    expect(safeCashfreeReturnUrl("https://user:pw@shop.example/")).toBeNull();
    expect(safeCashfreeReturnUrl(`https://shop.example/${"a".repeat(260)}`)).toBeNull();
  });

  it("maps every documented Cashfree payment status", () => {
    expect(attemptStatusOf({ payment_status: "SUCCESS" })).toBe("PAID");
    expect(attemptStatusOf({ payment_status: "PENDING" })).toBe("PROCESSING");
    expect(attemptStatusOf({ payment_status: "FAILED" })).toBe("FAILED");
    expect(attemptStatusOf({ payment_status: "VOID" })).toBe("FAILED");
    expect(attemptStatusOf({ payment_status: "USER_DROPPED" })).toBe("CANCELLED");
    expect(attemptStatusOf({ payment_status: "CANCELLED" })).toBe("CANCELLED");
    expect(attemptStatusOf({ payment_status: "NOT_ATTEMPTED" })).toBeNull();
  });
});
