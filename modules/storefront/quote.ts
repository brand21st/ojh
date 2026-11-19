import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { applyStoreCoupon, recordCouponEvent } from "./coupons/service";
import { resolveStoreCart } from "./resolve-cart";
import type { BundleSelection } from "./bundle-pricing";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { roundMoney } from "@/modules/orders/payment";
import { catalogCodAdvancePaid } from "@/modules/products/payment";

export type StoreQuoteItem = { productId: string; quantity: number };
export type StorePaymentPreference = "PREPAID" | "COD";


export function quoteCatalogPayment(input: {
  preference: StorePaymentPreference;
  lines: Array<{
    unitPrice: number;
    quantity: number;
    prepaidEnabled: boolean;
    codEnabled: boolean;
    codAdvancePercent: number | string | null;
  }>;
}) {
  const total = roundMoney(input.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  if (input.preference === "PREPAID") {
    const blocked = input.lines.find((line) => !line.prepaidEnabled);
    if (blocked) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "A product in your cart does not support prepaid.");
    }
    return {
      preference: "PREPAID" as const,
      total,
      amountDueNow: total,
      amountOnDelivery: 0,
      expectedAdvance: 0,
    };
  }
  const blocked = input.lines.find((line) => !line.codEnabled);
  if (blocked) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "A product in your cart does not support COD.");
  }
  const expectedAdvance = catalogCodAdvancePaid(
    input.lines.map((line) => ({
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      product: line,
    }))
  );
  const capped = Math.min(total, Math.max(0, expectedAdvance));
  return {
    preference: "COD" as const,
    total,
    amountDueNow: capped,
    amountOnDelivery: roundMoney(total - capped),
    expectedAdvance: capped,
  };
}

export type StoreCouponRequest = { code?: string | null; skipAuto?: boolean; phone?: string | null; trackApply?: boolean };

export type QuotedCoupon = {
  code: string;
  label: string;
  automatic: boolean;
  applied: boolean;
  discount: number;
  subtotal: number;
  message: string | null;
  couponId: string;
};

/**
 * Applies a typed or auto-apply coupon to a resolved cart. Returns the lines to charge plus a
 * quote version that also covers the coupon, so a discount change forces the customer to re-review.
 */
export async function priceStoreCart(
  supabase: SupabaseClient,
  organizationId: string,
  resolved: Awaited<ReturnType<typeof resolveStoreCart>>,
  preference: StorePaymentPreference,
  request: StoreCouponRequest = {}
) {
  const wantsCode = Boolean(request.code?.trim());
  const applied = wantsCode || !request.skipAuto
    ? await applyStoreCoupon(supabase, organizationId, resolved.lines, { code: request.code, preference, phone: request.phone })
    : null;
  let lines = resolved.lines;
  let coupon: QuotedCoupon | null = null;
  let couponError: string | null = null;
  if (applied && applied.coupon === null) {
    couponError = applied.error;
  } else if (applied && applied.coupon) {
    const evaluation = applied.evaluation;
    if (evaluation.ok) lines = evaluation.lines;
    // A failing auto-apply coupon stays quiet unless it is close (e.g. a minimum order hint).
    const message = evaluation.ok ? null : evaluation.message;
    if (!evaluation.ok && !applied.automatic) couponError = message;
    if (evaluation.ok || !applied.automatic || evaluation.reason === "MIN_ORDER" || evaluation.reason === "NEEDS_MORE_ITEMS") {
      coupon = {
        code: applied.coupon.code,
        label: applied.coupon.summary,
        automatic: applied.automatic,
        applied: evaluation.ok,
        discount: evaluation.ok ? evaluation.discount : 0,
        subtotal: evaluation.ok ? evaluation.subtotal : roundMoney(resolved.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)),
        message,
        couponId: applied.coupon.id,
      };
    }
  }
  const quoteVersion = coupon?.applied
    ? createHash("sha256").update(JSON.stringify({ base: resolved.quoteVersion, code: coupon.code, discount: coupon.discount, lines })).digest("hex")
    : resolved.quoteVersion;
  return { lines, coupon, couponError, quoteVersion };
}

export async function quotePublicStorePayment(
  supabase: SupabaseClient,
  organizationId: string,
  items: StoreQuoteItem[],
  preference: StorePaymentPreference,
  bundles: BundleSelection[] = [],
  couponRequest: StoreCouponRequest = {}
) {
  const resolved = await resolveStoreCart(supabase, organizationId, items, bundles);
  const priced = await priceStoreCart(supabase, organizationId, resolved, preference, couponRequest);
  const payment = quoteCatalogPayment({ preference, lines: priced.lines.map((line) => ({ ...line, prepaidEnabled: line.prepaidEnabled !== false, codEnabled: line.codEnabled !== false })) });
  if (priced.coupon?.applied && couponRequest.code && couponRequest.trackApply) {
    await recordCouponEvent(supabase, organizationId, priced.coupon.couponId, "COUPON_APPLIED");
  }
  const { couponId: _couponId, ...coupon } = priced.coupon ?? { couponId: "" };
  void _couponId;
  return {
    ...payment,
    subtotal: priced.coupon?.applied ? priced.coupon.subtotal : payment.total,
    discount: priced.coupon?.applied ? priced.coupon.discount : 0,
    coupon: priced.coupon ? (coupon as Omit<QuotedCoupon, "couponId">) : null,
    couponError: priced.couponError,
    quoteVersion: priced.quoteVersion,
    bundles: resolved.bundles,
    items: resolved.lines.map((line) => ({ productId: line.productId, name: line.title, quantity: line.quantity, unitPrice: line.unitPrice })),
  };
}
