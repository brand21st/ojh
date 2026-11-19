import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { hashSecret, randomToken, safeEqual } from "@/lib/security/crypto";
import { verifyOrderCheckoutSignature } from "@/modules/razorpay/signature";
import {
  activeMerchantGateway,
  credentialsOf,
  loadIntegration,
  ONLINE_PAYMENT_UNAVAILABLE,
  type MerchantPaymentIntegrationRow,
} from "./integration";
import { merchantRazorpayClient, type MerchantRazorpayClient, type MerchantRazorpayPayment } from "./razorpay";

/**
 * Storefront payment attempts on the MERCHANT's Razorpay account (Domain B).
 *
 * Trust model: the browser only ever supplies identifiers (order id, attempt token, Razorpay ids,
 * signature). Amounts come from the server-priced order; the organization comes from the store
 * link; payment status comes from Razorpay itself, fetched with the merchant's own keys. Every
 * state change goes through the apply_merchant_storefront_payment RPC.
 */

export type PaymentKind = "FULL" | "COD_ADVANCE";
export type StorefrontPaymentStatus = "CREATED" | "FAILED" | "AUTHORIZED" | "PAID" | "REFUNDED";

export type StorefrontPaymentRow = {
  id: string;
  organization_id: string;
  integration_id: string;
  order_id: string;
  payment_mode: "TEST" | "LIVE";
  key_fingerprint: string;
  payment_kind: PaymentKind;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount_paise: number;
  order_total_paise: number;
  currency: string;
  payment_status: StorefrontPaymentStatus;
  payment_method: string | null;
  failure_reason: string | null;
  checkout_token_hash: string;
  needs_review: boolean;
  review_reason: string | null;
  extra_payment_ids: string[];
  last_reconciled_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
};

const PAYMENT_COLUMNS =
  "id, organization_id, integration_id, order_id, payment_mode, key_fingerprint, payment_kind, razorpay_order_id, razorpay_payment_id, amount_paise, order_total_paise, currency, payment_status, payment_method, failure_reason, checkout_token_hash, needs_review, review_reason, extra_payment_ids, last_reconciled_at, paid_at, refunded_at, created_at, updated_at";

export type CheckoutSession = {
  provider: "RAZORPAY";
  keyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: "INR";
  mode: "TEST" | "LIVE";
  orderId: string;
  token: string;
};

type Deps = { client?: typeof merchantRazorpayClient };

/** Rupees (2 dp) → integer paise. Rejects anything that is not a whole number of paise. */
export function toPaise(rupees: number) {
  if (!Number.isFinite(rupees)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid payment amount.");
  const paise = Math.round(rupees * 100);
  if (Math.abs(paise - rupees * 100) > 0.001) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid payment amount.");
  return paise;
}

function tokenHash(token: string) {
  return hashSecret(`postbus.storefront-payment.v1\0${token}`);
}

/** Bearer token the storefront holds for one order's payment. Only its hash is stored. */
export function newPaymentToken() {
  return randomToken(24);
}

async function loadAttempt(admin: SupabaseClient, organizationId: string, orderId: string) {
  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .select(PAYMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not load the payment.");
  return (data as StorefrontPaymentRow | null) ?? null;
}

/** Loads an attempt for a public caller. Unknown order and wrong token look identical. */
async function attemptForBuyer(admin: SupabaseClient, input: { organizationId: string; orderId: string; token: string }) {
  const row = /^[0-9a-f-]{36}$/i.test(input.orderId) ? await loadAttempt(admin, input.organizationId, input.orderId) : null;
  if (!row || !/^[a-f0-9]{48}$/.test(input.token) || !safeEqual(row.checkout_token_hash, tokenHash(input.token))) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  }
  return row;
}

/**
 * Keys for an existing attempt: the integration must still hold the SAME Razorpay account that
 * created the order. Works even when online checkout is switched off, so in-flight payments can
 * still be verified and reconciled.
 */
export async function clientForAttempt(admin: SupabaseClient, row: StorefrontPaymentRow, deps: Deps = {}) {
  const { row: integration } = await loadIntegration(admin, row.organization_id);
  if (!integration || integration.id !== row.integration_id) return null;
  const creds = credentialsOf(integration);
  if (!creds || creds.fingerprint !== row.key_fingerprint) return null;
  return { client: (deps.client ?? merchantRazorpayClient)(creds), creds, integration };
}

function sessionFor(row: StorefrontPaymentRow, keyId: string, token: string): CheckoutSession {
  return {
    provider: "RAZORPAY",
    keyId,
    razorpayOrderId: row.razorpay_order_id,
    amountPaise: Number(row.amount_paise),
    currency: "INR",
    mode: row.payment_mode,
    orderId: row.order_id,
    token,
  };
}

/** Called before an order is created, so a broken configuration fails before anything is saved. */
export async function assertOnlinePaymentAvailable(admin: SupabaseClient, organizationId: string) {
  await activeMerchantGateway(admin, organizationId);
}

/**
 * Creates the Razorpay order on the merchant's account for a PostBus order that the server has
 * already priced. One attempt per PostBus order; a repeat call for the same order is refused.
 */
export async function createStorefrontPayment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    orderId: string;
    orderNumber: string | null;
    kind: PaymentKind;
    amountDue: number;
    orderTotal: number;
    token: string;
  },
  deps: Deps = {}
): Promise<CheckoutSession> {
  const gateway = await activeMerchantGateway(admin, input.organizationId, deps);
  const amountPaise = toPaise(input.amountDue);
  const totalPaise = toPaise(input.orderTotal);
  if (amountPaise < 100 || amountPaise > totalPaise) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This order amount cannot be paid online.");
  }
  const { data: order } = await admin
    .from("orders")
    .select("id, organization_id, status, payment_status")
    .eq("id", input.orderId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!order || order.status !== "IMPORTED" || order.payment_status !== "PENDING") {
    throw new AppError(ERROR_CODES.CONFLICT, "This order is not waiting for payment.");
  }

  const razorpayOrder = await gateway.client.createOrder({
    amountPaise,
    receipt: `pb_${input.orderId.replace(/-/g, "").slice(0, 32)}`,
    notes: {
      postbus_order_id: input.orderId,
      postbus_order_number: input.orderNumber ?? "",
      purpose: "postbus_storefront_order",
    },
  });
  if (!razorpayOrder?.id || Number(razorpayOrder.amount) !== amountPaise || razorpayOrder.currency !== "INR") {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Razorpay returned an unexpected order. Please try again.");
  }

  const token = input.token;
  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .insert({
      organization_id: input.organizationId,
      integration_id: gateway.integration.id,
      order_id: input.orderId,
      payment_mode: gateway.credentials.mode,
      key_fingerprint: gateway.credentials.fingerprint,
      payment_kind: input.kind,
      razorpay_order_id: razorpayOrder.id,
      amount_paise: amountPaise,
      order_total_paise: totalPaise,
      currency: "INR",
      checkout_token_hash: tokenHash(token),
    })
    .select(PAYMENT_COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === "23505") throw new AppError(ERROR_CODES.CONFLICT, "Payment for this order is already being prepared.");
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not start the payment. Please try again.");
  }
  await admin.from("audit_logs").insert({
    organization_id: input.organizationId,
    actor_id: null,
    action: "merchant_payment.created",
    entity_type: "order",
    entity_id: input.orderId,
    after: { amountPaise, kind: input.kind, mode: gateway.credentials.mode },
  });
  return sessionFor(data as StorefrontPaymentRow, gateway.credentials.keyId, token);
}

export type BuyerPaymentState = {
  orderId: string;
  status: StorefrontPaymentStatus;
  amountPaise: number;
  method: string | null;
  failureReason: string | null;
};

function buyerState(row: StorefrontPaymentRow): BuyerPaymentState {
  return {
    orderId: row.order_id,
    status: row.payment_status,
    amountPaise: Number(row.amount_paise),
    method: row.payment_method,
    failureReason: row.payment_status === "FAILED" ? row.failure_reason : null,
  };
}

/** Re-opens checkout for an unpaid attempt (after a cancel or failure). Same Razorpay order. */
export async function resumeStorefrontPayment(
  admin: SupabaseClient,
  input: { organizationId: string; orderId: string; token: string },
  deps: Deps = {}
): Promise<{ state: BuyerPaymentState; session: CheckoutSession | null }> {
  const existing = /^[0-9a-f-]{36}$/i.test(input.orderId) ? await loadAttempt(admin, input.organizationId, input.orderId) : null;
  if (!existing) {
    // The Razorpay order could not be created when the order was placed (e.g. Razorpay timed out).
    const session = await startFromOrder(admin, input, deps);
    return { state: { orderId: input.orderId, status: "CREATED", amountPaise: session.amountPaise, method: null, failureReason: null }, session };
  }
  const row = await attemptForBuyer(admin, input);
  if (row.payment_status === "PAID" || row.payment_status === "REFUNDED" || row.payment_status === "AUTHORIZED") {
    return { state: buyerState(row), session: null };
  }
  const { row: integration } = await loadIntegration(admin, row.organization_id);
  const resolved = integration?.enabled && integration.connection_status === "CONNECTED" ? await clientForAttempt(admin, row, deps) : null;
  if (!resolved) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, ONLINE_PAYMENT_UNAVAILABLE);
  return { state: buyerState(row), session: sessionFor(row, resolved.creds.keyId, input.token) };
}

export type PendingOnlinePayment = {
  provider: "RAZORPAY";
  status: "PENDING";
  kind: PaymentKind;
  amountDue: number;
  orderTotal: number;
  tokenHash: string;
};

/** Order metadata written by the server when an order is placed for online payment. */
export function pendingOnlinePaymentMeta(input: { kind: PaymentKind; amountDue: number; orderTotal: number; token: string }): PendingOnlinePayment {
  return { provider: "RAZORPAY", status: "PENDING", kind: input.kind, amountDue: input.amountDue, orderTotal: input.orderTotal, tokenHash: tokenHash(input.token) };
}

async function startFromOrder(admin: SupabaseClient, input: { organizationId: string; orderId: string; token: string }, deps: Deps) {
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, metadata")
    .eq("id", input.orderId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  const pending = ((order?.metadata as { storefront?: { onlinePayment?: Partial<PendingOnlinePayment> } } | null)?.storefront?.onlinePayment ?? null);
  if (
    !order ||
    !pending?.tokenHash ||
    !/^[a-f0-9]{48}$/.test(input.token) ||
    !safeEqual(pending.tokenHash, tokenHash(input.token)) ||
    (pending.kind !== "FULL" && pending.kind !== "COD_ADVANCE")
  ) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  }
  return createStorefrontPayment(
    admin,
    {
      organizationId: input.organizationId,
      orderId: input.orderId,
      orderNumber: (order.order_number as string | null) ?? null,
      kind: pending.kind,
      amountDue: Number(pending.amountDue),
      orderTotal: Number(pending.orderTotal),
      token: input.token,
    },
    deps
  );
}

function statusOfPayment(payment: MerchantRazorpayPayment): "PAID" | "AUTHORIZED" | "FAILED" | "REFUNDED" | null {
  const status = String(payment.status ?? "").toLowerCase();
  if (status === "captured") return "PAID";
  if (status === "authorized") return "AUTHORIZED";
  if (status === "failed") return "FAILED";
  if (status === "refunded") return "REFUNDED";
  return null;
}

export type ApplyResult = { result: string; payment_id?: string; order_id?: string; settled?: boolean };

export async function applyPayment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    razorpayOrderId: string;
    payment: MerchantRazorpayPayment;
    status: "PAID" | "AUTHORIZED" | "FAILED" | "REFUNDED";
    source: "CHECKOUT" | "WEBHOOK" | "RECONCILE";
  }
): Promise<ApplyResult> {
  const { data, error } = await admin.rpc("apply_merchant_storefront_payment", {
    p_organization_id: input.organizationId,
    p_razorpay_order_id: input.razorpayOrderId,
    p_razorpay_payment_id: input.payment.id,
    p_status: input.status,
    p_amount_paise: Number(input.payment.amount),
    p_currency: String(input.payment.currency ?? "").toUpperCase(),
    p_method: input.payment.method ? String(input.payment.method).slice(0, 40) : null,
    p_failure_reason: input.payment.error_description ? String(input.payment.error_description).slice(0, 300) : null,
    p_source: input.source,
  });
  if (error) {
    logError("merchant_payment.apply_failed", { organizationId: input.organizationId, source: input.source, code: error.code });
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not record the payment. It will be retried.");
  }
  const result = (data ?? { result: "unknown" }) as ApplyResult;
  if (result.result === "amount_mismatch") {
    logError("merchant_payment.amount_mismatch", { organizationId: input.organizationId, source: input.source });
  }
  if (result.result === "paid" && result.settled && result.order_id) {
    await afterSettled(admin, input.organizationId, result.order_id);
  }
  return result;
}

/** One-time side effects of a newly paid order. Never books India Post. */
async function afterSettled(admin: SupabaseClient, organizationId: string, orderId: string) {
  try {
    const { error: claimError } = await admin.from("idempotency_keys").insert({
      organization_id: organizationId,
      key: `merchant_payment:paid_notice:${orderId}`,
      request_hash: orderId,
    });
    if (claimError) return;
    const { data: order } = await admin
      .from("orders")
      .select("id, order_number, total_amount, customers(name, phone)")
      .eq("id", orderId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!order) return;
    const customer = (Array.isArray(order.customers) ? order.customers[0] : order.customers) as { name?: string; phone?: string } | null;
    await admin.from("notifications").insert({
      organization_id: organizationId,
      type: "storefront.online_payment_received",
      title: "Online payment received",
      body: `${order.order_number} · ${customer?.name ?? "Customer"} · ₹${order.total_amount}`,
      entity_type: "order",
      entity_id: orderId,
    });
    if (customer?.phone) {
      const { notifyCustomerPaymentConfirmed } = await import("@/modules/storefront/order-notify");
      await notifyCustomerPaymentConfirmed(admin, organizationId, customer.phone, String(order.order_number), orderId);
    }
  } catch (error) {
    // Notices are best effort; the payment is already recorded.
    logError("merchant_payment.notify_failed", { organizationId, message: error instanceof Error ? error.message : "notify failed" });
  }
}

/**
 * Browser callback after Razorpay Checkout succeeds. The signature proves the ids came from
 * Razorpay; the payment is then fetched from Razorpay so status and amount are never taken from
 * the browser.
 */
export async function confirmStorefrontPayment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    orderId: string;
    token: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    signature: string;
  },
  deps: Deps = {}
): Promise<BuyerPaymentState> {
  const row = await attemptForBuyer(admin, input);
  if (input.razorpayOrderId !== row.razorpay_order_id) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This payment does not belong to this order.");
  }
  if (row.payment_status === "PAID" && row.razorpay_payment_id === input.razorpayPaymentId) {
    return buyerState(row);
  }
  const resolved = await clientForAttempt(admin, row, deps);
  if (!resolved) {
    await flagForReview(admin, row, "Payment callback arrived after the Razorpay keys changed.");
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "We could not verify this payment automatically. The store will confirm it.");
  }
  const valid =
    /^pay_[A-Za-z0-9]+$/.test(input.razorpayPaymentId) &&
    /^[a-f0-9]{64}$/.test(input.signature) &&
    verifyOrderCheckoutSignature({
      orderId: row.razorpay_order_id,
      paymentId: input.razorpayPaymentId,
      signature: input.signature,
      secret: resolved.creds.keySecret,
    });
  if (!valid) {
    logError("merchant_payment.invalid_signature", { organizationId: row.organization_id });
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Payment could not be verified.");
  }
  const payment = await resolved.client.fetchPayment(input.razorpayPaymentId);
  if (payment.order_id !== row.razorpay_order_id) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This payment does not belong to this order.");
  }
  const status = statusOfPayment(payment);
  if (status) {
    const applied = await applyPayment(admin, {
      organizationId: row.organization_id,
      razorpayOrderId: row.razorpay_order_id,
      payment,
      status,
      source: "CHECKOUT",
    });
    if (applied.result === "amount_mismatch") {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "The paid amount does not match this order. The store will review it.");
    }
  }
  return buyerState((await loadAttempt(admin, row.organization_id, row.order_id)) ?? row);
}

/** Customer polling (after a dismissed checkout, or while a webhook is delayed). */
export async function storefrontPaymentState(
  admin: SupabaseClient,
  input: { organizationId: string; orderId: string; token: string },
  deps: Deps = {}
): Promise<BuyerPaymentState> {
  let row = await attemptForBuyer(admin, input);
  const recentlyChecked = row.last_reconciled_at && Date.now() - Date.parse(row.last_reconciled_at) < 10_000;
  if (row.payment_status !== "PAID" && row.payment_status !== "REFUNDED" && !recentlyChecked) {
    row = (await reconcileAttempt(admin, row, deps).catch(() => null)) ?? row;
  }
  return buyerState(row);
}

async function flagForReview(admin: SupabaseClient, row: StorefrontPaymentRow, reason: string) {
  await admin
    .from("merchant_storefront_payments")
    .update({ needs_review: true, review_reason: reason })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
}

/**
 * Pulls the truth from Razorpay for one attempt and applies it. Recovers payments whose browser
 * callback and webhook were both lost.
 */
export async function reconcileAttempt(
  admin: SupabaseClient,
  row: StorefrontPaymentRow,
  deps: Deps & { resolved?: { client: MerchantRazorpayClient } | null } = {}
): Promise<StorefrontPaymentRow | null> {
  const resolved = deps.resolved !== undefined ? deps.resolved : await clientForAttempt(admin, row, deps);
  await admin
    .from("merchant_storefront_payments")
    .update({ last_reconciled_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
  if (!resolved) return loadAttempt(admin, row.organization_id, row.order_id);

  const listed = await resolved.client.fetchOrderPayments(row.razorpay_order_id);
  const payments = (listed.items ?? []).filter((payment) => payment.order_id === row.razorpay_order_id);
  const byStatus = (wanted: string) => payments.filter((payment) => String(payment.status).toLowerCase() === wanted);
  const captured = [...byStatus("captured"), ...byStatus("refunded")];
  // Earliest captured payment wins; later ones are flagged as duplicates by the RPC.
  const ordered = captured.sort((a, b) => Number((a as { created_at?: number }).created_at ?? 0) - Number((b as { created_at?: number }).created_at ?? 0));
  for (const payment of ordered) {
    await applyPayment(admin, { organizationId: row.organization_id, razorpayOrderId: row.razorpay_order_id, payment, status: "PAID", source: "RECONCILE" });
    if (String(payment.status).toLowerCase() === "refunded") {
      await applyPayment(admin, { organizationId: row.organization_id, razorpayOrderId: row.razorpay_order_id, payment, status: "REFUNDED", source: "RECONCILE" });
    }
  }
  if (!ordered.length) {
    const authorized = byStatus("authorized")[0];
    const failed = byStatus("failed").at(-1);
    if (authorized) {
      await applyPayment(admin, { organizationId: row.organization_id, razorpayOrderId: row.razorpay_order_id, payment: authorized, status: "AUTHORIZED", source: "RECONCILE" });
    } else if (failed) {
      await applyPayment(admin, { organizationId: row.organization_id, razorpayOrderId: row.razorpay_order_id, payment: failed, status: "FAILED", source: "RECONCILE" });
    }
  }
  return loadAttempt(admin, row.organization_id, row.order_id);
}

const OPEN_STATUSES = ["CREATED", "FAILED", "AUTHORIZED"];

/** Reconciles every open attempt made with this integration's current keys (before replace/disconnect). */
export async function reconcileOpenAttemptsForIntegration(admin: SupabaseClient, integration: MerchantPaymentIntegrationRow, deps: Deps = {}) {
  const creds = credentialsOf(integration);
  if (!creds) return { checked: 0 };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select(PAYMENT_COLUMNS)
    .eq("organization_id", integration.organization_id)
    .eq("integration_id", integration.id)
    .eq("key_fingerprint", creds.fingerprint)
    .in("payment_status", OPEN_STATUSES)
    .gte("created_at", since)
    .limit(200);
  const client = (deps.client ?? merchantRazorpayClient)(creds);
  let checked = 0;
  for (const row of (data ?? []) as StorefrontPaymentRow[]) {
    await reconcileAttempt(admin, row, { resolved: { client } }).catch(() => null);
    checked += 1;
  }
  return { checked };
}

/** Cron sweep for missed callbacks and webhooks. */
export async function sweepOpenStorefrontPayments(admin: SupabaseClient, deps: Deps = {}) {
  const now = Date.now();
  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .select(PAYMENT_COLUMNS)
    .in("payment_status", OPEN_STATUSES)
    .lte("created_at", new Date(now - 5 * 60_000).toISOString())
    .gte("created_at", new Date(now - 3 * 86_400_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return { checked: 0, failed: 0 };
    throw new Error("Could not list open storefront payments.");
  }
  let checked = 0;
  let failed = 0;
  for (const row of (data ?? []) as StorefrontPaymentRow[]) {
    if (row.last_reconciled_at && now - Date.parse(row.last_reconciled_at) < 10 * 60_000) continue;
    try {
      await reconcileAttempt(admin, row, deps);
      checked += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked, failed };
}

/** Dashboard view of an order's online payment. Organization comes from the tenant context. */
export async function orderOnlinePayment(admin: SupabaseClient, organizationId: string, orderId: string) {
  const row = await loadAttempt(admin, organizationId, orderId);
  if (!row) return null;
  return {
    provider: "RAZORPAY" as const,
    status: row.payment_status,
    mode: row.payment_mode,
    kind: row.payment_kind,
    amount: Number(row.amount_paise) / 100,
    orderTotal: Number(row.order_total_paise) / 100,
    currency: row.currency,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id,
    method: row.payment_method,
    failureReason: row.failure_reason,
    needsReview: row.needs_review,
    reviewReason: row.review_reason,
    extraPaymentIds: row.extra_payment_ids ?? [],
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
    lastReconciledAt: row.last_reconciled_at,
  };
}

export async function reconcileOrderOnlinePayment(admin: SupabaseClient, organizationId: string, orderId: string, deps: Deps = {}) {
  const row = await loadAttempt(admin, organizationId, orderId);
  if (!row) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This order has no online payment.");
  const resolved = await clientForAttempt(admin, row, deps);
  if (!resolved) {
    throw new AppError(
      ERROR_CODES.INTEGRATION_NOT_CONNECTED,
      "The Razorpay account that took this payment is no longer connected. Check the payment in your Razorpay Dashboard."
    );
  }
  await reconcileAttempt(admin, row, { resolved });
  return orderOnlinePayment(admin, organizationId, orderId);
}
