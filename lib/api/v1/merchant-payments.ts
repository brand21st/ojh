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
import { reconcileOpenAttemptsForIntegration } from "@/modules/merchant-payments/payments";
import { orderOnlinePayment, reconcileOrderOnlinePayment } from "@/modules/merchant-payments/checkout";
import {
  disconnectMerchantCashfree,
  getCashfreeView,
  saveMerchantCashfree,
  setMerchantCashfreeEnabled,
  verifyMerchantCashfree,
} from "@/modules/merchant-payments/cashfree/integration";
import { reconcileOpenCashfreeAttempts } from "@/modules/merchant-payments/cashfree/payments";
import { ensureDefaultProvider, gatewayOverview, setDefaultProvider } from "@/modules/merchant-payments/gateway";

/**
 * Dashboard routes for the merchant's own Razorpay / Cashfree accounts (Domain B).
 *
 *   GET/PUT/PATCH/DELETE integrations/cashfree, POST integrations/cashfree/verify   (same shape as Razorpay)
 *   GET/PUT integrations/payment-gateway   default gateway for storefront online payments
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
const cashfreeSaveSchema = z.object({
  mode: z.enum(["TEST", "LIVE"]),
  clientId: z.string().trim().max(100).optional().nullable(),
  clientSecret: z.string().trim().max(200).optional().nullable(),
});
const gatewaySchema = z.object({ defaultProvider: z.enum(["RAZORPAY", "CASHFREE"]) });

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

/** Lightweight Cashfree card for GET integrations. Null when the Cashfree migration is not deployed. */
export async function merchantCashfreeSummary(organizationId: string) {
  if (!hasAdminClient()) return null;
  try {
    const client = createAdminClient();
    const overview = await gatewayOverview(client, organizationId);
    if (!overview.available) return null;
    const view = await getCashfreeView(client, organizationId);
    if (!view.available) return null;
    return {
      provider: "cashfree",
      name: "Cashfree Payments",
      status: view.status,
      enabled: view.enabled,
      mode: view.mode,
      isDefaultGateway: overview.activeProvider === "CASHFREE",
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
      const client = admin();
      const view = await setMerchantRazorpayEnabled(client, actor, body.enabled);
      if (body.enabled) await ensureDefaultProvider(client, actor, "RAZORPAY");
      return view;
    }
    if (key === "DELETE integrations/razorpay") {
      const client = admin();
      return disconnectMerchantRazorpay(client, actor, {
        reconcileOpen: (row) => reconcileOpenAttemptsForIntegration(client, row),
      });
    }
    return null;
  }

  if (slugs[0] === "integrations" && slugs[1] === "cashfree") {
    // dispatchTenantRoutes already required integrations.manage for every route below.
    if (key === "GET integrations/cashfree") {
      const client = admin();
      const [view, gateway] = await Promise.all([getCashfreeView(client, ctx.organizationId), gatewayOverview(client, ctx.organizationId)]);
      return { ...view, gateway };
    }
    const limited = rateLimit(`merchant-cashfree:${ctx.organizationId}`, 20, 60_000);
    if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again in a minute.");

    if (key === "PUT integrations/cashfree" || key === "POST integrations/cashfree") {
      const body = cashfreeSaveSchema.parse(await request.json().catch(() => ({})));
      const client = admin();
      return saveMerchantCashfree(client, actor, body, {
        reconcileOpen: (row) => reconcileOpenCashfreeAttempts(client, row),
      });
    }
    if (key === "POST integrations/cashfree/verify") return verifyMerchantCashfree(admin(), actor);
    if (key === "PATCH integrations/cashfree") {
      const body = toggleSchema.parse(await request.json().catch(() => ({})));
      const client = admin();
      const view = await setMerchantCashfreeEnabled(client, actor, body.enabled);
      if (body.enabled) await ensureDefaultProvider(client, actor, "CASHFREE");
      return view;
    }
    if (key === "DELETE integrations/cashfree") {
      const client = admin();
      return disconnectMerchantCashfree(client, actor, {
        reconcileOpen: (row) => reconcileOpenCashfreeAttempts(client, row),
      });
    }
    return null;
  }

  if (slugs[0] === "integrations" && slugs[1] === "payment-gateway") {
    if (key === "GET integrations/payment-gateway") return gatewayOverview(admin(), ctx.organizationId);
    if (key === "PUT integrations/payment-gateway") {
      const limited = rateLimit(`merchant-gateway:${ctx.organizationId}`, 20, 60_000);
      if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again in a minute.");
      const body = gatewaySchema.parse(await request.json().catch(() => ({})));
      return setDefaultProvider(admin(), actor, body.defaultProvider);
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
