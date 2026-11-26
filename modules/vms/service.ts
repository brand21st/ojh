import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { env } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  appendChunk,
  commitPart,
  nodeVideoStream,
  partSize,
  removePart,
  removeVideo,
  sniffVideo,
  videoFileSize,
  videoReadStream,
  type VideoMime,
} from "@/modules/vms/storage";
import { uniqueNames, zipReadableStream, ZIP_MAX_BYTES, type ZipEntry } from "@/modules/vms/zip-stream";
import {
  VMS_CHUNK_BYTES,
  VMS_MAX_VIDEO_BYTES,
  VMS_ZIP_MAX_VIDEOS,
  type PackingVideo,
  type PackingVideoBilling,
  type PackingVideoList,
  type VmsChunkResult,
  type VmsFinishResult,
  type VmsStartResult,
  type VmsSummary,
} from "@/types/vms";

const COLUMNS =
  "id, organization_id, barcode, order_id, order_number, tracking_number, status, billing_status, charge_micros, mime_type, size_bytes, duration_ms, storage_path, started_at, ended_at, expires_at, recorded_by";

type VideoRow = {
  id: string;
  organization_id: string;
  barcode: string;
  order_id: string | null;
  order_number: string | null;
  tracking_number: string | null;
  status: PackingVideo["status"];
  billing_status: PackingVideoBilling;
  charge_micros: number | string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  duration_ms: number | null;
  storage_path: string | null;
  started_at: string;
  ended_at: string | null;
  expires_at: string | null;
  recorded_by: string | null;
};

export const vmsStartSchema = z.object({ code: z.string().trim().min(1).max(120) });
export const vmsFinishSchema = z.object({ durationMs: z.number().int().min(0).max(6 * 60 * 60 * 1000) });
export const vmsListSchema = z.object({
  q: z.string().trim().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});

export function assertVmsEnabled() {
  if (!env.vmsEnabled) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Packing videos are not switched on yet.");
  }
}

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapVideo(row: VideoRow, names: Map<string, string>): PackingVideo {
  return {
    id: row.id,
    barcode: row.barcode,
    orderId: row.order_id,
    orderNumber: row.order_number,
    trackingNumber: row.tracking_number,
    status: row.status,
    billingStatus: row.billing_status,
    chargeMicros: toNumber(row.charge_micros) ?? 0,
    mimeType: row.mime_type,
    sizeBytes: toNumber(row.size_bytes),
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by ? (names.get(row.recorded_by) ?? null) : null,
  };
}

async function namesFor(userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", ids);
  for (const profile of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    names.set(profile.id, profile.full_name?.trim() || profile.email || "Member");
  }
  return names;
}

/** Reads one video through the caller's RLS, so other workspaces' videos are invisible. */
async function getVideo(supabase: SupabaseClient, ctx: TenantContext, videoId: string) {
  const { data, error } = await supabase
    .from("packing_videos")
    .select(COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .eq("id", videoId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Video not found.");
  return data as VideoRow;
}

async function getOwnRecording(supabase: SupabaseClient, ctx: TenantContext, videoId: string) {
  const video = await getVideo(supabase, ctx, videoId);
  if (video.recorded_by !== ctx.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Only the person recording can upload this video.");
  }
  if (video.status !== "RECORDING") {
    throw new AppError(ERROR_CODES.CONFLICT, "This video is already saved or was cancelled.");
  }
  return video;
}

// Recording -----------------------------------------------------------------------------------

export async function startRecording(supabase: SupabaseClient, ctx: TenantContext, code: string): Promise<VmsStartResult> {
  const { data, error } = await supabase.rpc("vms_start_recording", {
    p_organization_id: ctx.organizationId,
    p_code: code,
  });
  if (error) {
    if (error.code === "42501") throw new AppError(ERROR_CODES.FORBIDDEN, "You do not have access to the packing station.");
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  return data as VmsStartResult;
}

export async function uploadChunk(
  supabase: SupabaseClient,
  ctx: TenantContext,
  videoId: string,
  offset: number,
  bytes: Uint8Array
): Promise<VmsChunkResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid upload offset.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > VMS_CHUNK_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Upload pieces must be between 1 byte and 4 MB.");
  }
  if (offset + bytes.byteLength > VMS_MAX_VIDEO_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This video is too long to save. Keep recordings under 600 MB.");
  }
  await getOwnRecording(supabase, ctx, videoId);
  return appendChunk(ctx.organizationId, videoId, offset, bytes);
}

export async function uploadStatus(supabase: SupabaseClient, ctx: TenantContext, videoId: string): Promise<VmsChunkResult> {
  await getOwnRecording(supabase, ctx, videoId);
  return { ok: true, size: await partSize(ctx.organizationId, videoId) };
}

export async function finishRecording(
  supabase: SupabaseClient,
  ctx: TenantContext,
  videoId: string,
  durationMs: number
): Promise<VmsFinishResult> {
  const video = await getVideo(supabase, ctx, videoId);
  if (video.status === "READY") {
    return { videoId, billingStatus: video.billing_status, sizeBytes: toNumber(video.size_bytes) ?? 0 };
  }
  await getOwnRecording(supabase, ctx, videoId);

  const size = await partSize(ctx.organizationId, videoId);
  if (size === 0) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Nothing was uploaded for this video.");
  const mime = await sniffVideo(ctx.organizationId, videoId);
  if (!mime) {
    await removePart(ctx.organizationId, videoId);
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "The upload is not an MP4 or WebM video.");
  }
  const storagePath = await commitPart(ctx.organizationId, videoId, mime);

  const { data, error } = await createAdminClient().rpc("vms_finalize_video", {
    p_video_id: videoId,
    p_storage_path: storagePath,
    p_size_bytes: size,
    p_duration_ms: durationMs,
    p_mime_type: mime,
  });
  if (error) {
    logError("vms.finalize_failed", { videoId, organizationId: ctx.organizationId, message: error.message });
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "The video was uploaded but could not be saved. Try again.");
  }
  const result = data as { status: string };
  const billingStatus = (["FREE", "CHARGED", "UNPAID"].includes(result.status) ? result.status : "PENDING") as PackingVideoBilling;
  logInfo("vms.saved", { videoId, organizationId: ctx.organizationId, size, billingStatus });
  return { videoId, billingStatus, sizeBytes: size };
}

export async function cancelRecording(supabase: SupabaseClient, ctx: TenantContext, videoId: string) {
  const { data, error } = await supabase.rpc("vms_cancel_recording", { p_video_id: videoId });
  if (error) {
    if (error.code === "42501") throw new AppError(ERROR_CODES.FORBIDDEN, error.message);
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  await removePart(ctx.organizationId, videoId).catch(() => undefined);
  return { ok: Boolean(data) };
}

// Library -------------------------------------------------------------------------------------

/** PostgREST or() filters split on commas and parentheses, so strip them from search text. */
export function searchTerm(q: string | undefined) {
  const cleaned = (q ?? "").replace(/[,()*%\\"']/g, " ").replace(/\s+/g, "").toUpperCase();
  return cleaned.length >= 2 ? cleaned : "";
}

/** IST calendar day bounds, as the rest of the dashboard files things by IST day. */
function istBounds(from?: string, to?: string) {
  return {
    start: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : null,
    end: to ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : null,
  };
}

export async function listVideos(
  supabase: SupabaseClient,
  ctx: TenantContext,
  input: z.infer<typeof vmsListSchema>
): Promise<PackingVideoList> {
  let query = supabase
    .from("packing_videos")
    .select(COLUMNS, { count: "exact" })
    .eq("organization_id", ctx.organizationId)
    .in("status", ["READY"])
    .order("started_at", { ascending: false });
  const term = searchTerm(input.q);
  if (term) {
    const bare = term.replace(/^#/, "");
    query = query.or(
      `barcode.ilike.%${term}%,tracking_number.ilike.%${term}%,order_number.ilike.%${bare}%`
    );
  }
  const { start, end } = istBounds(input.from, input.to);
  if (start) query = query.gte("started_at", start);
  if (end) query = query.lt("started_at", end);
  const fromRow = (input.page - 1) * input.pageSize;
  const { data, error, count } = await query.range(fromRow, fromRow + input.pageSize - 1);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as VideoRow[];
  const names = await namesFor(rows.map((row) => row.recorded_by ?? ""));
  return { items: rows.map((row) => mapVideo(row, names)), total: count ?? rows.length, page: input.page, pageSize: input.pageSize };
}

export async function vmsSummary(supabase: SupabaseClient, ctx: TenantContext): Promise<VmsSummary> {
  const admin = createAdminClient();
  const { data: settings } = await admin
    .from("platform_settings")
    .select("vms_price_micros, vms_free_videos, vms_retention_days")
    .eq("id", 1)
    .maybeSingle();
  const s = (settings ?? {}) as { vms_price_micros?: number | string; vms_free_videos?: number; vms_retention_days?: number };
  const priceMicros = toNumber(s.vms_price_micros ?? null) ?? 1_000_000;
  const freeVideos = s.vms_free_videos ?? 10;
  const retentionDays = s.vms_retention_days ?? 35;

  const { count: freeUsed } = await supabase
    .from("packing_videos")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .eq("billing_status", "FREE");

  const monthStart = new Date(`${new Date(Date.now() + 19_800_000).toISOString().slice(0, 7)}-01T00:00:00+05:30`).toISOString();
  const { count: thisMonth } = await supabase
    .from("packing_videos")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .eq("status", "READY")
    .gte("started_at", monthStart);

  let walletAvailableMicros: number | null = null;
  const { data: wallet, error: walletError } = await admin
    .from("wallets")
    .select("balance_micros, reserved_micros, credit_limit_micros, status")
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!walletError) {
    const w = wallet as { balance_micros: string | number; reserved_micros: string | number; credit_limit_micros: string | number; status: string } | null;
    walletAvailableMicros = w
      ? w.status === "ACTIVE"
        ? (toNumber(w.balance_micros) ?? 0) + (toNumber(w.credit_limit_micros) ?? 0) - (toNumber(w.reserved_micros) ?? 0)
        : 0
      : 0;
  }

  return {
    enabled: env.vmsEnabled,
    priceMicros,
    freeVideos,
    freeRemaining: Math.max(freeVideos - (freeUsed ?? 0), 0),
    retentionDays,
    walletAvailableMicros,
    videosThisMonth: thisMonth ?? 0,
    workspaceName: ctx.organizationName,
    operatorName: ctx.fullName?.trim() || ctx.email || null,
  };
}

// Downloads -----------------------------------------------------------------------------------

/** A video saved while the wallet was short is charged when someone first downloads it. */
async function ensurePaid(video: VideoRow) {
  if (video.billing_status !== "UNPAID" && video.billing_status !== "PENDING") return;
  const { data, error } = await createAdminClient().rpc("vms__charge", { p_video_id: video.id });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Could not charge this video. Try again.");
  const status = (data as { status: string }).status;
  if (status !== "FREE" && status !== "CHARGED") {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      "This video is saved but unpaid. Recharge your wallet (₹1 per video) to download it."
    );
  }
}

function safeFilePart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "video";
}

export function downloadName(video: Pick<VideoRow, "barcode" | "started_at" | "mime_type">) {
  const ist = new Date(new Date(video.started_at).getTime() + 19_800_000).toISOString();
  const stamp = `${ist.slice(0, 10)}_${ist.slice(11, 19).replace(/:/g, "")}`;
  return `${safeFilePart(video.barcode)}_${stamp}.${video.mime_type === "video/webm" ? "webm" : "mp4"}`;
}

/** Parses a single "bytes=start-end" range; anything else plays the whole file. */
export function parseRange(header: string | null, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || size === 0) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid" as const;
  return { start, end };
}

export async function downloadVideo(
  supabase: SupabaseClient,
  ctx: TenantContext,
  videoId: string,
  options: { inline: boolean; range: string | null }
) {
  const video = await getVideo(supabase, ctx, videoId);
  if (video.status !== "READY" || !video.storage_path) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, video.status === "EXPIRED" ? "This video has expired and was deleted." : "Video not found.");
  }
  await ensurePaid(video);
  const size = await videoFileSize(video.storage_path, ctx.organizationId);
  if (size === null) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "The video file is missing on the server.");

  const mime = video.mime_type ?? "video/mp4";
  const name = downloadName(video);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${options.inline ? "inline" : "attachment"}; filename="${name}"`,
    "X-Content-Type-Options": "nosniff",
  };
  const range = parseRange(options.range, size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (range) {
    return new Response(videoReadStream(video.storage_path, ctx.organizationId, range), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }
  return new Response(videoReadStream(video.storage_path, ctx.organizationId), {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}

export function parseIds(raw: string | null) {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  return [...new Set(ids)];
}

export async function downloadZip(supabase: SupabaseClient, ctx: TenantContext, ids: string[]) {
  if (ids.length === 0) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Select at least one video.");
  if (ids.length > VMS_ZIP_MAX_VIDEOS) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Select up to ${VMS_ZIP_MAX_VIDEOS} videos per zip.`);
  }
  const { data, error } = await supabase
    .from("packing_videos")
    .select(COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .eq("status", "READY")
    .in("id", ids)
    .order("started_at", { ascending: true });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as VideoRow[];

  const ready: Array<VideoRow & { storage_path: string }> = [];
  let unpaid = 0;
  let total = 0;
  for (const row of rows) {
    if (!row.storage_path) continue;
    try {
      await ensurePaid(row);
    } catch {
      unpaid += 1;
      continue;
    }
    const size = await videoFileSize(row.storage_path, ctx.organizationId);
    if (size === null) continue;
    total += size;
    ready.push(row as VideoRow & { storage_path: string });
  }
  if (ready.length === 0) {
    throw new AppError(
      unpaid > 0 ? ERROR_CODES.CONFLICT : ERROR_CODES.RESOURCE_NOT_FOUND,
      unpaid > 0 ? "These videos are unpaid. Recharge your wallet to download them." : "None of the selected videos can be downloaded."
    );
  }
  if (total > ZIP_MAX_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "These videos add up to more than 4 GB. Select fewer.");
  }

  const names = uniqueNames(ready.map((row) => downloadName(row)));
  const entries: ZipEntry[] = ready.map((row, index) => ({
    name: names[index],
    modifiedAt: new Date(new Date(row.started_at).getTime() + 19_800_000 + new Date().getTimezoneOffset() * 60_000),
    open: () => nodeVideoStream(row.storage_path, ctx.organizationId),
  }));
  const day = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  return new Response(zipReadableStream(entries), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="packing-videos_${day}_${ready.length}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Videos-Skipped": String(ids.length - ready.length),
    },
  });
}

// Retention -----------------------------------------------------------------------------------

/** Deletes files of expired videos and abandoned recordings. Run from cron. */
export async function expireVideos(limit = 500) {
  const { data, error } = await createAdminClient().rpc("vms_expire_videos", { p_limit: limit });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as Array<{ id: string; organization_id: string; storage_path: string | null; previous_status: string }>;
  let deleted = 0;
  for (const row of rows) {
    try {
      if (row.storage_path) await removeVideo(row.storage_path, row.organization_id);
      await removePart(row.organization_id, row.id);
      deleted += 1;
    } catch (fileError) {
      logError("vms.expire_file_failed", {
        videoId: row.id,
        message: fileError instanceof Error ? fileError.message : "unknown",
      });
    }
  }
  return { expired: rows.length, filesDeleted: deleted };
}

export type { VideoMime };
