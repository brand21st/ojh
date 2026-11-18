import { createHash } from "node:crypto";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { toIndiaWhatsappE164 } from "@/lib/phone/india-whatsapp";
import { manifestWhatsAppMaxRecipients } from "@/modules/manifest-whatsapp/config";

export type WhatsAppRecipient = {
  e164: string;
  name: string | null;
};

export type RecipientResolution = {
  recipients: WhatsAppRecipient[];
  source: "office" | "default";
};

function recipientName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  return name || null;
}

function phoneFromUnknown(item: unknown) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  return String(row.phone ?? row.e164 ?? row.number ?? "").trim();
}

function nameFromUnknown(item: unknown) {
  if (!item || typeof item !== "object") return null;
  return recipientName((item as Record<string, unknown>).name);
}

export function normalizeWhatsAppRecipient(item: unknown): WhatsAppRecipient {
  try {
    return { e164: toIndiaWhatsappE164(phoneFromUnknown(item)), name: nameFromUnknown(item) };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter a 10-digit Indian WhatsApp number.");
  }
}

export function normalizeWhatsAppRecipients(input: unknown, max = manifestWhatsAppMaxRecipients()) {
  const list = Array.isArray(input) ? input : input == null ? [] : [input];
  const seen = new Map<string, WhatsAppRecipient>();
  for (const item of list) {
    if (item == null || item === "") continue;
    const recipient = normalizeWhatsAppRecipient(item);
    if (!seen.has(recipient.e164)) seen.set(recipient.e164, recipient);
  }
  const recipients = [...seen.values()];
  if (recipients.length > max) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Save at most ${max} WhatsApp numbers.`);
  }
  return recipients;
}

export function normalizeOfficeOverrides(input: unknown, max = manifestWhatsAppMaxRecipients()) {
  if (input == null) return {} as Record<string, WhatsAppRecipient[]>;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Office WhatsApp overrides must be a map of office id to numbers.");
  }
  const overrides: Record<string, WhatsAppRecipient[]> = {};
  for (const [officeId, recipients] of Object.entries(input as Record<string, unknown>)) {
    const key = officeId.trim();
    if (!key || key.length > 32) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Booking office id is missing.");
    }
    overrides[key] = normalizeWhatsAppRecipients(recipients, max);
  }
  return overrides;
}

export function resolveManifestWhatsAppRecipients(
  settings: { recipients: WhatsAppRecipient[]; officeOverrides: Record<string, WhatsAppRecipient[]> },
  officeId: string | null | undefined
): RecipientResolution {
  const key = officeId?.trim() || "";
  if (key && Object.prototype.hasOwnProperty.call(settings.officeOverrides, key)) {
    return { recipients: settings.officeOverrides[key] ?? [], source: "office" };
  }
  return { recipients: settings.recipients, source: "default" };
}

export function assertAutoSendRecipients(recipients: WhatsAppRecipient[]) {
  if (!recipients.length) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "Add at least one WhatsApp number before turning on automatic sending."
    );
  }
}

export function recipientE164List(recipients: WhatsAppRecipient[]) {
  return recipients.map((row) => row.e164);
}

export function recipientSetHash(recipients: WhatsAppRecipient[]) {
  return createHash("sha256")
    .update(JSON.stringify(recipients.map((row) => row.e164).sort()))
    .digest("hex");
}

export function autoIdempotencyKey(
  organizationId: string,
  manifestId: string,
  closedAt: string,
  e164: string,
  fileIndex: number
) {
  return `auto:${organizationId}:${manifestId}:${closedAt}:${e164}:${fileIndex}`;
}

export function manualIdempotencyKey(
  organizationId: string,
  manifestId: string,
  nonce: string,
  e164: string,
  fileIndex: number
) {
  return `manual:${organizationId}:${manifestId}:${nonce}:${e164}:${fileIndex}`;
}
