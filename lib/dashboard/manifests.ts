import type { ManifestRecord } from "@/types/api";

export function istDate(at: Date | string = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof at === "string" ? new Date(at) : at);
}

/** IST booking day, or the fallback date when the shipment has no booking time. */
export function bookingManifestDate(bookedAt: string | null | undefined, fallbackDate: string) {
  if (!bookedAt) return fallbackDate;
  const parsed = new Date(bookedAt);
  if (Number.isNaN(parsed.getTime())) return fallbackDate;
  return istDate(parsed);
}

/** An open draft is wrong when the shipment was booked on a different IST day. Closed manifests stay put. */
export function isDraftBookingMismatch(
  manifest: { status: string; date: string },
  bookedAt: string | null | undefined
) {
  if (manifest.status !== "DRAFT") return false;
  if (!bookedAt) return false;
  const parsed = new Date(bookedAt);
  if (Number.isNaN(parsed.getTime())) return false;
  return istDate(parsed) !== manifest.date.slice(0, 10);
}

export function manifestOfficeLabel(row: Pick<ManifestRecord, "officeName" | "officeId">) {
  if (row.officeName && row.officeId) return `${row.officeName} (${row.officeId})`;
  if (row.officeName) return row.officeName;
  // A bare facility ID reads like a stray number, so name what it is.
  return row.officeId ? `Office ${row.officeId}` : "Office not set";
}

export const MANIFEST_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  CLOSED: "Closed",
  HANDED_OVER: "Handed over",
};
