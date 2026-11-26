import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { publicAppOrigin } from "@/lib/auth/urls";
import { logInfo } from "@/lib/logger";
import {
  MEMBER_TEAMS,
  canAssignRole,
  canManageMember,
  effectivePermissions,
  normalizeOverrides,
} from "@/lib/permissions/rbac";
import { hashSecret, randomToken } from "@/lib/security/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEMBER_ROLES, type MemberRole } from "@/types/domain";
import type {
  CreatedInvite,
  InviteLookup,
  PackScanResult,
  TeamActivityItem,
  TeamInvite,
  TeamMember,
  TeamPerformance,
} from "@/types/team";
import { sendInviteEmail } from "@/modules/team/invite-email";
import {
  buildPerformance,
  emptyCounts,
  istDay,
  resolveRange,
  type PeopleById,
  type SummaryRow,
} from "@/modules/team/performance";

const INVITE_DAYS = 7;

const roleSchema = z.enum(MEMBER_ROLES);
const teamSchema = z.enum(MEMBER_TEAMS).nullable().optional();
const permissionList = z.array(z.string().max(40)).max(40).optional();

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  fullName: z.string().trim().max(120).optional().nullable(),
  role: roleSchema.default("OPERATOR"),
  team: teamSchema,
  title: z.string().trim().max(80).optional().nullable(),
  extraPermissions: permissionList,
  revokedPermissions: permissionList,
});

export const updateMemberSchema = z
  .object({
    role: roleSchema.optional(),
    team: teamSchema,
    title: z.string().trim().max(80).optional().nullable(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    extraPermissions: permissionList,
    revokedPermissions: permissionList,
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), { message: "Nothing to update" });

export const acceptNewAccountSchema = z.object({
  token: z.string().trim().min(16).max(200),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(72),
});

type MemberRow = {
  id: string;
  user_id: string;
  role: MemberRole;
  status: string | null;
  team: string | null;
  title: string | null;
  extra_permissions: string[] | null;
  revoked_permissions: string[] | null;
  created_at: string;
  last_seen_at: string | null;
};

type InviteRow = {
  id: string;
  organization_id: string;
  email: string;
  full_name: string | null;
  role: MemberRole;
  team: string | null;
  title: string | null;
  extra_permissions: string[] | null;
  revoked_permissions: string[] | null;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function displayName(profile: { full_name?: string | null; email?: string | null } | undefined, fallback = "Member") {
  return profile?.full_name?.trim() || profile?.email?.split("@")[0] || fallback;
}

function inviteUrl(token: string) {
  return `${publicAppOrigin()}/invite/${token}`;
}

function mapInvite(row: InviteRow): TeamInvite {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    team: row.team,
    title: row.title,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    expired: new Date(row.expires_at).getTime() < Date.now(),
  };
}

async function loadMembers(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("organization_members")
    .select("id, user_id, role, status, team, title, extra_permissions, revoked_permissions, created_at, last_seen_at")
    .eq("organization_id", organizationId);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as MemberRow[];
  const ids = rows.map((row) => row.user_id);
  const { data: profiles } = ids.length
    ? await supabase.from("profiles").select("id, email, full_name, last_active_at").in("id", ids)
    : { data: [] };
  const byId = new Map(
    ((profiles ?? []) as Array<{ id: string; email: string | null; full_name: string | null; last_active_at?: string | null }>).map(
      (profile) => [profile.id, profile]
    )
  );
  return { rows, profiles: byId };
}

async function summary(supabase: SupabaseClient, organizationId: string, start: Date, end: Date) {
  const { data, error } = await supabase.rpc("team_activity_summary", {
    p_organization_id: organizationId,
    p_from: start.toISOString(),
    p_to: end.toISOString(),
  });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return (data ?? []) as SummaryRow[];
}

// Members ------------------------------------------------------------------------------------

export async function listTeamMembers(supabase: SupabaseClient, ctx: TenantContext): Promise<TeamMember[]> {
  const { rows, profiles } = await loadMembers(supabase, ctx.organizationId);
  const today = istDay(new Date());
  const todayRange = resolveRange({ from: today, to: today });
  const todayRows = await summary(supabase, ctx.organizationId, todayRange.start, todayRange.end).catch(
    () => [] as SummaryRow[]
  );
  const todayByActor = new Map<string, ReturnType<typeof emptyCounts>>();
  for (const row of todayRows) {
    if (!row.actor_id) continue;
    const counts = todayByActor.get(row.actor_id) ?? emptyCounts();
    const key = row.action as keyof typeof counts;
    if (key in counts) counts[key] += Number(row.action === "manifest.created" ? row.quantity : row.events) || 0;
    todayByActor.set(row.actor_id, counts);
  }

  const order: Record<string, number> = Object.fromEntries(MEMBER_ROLES.map((role, index) => [role, index]));
  return rows
    .map((row) => {
      const profile = profiles.get(row.user_id);
      const overrides = { extra: row.extra_permissions, revoked: row.revoked_permissions };
      const clean = normalizeOverrides(row.role, overrides);
      return {
        id: row.id,
        userId: row.user_id,
        email: profile?.email ?? null,
        fullName: profile?.full_name ?? null,
        role: row.role,
        status: row.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
        team: row.team,
        title: row.title,
        extraPermissions: clean.extra,
        revokedPermissions: clean.revoked,
        permissions: effectivePermissions(row.role, overrides),
        joinedAt: row.created_at,
        lastActiveAt: profile?.last_active_at ?? row.last_seen_at ?? null,
        isYou: row.user_id === ctx.userId,
        canManage: row.user_id !== ctx.userId && canManageMember(ctx.role, row.role),
        today: todayByActor.get(row.user_id) ?? emptyCounts(),
      } satisfies TeamMember;
    })
    .sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || displayName({ full_name: a.fullName, email: a.email }).localeCompare(displayName({ full_name: b.fullName, email: b.email })));
}

async function activeOwnerCount(supabase: SupabaseClient, organizationId: string) {
  const { count } = await supabase
    .from("organization_members")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "OWNER")
    .eq("status", "ACTIVE");
  return count ?? 0;
}

async function getMemberRow(supabase: SupabaseClient, organizationId: string, memberId: string) {
  const { data } = await supabase
    .from("organization_members")
    .select("id, user_id, role, status, team, title, extra_permissions, revoked_permissions, created_at, last_seen_at")
    .eq("organization_id", organizationId)
    .eq("id", memberId)
    .maybeSingle();
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "That member is not in this workspace.");
  return data as MemberRow;
}

export async function updateTeamMember(
  supabase: SupabaseClient,
  ctx: TenantContext,
  memberId: string,
  input: z.infer<typeof updateMemberSchema>
) {
  const target = await getMemberRow(supabase, ctx.organizationId, memberId);
  if (target.user_id === ctx.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You can't change your own access. Ask another owner.");
  }
  if (!canManageMember(ctx.role, target.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Only an owner can change an owner or admin.");
  }
  const nextRole = input.role ?? target.role;
  if (input.role && input.role !== target.role && !canAssignRole(ctx.role, input.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You cannot give that role.");
  }
  const losingOwner =
    target.role === "OWNER" && target.status !== "SUSPENDED" && (nextRole !== "OWNER" || input.status === "SUSPENDED");
  if (losingOwner && (await activeOwnerCount(supabase, ctx.organizationId)) <= 1) {
    throw new AppError(ERROR_CODES.CONFLICT, "A workspace needs at least one active owner.");
  }

  const overrides = normalizeOverrides(nextRole, {
    extra: input.extraPermissions ?? target.extra_permissions,
    revoked: input.revokedPermissions ?? target.revoked_permissions,
  });
  const patch: Record<string, unknown> = {
    role: nextRole,
    extra_permissions: overrides.extra,
    revoked_permissions: overrides.revoked,
  };
  if (input.team !== undefined) patch.team = input.team;
  if (input.title !== undefined) patch.title = input.title || null;
  if (input.status) patch.status = input.status;

  const { error } = await supabase
    .from("organization_members")
    .update(patch)
    .eq("organization_id", ctx.organizationId)
    .eq("id", memberId);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  await audit(supabase, ctx, "member.updated", memberId, target, patch);
  return { ok: true as const };
}

export async function removeTeamMember(supabase: SupabaseClient, ctx: TenantContext, memberId: string) {
  const target = await getMemberRow(supabase, ctx.organizationId, memberId);
  if (target.user_id === ctx.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You can't remove yourself.");
  }
  if (!canManageMember(ctx.role, target.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Only an owner can remove an owner or admin.");
  }
  if (target.role === "OWNER" && (await activeOwnerCount(supabase, ctx.organizationId)) <= 1) {
    throw new AppError(ERROR_CODES.CONFLICT, "A workspace needs at least one active owner.");
  }
  const { error } = await supabase
    .from("organization_members")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("id", memberId);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  await audit(supabase, ctx, "member.removed", memberId, target, null);
  return { ok: true as const };
}

async function audit(
  supabase: SupabaseClient,
  ctx: TenantContext,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown
) {
  await supabase
    .from("audit_logs")
    .insert({
      organization_id: ctx.organizationId,
      actor_id: ctx.userId,
      action,
      entity_type: "organization_member",
      entity_id: entityId,
      before: before ?? null,
      after: after ?? null,
    })
    .then(
      () => undefined,
      () => undefined
    );
}

// Invites ------------------------------------------------------------------------------------

export async function listTeamInvites(supabase: SupabaseClient, ctx: TenantContext): Promise<TeamInvite[]> {
  const { data, error } = await supabase
    .from("organization_invites")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return ((data ?? []) as InviteRow[]).map(mapInvite);
}

export async function createTeamInvite(
  supabase: SupabaseClient,
  ctx: TenantContext,
  input: z.infer<typeof inviteMemberSchema>
): Promise<CreatedInvite> {
  if (!canAssignRole(ctx.role, input.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You cannot give that role.");
  }
  const { rows, profiles } = await loadMembers(supabase, ctx.organizationId);
  const already = rows.find((row) => profiles.get(row.user_id)?.email?.toLowerCase() === input.email);
  if (already) {
    throw new AppError(ERROR_CODES.CONFLICT, "That person is already on your team.");
  }

  // A new invite replaces any open one for the same email.
  await supabase
    .from("organization_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .ilike("email", input.email)
    .is("accepted_at", null)
    .is("revoked_at", null);

  const overrides = normalizeOverrides(input.role, {
    extra: input.extraPermissions,
    revoked: input.revokedPermissions,
  });
  const token = randomToken(24);
  const { data, error } = await supabase
    .from("organization_invites")
    .insert({
      organization_id: ctx.organizationId,
      email: input.email,
      full_name: input.fullName || null,
      role: input.role,
      team: input.team ?? null,
      title: input.title || null,
      extra_permissions: overrides.extra,
      revoked_permissions: overrides.revoked,
      token_hash: hashSecret(token),
      invited_by: ctx.userId,
      expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error?.message ?? "Could not create the invite.");

  const url = inviteUrl(token);
  const emailSent = await sendInviteEmail({
    to: input.email,
    organizationName: ctx.organizationName,
    inviterName: ctx.fullName,
    inviteeName: input.fullName ?? null,
    role: input.role,
    inviteUrl: url,
  });
  logInfo("team.invite.created", { organizationId: ctx.organizationId, role: input.role, emailSent });
  return { ...mapInvite(data as InviteRow), inviteUrl: url, emailSent };
}

export async function resendTeamInvite(supabase: SupabaseClient, ctx: TenantContext, inviteId: string): Promise<CreatedInvite> {
  const { data: existing } = await supabase
    .from("organization_invites")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", inviteId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .maybeSingle();
  if (!existing) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "That invite is no longer open.");
  const invite = existing as InviteRow;
  if (!canAssignRole(ctx.role, invite.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You cannot give that role.");
  }
  const token = randomToken(24);
  const { data, error } = await supabase
    .from("organization_invites")
    .update({
      token_hash: hashSecret(token),
      expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
    })
    .eq("id", inviteId)
    .eq("organization_id", ctx.organizationId)
    .select("*")
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error?.message ?? "Could not renew the invite.");
  const url = inviteUrl(token);
  const emailSent = await sendInviteEmail({
    to: invite.email,
    organizationName: ctx.organizationName,
    inviterName: ctx.fullName,
    inviteeName: invite.full_name,
    role: invite.role,
    inviteUrl: url,
  });
  return { ...mapInvite(data as InviteRow), inviteUrl: url, emailSent };
}

export async function revokeTeamInvite(supabase: SupabaseClient, ctx: TenantContext, inviteId: string) {
  const { error } = await supabase
    .from("organization_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", ctx.organizationId)
    .eq("id", inviteId)
    .is("accepted_at", null);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return { ok: true as const };
}

// Accepting (service role: the person is not a member yet) -----------------------------------

async function findInviteByToken(admin: SupabaseClient, token: string) {
  const clean = token.trim();
  if (clean.length < 16 || clean.length > 200) return null;
  const { data } = await admin
    .from("organization_invites")
    .select("*, organizations(name)")
    .eq("token_hash", hashSecret(clean))
    .maybeSingle();
  return data as (InviteRow & { organizations: { name: string } | { name: string }[] | null }) | null;
}

function inviteState(invite: InviteRow): InviteLookup["status"] {
  if (invite.accepted_at) return "ACCEPTED";
  if (invite.revoked_at) return "REVOKED";
  if (new Date(invite.expires_at).getTime() < Date.now()) return "EXPIRED";
  return "OPEN";
}

async function profileByEmail(admin: SupabaseClient, email: string) {
  const { data } = await admin.from("profiles").select("id, email, full_name").ilike("email", email).limit(1);
  return (data?.[0] ?? null) as { id: string; email: string | null; full_name: string | null } | null;
}

export async function lookupInvite(token: string): Promise<InviteLookup> {
  const admin = createAdminClient();
  const invite = await findInviteByToken(admin, token);
  if (!invite) return { status: "NOT_FOUND" };
  const org = Array.isArray(invite.organizations) ? invite.organizations[0] : invite.organizations;
  const status = inviteState(invite);
  if (status !== "OPEN") return { status, organizationName: org?.name };
  const [inviter, existing] = await Promise.all([
    invite.invited_by
      ? admin.from("profiles").select("full_name, email").eq("id", invite.invited_by).maybeSingle()
      : Promise.resolve({ data: null }),
    profileByEmail(admin, invite.email),
  ]);
  return {
    status,
    organizationName: org?.name ?? "a PostBus workspace",
    email: invite.email,
    fullName: invite.full_name,
    role: invite.role,
    invitedByName: inviter.data ? displayName(inviter.data as { full_name: string | null; email: string | null }, "") || null : null,
    hasAccount: Boolean(existing),
  };
}

async function joinFromInvite(admin: SupabaseClient, invite: InviteRow, userId: string) {
  const overrides = normalizeOverrides(invite.role, {
    extra: invite.extra_permissions,
    revoked: invite.revoked_permissions,
  });
  const { data: existing } = await admin
    .from("organization_members")
    .select("id")
    .eq("organization_id", invite.organization_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) {
    const { error } = await admin.from("organization_members").insert({
      organization_id: invite.organization_id,
      user_id: userId,
      role: invite.role,
      status: "ACTIVE",
      team: invite.team,
      title: invite.title,
      extra_permissions: overrides.extra,
      revoked_permissions: overrides.revoked,
      invited_by: invite.invited_by,
    });
    if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  // Claim the invite; a second click on the same link is harmless.
  await admin
    .from("organization_invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
    .eq("id", invite.id)
    .is("accepted_at", null);
  await admin.from("profiles").update({ active_organization_id: invite.organization_id }).eq("id", userId);
  logInfo("team.invite.accepted", { organizationId: invite.organization_id, role: invite.role });
  return { organizationId: invite.organization_id };
}

function assertOpen(invite: InviteRow | null): asserts invite is InviteRow {
  if (!invite) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This invite link is not valid.");
  const state = inviteState(invite);
  if (state === "EXPIRED") throw new AppError(ERROR_CODES.CONFLICT, "This invite has expired. Ask for a new one.");
  if (state === "REVOKED") throw new AppError(ERROR_CODES.CONFLICT, "This invite was cancelled. Ask for a new one.");
  if (state === "ACCEPTED") throw new AppError(ERROR_CODES.CONFLICT, "This invite was already used. Sign in instead.");
}

/** A signed-in user accepts. Their login email must match the invite. */
export async function acceptInviteAsUser(token: string, user: { id: string; email: string | null | undefined }) {
  const admin = createAdminClient();
  const invite = await findInviteByToken(admin, token);
  assertOpen(invite);
  if ((user.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError(
      ERROR_CODES.FORBIDDEN,
      `This invite is for ${invite.email}. Sign out and sign in with that email.`
    );
  }
  return joinFromInvite(admin, invite, user.id);
}

/**
 * A new person creates their PostBus login from the invite. The invite link stands in for
 * email confirmation: the owner sent it to this address (or shared it with this person).
 */
export async function acceptInviteWithNewAccount(input: z.infer<typeof acceptNewAccountSchema>) {
  const admin = createAdminClient();
  const invite = await findInviteByToken(admin, input.token);
  assertOpen(invite);
  if (await profileByEmail(admin, invite.email)) {
    throw new AppError(ERROR_CODES.CONFLICT, "You already have a PostBus login. Sign in to accept.");
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: invite.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName, invited_to: invite.organization_id },
  });
  if (error || !data.user) {
    const exists = /already|registered|exists/i.test(error?.message ?? "");
    throw new AppError(
      exists ? ERROR_CODES.CONFLICT : ERROR_CODES.VALIDATION_ERROR,
      exists ? "You already have a PostBus login. Sign in to accept." : error?.message ?? "Could not create your login."
    );
  }
  await admin.from("profiles").update({ full_name: input.fullName }).eq("id", data.user.id);
  await joinFromInvite(admin, invite, data.user.id);
  return { email: invite.email };
}

// Performance --------------------------------------------------------------------------------

async function peopleFor(supabase: SupabaseClient, organizationId: string): Promise<PeopleById> {
  const { rows, profiles } = await loadMembers(supabase, organizationId);
  return new Map(
    rows.map((row) => {
      const profile = profiles.get(row.user_id);
      return [row.user_id, { name: displayName(profile), email: profile?.email ?? null, role: row.role, team: row.team }];
    })
  );
}

export async function teamPerformance(
  supabase: SupabaseClient,
  ctx: TenantContext,
  query: { from?: string | null; to?: string | null }
): Promise<TeamPerformance> {
  const range = resolveRange(query);
  const [rows, people] = await Promise.all([
    summary(supabase, ctx.organizationId, range.start, range.end),
    peopleFor(supabase, ctx.organizationId),
  ]);
  return buildPerformance(rows, people, range);
}

export async function teamActivity(
  supabase: SupabaseClient,
  ctx: TenantContext,
  query: { actorId?: string | null; action?: string | null; limit?: number; before?: string | null }
): Promise<TeamActivityItem[]> {
  let request = supabase
    .from("team_activity_events")
    .select("id, action, actor_id, order_id, quantity, metadata, occurred_at")
    .eq("organization_id", ctx.organizationId)
    .order("occurred_at", { ascending: false })
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
  if (query.actorId) request = request.eq("actor_id", query.actorId);
  if (query.action) request = request.eq("action", query.action);
  if (query.before) request = request.lt("occurred_at", query.before);
  const { data, error } = await request;
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    action: TeamActivityItem["action"];
    actor_id: string | null;
    order_id: string | null;
    quantity: number;
    metadata: Record<string, unknown> | null;
    occurred_at: string;
  }>;
  const orderIds = Array.from(new Set(rows.map((row) => row.order_id).filter(Boolean))) as string[];
  const [{ data: orders }, people] = await Promise.all([
    orderIds.length
      ? supabase.from("orders").select("id, order_number").in("id", orderIds)
      : Promise.resolve({ data: [] as Array<{ id: string; order_number: string }> }),
    peopleFor(supabase, ctx.organizationId),
  ]);
  const numbers = new Map(((orders ?? []) as Array<{ id: string; order_number: string }>).map((row) => [row.id, row.order_number]));
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    actorName: row.actor_id ? people.get(row.actor_id)?.name ?? "Former member" : "Automation",
    orderId: row.order_id,
    orderNumber: row.order_id ? numbers.get(row.order_id) ?? null : null,
    barcode: typeof row.metadata?.barcode === "string" ? row.metadata.barcode : null,
    quantity: row.quantity,
    occurredAt: row.occurred_at,
  }));
}

// Packing ------------------------------------------------------------------------------------

export const packScanSchema = z.object({ code: z.string().trim().min(1).max(120) });
export const packUndoSchema = z.object({ orderId: z.string().uuid() });

export async function recordPackScan(supabase: SupabaseClient, ctx: TenantContext, code: string): Promise<PackScanResult> {
  const { data, error } = await supabase.rpc("record_pack_scan", {
    p_organization_id: ctx.organizationId,
    p_code: code,
  });
  if (error) {
    if (error.code === "42501") throw new AppError(ERROR_CODES.FORBIDDEN, "You do not have access to the packing station.");
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  return data as PackScanResult;
}

export async function undoPackScan(supabase: SupabaseClient, ctx: TenantContext, orderId: string) {
  const { data, error } = await supabase.rpc("undo_pack_scan", {
    p_organization_id: ctx.organizationId,
    p_order_id: orderId,
  });
  if (error) {
    if (error.code === "42501") {
      throw new AppError(ERROR_CODES.FORBIDDEN, "Only the packer (within 15 minutes) or a manager can undo this.");
    }
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  return { ok: Boolean(data) };
}

/** Today's packing for the station header: my count, the team's, and my recent scans. */
export async function packingToday(supabase: SupabaseClient, ctx: TenantContext) {
  const today = istDay(new Date());
  const range = resolveRange({ from: today, to: today });
  const { data, error } = await supabase
    .from("team_activity_events")
    .select("actor_id")
    .eq("organization_id", ctx.organizationId)
    .eq("action", "order.packed")
    .gte("occurred_at", range.start.toISOString())
    .lt("occurred_at", range.end.toISOString())
    .limit(10000);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const rows = (data ?? []) as Array<{ actor_id: string | null }>;
  const recent = await teamActivity(supabase, ctx, { actorId: ctx.userId, action: "order.packed", limit: 20 });
  return {
    day: today,
    mine: rows.filter((row) => row.actor_id === ctx.userId).length,
    team: rows.length,
    recent,
  };
}
