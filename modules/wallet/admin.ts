import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAdminActionPin } from "@/lib/admin/action-pin";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { AdminContext } from "@/lib/api/admin-context";
import { UTF8_BOM, toCsv } from "@/lib/csv";
import { logError } from "@/lib/logger";
import { writeBillingAudit } from "@/modules/billing/audit";
import { refundRazorpayPayment } from "@/modules/razorpay/client";
import { ADJUSTMENT_KINDS, LEDGER_LABELS, type LedgerEntryType } from "@/modules/wallet/constants";
import { parseRupeesToMicros, toMicros, ZERO } from "@/modules/wallet/money";
import { WHATSAPP_CATEGORIES } from "@/modules/wallet/pricing";
import { walletStatementRows } from "@/modules/wallet/read";
import { adminAdjustWallet, migrateAiCredits, reconcileWallets, setWalletStatus } from "@/modules/wallet/service";

/**
 * Super Admin → Wallet Management. Every money-moving action needs the
 * confirmation PIN and a reason, runs through a database function that
 * re-checks platform_admins, and lands in billing_audit_logs.
 */

const UUID = z.string().uuid();
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(400);
const pin = z.string().regex(/^\d{6}$/, "Enter the 6-digit confirmation PIN.");
const rupees = z.string().trim().min(1).max(20);

function ip(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

function micros(value: string, label: string, allowZero = false) {
  let parsed: bigint;
  try {
    parsed = parseRupeesToMicros(value);
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${label}: enter an amount like 100 or 0.115.`);
  }
  if (parsed < ZERO || (!allowZero && parsed === ZERO)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${label} must be ${allowZero ? "zero or more" : "more than zero"}.`);
  }
  return parsed;
}

async function rpc<T = Record<string, unknown>>(db: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.code === "42501") throw new AppError(ERROR_CODES.FORBIDDEN, "Platform admin required.");
    if (error.code === "22023") throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
    logError("wallet.admin_rpc_failed", { fn, message: error.message });
    throw new AppError(ERROR_CODES.JOB_FAILED, "The wallet action failed. Nothing was changed.");
  }
  return data as T;
}

async function audit(db: SupabaseClient, request: NextRequest, ctx: AdminContext, action: string, organizationId: string | null, metadata: Record<string, unknown>) {
  await writeBillingAudit(db, {
    actorId: ctx.userId,
    actorType: "SUPER_ADMIN",
    action,
    targetType: "wallet",
    targetId: organizationId,
    organizationId,
    ip: ip(request),
    metadata,
  });
}

const SETTINGS_COLUMNS =
  "wallet_recharge_min_paise, wallet_recharge_max_paise, wallet_recharge_presets_paise, wallet_gst_rate_bps, wallet_gst_place_of_supply, wallet_invoice_sac, wallet_signup_promo_enabled, wallet_signup_promo_micros::text, wallet_ai_credit_rate_micros::text, wallet_default_thresholds_micros, wallet_whatsapp_billing_enabled, wallet_whatsapp_resume_hours";

const settingsSchema = z
  .object({
    pin,
    reason,
    rechargeMinRupees: z.number().int().min(1).max(1_000_000).optional(),
    rechargeMaxRupees: z.number().int().min(1).max(1_000_000).optional(),
    rechargePresetsRupees: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(8).optional(),
    gstRatePercent: z.number().min(0).max(99.99).optional(),
    gstPlaceOfSupply: z.enum(["INTRA", "INTER"]).optional(),
    invoiceSac: z.string().trim().regex(/^(|\d{4,8})$/, "SAC is 4 to 8 digits.").optional(),
    signupPromoEnabled: z.boolean().optional(),
    signupPromoRupees: rupees.optional(),
    lowBalanceThresholdsRupees: z.array(z.number().int().min(1).max(1_000_000)).max(5).optional(),
    whatsappBillingEnabled: z.boolean().optional(),
    whatsappResumeHours: z.number().int().min(0).max(168).optional(),
  })
  .refine((v) => v.rechargeMinRupees == null || v.rechargeMaxRupees == null || v.rechargeMinRupees <= v.rechargeMaxRupees, {
    message: "Minimum recharge must not exceed the maximum.",
  });

const pricingSchema = z.object({
  pin,
  service: z.enum(["whatsapp", "ai"]),
  organizationId: UUID.nullable().optional(),
  whatsappCategory: z.enum(["*", ...WHATSAPP_CATEGORIES]).optional(),
  countryCode: z.string().trim().regex(/^(\*|[A-Za-z]{2})$/).optional(),
  provider: z.string().trim().min(1).max(60).optional(),
  aiFeature: z.string().trim().min(1).max(80).optional(),
  aiModel: z.string().trim().min(1).max(160).optional(),
  perUnitRupees: rupees,
  per1kInputTokensRupees: rupees.optional(),
  per1kOutputTokensRupees: rupees.optional(),
  markupPercent: z.number().min(0).max(1000).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(300).optional(),
});

function pct(value: number | undefined) {
  return value == null ? 0 : Math.round(value * 100);
}

export async function handleAdminWallet(
  request: NextRequest,
  db: SupabaseClient,
  ctx: AdminContext,
  slugs: string[],
  method: string
) {
  const path = slugs.join("/");
  const key = `${method} ${path}`;
  const params = request.nextUrl.searchParams;

  if (key === "GET overview") return rpc(db, "wallet_admin_totals", {});

  if (key === "GET wallets") {
    const page = Math.max(1, Math.trunc(Number(params.get("page")) || 1));
    const pageSize = Math.min(100, Math.max(10, Math.trunc(Number(params.get("pageSize")) || 25)));
    const sort = z
      .enum(["balance_asc", "balance_desc", "recharged_desc", "whatsapp_desc", "ai_desc", "last_recharge_desc", "name_asc"])
      .catch("balance_asc")
      .parse(params.get("sort") ?? "balance_asc");
    const status = z.enum(["", "ACTIVE", "FROZEN", "LOW", "NOT_MIGRATED"]).catch("").parse(params.get("status") ?? "");
    const result = await rpc<{ rows: unknown[]; total: number }>(db, "wallet_admin_list", {
      p_search: (params.get("q") ?? "").slice(0, 100),
      p_status: status,
      p_sort: sort,
      p_limit: pageSize,
      p_offset: (page - 1) * pageSize,
    });
    return { ...result, page, pageSize };
  }

  if (slugs[0] === "wallets" && slugs[1]) {
    const organizationId = UUID.parse(slugs[1]);
    const action = slugs[2] ?? "";

    if (method === "GET" && action === "") return walletDetail(db, organizationId);

    if (method === "GET" && action === "statement") {
      const range = z
        .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .parse({ from: params.get("from"), to: params.get("to") });
      const rows = await walletStatementRows(db, organizationId, range);
      await audit(db, request, ctx, "wallet.statement_exported", organizationId, range);
      return new NextResponse(UTF8_BOM + toCsv(rows), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="wallet-${organizationId.slice(0, 8)}-${range.from}-to-${range.to}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (method !== "POST") throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (action === "adjust") {
      const input = z
        .object({ pin, reason, kind: z.enum(ADJUSTMENT_KINDS), amountRupees: rupees, idempotencyKey: UUID })
        .parse(body);
      assertAdminActionPin(input.pin);
      const result = await adminAdjustWallet(db, {
        organizationId,
        kind: input.kind,
        amountMicros: micros(input.amountRupees, "Amount"),
        reason: input.reason,
        adminUserId: ctx.userId,
        adminEmail: ctx.email,
        idempotencyKey: input.idempotencyKey,
      });
      if (result.status === "INSUFFICIENT_BALANCE") {
        throw new AppError(ERROR_CODES.CONFLICT, "The wallet does not have that much available to debit.");
      }
      await audit(db, request, ctx, `wallet.adjust.${input.kind.toLowerCase()}`, organizationId, {
        amountRupees: input.amountRupees,
        reason: input.reason,
        status: result.status,
        adjustmentId: result.raw.adjustmentId,
      });
      return { status: result.status, balanceMicros: result.snapshot?.balanceMicros.toString() ?? null };
    }

    if (action === "status") {
      const input = z.object({ pin, reason, status: z.enum(["ACTIVE", "FROZEN"]) }).parse(body);
      assertAdminActionPin(input.pin);
      const result = await setWalletStatus(db, { organizationId, status: input.status, reason: input.reason, adminUserId: ctx.userId });
      if (result.status === "BALANCE_SHORT") {
        throw new AppError(ERROR_CODES.CONFLICT, "Add credit first: the balance does not cover money already on hold.");
      }
      await audit(db, request, ctx, `wallet.${input.status === "FROZEN" ? "frozen" : "unfrozen"}`, organizationId, { reason: input.reason });
      return { status: result.status };
    }

    if (action === "credit-limit") {
      const input = z.object({ pin, reason, limitRupees: rupees }).parse(body);
      assertAdminActionPin(input.pin);
      const result = await rpc(db, "wallet_set_credit_limit", {
        p_org: organizationId,
        p_limit_micros: micros(input.limitRupees, "Credit limit", true).toString(),
        p_reason: input.reason,
        p_admin_user_id: ctx.userId,
      });
      if (result.status === "BELOW_HOLDS") throw new AppError(ERROR_CODES.CONFLICT, "That limit is below money already on hold.");
      await audit(db, request, ctx, "wallet.credit_limit_set", organizationId, { limitRupees: input.limitRupees, reason: input.reason });
      return { status: result.status };
    }

    if (action === "migrate-ai-credits") {
      assertAdminActionPin(z.object({ pin }).parse(body).pin);
      const result = await migrateAiCredits(db, organizationId);
      await audit(db, request, ctx, "wallet.ai_credits_migrated", organizationId, { status: result.status, raw: result.raw });
      return { status: result.status, credits: result.raw.credits ?? 0, creditedMicros: result.raw.creditedMicros ?? "0" };
    }

    if (action === "thresholds") {
      const input = z
        .object({ pin, reason, thresholdsRupees: z.array(z.number().int().min(1).max(1_000_000)).max(5) })
        .parse(body);
      assertAdminActionPin(input.pin);
      const thresholds = [...new Set(input.thresholdsRupees)].sort((a, b) => b - a).map((r) => String(BigInt(r) * BigInt(1_000_000)));
      const { error } = await db.from("wallets").update({ low_balance_thresholds_micros: thresholds }).eq("organization_id", organizationId);
      if (error) throw new AppError(ERROR_CODES.JOB_FAILED, "Could not save the alert levels.");
      await audit(db, request, ctx, "wallet.thresholds_set", organizationId, { thresholdsRupees: input.thresholdsRupees, reason: input.reason });
      return { status: "UPDATED" };
    }

    if (action === "refund-recharge") {
      const input = z.object({ pin, reason, rechargeOrderId: UUID, amountRupees: rupees }).parse(body);
      assertAdminActionPin(input.pin);
      return refundRecharge(db, request, ctx, organizationId, input);
    }

    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
  }

  if (key === "POST migrate-ai-credits") {
    const input = z.object({ pin, limit: z.number().int().min(1).max(5000).default(500) }).parse(await request.json());
    assertAdminActionPin(input.pin);
    const result = await rpc(db, "wallet_migrate_all_ai_credits", { p_limit: input.limit });
    await audit(db, request, ctx, "wallet.ai_credits_migrated_all", null, result);
    return result;
  }

  if (key === "GET pricing") return pricingOverview(db);

  if (key === "POST pricing") {
    const input = pricingSchema.parse(await request.json());
    assertAdminActionPin(input.pin);
    const rule = {
      service: input.service,
      organizationId: input.organizationId ?? null,
      whatsappCategory: input.service === "whatsapp" ? input.whatsappCategory ?? "*" : "*",
      countryCode: input.service === "whatsapp" ? (input.countryCode ?? "*").toUpperCase() : "*",
      provider: input.provider ?? "*",
      aiFeature: input.service === "ai" ? input.aiFeature ?? "*" : "*",
      aiModel: input.service === "ai" ? input.aiModel ?? "*" : "*",
      perUnitMicros: micros(input.perUnitRupees, "Price", true).toString(),
      per1kInputTokensMicros: input.service === "ai" && input.per1kInputTokensRupees ? micros(input.per1kInputTokensRupees, "Input token rate", true).toString() : "0",
      per1kOutputTokensMicros: input.service === "ai" && input.per1kOutputTokensRupees ? micros(input.per1kOutputTokensRupees, "Output token rate", true).toString() : "0",
      markupBps: pct(input.markupPercent),
      discountBps: pct(input.discountPercent),
      effectiveFrom: input.effectiveFrom ?? new Date().toISOString(),
      note: input.note ?? null,
    };
    const result = await rpc(db, "wallet_set_pricing_rule", { p_rule: rule, p_admin_user_id: ctx.userId });
    if (result.status === "EFFECTIVE_FROM_TOO_EARLY") {
      throw new AppError(ERROR_CODES.CONFLICT, "A new rate must start after the current one for the same item.");
    }
    await audit(db, request, ctx, "wallet.pricing_rule_set", rule.organizationId, { rule, result });
    return result;
  }

  if (key === "POST allowances") {
    const input = z
      .object({
        pin,
        organizationId: UUID.nullable().optional(),
        whatsappCategory: z.enum(WHATSAPP_CATEGORIES),
        monthlyMessages: z.number().int().min(0).max(1_000_000),
        note: z.string().trim().max(300).optional(),
      })
      .parse(await request.json());
    assertAdminActionPin(input.pin);
    const result = await rpc(db, "wallet_set_free_allowance", {
      p_org: input.organizationId ?? null,
      p_category: input.whatsappCategory,
      p_monthly_messages: input.monthlyMessages,
      p_note: input.note ?? null,
      p_admin_user_id: ctx.userId,
    });
    await audit(db, request, ctx, "wallet.free_allowance_set", input.organizationId ?? null, { ...input, pin: undefined });
    return result;
  }

  if (key === "GET settings") {
    const { data, error } = await db.from("platform_settings").select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle();
    if (error) throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load wallet settings.");
    return settingsView(data as Record<string, unknown> | null);
  }

  if (key === "PATCH settings") {
    const input = settingsSchema.parse(await request.json());
    assertAdminActionPin(input.pin);
    const update: Record<string, unknown> = {};
    if (input.rechargeMinRupees != null) update.wallet_recharge_min_paise = input.rechargeMinRupees * 100;
    if (input.rechargeMaxRupees != null) update.wallet_recharge_max_paise = input.rechargeMaxRupees * 100;
    if (input.rechargePresetsRupees) update.wallet_recharge_presets_paise = [...new Set(input.rechargePresetsRupees)].sort((a, b) => a - b).map((r) => r * 100);
    if (input.gstRatePercent != null) update.wallet_gst_rate_bps = Math.round(input.gstRatePercent * 100);
    if (input.gstPlaceOfSupply) update.wallet_gst_place_of_supply = input.gstPlaceOfSupply;
    if (input.invoiceSac != null) update.wallet_invoice_sac = input.invoiceSac;
    if (input.signupPromoEnabled != null) update.wallet_signup_promo_enabled = input.signupPromoEnabled;
    if (input.signupPromoRupees != null) update.wallet_signup_promo_micros = micros(input.signupPromoRupees, "Signup promo", true).toString();
    if (input.lowBalanceThresholdsRupees) {
      update.wallet_default_thresholds_micros = [...new Set(input.lowBalanceThresholdsRupees)].sort((a, b) => b - a).map((r) => String(BigInt(r) * BigInt(1_000_000)));
    }
    if (input.whatsappBillingEnabled != null) update.wallet_whatsapp_billing_enabled = input.whatsappBillingEnabled;
    if (input.whatsappResumeHours != null) update.wallet_whatsapp_resume_hours = input.whatsappResumeHours;
    if (!Object.keys(update).length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Nothing to change.");

    if (input.whatsappBillingEnabled === true) {
      const { count } = await db
        .from("wallet_pricing_rules")
        .select("id", { count: "exact", head: true })
        .eq("service", "whatsapp")
        .eq("whatsapp_category", "UTILITY")
        .is("effective_to", null);
      if (!count) {
        throw new AppError(ERROR_CODES.CONFLICT, "Set a WhatsApp Utility rate in Pricing before turning WhatsApp billing on.");
      }
    }

    const { data: before } = await db.from("platform_settings").select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle();
    const { error } = await db.from("platform_settings").update(update).eq("id", 1);
    if (error) {
      if (error.code === "23514") throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Those settings are out of range.");
      throw new AppError(ERROR_CODES.JOB_FAILED, "Could not save wallet settings.");
    }
    await audit(db, request, ctx, "wallet.settings_updated", null, { reason: input.reason, before, changes: update });
    const { data } = await db.from("platform_settings").select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle();
    return settingsView(data as Record<string, unknown> | null);
  }

  if (key === "GET reconciliation") {
    const { data, error } = await db
      .from("wallet_reconciliation_issues")
      .select("id, organization_id, balance_micros::text, ledger_sum_micros::text, reserved_micros::text, held_sum_micros::text, detected_at, resolved_at, note, organizations(name)")
      .order("detected_at", { ascending: false })
      .limit(100);
    if (error) throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load reconciliation issues.");
    return { issues: data ?? [] };
  }

  if (key === "POST reconciliation/run") {
    const found = await reconcileWallets(db);
    await audit(db, request, ctx, "wallet.reconcile_run", null, { mismatches: found });
    return { mismatches: found };
  }

  if (slugs[0] === "reconciliation" && slugs[2] === "resolve" && method === "POST") {
    const issueId = UUID.parse(slugs[1]);
    const input = z.object({ pin, note: reason }).parse(await request.json());
    assertAdminActionPin(input.pin);
    const result = await rpc(db, "wallet_resolve_reconciliation_issue", { p_issue_id: issueId, p_note: input.note, p_admin_user_id: ctx.userId });
    await audit(db, request, ctx, "wallet.reconcile_resolved", null, { issueId, note: input.note });
    return result;
  }

  throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
}

function settingsView(row: Record<string, unknown> | null) {
  const r = row ?? {};
  const paise = (v: unknown, d: number) => Number(v ?? d);
  return {
    rechargeMinRupees: paise(r.wallet_recharge_min_paise, 10000) / 100,
    rechargeMaxRupees: paise(r.wallet_recharge_max_paise, 5000000) / 100,
    rechargePresetsRupees: (Array.isArray(r.wallet_recharge_presets_paise) ? r.wallet_recharge_presets_paise : []).map((v) => Number(v) / 100),
    gstRatePercent: paise(r.wallet_gst_rate_bps, 1800) / 100,
    gstPlaceOfSupply: r.wallet_gst_place_of_supply === "INTER" ? "INTER" : "INTRA",
    invoiceSac: String(r.wallet_invoice_sac ?? ""),
    signupPromoEnabled: Boolean(r.wallet_signup_promo_enabled),
    signupPromoMicros: String(r.wallet_signup_promo_micros ?? "100000000"),
    aiCreditRateMicros: String(r.wallet_ai_credit_rate_micros ?? "200000"),
    lowBalanceThresholdsRupees: (Array.isArray(r.wallet_default_thresholds_micros) ? r.wallet_default_thresholds_micros : []).map(
      (v) => Number(toMicros(String(v)) / BigInt(1_000_000))
    ),
    whatsappBillingEnabled: Boolean(r.wallet_whatsapp_billing_enabled),
    whatsappResumeHours: Number(r.wallet_whatsapp_resume_hours ?? 24),
  };
}

async function pricingOverview(db: SupabaseClient) {
  const [rules, allowances] = await Promise.all([
    db
      .from("wallet_pricing_rules")
      .select(
        "id, service, organization_id, whatsapp_category, country_code, provider, ai_feature, ai_model, per_unit_micros::text, per_1k_input_tokens_micros::text, per_1k_output_tokens_micros::text, markup_bps, discount_bps, effective_from, effective_to, superseded_by, note, created_by, created_at, organizations(name)"
      )
      .order("service")
      .order("effective_from", { ascending: false })
      .limit(500),
    db
      .from("wallet_free_allowances")
      .select("id, organization_id, whatsapp_category, monthly_messages, effective_from, effective_to, note, organizations(name)")
      .order("effective_from", { ascending: false })
      .limit(200),
  ]);
  if (rules.error) throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load pricing.");
  return { rules: rules.data ?? [], allowances: allowances.data ?? [] };
}

async function walletDetail(db: SupabaseClient, organizationId: string) {
  const [wallet, org, ledger, adjustments, events, recharges, aiUsage, waUsage] = await Promise.all([
    db
      .from("wallets")
      .select("status, balance_micros::text, reserved_micros::text, credit_limit_micros::text, low_balance_thresholds_micros, lifetime_recharged_micros::text, lifetime_whatsapp_micros::text, lifetime_ai_micros::text, lifetime_promo_micros::text, lifetime_refunded_micros::text, last_recharged_at, ai_credits_migrated_at, created_at")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    db.from("organizations").select("id, name, ai_credits_balance").eq("id", organizationId).maybeSingle(),
    db
      .from("wallet_ledger")
      .select("id, entry_type, service, amount_micros::text, balance_after_micros::text, description, actor_user_id, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("wallet_adjustments")
      .select("id, kind, amount_micros::text, reason, admin_email, admin_user_id, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("wallet_status_events")
      .select("id, from_status, to_status, reason, admin_user_id, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("wallet_recharge_orders")
      .select("id, razorpay_payment_id, amount_paise, tax_paise, credit_micros::text, refunded_paise, status, method, created_at, paid_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("ai_usage_records")
      .select("feature, status, charge_micros::text, input_tokens, output_tokens, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("whatsapp_usage_records")
      .select("event, category, status, charge_micros::text, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  if (!org.data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Tenant not found.");
  if (!wallet.data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This tenant has no wallet yet.");

  const summarize = (rows: Array<Record<string, unknown>>, keyField: string) => {
    const byKey = new Map<string, { count: number; chargedMicros: bigint; refused: number }>();
    for (const row of rows) {
      const k = String(row[keyField] ?? "other");
      const entry = byKey.get(k) ?? { count: 0, chargedMicros: ZERO, refused: 0 };
      entry.count += 1;
      if (row.status === "CHARGED") entry.chargedMicros += toMicros(String(row.charge_micros ?? "0"));
      if (row.status === "REJECTED" || row.status === "BLOCKED") entry.refused += 1;
      byKey.set(k, entry);
    }
    return [...byKey.entries()].map(([k, v]) => ({ key: k, count: v.count, chargedMicros: v.chargedMicros.toString(), refused: v.refused }));
  };

  return {
    organization: { id: org.data.id, name: org.data.name, legacyAiCredits: Number(org.data.ai_credits_balance ?? 0) },
    wallet: wallet.data,
    ledger: (ledger.data ?? []).map((row) => ({
      ...row,
      label: LEDGER_LABELS[String(row.entry_type) as LedgerEntryType] ?? row.entry_type,
    })),
    adjustments: adjustments.data ?? [],
    statusEvents: events.data ?? [],
    recharges: recharges.data ?? [],
    aiUsage: summarize((aiUsage.data ?? []) as Array<Record<string, unknown>>, "feature"),
    whatsappUsage: summarize((waUsage.data ?? []) as Array<Record<string, unknown>>, "event"),
  };
}

/** Refunds a recharge through Razorpay. The refund webhook then takes the credit back. */
async function refundRecharge(
  db: SupabaseClient,
  request: NextRequest,
  ctx: AdminContext,
  organizationId: string,
  input: { reason: string; rechargeOrderId: string; amountRupees: string }
) {
  const { data: order } = await db
    .from("wallet_recharge_orders")
    .select("id, razorpay_payment_id, amount_paise, refunded_paise, status")
    .eq("id", input.rechargeOrderId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!order) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Recharge not found for this tenant.");
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(String(order.status)) || !order.razorpay_payment_id) {
    throw new AppError(ERROR_CODES.CONFLICT, "Only a paid recharge can be refunded.");
  }
  const amount = micros(input.amountRupees, "Refund amount");
  if (amount % BigInt(10_000) !== ZERO) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Refunds are in whole paise.");
  const paise = Number(amount / BigInt(10_000));
  const refundable = Number(order.amount_paise) - Number(order.refunded_paise);
  if (paise > refundable) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `At most ₹${(refundable / 100).toFixed(2)} can still be refunded.`);
  }
  const refund = await refundRazorpayPayment(String(order.razorpay_payment_id), paise);
  await audit(db, request, ctx, "wallet.recharge_refund_requested", organizationId, {
    rechargeOrderId: order.id,
    razorpayPaymentId: order.razorpay_payment_id,
    refundPaise: paise,
    razorpayRefundId: refund.id ?? null,
    reason: input.reason,
  });
  return {
    status: "REFUND_REQUESTED",
    razorpayRefundId: refund.id ?? null,
    note: "Razorpay confirms the refund by webhook; the wallet credit is taken back then.",
  };
}
