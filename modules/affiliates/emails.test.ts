import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
import { deliveryAddress, renderPartnerEmail, runPartnerEmails } from "./emails";

const ctx = (payload: Record<string, unknown>, name = "Ravi Kumar") => ({ name, payload, appUrl: "https://postbus.in" });
afterEach(() => vi.unstubAllEnvs());

describe("partner email templates", () => {
  it("renders every lifecycle email", () => {
    for (const kind of ["application_received", "status_approved", "status_rejected", "status_suspended", "first_commission", "payout_sent", "payout_paid", "payout_failed", "payout_returned"]) {
      const email = renderPartnerEmail(kind, ctx({ amountPaise: 425050 }));
      expect(email?.subject, kind).toBeTruthy();
      expect(email?.html).toContain("Hi Ravi");
    }
    expect(renderPartnerEmail("unknown", ctx({}))).toBeNull();
  });

  it("shows amount and UTR on the paid email", () => {
    const email = renderPartnerEmail("payout_paid", ctx({ amountPaise: 425050, utr: "UTR12345" }))!;
    expect(email.subject).toBe("Paid: ₹4,250.50 has reached your account");
    expect(email.text).toContain("UTR / reference: UTR12345");
    expect(email.html).toContain("https://postbus.in/partner/payouts");
  });

  it("escapes partner-controlled text in HTML", () => {
    const email = renderPartnerEmail("status_rejected", ctx({ reason: "<script>x</script>" }, "<b>Eve</b>"))!;
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain("<b>Eve");
  });
});

describe("partner email delivery", () => {
  it("never mails real partners outside production", () => {
    vi.stubEnv("AFFILIATE_EMAIL_ENABLED", "true");
    vi.stubEnv("POSTBUS_ENV", "staging");
    expect(deliveryAddress("partner@real.in")).toEqual({ send: false, reason: "NO_TEST_RECIPIENT" });
    vi.stubEnv("AFFILIATE_EMAIL_TEST_RECIPIENT", "qa@postbus.in");
    expect(deliveryAddress("partner@real.in")).toEqual({ send: true, to: "qa@postbus.in" });
  });

  it("is off unless enabled", () => {
    expect(deliveryAddress("partner@real.in").send).toBe(false);
  });

  it("sends, skips opted-out status mail but always sends money mail, and retries failures", async () => {
    vi.stubEnv("AFFILIATE_EMAIL_ENABLED", "true");
    vi.stubEnv("AFFILIATE_EMAIL_TEST_RECIPIENT", "qa@postbus.in");
    vi.stubEnv("AFFILIATE_SMTP_FROM_EMAIL", "partners@postbus.in");
    const finished: unknown[] = [];
    const jobs = [
      { id: "1", lease: "l", kind: "payout_paid", payload: { amountPaise: 100000, utr: "U1" }, email: "a@x.in", application: { fullName: "Ravi", notify: false } },
      { id: "2", lease: "l", kind: "status_approved", payload: {}, email: "a@x.in", application: { fullName: "Ravi", notify: false } },
      { id: "3", lease: "l", kind: "payout_sent", payload: { amountPaise: 1 }, email: "a@x.in", application: { fullName: "Ravi" } },
    ];
    const db = { rpc: vi.fn(async (name: string, args: unknown) => { if (name === "affiliate_claim_emails") return { data: jobs, error: null }; finished.push(args); return { data: null, error: null }; }) } as unknown as SupabaseClient;
    const sendMail = vi.fn(async (m: Record<string, unknown>) => { if (String(m.subject).includes("on its way")) throw new Error("421 try later"); });
    const result = await runPartnerEmails(db, { sendMail });
    expect(result).toEqual({ sent: 1, skipped: 1, failed: 1 });
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "qa@postbus.in", from: "PostBus Partners <partners@postbus.in>" });
    expect(finished).toEqual([
      { p_id: "1", p_lease: "l", p_status: "SENT", p_error: "" },
      { p_id: "2", p_lease: "l", p_status: "SKIPPED", p_error: "OPTED_OUT" },
      { p_id: "3", p_lease: "l", p_status: "RETRY", p_error: "421 try later" },
    ]);
  });
});
