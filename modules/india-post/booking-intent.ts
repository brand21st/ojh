/** CEPT response identifiers. Stored beside the submit intent; they do not replace it. */
export const CEPT_CUSTOM_ID = "ceptCustomId";
export const CEPT_MAIL_BOOKING_DOM_ID = "ceptMailBookingDomId";

export function metadataWithCeptBookingIds(
  metadata: unknown,
  ids: { customId?: string | null; mailBookingDomId?: string | null }
) {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const customId = ids.customId?.trim();
  const mailBookingDomId = ids.mailBookingDomId?.trim();
  if (customId) base[CEPT_CUSTOM_ID] = customId;
  if (mailBookingDomId) base[CEPT_MAIL_BOOKING_DOM_ID] = mailBookingDomId;
  return base;
}

/** Durable proof that a CEPT booking POST was about to be sent. Stored on shipments.metadata. */
export const CEPT_SUBMIT_INTENT_AT = "ceptSubmitIntentAt";
/** Merchant confirmed a second CEPT POST after an unknown first outcome. */
export const CEPT_FORCE_RESUBMIT_AT = "ceptForceResubmitAt";

export function readCeptSubmitIntentAt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[CEPT_SUBMIT_INTENT_AT];
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** Preserves an existing intent timestamp. A retry must not clear it. */
export function metadataWithCeptSubmitIntent(metadata: unknown, at: string) {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const existing = readCeptSubmitIntentAt(base);
  if (existing) return base;
  return { ...base, [CEPT_SUBMIT_INTENT_AT]: at };
}

export function readCeptForceResubmitAt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[CEPT_FORCE_RESUBMIT_AT];
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function metadataWithCeptForceResubmit(metadata: unknown, at: string) {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return { ...base, [CEPT_FORCE_RESUBMIT_AT]: at };
}

/** When the single force-resubmit permission was used for a CEPT POST. */
export const CEPT_FORCE_RESUBMIT_CONSUMED_AT = "ceptForceResubmitConsumedAt";

export function readCeptForceResubmitConsumedAt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[CEPT_FORCE_RESUBMIT_CONSUMED_AT];
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/**
 * A force-resubmit permits exactly one POST. The run that sends it swaps the permission for a
 * consumed timestamp, so a later run (stale reclaim, retry) sees only the submit intent and
 * goes to tracking instead of posting again.
 */
export function metadataConsumingCeptForceResubmit(metadata: unknown, at: string) {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (!readCeptForceResubmitAt(base)) return base;
  delete base[CEPT_FORCE_RESUBMIT_AT];
  return { ...base, [CEPT_FORCE_RESUBMIT_CONSUMED_AT]: at };
}
