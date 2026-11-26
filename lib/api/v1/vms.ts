import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import {
  assertVmsEnabled,
  cancelRecording,
  downloadVideo,
  downloadZip,
  finishRecording,
  listVideos,
  parseIds,
  startRecording,
  uploadChunk,
  uploadStatus,
  vmsFinishSchema,
  vmsListSchema,
  vmsStartSchema,
  vmsSummary,
} from "@/modules/vms/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Packing videos. Permissions come from permissionForTenantRoute
 * (GET vms/* = orders.read; everything else = packing.scan).
 *
 *   POST vms/start                  { code }          start recording for a scanned code
 *   GET  vms/:id/chunk                                bytes received so far (resume)
 *   POST vms/:id/chunk?offset=N     raw bytes ≤4 MB   append one upload piece
 *   POST vms/:id/finish             { durationMs }    save and charge
 *   POST vms/:id/cancel                               drop an unsaved recording
 *   GET  vms                        ?q=&from=&to=&page=
 *   GET  vms/summary                                  price, free videos left, wallet
 *   GET  vms/:id/download           ?inline=1         MP4/WebM, supports Range
 *   GET  vms/zip                    ?ids=a,b,c        streamed zip of up to 100 videos
 */
export async function handleVmsRoutes(
  request: NextRequest,
  supabase: SupabaseClient,
  ctx: TenantContext,
  method: string,
  slugs: string[]
) {
  const [root, second, third] = slugs;
  if (root !== "vms") return null;
  assertVmsEnabled();
  const params = request.nextUrl.searchParams;

  if (slugs.length === 1 && method === "GET") {
    return listVideos(supabase, ctx, vmsListSchema.parse(Object.fromEntries(params.entries())));
  }
  if (slugs.length === 2 && second === "summary" && method === "GET") return vmsSummary(supabase, ctx);
  if (slugs.length === 2 && second === "zip" && method === "GET") return downloadZip(supabase, ctx, parseIds(params.get("ids")));
  if (slugs.length === 2 && second === "start" && method === "POST") {
    const body = vmsStartSchema.parse(await request.json().catch(() => ({})));
    return startRecording(supabase, ctx, body.code);
  }

  if (!second || !UUID.test(second) || slugs.length !== 3) return null;

  if (third === "chunk") {
    if (method === "GET") return uploadStatus(supabase, ctx, second);
    if (method === "POST") {
      const offset = Number(params.get("offset"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      return uploadChunk(supabase, ctx, second, offset, bytes);
    }
  }
  if (third === "finish" && method === "POST") {
    const body = vmsFinishSchema.parse(await request.json().catch(() => ({})));
    return finishRecording(supabase, ctx, second, body.durationMs);
  }
  if (third === "cancel" && method === "POST") return cancelRecording(supabase, ctx, second);
  if (third === "download" && method === "GET") {
    return downloadVideo(supabase, ctx, second, {
      inline: params.get("inline") === "1",
      range: request.headers.get("range"),
    });
  }
  return null;
}
