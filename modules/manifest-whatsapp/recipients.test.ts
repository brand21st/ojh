import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import {
  assertAutoSendRecipients,
  autoIdempotencyKey,
  normalizeWhatsAppRecipients,
  recipientE164List,
  resolveManifestWhatsAppRecipients,
} from "@/modules/manifest-whatsapp/recipients";

describe("manifest WhatsApp recipients", () => {
  it("normalizes Indian numbers to E.164 and drops duplicates", () => {
    const recipients = normalizeWhatsAppRecipients([
      { phone: "9876543210", name: " Office " },
      { phone: "+91 98765 43210", name: "Office" },
      { phone: "919876543210", name: "Second" },
    ]);
    expect(recipients).toEqual([{ e164: "+919876543210", name: "Office" }]);
  });

  it("rejects an invalid Indian mobile", () => {
    expect(() => normalizeWhatsAppRecipients(["12345"])).toThrow(AppError);
  });

  it("requires at least one recipient before auto-send", () => {
    expect(() => assertAutoSendRecipients([])).toThrow(/WhatsApp number/);
  });

  it("uses office overrides when present, including an empty list", () => {
    const settings = {
      recipients: [{ e164: "+919876543210", name: "Default" }],
      officeOverrides: { "22660454": [] as { e164: string; name: string | null }[] },
    };
    expect(resolveManifestWhatsAppRecipients(settings, "22660454")).toEqual({
      recipients: [],
      source: "office",
    });
    expect(resolveManifestWhatsAppRecipients(settings, "other").recipients[0]?.e164).toBe("+919876543210");
  });

  it("builds a stable auto idempotency key per recipient and file", () => {
    expect(autoIdempotencyKey("org", "m1", "2026-11-17T00:00:00.000Z", "+919876543210", 0)).toBe(
      "auto:org:m1:2026-11-17T00:00:00.000Z:+919876543210:0"
    );
  });

  it("lists unique E.164 numbers", () => {
    expect(recipientE164List([{ e164: "+919876543210", name: "A" }])).toEqual(["+919876543210"]);
  });
});
