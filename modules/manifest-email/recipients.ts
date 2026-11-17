import { createHash } from "node:crypto";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { manifestEmailMaxRecipients } from "@/modules/manifest-email/config";

const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const MAX_CC = 3;

export type RecipientResolution = {
  recipients: string[];
  source: "office" | "default";
};

export function normalizeEmailAddress(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

export function normalizeRecipients(input: unknown, max = manifestEmailMaxRecipients()) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && !item.trim()) continue;
    const email = normalizeEmailAddress(item);
    if (!email) {
      invalid.push(typeof item === "string" ? item.trim() : "invalid");
      continue;
    }
    seen.add(email);
  }
  if (invalid.length) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Enter a valid email address: ${invalid[0]}`);
  }
  const recipients = [...seen];
  if (recipients.length > max) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Save at most ${max} email addresses.`);
  }
  return recipients;
}

export function normalizeOfficeOverrides(input: unknown, max = manifestEmailMaxRecipients()) {
  if (input == null) return {} as Record<string, string[]>;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Office email overrides must be a map of office id to addresses.");
  }
  const overrides: Record<string, string[]> = {};
  for (const [officeId, recipients] of Object.entries(input as Record<string, unknown>)) {
    const key = officeId.trim();
    if (!key || key.length > 32) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Booking office id is missing.");
    }
    overrides[key] = normalizeRecipients(recipients, max);
  }
  return overrides;
}

/**
 * An explicit empty override does not fall through to the organization default.
 * A missing key, or a manifest with no office, uses the default list.
 */
export function resolveManifestRecipients(
  settings: { recipients: string[]; officeOverrides: Record<string, string[]> },
  officeId: string | null | undefined
): RecipientResolution {
  const key = officeId?.trim() || "";
  if (key && Object.prototype.hasOwnProperty.call(settings.officeOverrides, key)) {
    return { recipients: settings.officeOverrides[key] ?? [], source: "office" };
  }
  return { recipients: settings.recipients, source: "default" };
}

/**
 * Office To: stays the office list. Default recipients that are not already on To
 * are CC'd so a merchant copy is not dropped when an office mailbox is saved.
 * An empty office list still means do not send.
 */
export function ccForManifestEmail(
  settings: { recipients: string[]; officeOverrides: Record<string, string[]>; ccRecipients: string[] },
  officeId: string | null | undefined
) {
  const resolved = resolveManifestRecipients(settings, officeId);
  const seen = new Set([...resolved.recipients, ...settings.ccRecipients].map((email) => email.toLowerCase()));
  const extra =
    resolved.source === "office" && resolved.recipients.length
      ? settings.recipients.filter((email) => {
          const key = email.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      : [];
  return [...settings.ccRecipients, ...extra];
}

export type OfficeNameConnection = {
  pickup_dropoff_office_id?: string | null;
  pickup_dropoff_office_name?: string | null;
  pickup_office_id?: string | null;
  pickup_office_name?: string | null;
};

function text(value: unknown) {
  const next = typeof value === "string" ? value.trim() : "";
  return next || null;
}

export function fillOfficeDisplayName(
  officeId: string | null | undefined,
  storedName: string | null | undefined,
  connection: OfficeNameConnection | null | undefined
) {
  const saved = text(storedName);
  if (saved) return saved;
  const id = text(officeId);
  if (!id || !connection) return "";
  const dropId = text(connection.pickup_dropoff_office_id);
  const pickupId = text(connection.pickup_office_id);
  if (id === dropId) return text(connection.pickup_dropoff_office_name) || (id === pickupId ? text(connection.pickup_office_name) : null) || "";
  if (id === pickupId) return text(connection.pickup_office_name) || "";
  return "";
}

/**
 * Replace one booking office's recipient list without dropping other offices.
 * An empty list is stored only when that office already had its own entry.
 */
export function withBookingOfficeRecipients(
  overrides: Record<string, string[]>,
  officeId: string,
  emails: string[],
  keepEmpty = false
): Record<string, string[]> {
  const key = officeId.trim();
  const next = { ...overrides };
  if (!key) return next;
  if (!emails.length && !keepEmpty) {
    delete next[key];
    return next;
  }
  next[key] = [...emails];
  return next;
}

export function assertAutoSendRecipients(recipients: string[]) {
  if (!recipients.length) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "Add at least one India Post email address before turning on automatic sending."
    );
  }
}

export function recipientSetHash(input: { recipients: string[]; cc: string[]; replyTo: string | null }) {
  const body = JSON.stringify({
    to: [...input.recipients].sort(),
    cc: [...input.cc].sort(),
    replyTo: input.replyTo,
  });
  return createHash("sha256").update(body).digest("hex");
}

export function autoIdempotencyKey(organizationId: string, manifestId: string, closedAt: string) {
  return `auto:${organizationId}:${manifestId}:${closedAt}`;
}

export function manualIdempotencyKey(organizationId: string, manifestId: string, nonce: string) {
  return `manual:${organizationId}:${manifestId}:${nonce}`;
}
