const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const BUCKET_CAP_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_RECIPIENTS = 10;
const HARD_MAX_RECIPIENTS = 25;
const DEFAULT_SIGNED_TTL_SECONDS = 15 * 60;

function optional(value: string | undefined) {
  return value?.trim() || "";
}

/** Server kill switch. Merchants can save settings while this is off; nothing is sent. */
export function manifestWhatsAppEnabled() {
  return optional(process.env.MANIFEST_WHATSAPP_ENABLED).toLowerCase() === "true";
}

/**
 * Session `type=document` sends. Off by default because Vachat cannot confirm the
 * 24-hour customer-service window. Enable only for authorized internal tests.
 */
export function manifestWhatsAppSessionDocumentsEnabled() {
  return optional(process.env.MANIFEST_WHATSAPP_SESSION_DOCUMENTS).toLowerCase() === "true";
}

export function manifestWhatsAppTemplateName() {
  return optional(process.env.MANIFEST_WHATSAPP_TEMPLATE_NAME);
}

export function manifestWhatsAppTemplateLanguage() {
  return optional(process.env.MANIFEST_WHATSAPP_TEMPLATE_LANGUAGE) || "en";
}

export function manifestWhatsAppMaxBytes() {
  const parsed = Number(optional(process.env.MANIFEST_WHATSAPP_MAX_BYTES));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(parsed), BUCKET_CAP_BYTES);
}

export function manifestWhatsAppMaxRecipients() {
  const parsed = Number(optional(process.env.MANIFEST_WHATSAPP_MAX_RECIPIENTS));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_RECIPIENTS;
  return Math.min(Math.floor(parsed), HARD_MAX_RECIPIENTS);
}

export function manifestWhatsAppSignedTtlSeconds() {
  const parsed = Number(optional(process.env.MANIFEST_WHATSAPP_SIGNED_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed < 60) return DEFAULT_SIGNED_TTL_SECONDS;
  return Math.min(Math.floor(parsed), 60 * 60);
}

export const MANIFEST_WHATSAPP_BUCKET = "manifest-whatsapp";
export const MANIFEST_WHATSAPP_STALE_MS = 15 * 60 * 1000;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
