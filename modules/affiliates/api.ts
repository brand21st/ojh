import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequestAuthUser } from "@/lib/supabase/request-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { encryptSecret, decryptSecret } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/rate-limit";
import { assertAdminActionPin } from "@/lib/admin/action-pin";
import { applicationSchema, campaignLinkSchema, paise, payoutsEnabled } from "./policy";
import { razorpayxConfigured } from "./razorpayx";
import { istDate } from "./payout-engine";
import { originsMatch } from "@/lib/security/origin";
import { checked, partnerProfile, partnerSummary, requireAffiliates } from "./service";
const uuid = z.uuid();
const actionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("correction"), affiliateId: uuid, linkId: uuid, reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("status"), status: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]), reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("policy"), affiliateId: uuid.nullable(), linkId: uuid.nullable(), basisPoints: z.number().int().min(0).max(10000), fixedPaise: paise.nullable(), reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("tax"), taxPaise: paise, refundedPaise: paise, refundedTaxPaise: paise, reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("adjustment"), amountPaise: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), key: uuid, reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("link"), enabled: z.boolean(), reason: z.string().min(3).max(500) }),
    z.object({ action: z.literal("settings"), registrationOpen: z.boolean(), attributionDays: z.number().int().min(1).max(90), holdDays: z.number().int().min(1).max(365), minimumPayoutPaise: paise.positive(), reason: z.string().min(3).max(500) }),
]);
function sameOrigin(request: NextRequest) {
    if (request.method === "GET")
        return;
    const origin = request.headers.get("origin");
    if (!originsMatch(origin, request.nextUrl.origin))
        throw new AppError(ERROR_CODES.FORBIDDEN, "Invalid request origin.");
}
function pagination(request: NextRequest) {
    const page = z.coerce.number().int().min(0).max(10000).parse(request.nextUrl.searchParams.get("page") || 0);
    return { start: page * 25, end: page * 25 + 24 };
}
export async function handlePartnerApi(request: NextRequest, path: string) {
    requireAffiliates();
    sameOrigin(request);
    const { user } = await getRequestAuthUser();
    if (!user)
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, "Please sign in to continue.");
    if (!rateLimit(`affiliate:${user.id}`, 60, 60000).ok)
        throw new AppError(ERROR_CODES.RATE_LIMITED, "Please try again shortly.");
    const db = createAdminClient();
    const profile = await partnerProfile(db, user.id);
    if ((path === "me" || path === "dashboard" || path === "analytics") && request.method === "GET") {
        const settings = checked(await db.from("affiliate_settings").select("minimum_payout_paise,hold_days,attribution_days,registration_open").single());
        const policy = checked(await db.from("affiliate_policies").select("basis_points").is("affiliate_id", null).is("link_id", null).order("version", { ascending: false }).limit(1).maybeSingle());
        const payload = { profile, email: user.email ?? "", payoutsEnabled: payoutsEnabled(), settings: settings ? { ...settings, default_basis_points: policy?.basis_points ?? null } : null };
        if (path === "me") return payload;
        if (!profile) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Submit your partner application first.");
        const to = z.iso.datetime().parse(request.nextUrl.searchParams.get("to") || new Date().toISOString());
        const from = z.iso.datetime().parse(request.nextUrl.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString());
        if (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000)
            throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Choose a date range of up to one year.");
        return { ...payload, summary: await partnerSummary(db, profile.id, from, to), currency: "INR" };
    }
    if (path === "application" && request.method === "POST") {
        const body = applicationSchema.parse(await request.json());
        const settings = checked(await db.from("affiliate_settings").select("registration_open").single());
        if (!settings?.registration_open)
            throw new AppError(ERROR_CODES.FORBIDDEN, "Partner registration is currently closed.");
        if (profile)
            throw new AppError(ERROR_CODES.CONFLICT, "You already have a partner application.");
        return checked(await db.from("affiliate_profiles").insert({ user_id: user.id, application: body, terms_version: "2026-10-v1" }).select("id,status").single());
    }
    if (!profile)
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Submit your partner application first.");
    if (path === "summary" && request.method === "GET") {
        const to = z.iso.datetime().parse(request.nextUrl.searchParams.get("to") || new Date().toISOString());
        const from = z.iso.datetime().parse(request.nextUrl.searchParams.get("from") || new Date(Date.now() - 30 * 86400000).toISOString());
        if (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000)
            throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Choose a date range of up to one year.");
        return partnerSummary(db, profile.id, from, to);
    }
    if ((path === "links" || path === "campaigns") && request.method === "POST") {
        if (profile.status !== "APPROVED")
            throw new AppError(ERROR_CODES.FORBIDDEN, "Partner approval is required.");
        const campaignBody = path === "campaigns" ? campaignLinkSchema.parse(await request.json()) : null;
        const simpleBody = campaignBody ? null : z.object({ campaign: z.string().trim().max(80).regex(/^[\w -]*$/).default("") }).strict().parse(await request.json());
        const campaign = campaignBody?.campaign ?? simpleBody?.campaign ?? "";
        const extras = campaignBody ? {
            landing_path: campaignBody.landingPath,
            utm_source: campaignBody.utmSource || campaignBody.channel || "",
            utm_medium: campaignBody.utmMedium,
            utm_campaign: campaignBody.utmCampaign || campaignBody.campaign,
        } : {};
        const inserted = await db.from("affiliate_links").insert({ affiliate_id: profile.id, campaign, code: randomBytes(18).toString("base64url"), ...extras }).select("id,code,campaign,enabled,landing_path,utm_source,utm_medium,utm_campaign").maybeSingle();
        if (inserted.error?.code === "23505") {
            return checked(await db.from("affiliate_links").select("id,code,campaign,enabled,landing_path,utm_source,utm_medium,utm_campaign").eq("affiliate_id", profile.id).eq("campaign", campaign).single());
        }
        return checked(inserted);
    }
    if (path === "profile" && request.method === "PATCH") {
        const body = applicationSchema.parse(await request.json());
        checked(await db.from("affiliate_profiles").update({ application: body }).eq("id", profile.id));
        return { saved: true };
    }
    if (path === "accounts" && request.method === "POST") {
        if (profile.status !== "APPROVED")
            throw new AppError(ERROR_CODES.FORBIDDEN, "Partner approval is required.");
        const body = z.object({ name: z.string().trim().min(2).max(100), upi: z.string().trim().regex(/^[\w.\-]{2,100}@[\w.\-]{2,50}$/) }).strict().parse(await request.json());
        if (!process.env.INTEGRATION_ENCRYPTION_KEY)
            throw new AppError(ERROR_CODES.AUTH_UNAVAILABLE, "Payout account storage is not configured.");
        return checked(await db.from("affiliate_payout_accounts").insert({ affiliate_id: profile.id, encrypted_details: encryptSecret(JSON.stringify(body)), masked_details: `UPI •••${body.upi.slice(-4)}` }).select("id,masked_details,created_at").single());
    }
    if (path === "payouts/overview" && request.method === "GET") {
        return payoutOverview(db, profile.id);
    }
    if (path === "payouts" && request.method === "POST") {
        if (!payoutsEnabled())
            throw new AppError(ERROR_CODES.FORBIDDEN, "Payout requests are currently unavailable.");
        const body = z.object({ accountId: uuid, amountPaise: paise.positive(), key: uuid }).strict().parse(await request.json());
        return { id: checked(await db.rpc("affiliate_request_payout", { p_affiliate: profile.id, p_account: body.accountId, p_amount: body.amountPaise, p_key: body.key })) };
    }
    const lists: Record<string, [
        string,
        string
    ]> = {
        links: ["affiliate_links", "id,code,campaign,enabled,created_at"], referrals: ["affiliate_attributions", "id,created_at"],
        commissions: ["affiliate_commissions", "id,amount_paise,net_paise,available_at,created_at"],
        ledger: ["affiliate_ledger_entries", "id,commission_id,kind,amount_paise,created_at"],
        payouts: ["affiliate_payout_requests", "id,amount_paise,status,origin,send_via,hold_reason,failure_reason,utr,settlement_reference,sent_at,created_at,settled_at"],
        accounts: ["affiliate_payout_accounts", "id,masked_details,created_at"], notifications: ["affiliate_notifications", "id,message,created_at"],
    };
    if (request.method === "GET" && (path === "links" || path === "campaigns")) {
        const stats = await db.rpc("affiliate_partner_link_stats", { p_affiliate: profile.id });
        if (!stats.error) return { rows: stats.data || [] };
        const { start, end } = pagination(request);
        return { rows: checked(await db.from("affiliate_links").select("id,code,campaign,enabled,created_at").eq("affiliate_id", profile.id).order("created_at", { ascending: false }).range(start, end)) };
    }
    if (request.method === "GET" && ["referrals", "commissions"].includes(path)) {
        const q = (request.nextUrl.searchParams.get("q") || "").slice(0, 80);
        const status = (request.nextUrl.searchParams.get("status") || "").slice(0, 40);
        const from = request.nextUrl.searchParams.get("from");
        const to = request.nextUrl.searchParams.get("to");
        return checked(await db.rpc("affiliate_partner_records", {
            p_affiliate: profile.id, p_type: path, p_offset: pagination(request).start,
            p_query: q, p_status: status, p_from: from || null, p_to: to || null,
        }));
    }
    if (request.method === "GET" && lists[path]) {
        const [table, fields] = lists[path];
        const { start, end } = pagination(request);
        return checked(await db.from(table).select(fields).eq("affiliate_id", profile.id).order("created_at", { ascending: false }).range(start, end));
    }
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
}
type Row = Record<string, unknown>;
export const autoSettingsSchema = z.object({
    autoPayoutEnabled: z.boolean(),
    autoPayoutDay: z.number().int().min(1).max(28),
    reason: z.string().min(3).max(500),
});
/** Next scheduled payout date (IST) for a given payout day. */
export function nextPayoutDate(now: Date, day: number) {
    const t = istDate(now);
    const [y, m] = t.day < day ? [t.year, t.month] : t.month === 12 ? [t.year + 1, 1] : [t.year, t.month + 1];
    return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
async function payoutOverview(db: SupabaseClient, affiliateId: string) {
    const [settings, balance, account, open] = await Promise.all([
        db.from("affiliate_settings").select("minimum_payout_paise,auto_payout_enabled,auto_payout_day").single(),
        db.rpc("affiliate_balance", { p_affiliate: affiliateId }),
        db.from("affiliate_payout_accounts").select("id,masked_details,created_at").eq("affiliate_id", affiliateId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("affiliate_payout_requests").select("id,amount_paise,status,hold_reason,created_at").eq("affiliate_id", affiliateId).in("status", ["REQUESTED", "APPROVED", "PROCESSING", "REVIEW"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const s = checked(settings) as { minimum_payout_paise: number; auto_payout_enabled: boolean; auto_payout_day: number };
    const acct = checked(account) as { id: string; masked_details: string; created_at: string } | null;
    const automatic = Boolean(s.auto_payout_enabled) && payoutsEnabled() && razorpayxConfigured();
    return {
        automatic,
        balance: checked(balance),
        minimumPaise: String(s.minimum_payout_paise),
        nextPayoutDate: automatic ? nextPayoutDate(new Date(), s.auto_payout_day) : null,
        payoutDay: s.auto_payout_day,
        account: acct ? { masked: acct.masked_details, addedAt: acct.created_at } : null,
        openPayout: checked(open),
    };
}
const adminStatusFilter = z.union([z.literal(""), z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED", "REQUESTED", "PROCESSING", "PAID", "FAILED", "REVIEW", "RETURNED"])]);
/** PostgREST `or()` filter values cannot carry its own delimiters or wildcards. */
export function searchTerm(raw: string | null) {
    return (raw || "").replace(/[^\p{L}\p{N} .@+\-]/gu, "").trim().slice(0, 60);
}
/** Adds `partner_name` so admin tables never need to show raw partner UUIDs. */
async function withPartnerNames(db: SupabaseClient, rows: Row[]) {
    const ids = [...new Set(rows.map(r => r.affiliate_id).filter((v): v is string => typeof v === "string"))];
    if (!ids.length) return rows;
    const profiles = checked(await db.from("affiliate_profiles").select("id,application").in("id", ids)) as { id: string; application: Row }[];
    const names = new Map(profiles.map(p => [p.id, String(p.application?.fullName || "Partner")]));
    return rows.map(r => ({ ...r, partner_name: names.get(String(r.affiliate_id)) ?? null }));
}
async function adminPartnerDetail(db: SupabaseClient, id: string) {
    const profile = checked(await db.from("affiliate_profiles").select("id,user_id,status,application,rejection_reason,terms_version,created_at").eq("id", id).maybeSingle()) as Row | null;
    if (!profile)
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Partner not found.");
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const [summary, links, policies, payouts, accounts, audit, user] = await Promise.all([
        db.rpc("affiliate_summary", { p_affiliate: id, p_from: from, p_to: to }),
        db.rpc("affiliate_partner_link_stats", { p_affiliate: id }),
        db.from("affiliate_policies").select("id,link_id,basis_points,fixed_paise,version,created_at").eq("affiliate_id", id).order("version", { ascending: false }).limit(20),
        db.from("affiliate_payout_requests").select("id,account_id,amount_paise,status,send_via,origin,hold_reason,failure_reason,utr,settlement_reference,settled_at,created_at").eq("affiliate_id", id).order("created_at", { ascending: false }).limit(20),
        db.from("affiliate_payout_accounts").select("id,masked_details,created_at").eq("affiliate_id", id).order("created_at", { ascending: false }),
        db.from("affiliate_audit_logs").select("id,action,details,actor_id,created_at").eq("affiliate_id", id).order("created_at", { ascending: false }).limit(30),
        db.auth.admin.getUserById(String(profile.user_id)),
    ]);
    return {
        profile: { ...profile, email: user.data?.user?.email ?? null },
        summary: checked(summary),
        links: checked(links),
        policies: checked(policies),
        payouts: checked(payouts),
        accounts: checked(accounts),
        audit: checked(audit),
    };
}
export async function handleAffiliateAdmin(request: NextRequest, actorId: string, path: string[]) {
    requireAffiliates();
    sameOrigin(request);
    if (!rateLimit(`affiliate-admin:${actorId}`, 90, 60000).ok)
        throw new AppError(ERROR_CODES.RATE_LIMITED, "Please try again shortly.");
    const db = createAdminClient();
    const section = path[0] || "partners";
    if (request.method === "GET") {
        if (section === "overview")
            return checked(await db.rpc("affiliate_admin_overview"));
        if (section === "report")
            return checked(await db.rpc("affiliate_reconciliation_report", { p_limit: 50 }));
        if (section === "partners" && path[1])
            return adminPartnerDetail(db, uuid.parse(path[1]));
        const tables: Record<string, string> = { partners: "affiliate_profiles", applications: "affiliate_profiles", links: "affiliate_links", campaigns: "affiliate_links", referrals: "affiliate_attributions", commissions: "affiliate_commissions", conversions: "affiliate_commissions", payouts: "affiliate_payout_requests", policies: "affiliate_policies", settings: "affiliate_settings", audit: "affiliate_audit_logs", reconciliation: "affiliate_processing", evidence: "affiliate_payment_evidence", emails: "affiliate_email_outbox" };
        if (!tables[section])
            throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
        const { start, end } = pagination(request);
        let query = db.from(tables[section]).select("*").order("created_at", { ascending: false }).range(start, end);
        const params = request.nextUrl.searchParams;
        if (section === "applications")
            query = query.eq("status", "PENDING");
        const status = adminStatusFilter.parse(params.get("status") || "");
        if (status && (section === "partners" || section === "payouts"))
            query = query.eq("status", status);
        const search = searchTerm(params.get("q"));
        if (search && (section === "partners" || section === "applications"))
            query = query.or(["fullName", "mobile", "business", "channel", "city"].map(key => `application->>${key}.ilike."*${search}*"`).join(","));
        const partner = params.get("partner");
        if (partner && !["partners", "applications", "settings", "reconciliation", "evidence"].includes(section))
            query = query.eq("affiliate_id", uuid.parse(partner));
        const rows = checked(await query) as Row[];
        return withPartnerNames(db, rows);
    }
    const raw = z.object({ pin: z.string(), data: z.record(z.string(), z.unknown()) }).strict().parse(await request.json());
    if (!process.env.ADMIN_ACCOUNT_ACTION_PIN)
        throw new AppError(ERROR_CODES.AUTH_UNAVAILABLE, "A dedicated admin action PIN must be configured.");
    assertAdminActionPin(raw.pin);
    const id = path[1] ? uuid.parse(path[1]) : null;
    if (section === "payouts" && id) {
        if (!payoutsEnabled())
            throw new AppError(ERROR_CODES.FORBIDDEN, "Payout actions are currently disabled.");
        const data = z.object({ action: z.enum(["APPROVED", "REJECTED", "REVIEW", "PAID", "RETURNED"]), reference: z.string().max(150).default(""), reason: z.string().min(3).max(500) }).strict().parse(raw.data);
        checked(await db.rpc("affiliate_settle_payout", { p_id: id, p_action: data.action, p_reference: data.reference, p_actor: actorId, p_reason: data.reason }));
    }
    else if (section === "auto-settings") {
        const data = autoSettingsSchema.parse(raw.data);
        checked(await db.rpc("affiliate_admin_auto_settings", { p_actor: actorId, p_data: data }));
    }
    else if (section === "destination" && id) {
        const account = checked(await db.from("affiliate_payout_accounts").select("affiliate_id,encrypted_details").eq("id", id).single());
        if (!account)
            throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Account not found.");
        checked(await db.from("affiliate_audit_logs").insert({ affiliate_id: account.affiliate_id, actor_id: actorId, action: "payout.destination_viewed", details: { accountId: id } }));
        return JSON.parse(decryptSecret(account.encrypted_details));
    }
    else {
        const data = actionSchema.parse(raw.data);
        checked(await db.rpc("affiliate_admin_action", { p_actor: actorId, p_action: data.action, p_id: id, p_data: data }));
    }
    return { saved: true };
}
