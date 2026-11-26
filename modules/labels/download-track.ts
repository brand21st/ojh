import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/logger";

type TrackRequest = {
  headers: { get(name: string): string | null };
  url?: string;
  nextUrl?: { searchParams: { get(name: string): string | null } };
};

export function shouldTrackLabelDownload(request: TrackRequest) {
  const header = request.headers.get("x-label-download");
  if (header === "1") return true;
  const fromNext = request.nextUrl?.searchParams.get("track");
  if (fromNext === "1") return true;
  if (!request.url) return false;
  try {
    return new URL(request.url).searchParams.get("track") === "1";
  } catch {
    return false;
  }
}

export async function markLabelsDownloaded(
  supabase: SupabaseClient,
  organizationId: string,
  labelIds: string[]
) {
  const ids = [...new Set(labelIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return;
  const { error } = await supabase
    .from("labels")
    .update({ downloaded_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) {
    logError("LABEL_DOWNLOAD_TRACK_FAILED", {
      organizationId,
      message: error.message,
    });
  }
}
