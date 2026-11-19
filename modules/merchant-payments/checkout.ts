import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { safeEqual } from "@/lib/security/crypto";
import {
  cashfreeOrderPayment,
  cashfreePaymentState,
  createCashfreePayment,
  reconcileCashfreeOrderPayment,
  resumeCashfreePayment,
  sweepOpenCashfreePayments,
  type CashfreeCheckoutSession,
} from "./cashfree/payments";
import type { merchantCashfreeClient } from "./cashfree/client";
import { resolveCheckoutProvider } from "./gateway";
import { ONLINE_PAYMENT_UNAVAILABLE, type MerchantPaymentProvider } from "./integration";
import {
  confirmStorefrontPayment as confirmRazorpayPayment,
  createStorefrontPayment as createRazorpayPayment,
  orderOnlinePayment as razorpayOrderPayment,
  paymentTokenHash,
  reconcileOrderOnlinePayment as reconcileRazorpayOrderPayment,
  resumeStorefrontPayment as resumeRazorpayPayment,
  storefrontPaymentState as razorpayPaymentState,
  sweepOpenStorefrontPayments as sweepRazorpayPayments,
  type CheckoutSession as RazorpayCheckoutSession,
  type PaymentKind,
} from "./payments";

/**
 * Storefront online payment, routed to the merchant's OWN gateway (Razorpay or Cashfree).
 *
 *  - New checkouts use the gateway from resolveCheckoutProvider (explicit merchant default; never
 *    a silent switch, never a PostBus account).
 *  - An existing attempt always stays on the gateway that created it, even if the merchant later
 *    changes the default, so a customer mid-payment is never moved to another account.
 */

export type StorefrontCheckoutSession = RazorpayCheckoutSession | CashfreeCheckoutSession;

/** Test seam: injected gateway clients. Production always uses the real per-merchant clients. */
type Deps = { cashfreeClient?: typeof merchantCashfreeClient };

export type PendingOnlinePayment = {
  provider: MerchantPaymentProvider;
  status: "PENDING";
  kind: PaymentKind;
  amountDue: number;
  orderTotal: number;
  tokenHash: string;
};

/** Fails before an order is created when the store cannot take online payments. */
export async function assertOnlinePaymentAvailable(admin: SupabaseClient, organizationId: string): Promise<MerchantPaymentProvider> {
  const provider = await resolveCheckoutProvider(admin, organizationId);
  if (!provider) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, ONLINE_PAYMENT_UNAVAILABLE);
  return provider;
}

/** Public storefront flag: which gateway's checkout to show, or null. Says nothing about keys. */
export async function storefrontOnlinePaymentProvider(admin: SupabaseClient, organizationId: string) {
  try {
    return await resolveCheckoutProvider(admin, organizationId);
  } catch {
    return null;
  }
}

/** Order metadata written when an order is placed for online payment. */
export function pendingOnlinePaymentMeta(input: {
  provider: MerchantPaymentProvider;
  kind: PaymentKind;
  amountDue: number;
  orderTotal: number;
  token: string;
}): PendingOnlinePayment {
  return {
    provider: input.provider,
    status: "PENDING",
    kind: input.kind,
    amountDue: input.amountDue,
    orderTotal: input.orderTotal,
    tokenHash: paymentTokenHash(input.token),
  };
}

export type CreatePaymentInput = {
  provider: MerchantPaymentProvider;
  organizationId: string;
  orderId: string;
  orderNumber: string | null;
  kind: PaymentKind;
  amountDue: number;
  orderTotal: number;
  token: string;
  customer?: { name?: string | null; phone?: string | null; email?: string | null } | null;
  returnUrl?: string | null;
};

export async function createStorefrontPayment(admin: SupabaseClient, input: CreatePaymentInput, deps: Deps = {}): Promise<StorefrontCheckoutSession> {
  // The gateway must still be the one checkout resolves to; it is never swapped mid-order.
  const current = await resolveCheckoutProvider(admin, input.organizationId);
  if (current !== input.provider) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, ONLINE_PAYMENT_UNAVAILABLE);
  if (input.provider === "CASHFREE") return createCashfreePayment(admin, input, { client: deps.cashfreeClient });
  return createRazorpayPayment(admin, input);
}

type AttemptRef = { organizationId: string; orderId: string; token: string };

async function attemptProvider(admin: SupabaseClient, ref: AttemptRef): Promise<MerchantPaymentProvider | null> {
  if (!/^[0-9a-f-]{36}$/i.test(ref.orderId)) return null;
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select("provider")
    .eq("organization_id", ref.organizationId)
    .eq("order_id", ref.orderId)
    .maybeSingle();
  const provider = (data as { provider?: string } | null)?.provider;
  return provider === "CASHFREE" ? "CASHFREE" : provider === "RAZORPAY" ? "RAZORPAY" : null;
}

/** The gateway recorded on the order when it was placed (attempt not created yet). */
async function pendingProvider(admin: SupabaseClient, ref: AttemptRef) {
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, metadata")
    .eq("id", ref.orderId)
    .eq("organization_id", ref.organizationId)
    .maybeSingle();
  const pending = (order?.metadata as { storefront?: { onlinePayment?: Partial<PendingOnlinePayment> } } | null)?.storefront?.onlinePayment ?? null;
  if (
    !order ||
    !pending?.tokenHash ||
    !/^[a-f0-9]{48}$/.test(ref.token) ||
    !safeEqual(pending.tokenHash, paymentTokenHash(ref.token)) ||
    (pending.kind !== "FULL" && pending.kind !== "COD_ADVANCE")
  ) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  }
  // Orders placed before Cashfree existed carry provider RAZORPAY (or nothing).
  const provider: MerchantPaymentProvider = pending.provider === "CASHFREE" ? "CASHFREE" : "RAZORPAY";
  return { provider, pending, orderNumber: (order.order_number as string | null) ?? null };
}

/** Re-opens checkout. Starts the gateway order now if it could not be created at order time. */
export async function resumeStorefrontPayment(admin: SupabaseClient, ref: AttemptRef & { returnUrl?: string | null }, deps: Deps = {}) {
  const provider = await attemptProvider(admin, ref);
  if (provider === "CASHFREE") return resumeCashfreePayment(admin, ref, { client: deps.cashfreeClient });
  if (provider === "RAZORPAY") return resumeRazorpayPayment(admin, ref);

  const pending = await pendingProvider(admin, ref);
  if (pending.provider === "RAZORPAY") {
    // The Razorpay module re-validates the token and starts from the stored order metadata.
    const current = await resolveCheckoutProvider(admin, ref.organizationId);
    if (current !== "RAZORPAY") throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, ONLINE_PAYMENT_UNAVAILABLE);
    return resumeRazorpayPayment(admin, ref);
  }
  const session = await createStorefrontPayment(admin, {
    provider: "CASHFREE",
    organizationId: ref.organizationId,
    orderId: ref.orderId,
    orderNumber: pending.orderNumber,
    kind: pending.pending.kind as PaymentKind,
    amountDue: Number(pending.pending.amountDue),
    orderTotal: Number(pending.pending.orderTotal),
    token: ref.token,
    returnUrl: ref.returnUrl ?? null,
  }, deps);
  return {
    state: { orderId: ref.orderId, status: "CREATED" as const, amountPaise: session.amountPaise, method: null, failureReason: null },
    session,
  };
}

export async function storefrontPaymentState(admin: SupabaseClient, ref: AttemptRef & { force?: boolean }, deps: Deps = {}) {
  const provider = await attemptProvider(admin, ref);
  if (provider === "CASHFREE") return cashfreePaymentState(admin, ref, { client: deps.cashfreeClient });
  return razorpayPaymentState(admin, ref);
}

/** Razorpay's signed browser callback. Cashfree has no client signature: use verify instead. */
export async function confirmRazorpayStorefrontPayment(admin: SupabaseClient, input: Parameters<typeof confirmRazorpayPayment>[1]) {
  const provider = await attemptProvider(admin, input);
  if (provider !== "RAZORPAY") throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  return confirmRazorpayPayment(admin, input);
}

/** After Cashfree Checkout closes: always re-check with Cashfree's API. Never trusts the browser. */
export async function verifyCashfreeStorefrontPayment(admin: SupabaseClient, ref: AttemptRef, deps: Deps = {}) {
  const provider = await attemptProvider(admin, ref);
  if (provider !== "CASHFREE") throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  return cashfreePaymentState(admin, { ...ref, force: true }, { client: deps.cashfreeClient });
}

async function dashboardProvider(admin: SupabaseClient, organizationId: string, orderId: string) {
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select("provider")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as { provider?: string } | null)?.provider ?? null;
}

/** Dashboard: one order's online payment, whichever gateway took it. */
export async function orderOnlinePayment(admin: SupabaseClient, organizationId: string, orderId: string) {
  const provider = await dashboardProvider(admin, organizationId, orderId);
  if (provider === "CASHFREE") return cashfreeOrderPayment(admin, organizationId, orderId);
  const razorpay = await razorpayOrderPayment(admin, organizationId, orderId);
  return razorpay ? { ...razorpay, providerOrderId: razorpay.razorpayOrderId, providerPaymentId: razorpay.razorpayPaymentId } : null;
}

export async function reconcileOrderOnlinePayment(admin: SupabaseClient, organizationId: string, orderId: string) {
  const provider = await dashboardProvider(admin, organizationId, orderId);
  if (provider === "CASHFREE") return reconcileCashfreeOrderPayment(admin, organizationId, orderId);
  const razorpay = await reconcileRazorpayOrderPayment(admin, organizationId, orderId);
  return razorpay ? { ...razorpay, providerOrderId: razorpay.razorpayOrderId, providerPaymentId: razorpay.razorpayPaymentId } : null;
}

/** Cron: both gateways, each strictly with its own merchant credentials. */
export async function sweepOpenMerchantPayments(admin: SupabaseClient, deps: Deps = {}) {
  const [razorpay, cashfree] = await Promise.all([
    sweepRazorpayPayments(admin).catch(() => ({ checked: 0, failed: 1 })),
    sweepOpenCashfreePayments(admin, { client: deps.cashfreeClient }).catch(() => ({ checked: 0, failed: 1 })),
  ]);
  return { razorpay, cashfree };
}
