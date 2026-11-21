import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/logger";
import { formatMicros, toMicros } from "@/modules/wallet/money";

/**
 * Low-balance alerts from the wallet cron: an in-app notification for every
 * crossing, and an email to the workspace owners when WALLET_EMAIL_ENABLED
 * is on. Outside production, email only ever goes to WALLET_EMAIL_TEST_RECIPIENT.
 */

export type ClaimedAlert = {
  organizationId: string;
  organizationName: string;
  thresholdMicros: string;
  balanceMicros: string;
  availableMicros: string;
  walletStatus: string;
  ownerEmails: string[];
};

type Mailer = { sendMail: (message: Record<string, unknown>) => Promise<unknown> };

function createTransport(options: Record<string, unknown>) {
  const load = new Function("name", "return require(name)") as (name: string) => {
    createTransport: (opts: Record<string, unknown>) => Mailer;
  };
  return load("nodemailer").createTransport(options);
}

function env(name: string) {
  return process.env[`WALLET_SMTP_${name}`]?.trim() || process.env[`MANIFEST_SMTP_${name}`]?.trim() || "";
}

export function walletSmtpConfig() {
  const port = Number(env("PORT") || "587");
  return {
    host: env("HOST"),
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env("SECURE").toLowerCase() === "true" || port === 465,
    user: env("USER"),
    password: env("PASSWORD"),
    fromEmail: env("FROM_EMAIL"),
    fromName: process.env.WALLET_SMTP_FROM_NAME?.trim() || "PostBus",
  };
}

/** Who actually receives the email: nobody unless enabled, and only the test inbox outside production. */
export function walletAlertRecipients(ownerEmails: string[]) {
  if (process.env.WALLET_EMAIL_ENABLED?.trim().toLowerCase() !== "true") return [];
  const test = process.env.WALLET_EMAIL_TEST_RECIPIENT?.trim();
  if (process.env.POSTBUS_ENV === "staging" || process.env.NODE_ENV !== "production") return test ? [test] : [];
  return ownerEmails.filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).slice(0, 5);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderLowBalanceAlert(alert: ClaimedAlert, appUrl: string) {
  const balance = formatMicros(toMicros(alert.balanceMicros)).replace("₹", "Rs ");
  const level = formatMicros(toMicros(alert.thresholdMicros)).replace("₹", "Rs ");
  const frozen = alert.walletStatus === "FROZEN";
  const empty = toMicros(alert.availableMicros) <= BigInt(0);
  const title = frozen ? "Your PostBus wallet is on hold" : empty ? "Your PostBus wallet is empty" : `PostBus wallet below ${level}`;
  const body = frozen
    ? "WhatsApp notifications and paid AI features are paused. Contact PostBus support to restore your wallet."
    : empty
      ? "WhatsApp notifications and AI checks are paused until you recharge. Shipping, labels and tracking keep working."
      : `Your balance is ${balance}. Recharge so WhatsApp notifications and AI checks keep running.`;
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/wallet`;
  return {
    title,
    body,
    subject: `${title} — ${alert.organizationName}`.slice(0, 150),
    text: `${body}\n\nWorkspace: ${alert.organizationName}\nBalance: ${balance}\n\nRecharge: ${link}\n`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#09090b;line-height:1.5">
<p style="font-size:16px;font-weight:600">${escape(title)}</p>
<p>${escape(body)}</p>
<p style="color:#71717a">Workspace: ${escape(alert.organizationName)}<br>Balance: ${escape(balance)}</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600">Recharge wallet</a></p>
</div>`,
  };
}

export async function deliverWalletAlerts(db: SupabaseClient, transport?: Mailer) {
  const result = { alerts: 0, notified: 0, emailed: 0, emailFailed: 0 };
  const { data, error } = await db.rpc("wallet_claim_alerts", { p_limit: 200 });
  if (error) {
    if (error.code !== "PGRST202") logError("wallet.alerts_claim_failed", { message: error.message });
    return result;
  }
  const alerts = (Array.isArray(data) ? data : []) as ClaimedAlert[];
  result.alerts = alerts.length;
  if (!alerts.length) return result;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://postbus.in";
  const smtp = walletSmtpConfig();
  const mailer =
    transport ??
    (smtp.host && smtp.fromEmail
      ? createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined })
      : null);

  for (const alert of alerts) {
    const message = renderLowBalanceAlert(alert, appUrl);
    const { error: insertError } = await db.from("notifications").insert({
      organization_id: alert.organizationId,
      type: "wallet.low_balance",
      title: message.title,
      body: message.body,
      entity_type: "wallet",
    });
    if (insertError) logError("wallet.alert_notify_failed", { organizationId: alert.organizationId, message: insertError.message });
    else result.notified += 1;

    const to = walletAlertRecipients(alert.ownerEmails ?? []);
    if (!mailer || !to.length) continue;
    try {
      await mailer.sendMail({
        from: `${smtp.fromName.replace(/[\r\n<>"]/g, "")} <${smtp.fromEmail}>`,
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { "X-PostBus-Email": "wallet_low_balance" },
      });
      result.emailed += 1;
    } catch (cause) {
      // Alerts are claimed before sending: a failed email is logged, not retried, so nobody gets duplicates.
      logError("wallet.alert_email_failed", {
        organizationId: alert.organizationId,
        message: (cause instanceof Error ? cause.message : "send failed").split(smtp.password || "\u0000").join("[redacted]"),
      });
      result.emailFailed += 1;
    }
  }
  if (result.alerts) logInfo("wallet.alerts_delivered", result);
  return result;
}
