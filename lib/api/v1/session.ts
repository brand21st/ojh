import { z } from "zod";
import type { NextRequest } from "next/server";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
  createOrganization,
  ensureActiveWorkspace,
  listMemberships,
} from "@/modules/organizations/service";
import { listOrganizationAddonEntitlements } from "@/modules/addons/entitlements";
import { getOrganizationEntitlements } from "@/modules/billing/entitlements";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTransientAuthClass } from "@/lib/auth/session/classify";
import { getRequestAuthUser } from "@/lib/supabase/request-auth";
import { isMerchantApiOpenForOrg } from "@/modules/merchant-api/flags";
import { setIndiaPostBookingGuideHiddenForUser } from "@/lib/dashboard/india-post-booking-guide";
import { walletEnabled } from "@/modules/wallet/constants";

/** Read with the member's own session (RLS), so it costs two indexed lookups and nothing more. */
async function walletFlags(supabase: SupabaseClient, organizationId: string) {
  if (!walletEnabled()) return { enabled: false };
  const [wallet, alerts] = await Promise.all([
    supabase.from("wallets").select("status").eq("organization_id", organizationId).maybeSingle(),
    supabase
      .from("wallet_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "OPEN"),
  ]);
  return {
    enabled: true,
    frozen: wallet.data?.status === "FROZEN",
    lowBalance: (alerts.count ?? 0) > 0,
  };
}
import { dismissIndiaPostOnboardingForUser } from "@/lib/dashboard/india-post-onboarding";
import { shouldWritePresence } from "@/lib/admin/user-presence";
import { effectivePermissions } from "@/lib/permissions/rbac";
import type { MemberRole } from "@/types/domain";

export async function handleSessionRoutes(
  request: NextRequest,
  supabase: SupabaseClient,
  key: string
) {
  if (key === "GET me") {
    const auth = await getRequestAuthUser();
    const user = auth.user;
    if (auth.classification && isTransientAuthClass(auth.classification)) {
      throw new AppError(ERROR_CODES.AUTH_UNAVAILABLE, "Authentication is temporarily unavailable. Try again shortly.");
    }
    if (!user) throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();
    const ensured = await ensureActiveWorkspace(supabase, user.id, {
      fullName: profile?.full_name ?? user.user_metadata?.full_name,
      email: profile?.email ?? user.email,
      activeOrganizationId: profile?.active_organization_id,
    });
    const organization = ensured.current
      ? { id: ensured.current.id, name: ensured.current.name, slug: ensured.current.slug }
      : null;
    const entitlements = organization
      ? await getOrganizationEntitlements(supabase, organization.id)
      : null;
    const addons = organization ? await listOrganizationAddonEntitlements(supabase, organization.id) : [];
    const { data: memberRow } = organization
      ? await supabase
          .from("organization_members")
          .select("role, status, team, title, extra_permissions, revoked_permissions")
          .eq("organization_id", organization.id)
          .eq("user_id", user.id)
          .maybeSingle()
      : { data: null };
    const role = (memberRow?.role ?? ensured.role ?? null) as MemberRole | null;
    const permissions = role
      ? effectivePermissions(role, {
          extra: memberRow?.extra_permissions as string[] | null,
          revoked: memberRow?.revoked_permissions as string[] | null,
        })
      : [];
    return {
      user: {
        id: user.id,
        email: profile?.email ?? user.email,
        fullName: profile?.full_name,
        avatarUrl: profile?.avatar_url,
        whatsappNumber: profile?.whatsapp_number ?? null,
        indiaPostContractualCustomer: profile?.india_post_contractual_customer ?? null,
        indiaPostOnboardingDismissedAt: profile?.india_post_onboarding_dismissed_at ?? null,
        indiaPostBookingGuideHiddenAt: profile?.india_post_booking_guide_hidden_at ?? null,
      },
      organization,
      role: ensured.role,
      permissions: memberRow?.status === "SUSPENDED" ? [] : permissions,
      member: memberRow
        ? {
            status: memberRow.status ?? "ACTIVE",
            team: memberRow.team ?? null,
            title: memberRow.title ?? null,
          }
        : null,
      organizations: ensured.all.length
        ? ensured.all.map((item) => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            role: item.role,
            status: item.status,
          }))
        : organization
          ? [{ id: organization.id, name: organization.name, slug: organization.slug, role: ensured.role }]
          : [],
      subscription: {
        planCode: entitlements?.planSlug,
        planName: entitlements?.planName,
        status: entitlements?.status ?? "CONFIGURATION_REQUIRED",
        features: entitlements?.features ?? [],
        trial: Boolean(entitlements?.trial),
        trialEnd: entitlements?.trialEnd ?? null,
        trialCohort: entitlements?.trialCohort ?? null,
        coverageEnded: Boolean(entitlements?.coverageEnded),
      },
      merchantApi: {
        enabled: isMerchantApiOpenForOrg(organization?.id),
      },
      wallet: organization ? await walletFlags(supabase, organization.id) : { enabled: false },
      addons: addons
        .filter((row) => row.access_mode === "FULL" || row.access_mode === "READ_ONLY")
        .map((row) => ({
          slug: row.addon_slug,
          accessMode: row.access_mode,
          status: row.status,
        })),
    };
  }

  if (key === "POST invites/accept") {
    const auth = await getRequestAuthUser();
    if (auth.classification && isTransientAuthClass(auth.classification)) {
      throw new AppError(ERROR_CODES.AUTH_UNAVAILABLE, "Authentication is temporarily unavailable. Try again shortly.");
    }
    if (!auth.user) throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    const body = z.object({ token: z.string().trim().min(16).max(200) }).parse(await request.json().catch(() => ({})));
    const { acceptInviteAsUser } = await import("@/modules/team/service");
    return acceptInviteAsUser(body.token, { id: auth.user.id, email: auth.user.email });
  }

  if (key === "POST me/presence") {
    const auth = await getRequestAuthUser();
    const user = auth.user;
    if (auth.classification && isTransientAuthClass(auth.classification)) {
      throw new AppError(
        ERROR_CODES.AUTH_UNAVAILABLE,
        "Authentication is temporarily unavailable. Try again shortly."
      );
    }
    if (!user) throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    const { data: profile, error: readError } = await supabase
      .from("profiles")
      .select("last_active_at")
      .eq("id", user.id)
      .maybeSingle();
    if (readError) {
      throw new AppError(ERROR_CODES.PROFILE_UNAVAILABLE, "Could not record activity.");
    }
    if (!shouldWritePresence(profile?.last_active_at ?? null)) {
      return { ok: true as const, skipped: true as const };
    }
    const lastActiveAt = new Date().toISOString();
    const { error } = await supabase.from("profiles").update({ last_active_at: lastActiveAt }).eq("id", user.id);
    if (error) {
      throw new AppError(ERROR_CODES.PROFILE_UNAVAILABLE, "Could not record activity.");
    }
    const { scheduleSheetsCrmEvent } = await import("@/modules/sheets-crm/enqueue");
    scheduleSheetsCrmEvent({ eventType: "customer.activity.updated", customerId: user.id });
    return { ok: true as const, lastActiveAt };
  }

  if (key === "PATCH me") {
    const auth = await getRequestAuthUser();
    const user = auth.user;
    if (auth.classification && isTransientAuthClass(auth.classification)) {
      throw new AppError(
        ERROR_CODES.AUTH_UNAVAILABLE,
        "Authentication is temporarily unavailable. Try again shortly."
      );
    }
    if (!user) throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    const body = await request.json().catch(() => ({}));
    const parsed = z
      .object({
        indiaPostOnboardingDismissedAt: z.literal(true).optional(),
        indiaPostBookingGuideHidden: z.boolean().optional(),
      })
      .refine(
        (value) =>
          value.indiaPostOnboardingDismissedAt === true || typeof value.indiaPostBookingGuideHidden === "boolean",
        { message: "No preference to save" },
      )
      .parse(body);
    const result: {
      dismissed?: true;
      indiaPostOnboardingDismissedAt?: string;
      indiaPostBookingGuideHiddenAt?: string | null;
    } = {};
    if (parsed.indiaPostOnboardingDismissedAt) {
      Object.assign(result, await dismissIndiaPostOnboardingForUser(supabase, user.id));
    }
    if (typeof parsed.indiaPostBookingGuideHidden === "boolean") {
      Object.assign(
        result,
        await setIndiaPostBookingGuideHiddenForUser(supabase, user.id, parsed.indiaPostBookingGuideHidden),
      );
    }
    return result;
  }

  if (key === "POST organizations") {
    const { user, classification } = await getRequestAuthUser();
    if (classification && isTransientAuthClass(classification)) {
      throw new AppError(ERROR_CODES.AUTH_UNAVAILABLE, "Authentication is temporarily unavailable. Try again shortly.");
    }
    if (!user) throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    const existing = await listMemberships(supabase, user.id);
    if (existing[0]) {
      const org = Array.isArray(existing[0].organizations)
        ? existing[0].organizations[0]
        : existing[0].organizations;
      return org;
    }
    const body = await request.json().catch(() => ({}));
    const name = z.string().min(2).parse(body.name);
    return createOrganization(supabase, user.id, name);
  }

  return null;
}
