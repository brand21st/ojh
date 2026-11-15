const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const BUCKET_CAP_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_RECIPIENTS = 10;
const HARD_MAX_RECIPIENTS = 25;

function optional(value: string | undefined) {
  return value?.trim() || "";
}

/** Server kill switch. Merchants can save settings while this is off; nothing is sent. */
export function manifestEmailEnabled() {
  return optional(process.env.MANIFEST_EMAIL_ENABLED).toLowerCase() === "true";
}

export function manifestEmailMaxBytes() {
  const parsed = Number(optional(process.env.MANIFEST_EMAIL_MAX_BYTES));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(parsed), BUCKET_CAP_BYTES);
}

export function manifestEmailMaxRecipients() {
  const parsed = Number(optional(process.env.MANIFEST_EMAIL_MAX_RECIPIENTS));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_RECIPIENTS;
  return Math.min(Math.floor(parsed), HARD_MAX_RECIPIENTS);
}

export function manifestSmtpConfig() {
  const port = Number(optional(process.env.MANIFEST_SMTP_PORT) || "587");
  const secureFlag = optional(process.env.MANIFEST_SMTP_SECURE).toLowerCase();
  return {
    host: optional(process.env.MANIFEST_SMTP_HOST),
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: secureFlag === "true" || port === 465,
    user: optional(process.env.MANIFEST_SMTP_USER),
    password: optional(process.env.MANIFEST_SMTP_PASSWORD),
    fromEmail: optional(process.env.MANIFEST_SMTP_FROM_EMAIL),
    fromName: optional(process.env.MANIFEST_SMTP_FROM_NAME) || "PostBus Manifest Service",
  };
}

export const MANIFEST_EMAIL_BUCKET = "manifest-email";
export const MANIFEST_EMAIL_STALE_MS = 15 * 60 * 1000;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
