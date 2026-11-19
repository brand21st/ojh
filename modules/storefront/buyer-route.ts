import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ok } from "@/lib/api/response";
import { logError } from "@/lib/logger";
import { findPublicCollectionLink, type PublicLinkRef } from "@/modules/customer-order-links/public";
import type { SubmitCustomerOrderLinkInput } from "@/modules/customer-order-links/schema";
import { BUYER_COOKIE, buyerCookieOptions, readDeviceToken, rememberBuyer } from "@/modules/storefront/buyer";

export function requestDeviceToken(request: NextRequest) {
  return readDeviceToken(request.cookies.get(BUYER_COOKIE)?.value);
}

export function requestIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/**
 * After an order is placed, save its address when the buyer asked to and trust this
 * browser for the number. Saving is best effort: it never fails a placed order.
 */
export async function respondWithRememberedBuyer(
  request: NextRequest,
  supabase: SupabaseClient,
  ref: PublicLinkRef,
  body: SubmitCustomerOrderLinkInput,
  result: unknown
) {
  const response = ok(result);
  if (!body.saveAddress) return response;
  try {
    const link = await findPublicCollectionLink(supabase, ref);
    if (!link) return response;
    const { token } = await rememberBuyer(supabase, {
      organizationId: link.organization_id,
      phone: body.phone,
      address: body,
      token: requestDeviceToken(request),
    });
    response.cookies.set(BUYER_COOKIE, token, buyerCookieOptions());
  } catch (error) {
    logError("storefront.buyer_save_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  return response;
}
