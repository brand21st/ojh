import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { rateLimit } from "@/lib/security/rate-limit";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { hasPermission } from "@/lib/permissions/rbac";
import {
  disconnectMerchantRazorpay,
  getIntegrationView,
  saveMerchantRazorpay,
  setMerchantRazorpayEnabled,
  verifyMerchantRazorpay,
} from "@/modules/merchant-payments/integration";
import {
  orderOnlinePayment,
  reconcileOpenAttemptsForIntegration,
  reconcileOrderOnlinePayment,
} from "@/modules/merchant-payments/payments";

/**
 * Dashboard routes for the merchant's own Razorpay account (Domain B).
 *
 *   GET    integrations/razorpay          masked status, webhook URL
 *   PUT    integrations/razorpay          connect / replace keys (verified with Razorpay first)
 *   POST   integrations/razorpay/verify   re-check stored keys
 *   PATCH  integrations/razorpay          { enabled } turn storefront online payments on/off
 *   DELETE integrations/razorpay          disconnect (keeps payment history)
 *   GET    orders/:id/online-payment      payment details for one order
 *   POST   orders/:id/online-payment/reconcile   pull the latest status from Razorpay
 *
 * The organization always comes from the signed-in tenant context. These routes never touch
 * PostBus SaaS billing (lib/api/v1/billing.ts, modules/billing, modules/razorpay).
 */

const saveSchema = z.object({
  mode: z.enum(["TEST", "LIVE"]),
  keyId: z.string().trim().max(64).optional().nullable(),
  keySecret: z.string().trim().max(128).optional().nullable(),
  webhookSecret: z.string().trim().max(256).optional().nullable(),
});
const toggleSchema = z.object({ enabled: z.boolean() });

function admin(): SupabaseClient {
  if (!hasAdminClient()) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Server is not configured.");
  return createAdminClient();
}

/** Lightweight card for GET integrations. Null when the feature's tables are not deployed yet. */
export async function merchantRazorpaySummary(organizationId: string) {
  if (!hasAdminClient()) return null;
  try {
    const view = await getIntegrationView(createAdminClient(), organizationId);
    if (!view.available) return null;
    return {
      provider: "razorpay",
      name: "Razorpay — Online Payments",
      status: view.status,
      enabled: view.enabled,
      mode: view.mode,
      lastVerifiedAt: view.lastVerifiedAt,
      lastError: view.lastError,
    };
  } catch {
    return null;
  }
}

export async function handleMerchantPaymentRoutes(
  request: NextRequest,
  ctx: TenantContext,
  key: string,
  method: string,
  slugs: string[]
) {
  const actor = { organizationId: ctx.organizationId, userId: ctx.userId };

  if (slugs[0] === "integrations" && slugs[1] === "razorpay") {
    // dispatchTenantRoutes already required integrations.manage for every route below.
    if (key === "GET integrations/razorpay") return getIntegrationView(admin(), ctx.organizationId);

    const limited = rateLimit(`merchant-razorpay:${ctx.organizationId}`, 20, 60_000);
    if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again in a minute.");

    if (key === "PUT integrations/razorpay" || key === "POST integrations/razorpay") {
      const body = saveSchema.parse(await request.json().catch(() => ({})));
      const client = admin();
      return saveMerchantRazorpay(client, actor, body, {
        reconcileOpen: (row) => reconcileOpenAttemptsForIntegration(client, row),
      });
    }
    if (key === "POST integrations/razorpay/verify") return verifyMerchantRazorpay(admin(), actor);
    if (key === "PATCH integrations/razorpay") {
      const body = toggleSchema.parse(await request.json().catch(() => ({})));
      return setMerchantRazorpayEnabled(admin(), actor, body.enabled);
    }
    if (key === "DELETE integrations/razorpay") {
      const client = admin();
      return disconnectMerchantRazorpay(client, actor, {
        reconcileOpen: (row) => reconcileOpenAttemptsForIntegration(client, row),
      });
    }
    return null;
  }

  if (slugs[0] === "orders" && slugs[1] && slugs[2] === "online-payment") {
    const orderId = z.string().uuid().safeParse(slugs[1]);
    if (!orderId.success) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Order not found.");
    if (method === "GET" && slugs.length === 3) {
      return { payment: await orderOnlinePayment(admin(), ctx.organizationId, orderId.data) };
    }
    if (method === "POST" && slugs[3] === "reconcile" && slugs.length === 4) {
      if (!hasPermission(ctx.role, "orders.write")) {
        throw new AppError(ERROR_CODES.FORBIDDEN, "You do not have permission to perform this action.");
      }
      const limited = rateLimit(`merchant-payment-reconcile:${ctx.organizationId}:${orderId.data}`, 6, 60_000);
      if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Checked recently. Try again in a minute.");
      return { payment: await reconcileOrderOnlinePayment(admin(), ctx.organizationId, orderId.data) };
    }
  }

  return null;
}
