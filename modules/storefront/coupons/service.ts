import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
  couponWindowState,
  describeCoupon,
  evaluateCoupon,
  normalizeCouponCode,
  type CouponCartLine,
  type CouponEvaluation,
  type CouponRule,
} from "./engine";
import type { CouponInput } from "./schema";

const COUPON_SELECT =
  "id, code, title, description, discount_type, value, max_discount, applies_to, product_ids, category_ids, buy_quantity, get_quantity, min_order_amount, usage_limit, per_customer_limit, first_order_only, prepaid_only, auto_apply, starts_at, ends_at, status, created_at, updated_at";

export type CouponRecord = CouponRule & { createdAt: string; updatedAt: string; summary: string; state: ReturnType<typeof couponWindowState> };

export type CouponStatsRow = {
  couponId: string;
  redemptions: number;
  customers: number;
  discount: number;
  revenue: number;
  linkOpens: number;
  applies: number;
  lifetimeRedemptions: number;
};

export type CouponStats = {
  totals: { redemptions: number; customers: number; discount: number; revenue: number; linkOpens: number; applies: number };
  coupons: CouponStatsRow[];
  daily: Array<{ day: string; redemptions: number; discount: number; revenue: number }>;
};

const num = (value: unknown) => (value == null ? null : Number(value));

export function mapCoupon(row: Record<string, unknown>): CouponRecord {
  const rule: CouponRule = {
    id: String(row.id),
    code: String(row.code),
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    discountType: row.discount_type as CouponRule["discountType"],
    value: Number(row.value),
    maxDiscount: num(row.max_discount),
    appliesTo: (row.applies_to as CouponRule["appliesTo"]) ?? "ALL",
    productIds: Array.isArray(row.product_ids) ? (row.product_ids as string[]) : [],
    categoryIds: Array.isArray(row.category_ids) ? (row.category_ids as string[]) : [],
    buyQuantity: num(row.buy_quantity),
    getQuantity: num(row.get_quantity),
    minOrderAmount: num(row.min_order_amount),
    usageLimit: num(row.usage_limit),
    perCustomerLimit: num(row.per_customer_limit),
    firstOrderOnly: row.first_order_only === true,
    prepaidOnly: row.prepaid_only === true,
    autoApply: row.auto_apply === true,
    startsAt: (row.starts_at as string | null) ?? null,
    endsAt: (row.ends_at as string | null) ?? null,
    status: (row.status as CouponRule["status"]) ?? "ACTIVE",
  };
  return {
    ...rule,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    summary: describeCoupon(rule),
    state: couponWindowState(rule),
  };
}

function toRow(input: CouponInput) {
  return {
    code: input.code,
    title: input.title,
    description: input.description,
    discount_type: input.discountType,
    value: input.value,
    max_discount: input.discountType === "PERCENT" ? input.maxDiscount : null,
    applies_to: input.appliesTo,
    product_ids: input.appliesTo === "PRODUCTS" ? [...new Set(input.productIds)] : [],
    category_ids: input.appliesTo === "CATEGORIES" ? [...new Set(input.categoryIds)] : [],
    buy_quantity: input.discountType === "BUY_X_GET_Y" ? input.buyQuantity : null,
    get_quantity: input.discountType === "BUY_X_GET_Y" ? input.getQuantity : null,
    min_order_amount: input.minOrderAmount,
    usage_limit: input.usageLimit,
    per_customer_limit: input.perCustomerLimit,
    first_order_only: input.firstOrderOnly,
    prepaid_only: input.prepaidOnly,
    auto_apply: input.autoApply,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    status: input.status,
  };
}

function writeError(error: { code?: string; message: string }): never {
  if (error.code === "23505") {
    const auto = /auto_apply/i.test(error.message);
    throw new AppError(
      ERROR_CODES.CONFLICT,
      auto ? "Another coupon already auto-applies. Turn that off first." : "A coupon with this code already exists."
    );
  }
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Coupons aren’t set up on this workspace yet.");
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
}

async function assertScopeBelongsToOrg(supabase: SupabaseClient, organizationId: string, input: CouponInput) {
  if (input.appliesTo === "PRODUCTS" && input.productIds.length) {
    const ids = [...new Set(input.productIds)];
    const { count, error } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).in("id", ids);
    if (error) writeError(error);
    if ((count ?? 0) !== ids.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One or more products were not found.");
  }
  if (input.appliesTo === "CATEGORIES" && input.categoryIds.length) {
    const ids = [...new Set(input.categoryIds)];
    const { count, error } = await supabase.from("product_categories").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).in("id", ids);
    if (error) writeError(error);
    if ((count ?? 0) !== ids.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One or more categories were not found.");
  }
}

// ---------------------------------------------------------------- dashboard

export function rangeWindow(range: "7d" | "30d" | "90d" | "all", now = new Date()) {
  const to = new Date(now.getTime() + 60_000);
  if (range === "all") return { from: new Date("2000-01-01T00:00:00Z"), to };
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return { from: new Date(now.getTime() - days * 86_400_000), to };
}

export async function listCoupons(supabase: SupabaseClient, ctx: TenantContext, range: "7d" | "30d" | "90d" | "all") {
  const window = rangeWindow(range);
  const [{ data, error }, stats] = await Promise.all([
    supabase.from("storefront_coupons").select(COUPON_SELECT).eq("organization_id", ctx.organizationId).order("created_at", { ascending: false }),
    supabase.rpc("storefront_coupon_stats", {
      p_organization_id: ctx.organizationId,
      p_from: window.from.toISOString(),
      p_to: window.to.toISOString(),
    }),
  ]);
  if (error) writeError(error);
  if (stats.error) writeError(stats.error);
  const raw = (stats.data ?? {}) as Partial<CouponStats>;
  const totals = raw.totals ?? { redemptions: 0, customers: 0, discount: 0, revenue: 0, linkOpens: 0, applies: 0 };
  return {
    range,
    from: window.from.toISOString(),
    coupons: (data ?? []).map((row) => mapCoupon(row as Record<string, unknown>)),
    stats: {
      totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value) || 0])) as CouponStats["totals"],
      coupons: (raw.coupons ?? []).map((row) => ({
        couponId: String(row.couponId),
        redemptions: Number(row.redemptions) || 0,
        customers: Number(row.customers) || 0,
        discount: Number(row.discount) || 0,
        revenue: Number(row.revenue) || 0,
        linkOpens: Number(row.linkOpens) || 0,
        applies: Number(row.applies) || 0,
        lifetimeRedemptions: Number(row.lifetimeRedemptions) || 0,
      })),
      daily: (raw.daily ?? []).map((row) => ({ day: String(row.day), redemptions: Number(row.redemptions) || 0, discount: Number(row.discount) || 0, revenue: Number(row.revenue) || 0 })),
    } satisfies CouponStats,
  };
}

export async function createCoupon(supabase: SupabaseClient, ctx: TenantContext, input: CouponInput) {
  await assertScopeBelongsToOrg(supabase, ctx.organizationId, input);
  const { data, error } = await supabase
    .from("storefront_coupons")
    .insert({ ...toRow(input), organization_id: ctx.organizationId, created_by: ctx.userId ?? null })
    .select(COUPON_SELECT)
    .single();
  if (error) writeError(error);
  await audit(supabase, ctx, "storefront.coupon_created", String(data.id), { code: input.code });
  return mapCoupon(data as Record<string, unknown>);
}

export async function updateCoupon(supabase: SupabaseClient, ctx: TenantContext, id: string, input: CouponInput) {
  await assertScopeBelongsToOrg(supabase, ctx.organizationId, input);
  const { data: current } = await supabase.from("storefront_coupons").select("code").eq("organization_id", ctx.organizationId).eq("id", id).maybeSingle();
  if (!current) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Coupon not found.");
  if (current.code !== input.code) {
    // Renaming a used code would orphan shared links and confuse reporting.
    const { count } = await supabase.from("storefront_coupon_redemptions").select("id", { count: "exact", head: true }).eq("organization_id", ctx.organizationId).eq("coupon_id", id);
    if ((count ?? 0) > 0) throw new AppError(ERROR_CODES.CONFLICT, "This code has been used, so it can’t be renamed. Create a new coupon instead.");
  }
  const { data, error } = await supabase
    .from("storefront_coupons")
    .update(toRow(input))
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select(COUPON_SELECT)
    .maybeSingle();
  if (error) writeError(error);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Coupon not found.");
  await audit(supabase, ctx, "storefront.coupon_updated", id, { code: input.code });
  return mapCoupon(data as Record<string, unknown>);
}

export async function setCouponStatus(supabase: SupabaseClient, ctx: TenantContext, id: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED") {
  const { data, error } = await supabase
    .from("storefront_coupons")
    .update({ status, ...(status === "ARCHIVED" ? { auto_apply: false } : {}) })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select(COUPON_SELECT)
    .maybeSingle();
  if (error) writeError(error);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Coupon not found.");
  await audit(supabase, ctx, `storefront.coupon_${status.toLowerCase()}`, id, { status });
  return mapCoupon(data as Record<string, unknown>);
}

/** Unused coupons are deleted; used ones are archived so their order history stays intact. */
export async function deleteCoupon(supabase: SupabaseClient, ctx: TenantContext, id: string) {
  const { count } = await supabase.from("storefront_coupon_redemptions").select("id", { count: "exact", head: true }).eq("organization_id", ctx.organizationId).eq("coupon_id", id);
  if ((count ?? 0) > 0) {
    await setCouponStatus(supabase, ctx, id, "ARCHIVED");
    return { deleted: false, archived: true };
  }
  const { data, error } = await supabase.from("storefront_coupons").delete().eq("organization_id", ctx.organizationId).eq("id", id).select("id").maybeSingle();
  if (error) writeError(error);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Coupon not found.");
  await audit(supabase, ctx, "storefront.coupon_deleted", id, {});
  return { deleted: true, archived: false };
}

export async function listCouponRedemptions(supabase: SupabaseClient, ctx: TenantContext, id: string) {
  const { data, error } = await supabase
    .from("storefront_coupon_redemptions")
    .select("id, order_id, code, customer_phone, subtotal, discount_amount, order_total, payment_preference, created_at, orders(order_number, status)")
    .eq("organization_id", ctx.organizationId)
    .eq("coupon_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) writeError(error);
  return (data ?? []).map((row) => {
    const order = (Array.isArray(row.orders) ? row.orders[0] : row.orders) as { order_number?: string; status?: string } | null;
    const phone = String(row.customer_phone ?? "");
    return {
      id: String(row.id),
      orderId: (row.order_id as string | null) ?? null,
      orderNumber: order?.order_number ?? null,
      orderStatus: order?.status ?? null,
      // Mask the middle digits: enough to recognise a repeat customer without exposing the number.
      customer: phone.length >= 10 ? `${phone.slice(0, 2)}••••••${phone.slice(-2)}` : phone,
      subtotal: Number(row.subtotal),
      discount: Number(row.discount_amount),
      total: Number(row.order_total),
      paymentPreference: (row.payment_preference as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  });
}

async function audit(supabase: SupabaseClient, ctx: TenantContext, action: string, id: string, after: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    organization_id: ctx.organizationId,
    actor_id: ctx.userId ?? null,
    action,
    entity_type: "storefront_coupon",
    entity_id: id,
    after,
  });
}

// ---------------------------------------------------------------- public store

export type PublicCouponSummary = { code: string; label: string; description: string | null; autoApply: boolean; prepaidOnly: boolean; endsAt: string | null };

export function publicCouponSummary(coupon: CouponRule): PublicCouponSummary {
  return {
    code: coupon.code,
    label: describeCoupon(coupon),
    description: coupon.description,
    autoApply: coupon.autoApply,
    prepaidOnly: coupon.prepaidOnly,
    endsAt: coupon.endsAt,
  };
}

export async function findCouponByCode(db: SupabaseClient, organizationId: string, code: string) {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return null;
  try {
    const { data, error } = await db.from("storefront_coupons").select(COUPON_SELECT).eq("organization_id", organizationId).eq("code", normalized).neq("status", "ARCHIVED").maybeSingle();
    if (error) return null; // Missing table (migration not applied) behaves like "no such coupon".
    return data ? mapCoupon(data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function findAutoApplyCoupon(db: SupabaseClient, organizationId: string) {
  // Checkout and the store page must keep working even if coupons are unavailable.
  try {
    const { data, error } = await db.from("storefront_coupons").select(COUPON_SELECT).eq("organization_id", organizationId).eq("auto_apply", true).eq("status", "ACTIVE").maybeSingle();
    if (error || !data) return null;
    const coupon = mapCoupon(data as Record<string, unknown>);
    return coupon.state === "ACTIVE" ? coupon : null;
  } catch {
    return null;
  }
}

async function categoryMembership(db: SupabaseClient, organizationId: string, productIds: string[]) {
  const ids = [...new Set(productIds)];
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const { data } = await db.from("product_category_members").select("product_id, category_id").eq("organization_id", organizationId).in("product_id", ids);
  for (const row of data ?? []) {
    const list = map.get(String(row.product_id)) ?? [];
    list.push(String(row.category_id));
    map.set(String(row.product_id), list);
  }
  return map;
}

async function customerUsage(db: SupabaseClient, organizationId: string, coupon: CouponRule, phone: string) {
  const [used, previous] = await Promise.all([
    coupon.perCustomerLimit
      ? db.from("storefront_coupon_redemptions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("coupon_id", coupon.id).eq("customer_phone", phone)
      : Promise.resolve({ count: 0 }),
    coupon.firstOrderOnly ? hasPreviousOrder(db, organizationId, phone) : Promise.resolve(false),
  ]);
  return { used: used.count ?? 0, hasOrdered: previous };
}

async function hasPreviousOrder(db: SupabaseClient, organizationId: string, phone: string) {
  const { data: customers } = await db.from("customers").select("id").eq("organization_id", organizationId).eq("phone", phone).limit(200);
  const ids = (customers ?? []).map((row) => String(row.id));
  if (!ids.length) return false;
  const { count } = await db.from("orders").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).in("customer_id", ids);
  return (count ?? 0) > 0;
}

export type AppliedCoupon<T extends CouponCartLine> = {
  coupon: CouponRecord;
  evaluation: CouponEvaluation<T>;
  /** True when the coupon came from the store's auto-apply setting rather than a typed code. */
  automatic: boolean;
};

/**
 * Picks the typed code (or the auto-apply coupon when none was typed) and prices the cart.
 * Returns null when there is nothing to apply. Customer checks run only when `phone` is known.
 */
export async function applyStoreCoupon<T extends CouponCartLine>(
  db: SupabaseClient,
  organizationId: string,
  lines: T[],
  input: { code?: string | null; preference: "PREPAID" | "COD"; phone?: string | null }
): Promise<AppliedCoupon<T> | { coupon: null; error: string } | null> {
  const typed = input.code ? normalizeCouponCode(input.code) : "";
  const coupon = typed ? await findCouponByCode(db, organizationId, typed) : await findAutoApplyCoupon(db, organizationId);
  if (!coupon) return typed ? { coupon: null, error: "This coupon code isn’t valid." } : null;
  if (coupon.usageLimit) {
    const { count } = await db.from("storefront_coupon_redemptions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("coupon_id", coupon.id);
    if ((count ?? 0) >= coupon.usageLimit) return { coupon, automatic: !typed, evaluation: { ok: false, reason: "NOT_ACTIVE", message: "This coupon has reached its usage limit." } };
  }
  if (input.phone && (coupon.perCustomerLimit || coupon.firstOrderOnly)) {
    const usage = await customerUsage(db, organizationId, coupon, input.phone);
    if (coupon.perCustomerLimit && usage.used >= coupon.perCustomerLimit) {
      return { coupon, automatic: !typed, evaluation: { ok: false, reason: "NOT_ACTIVE", message: "You’ve already used this coupon." } };
    }
    if (coupon.firstOrderOnly && usage.hasOrdered) {
      return { coupon, automatic: !typed, evaluation: { ok: false, reason: "NOT_ACTIVE", message: "This coupon is for first orders only." } };
    }
  }
  const categories = coupon.appliesTo === "CATEGORIES" ? await categoryMembership(db, organizationId, lines.map((line) => line.productId ?? "").filter(Boolean)) : new Map<string, string[]>();
  const priced = lines.map((line) => ({ ...line, categoryIds: line.productId ? categories.get(line.productId) ?? [] : [] }));
  const evaluation = evaluateCoupon(coupon, { lines: priced, preference: input.preference });
  return { coupon, automatic: !typed, evaluation: evaluation as CouponEvaluation<T> };
}

const RESERVE_ERRORS: Record<string, string> = {
  COUPON_UNAVAILABLE: "This coupon is no longer available.",
  COUPON_EXPIRED: "This coupon has expired.",
  COUPON_USAGE_LIMIT: "This coupon has reached its usage limit.",
  COUPON_CUSTOMER_LIMIT: "You’ve already used this coupon.",
};

export async function reserveCouponRedemption(
  db: SupabaseClient,
  input: { organizationId: string; couponId: string; phone: string; subtotal: number; discount: number; total: number; preference: "PREPAID" | "COD" }
) {
  const { data, error } = await db.rpc("reserve_storefront_coupon", {
    p_organization_id: input.organizationId,
    p_coupon_id: input.couponId,
    p_customer_phone: input.phone,
    p_subtotal: input.subtotal,
    p_discount: input.discount,
    p_order_total: input.total,
    p_payment_preference: input.preference,
  });
  if (error) {
    const known = Object.keys(RESERVE_ERRORS).find((key) => error.message.includes(key));
    throw new AppError(ERROR_CODES.CONFLICT, known ? `${RESERVE_ERRORS[known]} Remove it to place your order.` : "Could not apply the coupon. Try again.");
  }
  return String(data);
}

export async function attachRedemptionOrder(db: SupabaseClient, organizationId: string, redemptionId: string, orderId: string) {
  await db.from("storefront_coupon_redemptions").update({ order_id: orderId }).eq("organization_id", organizationId).eq("id", redemptionId);
}

export async function releaseCouponRedemption(db: SupabaseClient, organizationId: string, redemptionId: string) {
  await db.from("storefront_coupon_redemptions").delete().eq("organization_id", organizationId).eq("id", redemptionId);
}

export async function recordCouponEvent(db: SupabaseClient, organizationId: string, couponId: string, type: "COUPON_LINK_OPENED" | "COUPON_APPLIED", sessionId?: string | null) {
  // Analytics must never block shopping.
  try {
    await db.from("storefront_events").insert({ organization_id: organizationId, event_type: type, coupon_id: couponId, session_id: sessionId ?? null });
  } catch {
    /* ignore */
  }
}
