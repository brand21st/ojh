import { NextRequest } from "next/server";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { apiRouteWithContext } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { rateLimit } from "@/lib/security/rate-limit";
import { couponWindowState } from "@/modules/storefront/coupons/engine";
import { findCouponByCode, publicCouponSummary, recordCouponEvent } from "@/modules/storefront/coupons/service";
import { assertStorePublished, organizationFromLink, publicStoreClient } from "@/modules/storefront/public";
import { publicCouponLookupSchema, storeLinkRef } from "@/modules/storefront/schema";

/**
 * Looks up a coupon for the store banner (magic links) without needing a cart.
 * Cart-dependent rules (minimum order, eligible items, limits) are checked by the quote.
 */
export const GET = apiRouteWithContext(async (request: NextRequest) => {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  const query = publicCouponLookupSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  // Tight limit: this endpoint answers "does this code exist", so it must not allow guessing.
  const limited = rateLimit(`public-store-coupon:${ip}:${query.workspace ?? query.token ?? "x"}`, 20, 60_000);
  if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again shortly.");
  const supabase = publicStoreClient();
  const organizationId = await organizationFromLink(supabase, storeLinkRef(query));
  await assertStorePublished(supabase, organizationId);
  const coupon = await findCouponByCode(supabase, organizationId, query.coupon);
  if (!coupon) return ok({ valid: false, message: "This coupon code isn’t valid.", coupon: null });
  const state = couponWindowState(coupon);
  if (query.source === "link") {
    const ua = request.headers.get("user-agent") ?? "";
    if (!/bot|crawler|spider|preview|facebookexternalhit|whatsapp|slurp/i.test(ua)) {
      await recordCouponEvent(supabase, organizationId, coupon.id, "COUPON_LINK_OPENED", query.sessionId);
    }
  }
  if (state !== "ACTIVE") {
    const message = state === "SCHEDULED" ? "This coupon isn’t active yet." : state === "EXPIRED" ? "This coupon has expired." : "This coupon isn’t active.";
    return ok({ valid: false, message, coupon: null });
  }
  return ok({ valid: true, message: null, coupon: publicCouponSummary(coupon) });
});
