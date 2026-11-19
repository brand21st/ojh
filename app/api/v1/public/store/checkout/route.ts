import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { apiRouteWithContext } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  BUYER_COOKIE,
  buyerCookieOptions,
  forgetBuyerAddress,
  lookupBuyer,
  requestCheckoutCode,
  verifyCheckoutCode,
} from "@/modules/storefront/buyer";
import { requestDeviceToken, requestIp } from "@/modules/storefront/buyer-route";
import { assertStorePublished, organizationFromLink, publicStoreClient } from "@/modules/storefront/public";
import { storeLinkFields, storeLinkRef } from "@/modules/storefront/schema";

const phone = z.string().trim().min(10).max(20);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lookup"), ...storeLinkFields, phone }),
  z.object({ action: z.literal("send-code"), ...storeLinkFields, phone }),
  z.object({ action: z.literal("verify-code"), ...storeLinkFields, phone, otp: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code.") }),
  z.object({ action: z.literal("forget-address"), ...storeLinkFields, phone, addressId: z.string().uuid() }),
]);

/** Fast checkout for returning buyers: look up a number, prove it with a WhatsApp code, manage saved addresses. */
export const POST = apiRouteWithContext(async (request: NextRequest) => {
  const ip = requestIp(request);
  const input = body.parse(await request.json().catch(() => ({})));
  const limited = rateLimit(`public-store-checkout:${input.action}:${ip}`, input.action === "lookup" ? 30 : 10, 60_000);
  if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many requests. Try again shortly.");

  const supabase = publicStoreClient();
  const organizationId = await organizationFromLink(supabase, storeLinkRef(input));
  await assertStorePublished(supabase, organizationId);
  const token = requestDeviceToken(request);

  switch (input.action) {
    case "lookup":
      return lookupBuyer(supabase, organizationId, input.phone, token);
    case "send-code":
      return requestCheckoutCode(supabase, { organizationId, phone: input.phone, ip });
    case "verify-code": {
      const verified = await verifyCheckoutCode(supabase, { organizationId, phone: input.phone, code: input.otp, token });
      const response = ok({ status: "ready" as const, addresses: verified.addresses });
      response.cookies.set(BUYER_COOKIE, verified.token, buyerCookieOptions());
      return response;
    }
    case "forget-address":
      return forgetBuyerAddress(supabase, { organizationId, phone: input.phone, addressId: input.addressId, token });
  }
});
