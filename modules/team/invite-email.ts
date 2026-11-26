import { createTransport } from "nodemailer";
import { logError, logInfo } from "@/lib/logger";
import { roleLabel } from "@/lib/permissions/rbac";
import type { MemberRole } from "@/types/domain";

/** Team invite emails. Uses TEAM_SMTP_* and falls back to the manifest mailbox settings. */

function env(name: string) {
  return process.env[`TEAM_SMTP_${name}`]?.trim() || process.env[`MANIFEST_SMTP_${name}`]?.trim() || "";
}

export function teamSmtpConfig() {
  const port = Number(env("PORT") || "587");
  return {
    host: env("HOST"),
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env("SECURE").toLowerCase() === "true" || port === 465,
    user: env("USER"),
    password: env("PASSWORD"),
    fromEmail: env("FROM_EMAIL"),
    fromName: process.env.TEAM_SMTP_FROM_NAME?.trim() || "PostBus",
  };
}

/**
 * Who actually receives the invite. Outside production it only ever goes to
 * TEAM_EMAIL_TEST_RECIPIENT, so local and staging runs never mail real staff.
 */
export function inviteDeliveryAddress(email: string) {
  if (process.env.TEAM_INVITE_EMAIL_ENABLED?.trim().toLowerCase() === "false") {
    return { send: false as const, reason: "DISABLED" };
  }
  const test = process.env.TEAM_EMAIL_TEST_RECIPIENT?.trim();
  if (process.env.POSTBUS_ENV === "staging" || process.env.NODE_ENV !== "production") {
    return test ? { send: true as const, to: test } : { send: false as const, reason: "NO_TEST_RECIPIENT" };
  }
  return { send: true as const, to: email };
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderInviteEmail(input: {
  organizationName: string;
  inviterName: string | null;
  inviteeName: string | null;
  role: MemberRole;
  inviteUrl: string;
}) {
  const who = input.inviterName?.trim() || "Your team";
  const hello = input.inviteeName?.trim() ? `Hi ${input.inviteeName.trim()},` : "Hi,";
  const role = roleLabel(input.role);
  const subject = `${who} added you to ${input.organizationName} on PostBus`;
  const text = [
    hello,
    "",
    `${who} invited you to join ${input.organizationName} on PostBus as ${role}.`,
    "Open this link to set up your login. It works for 7 days.",
    "",
    input.inviteUrl,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e4e4e7">
<tr><td style="padding:24px 28px 0"><span style="font-weight:700;color:#e11d48;font-size:16px">PostBus</span></td></tr>
<tr><td style="padding:16px 28px 0"><h1 style="margin:0;font-size:22px;line-height:1.3;color:#18181b">Join ${esc(input.organizationName)}</h1></td></tr>
<tr><td style="padding:0 28px">
<p style="margin:12px 0;font-size:15px;line-height:1.6;color:#3f3f46">${esc(hello)}</p>
<p style="margin:12px 0;font-size:15px;line-height:1.6;color:#3f3f46">${esc(who)} invited you to join <b>${esc(input.organizationName)}</b> on PostBus as <b>${esc(role)}</b>.</p>
</td></tr>
<tr><td style="padding:12px 28px 8px"><a href="${esc(input.inviteUrl)}" style="display:inline-block;background:#e11d48;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;font-size:15px">Accept invite</a></td></tr>
<tr><td style="padding:8px 28px 24px"><p style="margin:0;font-size:13px;color:#71717a">The link works for 7 days. If you weren't expecting this, you can ignore it.</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Sends the invite. Never throws: the owner always gets a link to share as well. */
export async function sendInviteEmail(input: {
  to: string;
  organizationName: string;
  inviterName: string | null;
  inviteeName: string | null;
  role: MemberRole;
  inviteUrl: string;
}) {
  const delivery = inviteDeliveryAddress(input.to);
  const smtp = teamSmtpConfig();
  if (!delivery.send || !smtp.host || !smtp.fromEmail) {
    logInfo("team.invite_email.skipped", { reason: delivery.send ? "NO_SMTP" : delivery.reason });
    return false;
  }
  try {
    const mail = renderInviteEmail(input);
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    });
    await transport.sendMail({
      from: { name: smtp.fromName, address: smtp.fromEmail },
      to: delivery.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return true;
  } catch (error) {
    logError("team.invite_email.failed", { message: error instanceof Error ? error.message : "send failed" });
    return false;
  }
}
