import type { ManifestRecord } from "@/types/api";

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
