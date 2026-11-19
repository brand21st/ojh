import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyIdHint, modeOfKeyId, openSecret, sealSecret, validateRazorpayKeys, validateWebhookSecret } from "./credentials";
import { merchantRazorpayClient } from "./razorpay";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const MERCHANT_CODE = [
  ...files("modules/merchant-payments").filter((path) => !path.includes(".test.") && !path.includes(".testkit.")),
  "lib/api/v1/merchant-payments.ts",
  "app/api/webhooks/merchant/razorpay/[token]/route.ts",
  "app/api/v1/public/store/payment/route.ts",
  "app/api/cron/merchant-payments/route.ts",
];

const PLATFORM_BILLING_CODE = [
  "app/api/webhooks/razorpay/route.ts",
  "app/api/cron/billing/route.ts",
  "lib/api/v1/billing.ts",
  ...files("modules/billing").filter((path) => !path.includes(".test.")),
  "modules/razorpay/client.ts",
  "modules/razorpay/config.ts",
  "modules/razorpay/admin-settings.ts",
];

describe("merchant payments stay separate from PostBus SaaS billing", () => {
  it("merchant code never loads platform Razorpay credentials or billing modules", () => {
    for (const path of MERCHANT_CODE) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/@\/modules\/razorpay\/(config|client|admin-settings)/);
      expect(source, path).not.toMatch(/@\/modules\/billing\//);
      expect(source, path).not.toMatch(/@\/lib\/api\/v1\/billing/);
      expect(source, path).not.toMatch(/platform_settings|razorpay_webhook_events|from\("payments"\)|\.from\("subscriptions"\)/);
      expect(source, path).not.toMatch(/env\.razorpay|RAZORPAY_KEY|RAZORPAY_WEBHOOK_SECRET/);
    }
  });

  it("platform billing code never reaches merchant payment code or tables", () => {
    for (const path of PLATFORM_BILLING_CODE) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/merchant-payments|merchant_storefront_payments|merchant_payment_/);
    }
  });

  it("the merchant client refuses to exist without the merchant's own keys", () => {
    expect(() => merchantRazorpayClient({ keyId: "", keySecret: "" })).toThrow(/not configured/);
  });
});

describe("merchant credential handling", () => {
  it("reads the mode from the key prefix and enforces it", () => {
    expect(modeOfKeyId("rzp_test_ABCdef123456")).toBe("TEST");
    expect(modeOfKeyId("rzp_live_ABCdef123456")).toBe("LIVE");
    expect(modeOfKeyId("rzp_ABCdef123456")).toBeNull();
    expect(validateRazorpayKeys({ keyId: " rzp_live_ABCdef123456 ", keySecret: " sec_ret12345 ", mode: "LIVE" })).toEqual({
      keyId: "rzp_live_ABCdef123456",
      keySecret: "sec_ret12345",
    });
    expect(() => validateRazorpayKeys({ keyId: "rzp_live_ABCdef123456", keySecret: "secret1234", mode: "TEST" })).toThrow(/Live Key ID/);
    expect(() => validateRazorpayKeys({ keyId: "rzp_test_ABCdef123456", keySecret: "short", mode: "TEST" })).toThrow(/Key Secret/);
    expect(() => validateWebhookSecret("has space here")).toThrow();
  });

  it("masks the Key ID and round-trips encrypted values without exposing them", () => {
    expect(keyIdHint("rzp_test_ABCdef123456")).toBe("rzp_test_••••3456");
    const sealed = sealSecret("secret-value-123");
    expect(sealed).not.toContain("secret-value-123");
    expect(openSecret(sealed)).toBe("secret-value-123");
    expect(openSecret("tampered.value.here")).toBeNull();
    expect(openSecret(null)).toBeNull();
  });
});
