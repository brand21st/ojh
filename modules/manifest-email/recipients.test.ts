import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import {
  assertAutoSendRecipients,
  autoIdempotencyKey,
  manualIdempotencyKey,
  normalizeRecipients,
  recipientSetHash,
  resolveManifestRecipients,
  withBookingOfficeRecipients,
} from "@/modules/manifest-email/recipients";

describe("manifest email recipients", () => {
  it("normalizes, drops blanks, and dedupes", () => {
    expect(normalizeRecipients(["  PostOffice@Example.com ", "", "postoffice@example.com", "booking@example.com"], 10)).toEqual([
      "postoffice@example.com",
      "booking@example.com",
    ]);
  });

  it("rejects an invalid address and a list over the cap", () => {
    expect(() => normalizeRecipients(["not-an-email"])).toThrow(AppError);
    expect(() => normalizeRecipients(["a@example.com", "b@example.com"], 1)).toThrow(/at most 1/);
  });

  it("uses an office list only when that office has its own entry", () => {
    const settings = {
      recipients: ["default@example.com"],
      officeOverrides: { "22660454": ["office@example.com"], "22660001": [] as string[] },
    };
    expect(resolveManifestRecipients(settings, "22660454").recipients).toEqual(["office@example.com"]);
    expect(resolveManifestRecipients(settings, "22660001").recipients).toEqual([]);
    expect(resolveManifestRecipients(settings, "99999999").recipients).toEqual(["default@example.com"]);
    expect(resolveManifestRecipients(settings, null).recipients).toEqual(["default@example.com"]);
  });

  it("updates the current booking office without dropping other offices", () => {
    const overrides = {
      "11111111": ["kept@example.com"],
      "22222222": [] as string[],
    };
    expect(withBookingOfficeRecipients(overrides, "33333333", ["office@example.com"])).toEqual({
      "11111111": ["kept@example.com"],
      "22222222": [],
      "33333333": ["office@example.com"],
    });
    expect(overrides["33333333"]).toBeUndefined();
  });

  it("does not store an empty booking-office list unless that office already had one", () => {
    const overrides = { "11111111": ["kept@example.com"] };
    expect(withBookingOfficeRecipients(overrides, "33333333", [])).toEqual(overrides);
    expect(withBookingOfficeRecipients(overrides, "11111111", [], true)).toEqual({
      "11111111": [],
    });
  });

  it("refuses automatic sending without a default recipient", () => {
    expect(() => assertAutoSendRecipients([])).toThrow(/at least one/i);
  });

  it("keeps one automatic key per close and a new key after another close", () => {
    const closed = "2026-11-15T04:30:00.000Z";
    const key = autoIdempotencyKey("org", "manifest", closed);
    expect(autoIdempotencyKey("org", "manifest", closed)).toBe(key);
    expect(autoIdempotencyKey("org", "manifest", "2026-11-15T06:00:00.000Z")).not.toBe(key);
    expect(manualIdempotencyKey("org", "manifest", "one")).not.toBe(manualIdempotencyKey("org", "manifest", "two"));
  });

  it("changes the recipient hash when the set changes", () => {
    const first = recipientSetHash({ recipients: ["a@example.com"], cc: [], replyTo: null });
    const second = recipientSetHash({ recipients: ["b@example.com"], cc: [], replyTo: null });
    expect(first).not.toBe(second);
  });
});
