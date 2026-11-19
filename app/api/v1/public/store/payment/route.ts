import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { apiRouteWithContext } from "@/lib/api/handler";
import { rateLimit } from "@/lib/security/rate-limit";
import { requestIp } from "@/modules/storefront/buyer-route";
import { organizationFromLink, publicStoreClient } from "@/modules/storefront/public";
import { storeLinkFields, storeLinkRef } from "@/modules/storefront/schema";
import {
  confirmStorefrontPayment,
  resumeStorefrontPayment,
  storefrontPaymentState,
} from "@/modules/merchant-payments/payments";

const attempt = {
  ...storeLinkFields,
  orderId: z.string().trim().uuid(),
  paymentToken: z.string().trim().regex(/^[a-f0-9]{48}$/, "Payment not found."),
};
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resume"), ...attempt }),
  z.object({ action: z.literal("status"), ...attempt }),
  z.object({
    action: z.literal("confirm"),
    ...attempt,
    razorpayOrderId: z.string().trim().regex(/^order_[A-Za-z0-9]+$/).max(64),
    razorpayPaymentId: z.string().trim().regex(/^pay_[A-Za-z0-9]+$/).max(64),
    razorpaySignature: z.string().trim().regex(/^[a-f0-9]{64}$/),
  }),
]);

/**
 * Storefront online payment (merchant's own Razorpay account). The organization is resolved from
 * the store link, the attempt from (organization, order id, attempt token). Amounts and payment
 * status are never read from this request.
 */
export const POST = apiRouteWithContext(async (request: NextRequest) => {
  const ip = requestIp(request);
  const input = body.parse(await request.json().catch(() => ({})));
  const perIp = rateLimit(`public-store-payment:${input.action}:${ip}`, input.action === "status" ? 40 : 15, 60_000);
  const perOrder = rateLimit(`public-store-payment-order:${input.orderId}`, 30, 60_000);
  if (!perIp.ok || !perOrder.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many requests. Try again shortly.");

  const supabase = publicStoreClient();
  const organizationId = await organizationFromLink(supabase, storeLinkRef(input));
  const ref = { organizationId, orderId: input.orderId, token: input.paymentToken };

  switch (input.action) {
    case "resume":
      return resumeStorefrontPayment(supabase, ref);
    case "status":
      return { state: await storefrontPaymentState(supabase, ref) };
    case "confirm":
      return {
        state: await confirmStorefrontPayment(supabase, {
          ...ref,
          razorpayOrderId: input.razorpayOrderId,
          razorpayPaymentId: input.razorpayPaymentId,
          signature: input.razorpaySignature,
        }),
      };
  }
});
