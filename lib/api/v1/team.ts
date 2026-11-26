import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import {
  createTeamInvite,
  inviteMemberSchema,
  listTeamInvites,
  listTeamMembers,
  packScanSchema,
  packUndoSchema,
  packingToday,
  recordPackScan,
  removeTeamMember,
  resendTeamInvite,
  revokeTeamInvite,
  teamActivity,
  teamPerformance,
  undoPackScan,
  updateMemberSchema,
  updateTeamMember,
} from "@/modules/team/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Team routes: members, invites, team performance and the packing station.
 * Permissions come from permissionForTenantRoute (members.* = members.manage, except GET members;
 * team/* = team.read; packing/* = packing.scan) and are checked before this runs.
 */
export async function handleTeamRoutes(
  request: NextRequest,
  supabase: SupabaseClient,
  ctx: TenantContext,
  method: string,
  slugs: string[]
) {
  const [root, second, third] = slugs;
  const params = request.nextUrl.searchParams;

  if (root === "members") {
    if (method === "GET" && slugs.length === 1) return { items: await listTeamMembers(supabase, ctx) };
    if (second === "invites") {
      if (method === "GET" && slugs.length === 2) return { items: await listTeamInvites(supabase, ctx) };
      if (method === "POST" && slugs.length === 2) {
        return createTeamInvite(supabase, ctx, inviteMemberSchema.parse(await request.json().catch(() => ({}))));
      }
      if (third && UUID.test(third)) {
        if (method === "DELETE" && slugs.length === 3) return revokeTeamInvite(supabase, ctx, third);
        if (method === "POST" && slugs[3] === "resend") return resendTeamInvite(supabase, ctx, third);
      }
      return null;
    }
    if (second && UUID.test(second) && slugs.length === 2) {
      if (method === "PATCH") {
        return updateTeamMember(supabase, ctx, second, updateMemberSchema.parse(await request.json().catch(() => ({}))));
      }
      if (method === "DELETE") return removeTeamMember(supabase, ctx, second);
    }
    return null;
  }

  if (root === "team" && method === "GET") {
    if (second === "performance") {
      return teamPerformance(supabase, ctx, { from: params.get("from"), to: params.get("to") });
    }
    if (second === "activity") {
      const actorId = params.get("actorId");
      return {
        items: await teamActivity(supabase, ctx, {
          actorId: actorId && UUID.test(actorId) ? actorId : null,
          action: params.get("action"),
          before: params.get("before"),
          limit: Number(params.get("limit") ?? 50) || 50,
        }),
      };
    }
    return null;
  }

  if (root === "packing") {
    if (method === "POST" && second === "scan") {
      const body = packScanSchema.parse(await request.json().catch(() => ({})));
      return recordPackScan(supabase, ctx, body.code);
    }
    if (method === "POST" && second === "undo") {
      const body = packUndoSchema.parse(await request.json().catch(() => ({})));
      return undoPackScan(supabase, ctx, body.orderId);
    }
    if (method === "GET" && second === "today") return packingToday(supabase, ctx);
    return null;
  }

  return null;
}
