import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/logger";
import { formatPaiseInr } from "./policy";
import { checked } from "./service";

/** Partner lifecycle emails, sent from the affiliate_email_outbox by the billing cron. */

type Payload = Record<string, unknown>;
export type PartnerEmail = { subject: string; text: string; html: string };
type Claimed = { id: string; kind: string; payload: Payload; lease: string; email: string | null; application: Payload | null };

const BRAND = "#e11d48";
const SKIP_WHEN_OPTED_OUT = new Set(["status_approved", "status_rejected", "status_suspended", "first_commission", "application_received"]);

function createTransport(options: Record<string, unknown>) {
  const load = new Function("name", "return require(name)") as (name: string) => {
    createTransport: (opts: Record<string, unknown>) => { sendMail: (m: Record<string, unknown>) => Promise<unknown> };
  };
  return load("nodemailer").createTransport(options);
}

function env(name: string) {
  return process.env[`AFFILIATE_SMTP_${name}`]?.trim() || process.env[`MANIFEST_SMTP_${name}`]?.trim() || "";
}

export function partnerSmtpConfig() {
  const port = Number(env("PORT") || "587");
  return {
    host: env("HOST"),
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env("SECURE").toLowerCase() === "true" || port === 465,
    user: env("USER"),
    password: env("PASSWORD"),
    fromEmail: env("FROM_EMAIL"),
    fromName: process.env.AFFILIATE_SMTP_FROM_NAME?.trim() || "PostBus Partners",
  };
}

/**
 * Who actually receives mail. Staging never mails real partners: with no test recipient
 * configured it sends nothing, otherwise every message is redirected there.
 */
export function deliveryAddress(partnerEmail: string | null) {
  if (process.env.AFFILIATE_EMAIL_ENABLED?.trim().toLowerCase() !== "true") return { send: false as const, reason: "DISABLED" };
  const test = process.env.AFFILIATE_EMAIL_TEST_RECIPIENT?.trim();
  if (process.env.POSTBUS_ENV === "staging" || process.env.NODE_ENV !== "production") {
    return test ? { send: true as const, to: test } : { send: false as const, reason: "NO_TEST_RECIPIENT" };
  }
  if (test) return { send: true as const, to: test };
  return partnerEmail ? { send: true as const, to: partnerEmail } : { send: false as const, reason: "NO_ADDRESS" };
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(heading: string, paragraphs: string[], cta: { label: string; href: string } | null, detail?: [string, string][]) {
  const rows = (detail ?? [])
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#71717a;font-size:14px">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#18181b;font-size:14px">${esc(v)}</td></tr>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e4e4e7">
<tr><td style="padding:24px 28px 0"><span style="font-weight:700;color:${BRAND};font-size:16px">PostBus Partners</span></td></tr>
<tr><td style="padding:16px 28px 8px"><h1 style="margin:0;font-size:22px;line-height:1.3;color:#18181b">${esc(heading)}</h1></td></tr>
<tr><td style="padding:0 28px">${paragraphs.map((p) => `<p style="margin:12px 0;font-size:15px;line-height:1.6;color:#3f3f46">${esc(p)}</p>`).join("")}</td></tr>
${rows ? `<tr><td style="padding:4px 28px"><table role="presentation" width="100%" style="border-top:1px solid #f4f4f5;border-bottom:1px solid #f4f4f5;margin:8px 0">${rows}</table></td></tr>` : ""}
${cta ? `<tr><td style="padding:16px 28px 8px"><a href="${esc(cta.href)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${esc(cta.label)}</a></td></tr>` : ""}
<tr><td style="padding:20px 28px 24px;font-size:12px;line-height:1.5;color:#a1a1aa">You're receiving this because you're a PostBus partner. Manage email preferences in your partner profile.</td></tr>
</table></td></tr></table></body></html>`;
}

function text(heading: string, paragraphs: string[], cta: { label: string; href: string } | null, detail?: [string, string][]) {
  return [heading, "", ...paragraphs, ...(detail?.length ? ["", ...detail.map(([k, v]) => `${k}: ${v}`)] : []), ...(cta ? ["", `${cta.label}: ${cta.href}`] : [])].join("\n");
}

export function renderPartnerEmail(kind: string, ctx: { name: string; payload: Payload; appUrl: string }): PartnerEmail | null {
  const first = ctx.name.trim().split(/\s+/)[0] || "there";
  const p = ctx.payload;
  const amount = p.amountPaise != null ? formatPaiseInr(p.amountPaise) : null;
  const dashboard = { label: "Open partner dashboard", href: `${ctx.appUrl}/partner/dashboard` };
  const payouts = { label: "View payouts", href: `${ctx.appUrl}/partner/payouts` };
  const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : null;

  const spec: Record<string, () => [string, string, string[], { label: string; href: string } | null, ([string, string][] | undefined)?]> = {
    application_received: () => ["We received your partner application", "Application received", [`Hi ${first}, thanks for applying to the PostBus Partner Program.`, "We review every application by hand, usually within 2 working days. We'll email you as soon as there's a decision."], dashboard],
    status_approved: () => ["You're approved — start earning with PostBus", "Welcome to PostBus Partners", [`Hi ${first}, your application is approved.`, "Your referral link is ready. Share it with sellers who ship with India Post and earn commission on every subscription payment they make."], { label: "Get my referral link", href: `${ctx.appUrl}/partner/links` }],
    status_rejected: () => ["Update on your PostBus partner application", "Application not approved", [`Hi ${first}, we're not able to approve your application right now.`, ...(reason ? [`Reason: ${reason}`] : []), "You're welcome to reply to this email if you'd like us to take another look."], null],
    status_suspended: () => ["Your PostBus partner account is paused", "Partner account paused", [`Hi ${first}, your partner account has been paused, so new referrals aren't being credited for now.`, "Earnings you've already made are safe. Reply to this email and our team will help."], null],
    first_commission: () => [`Your first commission has cleared${amount ? ` — ${amount}` : ""}`, "Your first commission cleared", [`Hi ${first}, a commission from one of your referrals has cleared its hold period and is now in your available balance.`, "Add a UPI ID in Payouts so we can pay you automatically each month."], payouts, amount ? [["Cleared amount", amount]] : undefined],
    payout_sent: () => [`Payout of ${amount ?? "your earnings"} is on its way`, "Your payout is on its way", [`Hi ${first}, we've sent your payout to your UPI account. Most UPI payouts arrive within minutes; some banks take a few hours.`], payouts, amount ? [["Amount", amount]] : undefined],
    payout_paid: () => [`Paid: ${amount ?? "your payout"} has reached your account`, "Payout completed", [`Hi ${first}, your payout has been credited.`], payouts, [...(amount ? [["Amount", amount] as [string, string]] : []), ...(p.utr ? [["UTR / reference", String(p.utr)] as [string, string]] : [])]],
    payout_failed: () => [`Payout of ${amount ?? "your earnings"} didn't go through`, "We couldn't complete your payout", [`Hi ${first}, your payout couldn't be completed${reason ? `: ${reason}` : "."}`, "The money is back in your available balance — nothing is lost. Please check your UPI ID in Payouts; we'll retry on the next payout run."], payouts, amount ? [["Amount", amount]] : undefined],
    payout_returned: () => [`Payout of ${amount ?? "your earnings"} was returned`, "Your payout was returned", [`Hi ${first}, your bank returned a payout${reason ? ` (${reason})` : ""}.`, "The full amount is back in your available balance. Please confirm your UPI ID so the next payout lands."], payouts, amount ? [["Amount", amount]] : undefined],
  };
  const build = spec[kind];
  if (!build) return null;
  const [subject, heading, paragraphs, cta, detail] = build();
  return { subject, html: layout(heading, paragraphs, cta, detail), text: text(heading, paragraphs, cta, detail) };
}

export async function runPartnerEmails(db: SupabaseClient, transport?: { sendMail: (m: Record<string, unknown>) => Promise<unknown> }) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (process.env.AFFILIATE_EMAIL_ENABLED?.trim().toLowerCase() !== "true") return result;
  const smtp = partnerSmtpConfig();
  if (!transport && (!smtp.host || !smtp.fromEmail)) return result;
  const mailer = transport ?? createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://postbus.in";
  const jobs = (checked(await db.rpc("affiliate_claim_emails", { p_limit: 25 })) ?? []) as Claimed[];

  for (const job of jobs) {
    const finish = async (status: "SENT" | "SKIPPED" | "RETRY", error = "") =>
      checked(await db.rpc("affiliate_finish_email", { p_id: job.id, p_lease: job.lease, p_status: status, p_error: error }));
    const app = job.application ?? {};
    const email = renderPartnerEmail(job.kind, { name: String(app.fullName ?? ""), payload: job.payload ?? {}, appUrl });
    const target = deliveryAddress(job.email);
    if (!email || !target.send || (app.notify === false && SKIP_WHEN_OPTED_OUT.has(job.kind))) {
      await finish("SKIPPED", !email ? "UNKNOWN_KIND" : !target.send ? target.reason : "OPTED_OUT");
      result.skipped++;
      continue;
    }
    try {
      await mailer.sendMail({
        from: `${smtp.fromName.replace(/[\r\n<>"]/g, "")} <${smtp.fromEmail}>`,
        to: target.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: { "X-PostBus-Email": job.kind },
      });
      await finish("SENT");
      result.sent++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "send failed").split(smtp.password || "\u0000").join("[redacted]");
      logError("affiliate.email_failed", { kind: job.kind });
      await finish("RETRY", message);
      result.failed++;
    }
  }
  return result;
}
