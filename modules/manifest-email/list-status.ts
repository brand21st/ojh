import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryStatus } from "@/modules/manifest-email/types";

export type ManifestEmailListStatus = {
  id: string;
  status: DeliveryStatus;
  retryable: boolean;
};

export async function latestManifestEmailStatuses(
  supabase: SupabaseClient,
  organizationId: string,
  manifestIds: string[]
): Promise<Record<string, ManifestEmailListStatus>> {
  if (!manifestIds.length) return {};
  const { data, error } = await supabase
    .from("manifest_email_deliveries")
    .select("id, manifest_id, status, retryable, created_at")
    .eq("organization_id", organizationId)
    .in("manifest_id", manifestIds)
    .order("created_at", { ascending: false });
  if (error || !data?.length) return {};
  const latest: Record<string, ManifestEmailListStatus> = {};
  for (const row of data) {
    const manifestId = String(row.manifest_id ?? "");
    if (!manifestId || latest[manifestId]) continue;
    latest[manifestId] = {
      id: String(row.id),
      status: row.status as DeliveryStatus,
      retryable: Boolean(row.retryable),
    };
  }
  return latest;
}
