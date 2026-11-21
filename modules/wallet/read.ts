import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { LEDGER_LABELS, type LedgerEntryType } from "@/modules/wallet/constants";
import { formatMicros, toMicros, ZERO } from "@/modules/wallet/money";
import { isMissingRelation } from "@/modules/wallet/recharge";

/**
 * Read models for the merchant Wallet page. Callers pass a service-role
 * client and the organization from the signed-in tenant context; every query
 * is filtered by that organization. Money leaves here as strings of micros.
 */

export type TransactionFilter = "all" | "recharge" | "whatsapp" | "ai" | "credits";

const CREDIT_TYPES = ["PROMO_CREDIT", "ADMIN_CREDIT", "ADMIN_REFUND", "ADMIN_DEBIT", "MIGRATION_OPENING"];

function page(input: { page?: number; pageSize?: number }, max = 100) {
  const pageSize = Math.min(max, Math.max(1, Math.trunc(Number(input.pageSize) || 20)));
  const pageNumber = Math.max(1, Math.trunc(Number(input.page) || 1));
  return { page: pageNumber, pageSize, from: (pageNumber - 1) * pageSize };
}

export async function getWalletOverview(db: SupabaseClient, organizationId: string) {
  const { data, error } = await db.rpc("wallet_summary", { p_org: organizationId });
  if (error) {
    if (isMissingRelation(error) || error.code === "PGRST202") {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Wallet is not set up yet.");
    }
    logError("wallet.summary_failed", { message: error.message, organizationId });
    throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load the wallet.");
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  if (raw.status !== "OK") throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Wallet is not set up yet.");
  const balance = toMicros(raw.balanceMicros);
  const thresholds = (Array.isArray(raw.thresholdsMicros) ? raw.thresholdsMicros : []).map(toMicros);
  const highestThreshold = thresholds.reduce((max, t) => (t > max ? t : max), ZERO);
  return {
    walletStatus: raw.walletStatus === "FROZEN" ? "FROZEN" : "ACTIVE",
    balanceMicros: String(raw.balanceMicros),
    reservedMicros: String(raw.reservedMicros),
    availableMicros: String(raw.availableMicros),
    lifetimeRechargedMicros: String(raw.lifetimeRechargedMicros),
    lifetimeWhatsappMicros: String(raw.lifetimeWhatsappMicros),
    lifetimeAiMicros: String(raw.lifetimeAiMicros),
    lifetimePromoMicros: String(raw.lifetimePromoMicros),
    monthWhatsappMicros: String(raw.monthWhatsappMicros),
    monthAiMicros: String(raw.monthAiMicros),
    monthSpendMicros: String(raw.monthSpendMicros),
    monthRechargedMicros: String(raw.monthRechargedMicros),
    monthStart: raw.monthStart ?? null,
    lastRechargedAt: raw.lastRechargedAt ?? null,
    lowBalance: raw.lowestOpenAlertMicros != null || (highestThreshold > ZERO && balance < highestThreshold),
    lowestOpenAlertMicros: raw.lowestOpenAlertMicros ?? null,
  };
}

export async function listWalletTransactions(
  db: SupabaseClient,
  organizationId: string,
  input: { page?: number; pageSize?: number; type?: TransactionFilter }
) {
  const p = page(input);
  let query = db
    .from("wallet_ledger")
    .select(
      "id, entry_type, service, amount_micros::text, balance_after_micros::text, description, reference_type, created_at",
      { count: "exact" }
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(p.from, p.from + p.pageSize - 1);
  if (input.type === "recharge") query = query.in("entry_type", ["RECHARGE", "RECHARGE_REVERSAL"]);
  if (input.type === "whatsapp") query = query.eq("service", "whatsapp");
  if (input.type === "ai") query = query.eq("service", "ai").neq("entry_type", "MIGRATION_OPENING");
  if (input.type === "credits") query = query.in("entry_type", CREDIT_TYPES);

  const { data, error, count } = await query;
  if (error) {
    logError("wallet.transactions_failed", { message: error.message, organizationId });
    throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load wallet transactions.");
  }
  return {
    entries: (data ?? []).map((row) => {
      const type = String(row.entry_type) as LedgerEntryType;
      return {
        id: String(row.id),
        date: String(row.created_at),
        type,
        label: LEDGER_LABELS[type] ?? type,
        service: (row.service as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        amountMicros: String(row.amount_micros),
        balanceAfterMicros: String(row.balance_after_micros),
      };
    }),
    page: p.page,
    pageSize: p.pageSize,
    total: count ?? 0,
  };
}

function invoiceNumberOf(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const number = (row as { invoice_number?: unknown } | null | undefined)?.invoice_number;
  return typeof number === "string" ? number : null;
}

export async function listRechargeOrders(
  db: SupabaseClient,
  organizationId: string,
  input: { page?: number; pageSize?: number }
) {
  const p = page(input, 50);
  const { data, error, count } = await db
    .from("wallet_recharge_orders")
    .select(
      "id, razorpay_order_id, razorpay_payment_id, amount_paise, taxable_paise, tax_paise, gst_rate_bps, credit_micros::text, refunded_paise, status, method, failure_reason, created_at, paid_at, wallet_recharge_invoices(invoice_number)",
      { count: "exact" }
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .range(p.from, p.from + p.pageSize - 1);
  if (error) {
    logError("wallet.recharges_failed", { message: error.message, organizationId });
    throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load recharges.");
  }
  return {
    recharges: (data ?? []).map((row) => ({
      id: String(row.id),
      razorpayOrderId: String(row.razorpay_order_id),
      razorpayPaymentId: (row.razorpay_payment_id as string | null) ?? null,
      amountPaise: Number(row.amount_paise),
      taxablePaise: Number(row.taxable_paise),
      taxPaise: Number(row.tax_paise),
      gstRateBps: Number(row.gst_rate_bps),
      creditMicros: String(row.credit_micros),
      refundedPaise: Number(row.refunded_paise),
      status: String(row.status),
      method: (row.method as string | null) ?? null,
      failureReason: (row.failure_reason as string | null) ?? null,
      createdAt: String(row.created_at),
      paidAt: (row.paid_at as string | null) ?? null,
      invoiceNumber: invoiceNumberOf(row.wallet_recharge_invoices),
    })),
    page: p.page,
    pageSize: p.pageSize,
    total: count ?? 0,
  };
}

export async function walletDailyUsage(db: SupabaseClient, organizationId: string, days: number) {
  const span = Math.max(7, Math.min(90, Math.trunc(Number(days) || 30)));
  const { data, error } = await db.rpc("wallet_usage_daily", { p_org: organizationId, p_days: span });
  if (error) {
    logError("wallet.usage_failed", { message: error.message, organizationId });
    throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load wallet usage.");
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    day: String(row.day),
    whatsappMicros: String(row.whatsapp_micros ?? 0),
    aiMicros: String(row.ai_micros ?? 0),
    rechargedMicros: String(row.recharged_micros ?? 0),
  }));
}

const STATEMENT_MAX_ROWS = 20000;

/** CSV rows for a date range in India time, oldest first, with a running balance. */
export async function walletStatementRows(
  db: SupabaseClient,
  organizationId: string,
  range: { from: string; to: string }
) {
  const fromIso = new Date(`${range.from}T00:00:00+05:30`);
  const toIso = new Date(`${range.to}T00:00:00+05:30`);
  if (Number.isNaN(fromIso.getTime()) || Number.isNaN(toIso.getTime()) || toIso < fromIso) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "The date range is invalid.");
  }
  toIso.setUTCDate(toIso.getUTCDate() + 1);
  if (toIso.getTime() - fromIso.getTime() > 400 * 24 * 60 * 60 * 1000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Export up to about a year at a time.");
  }

  const rows: unknown[][] = [["Date (IST)", "Type", "Description", "Debit (₹)", "Credit (₹)", "Balance (₹)", "Entry ID"]];
  const batch = 1000;
  for (let offset = 0; offset < STATEMENT_MAX_ROWS; offset += batch) {
    const { data, error } = await db
      .from("wallet_ledger")
      .select("id, entry_type, description, amount_micros::text, balance_after_micros::text, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", fromIso.toISOString())
      .lt("created_at", toIso.toISOString())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + batch - 1);
    if (error) {
      logError("wallet.statement_failed", { message: error.message, organizationId });
      throw new AppError(ERROR_CODES.JOB_FAILED, "Could not build the statement.");
    }
    for (const row of data ?? []) {
      const amount = toMicros(String(row.amount_micros));
      const type = String(row.entry_type) as LedgerEntryType;
      rows.push([
        new Date(String(row.created_at)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        LEDGER_LABELS[type] ?? type,
        row.description ?? "",
        amount < ZERO ? formatMicros(-amount, { symbol: false, maxFractionDigits: 6 }) : "",
        amount > ZERO ? formatMicros(amount, { symbol: false, maxFractionDigits: 6 }) : "",
        formatMicros(toMicros(String(row.balance_after_micros)), { symbol: false, maxFractionDigits: 6 }),
        String(row.id),
      ]);
    }
    if (!data || data.length < batch) break;
  }
  return rows;
}
