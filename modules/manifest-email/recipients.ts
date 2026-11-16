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
