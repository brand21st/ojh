import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { getInventoryAnalytics } from "@/modules/products/analytics";
import type { InventoryOverview, InventoryOverviewPeriod } from "@/types/api";

export const inventoryOverviewQuery = z.object({
  range: z.enum(["today", "7d", "30d", "90d"]).default("30d"),
});

const DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET = 330 * 60 * 1000;

/** Start of the IST calendar day containing `at`, as a UTC instant. */
export function istDayStart(at: Date) {
  const shifted = new Date(at.getTime() + IST_OFFSET);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET);
}

/**
 * Current window = whole IST days ending today (today counts as day one), up to now.
 * Previous window = the same span shifted back by the window's day count, ending at
 * the same time of day, so "today" compares with the same hours yesterday.
 */
export function overviewWindow(range: InventoryOverview["range"], now = new Date()) {
  const days = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const from = new Date(istDayStart(now).getTime() - (days - 1) * DAY);
  const shift = days * DAY;
  return {
    from,
    to: now,
    prevFrom: new Date(from.getTime() - shift),
    prevTo: new Date(now.getTime() - shift),
    bucket: (range === "today" ? "hour" : "day") as InventoryOverview["bucket"],
  };
}

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function period(raw: unknown): InventoryOverviewPeriod {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    orders: num(r.orders),
    units: num(r.units),
    orderValue: num(r.orderValue),
    collected: num(r.collected),
    codDue: num(r.codDue),
    prepaidDue: num(r.prepaidDue),
    returned: num(r.returned),
    cancelled: num(r.cancelled),
    refunded: num(r.refunded),
  };
}

function isMissingFunction(error: { code?: string; message?: string }) {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

export async function getInventoryOverview(
  supabase: SupabaseClient,
  ctx: TenantContext,
  query: z.infer<typeof inventoryOverviewQuery>,
  now = new Date()
): Promise<InventoryOverview> {
  const w = overviewWindow(query.range, now);
  const { data, error } = await supabase.rpc("inventory_overview", {
    p_organization_id: ctx.organizationId,
    p_from: w.from.toISOString(),
    p_to: w.to.toISOString(),
    p_prev_from: w.prevFrom.toISOString(),
    p_prev_to: w.prevTo.toISOString(),
    p_bucket: w.bucket,
  });
  if (error) {
    if (isMissingFunction(error)) return legacyOverview(supabase, ctx, query.range, w);
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  const catalog = (raw.catalog ?? {}) as Record<string, unknown>;
  return {
    range: query.range,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    complete: true,
    bucket: w.bucket,
    catalog: {
      totalProducts: num(catalog.totalProducts),
      activeProducts: num(catalog.activeProducts),
      stockUnits: num(catalog.stockUnits),
      stockValue: num(catalog.stockValue),
      outOfStock: num(catalog.outOfStock),
      lowStock: num(catalog.lowStock),
    },
    current: period(raw.current),
    previous: period(raw.previous),
    series: ((raw.series ?? []) as Array<Record<string, unknown>>).map((b) => ({
      bucket: String(b.bucket),
      orders: num(b.orders),
      orderValue: num(b.orderValue),
    })),
    topProducts: ((raw.topProducts ?? []) as Array<Record<string, unknown>>).map((p) => ({
      productId: String(p.productId),
      name: String(p.name ?? "Product"),
      sku: String(p.sku ?? ""),
      orders: num(p.orders),
      units: num(p.units),
      revenue: num(p.revenue),
      onHand: num(p.onHand),
      active: p.active !== false,
    })),
    attention: ((raw.attention ?? []) as Array<Record<string, unknown>>).map((p) => ({
      productId: String(p.productId),
      name: String(p.name ?? "Product"),
      sku: String(p.sku ?? ""),
      onHand: num(p.onHand),
      threshold: num(p.threshold),
      units30d: num(p.units30d),
    })),
  };
}

/** Pre-migration fallback built from the older RPCs: no comparison, trend or demand. */
async function legacyOverview(
  supabase: SupabaseClient,
  ctx: TenantContext,
  range: InventoryOverview["range"],
  w: ReturnType<typeof overviewWindow>
): Promise<InventoryOverview> {
  const a = await getInventoryAnalytics(supabase, ctx, { range: "custom", from: w.from.toISOString(), to: w.to.toISOString() });
  const codDue = Math.min(a.codOutstanding, a.pendingAmount);
  return {
    range,
    from: a.from,
    to: a.to,
    complete: false,
    bucket: w.bucket,
    catalog: {
      totalProducts: a.totalProducts,
      activeProducts: a.activeProducts,
      stockUnits: a.totalStock,
      stockValue: a.totalProductValue,
      outOfStock: a.outOfStock,
      lowStock: a.lowStock,
    },
    current: {
      orders: a.orderCount,
      units: a.totalUnitsSold,
      orderValue: a.totalSales,
      collected: a.amountReceived,
      codDue,
      prepaidDue: Math.max(0, a.pendingAmount - codDue),
      returned: 0,
      cancelled: 0,
      refunded: 0,
    },
    previous: null,
    series: [],
    topProducts: a.topProducts.map((p) => ({ productId: p.productId, name: p.name, sku: p.sku, orders: p.orderCount, units: p.unitsSold, revenue: p.revenue, onHand: p.onHand, active: true })),
    attention: a.lowStockProducts.map((p) => ({ productId: p.productId, name: p.name, sku: p.sku, onHand: p.onHand, threshold: p.lowStockThreshold, units30d: null })),
  };
}
