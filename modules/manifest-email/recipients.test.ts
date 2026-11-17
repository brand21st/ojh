import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/errors";
import {
  assertAutoSendRecipients,
  autoIdempotencyKey,
  ccForManifestEmail,
  commitEmailDraft,
  fillOfficeAddress,
  fillOfficeDisplayName,
  manualIdempotencyKey,
  normalizeRecipients,
  splitEmailField,
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

  it("splits a pasted field into addresses", () => {
    expect(splitEmailField(" a@x.com, B@Y.com; c@z.com ")).toEqual(["a@x.com", "B@Y.com", "c@z.com"]);
    expect(normalizeRecipients("a@x.com, B@Y.com; c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(normalizeRecipients("a@x.com,  , b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(() => normalizeRecipients("bad, a@x.com")).toThrow(/Enter a valid email address/);
  });

  it("keeps an unfinished address out of the saved list until it is finished", () => {
    expect(commitEmailDraft(["a@x.com"], "ops@", { max: 10, flushPending: false })).toEqual({
      emails: ["a@x.com"],
      pending: "ops@",
      error: null,
    });
    expect(commitEmailDraft(["a@x.com"], "b@y.com, c@z.com", { max: 10, flushPending: true })).toEqual({
      emails: ["a@x.com", "b@y.com", "c@z.com"],
      pending: "",
      error: null,
    });
    expect(commitEmailDraft(["a@x.com"], "a@x.com,", { max: 10, flushPending: false }).error).toMatch(/already/);
    expect(commitEmailDraft([], "not-an-email", { max: 10, flushPending: true }).error).toMatch(/valid email/);
    expect(commitEmailDraft(["a@x.com"], "b@y.com", { max: 1, flushPending: true })).toMatchObject({
      emails: ["a@x.com"],
      pending: "b@y.com",
    });
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

  it("CCs leftover default recipients when an office list is used for auto-send", () => {
    const settings = {
      recipients: ["office@indiapost.gov.in", "merchant@example.com"],
      officeOverrides: { "22661165": ["office@indiapost.gov.in"] },
      ccRecipients: ["ops@example.com"],
    };
    expect(ccForManifestEmail(settings, "22661165")).toEqual(["ops@example.com", "merchant@example.com"]);
    expect(ccForManifestEmail(settings, "99999999")).toEqual(["ops@example.com"]);
    expect(
      ccForManifestEmail({ ...settings, officeOverrides: { "22661165": [] } }, "22661165")
    ).toEqual(["ops@example.com"]);
  });

  it("fills a missing office name from the pickup office when drop-off shares the id", () => {
    expect(
      fillOfficeDisplayName("22661165", null, {
        pickup_dropoff_office_id: "22661165",
        pickup_dropoff_office_name: null,
        pickup_office_id: "22661165",
        pickup_office_name: "Kodurmalabar SO",
      })
    ).toBe("Kodurmalabar SO");
    expect(fillOfficeDisplayName("22661165", "Saved Name", {
      pickup_dropoff_office_id: "22661165",
      pickup_dropoff_office_name: null,
      pickup_office_id: "22661165",
      pickup_office_name: "Kodurmalabar SO",
    })).toBe("Saved Name");
  });

  it("builds a booking office address from the India Post connection", () => {
    expect(
      fillOfficeAddress("22660001", {
        pickup_office_id: "22660001",
        pickup_office_city: "Kochi",
        pickup_office_state: "Kerala",
        pickup_office_pincode: "682001",
        pickup_dropoff_office_id: "22660454",
        pickup_dropoff_office_pincode: "682311",
      })
    ).toBe("Kochi, Kerala 682001");
    expect(
      fillOfficeAddress("22660454", {
        pickup_office_id: "22660001",
        pickup_office_city: "Kochi",
        pickup_dropoff_office_id: "22660454",
        pickup_dropoff_office_pincode: "682311",
      })
    ).toBe("682311");
    expect(fillOfficeAddress("99999999", { pickup_office_id: "22660001", pickup_office_city: "Kochi" })).toBe("");
    expect(fillOfficeAddress("22660001", { pickup_office_id: "22660001", pickup_office_city: "Kochi" })).toBe("Kochi");
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
