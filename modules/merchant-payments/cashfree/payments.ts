import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { hashSecret, safeEqual } from "@/lib/security/crypto";
import type { MerchantPaymentIntegrationRow } from "../integration";
import { notifyStorefrontPaymentSettled, paymentTokenHash, toPaise, type ApplyResult, type PaymentKind } from "../payments";
import {
  cashfreeAmountToPaise,
  CashfreeConflictError,
  CashfreeNotFoundError,
  merchantCashfreeClient,
  type CashfreeOrder,
  type CashfreePayment,
  type MerchantCashfreeClient,
} from "./client";
import {
  activeCashfreeGateway,
  CASHFREE_UNAVAILABLE,
  cashfreeCredentialsOf,
  cashfreeUsable,
  cashfreeWebhookUrl,
  loadCashfreeIntegration,
} from "./integration";

/**
 * Storefront payment attempts on the MERCHANT's Cashfree account (Domain B).
 *
 * Trust model: the browser only supplies identifiers (order id + attempt token). The amount comes
 * from the server-priced order; the organization from the store link; payment status ONLY from
 * Cashfree's Get Order / Get Payments APIs called with the merchant's own credentials. The
 * checkout promise, return URL and webhook body are triggers to check, never proof of payment.
 * Every state change goes through apply_merchant_cashfree_payment.
 */

export type CashfreeAttemptStatus = "CREATED" | "FAILED" | "CANCELLED" | "PROCESSING" | "PAID" | "REFUNDED";

export type CashfreeAttemptRow = {
  id: string;
  organization_id: string;
  integration_id: string;
  order_id: string;
  provider: "CASHFREE";
  payment_mode: "TEST" | "LIVE";
  key_fingerprint: string;
  payment_kind: PaymentKind;
  cashfree_order_id: string;
  cashfree_cf_order_id: string | null;
  cashfree_payment_id: string | null;
  amount_paise: number;
  order_total_paise: number;
  currency: string;
  payment_status: CashfreeAttemptStatus;
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

const COLUMNS =
  "id, organization_id, integration_id, order_id, provider, payment_mode, key_fingerprint, payment_kind, cashfree_order_id, cashfree_cf_order_id, cashfree_payment_id, amount_paise, order_total_paise, currency, payment_status, payment_method, failure_reason, checkout_token_hash, needs_review, review_reason, extra_payment_ids, last_reconciled_at, paid_at, refunded_at, created_at, updated_at";

/** What the browser needs to open Cashfree Checkout. payment_session_id is not a credential. */
export type CashfreeCheckoutSession = {
  provider: "CASHFREE";
  paymentSessionId: string;
  /** Mode for the Cashfree JS SDK. */
  environment: "sandbox" | "production";
  cashfreeOrderId: string;
  amountPaise: number;
  currency: "INR";
  mode: "TEST" | "LIVE";
  orderId: string;
  token: string;
};

export type BuyerCashfreeState = {
  orderId: string;
  status: CashfreeAttemptStatus;
  amountPaise: number;
  method: string | null;
  failureReason: string | null;
};

type Deps = { client?: typeof merchantCashfreeClient };

/** Our order_id at Cashfree: 3–45 chars of [A-Za-z0-9_-], unique per PostBus order. */
export function cashfreeOrderIdFor(orderId: string) {
  return `pb_${orderId.replace(/-/g, "").toLowerCase()}`;
}

/** Stable UUID-shaped idempotency key for creating this order's Cashfree order. */
export function cashfreeIdempotencyKey(organizationId: string, orderId: string) {
  const h = hashSecret(`postbus.cashfree.create-order.v1\0${organizationId}\0${orderId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Cashfree needs a 10-digit phone; storefront phones are Indian mobiles in various formats. */
export function cashfreePhone(raw: string | null | undefined) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

/**
 * Return URL after a redirect checkout (in-app browsers). Only http(s) URLs; http only for local
 * development; query and fragment are dropped so no token can leak into it; max 250 characters.
 */
export function safeCashfreeReturnUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username || url.password) return null;
    const clean = `${url.origin}${url.pathname}?postbus_payment=return`;
    return clean.length <= 250 ? clean : null;
  } catch {
    return null;
  }
}

/** Cashfree payment_status → PostBus attempt status. NOT_ATTEMPTED and unknown values → null. */
export function attemptStatusOf(payment: Pick<CashfreePayment, "payment_status">): "PAID" | "PROCESSING" | "FAILED" | "CANCELLED" | null {
  switch (String(payment.payment_status ?? "").toUpperCase()) {
    case "SUCCESS":
      return "PAID";
    case "PENDING":
      return "PROCESSING";
    case "FAILED":
    case "VOID":
      return "FAILED";
    case "USER_DROPPED":
    case "CANCELLED":
      return "CANCELLED";
    default:
      return null;
  }
}

function paymentTime(payment: CashfreePayment) {
  const value = Date.parse(String(payment.payment_completion_time || payment.payment_time || ""));
  return Number.isFinite(value) ? value : 0;
}

async function loadAttempt(admin: SupabaseClient, organizationId: string, orderId: string) {
  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .eq("provider", "CASHFREE")
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not load the payment.");
  return (data as CashfreeAttemptRow | null) ?? null;
}

export async function loadCashfreeAttemptByCashfreeOrder(admin: SupabaseClient, organizationId: string, cashfreeOrderId: string) {
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("provider", "CASHFREE")
    .eq("cashfree_order_id", cashfreeOrderId)
    .maybeSingle();
  return (data as CashfreeAttemptRow | null) ?? null;
}

/** Unknown order and wrong token look identical to a public caller. */
async function attemptForBuyer(admin: SupabaseClient, input: { organizationId: string; orderId: string; token: string }) {
  const row = /^[0-9a-f-]{36}$/i.test(input.orderId) ? await loadAttempt(admin, input.organizationId, input.orderId) : null;
  if (!row || !/^[a-f0-9]{48}$/.test(input.token) || !safeEqual(row.checkout_token_hash, paymentTokenHash(input.token))) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Payment not found.");
  }
  return row;
}

/**
 * Credentials for an existing attempt: the integration must still hold the SAME Cashfree account
 * and environment that created the order. Works while checkout is switched off, so in-flight
 * payments still reconcile.
 */
export async function cashfreeClientForAttempt(admin: SupabaseClient, row: Pick<CashfreeAttemptRow, "organization_id" | "integration_id" | "key_fingerprint">, deps: Deps = {}) {
  const { row: integration } = await loadCashfreeIntegration(admin, row.organization_id);
  if (!integration || integration.id !== row.integration_id) return null;
  const creds = cashfreeCredentialsOf(integration);
  if (!creds || creds.fingerprint !== row.key_fingerprint) return null;
  return { client: (deps.client ?? merchantCashfreeClient)(creds), creds, integration };
}

function buyerState(row: CashfreeAttemptRow): BuyerCashfreeState {
  return {
    orderId: row.order_id,
    status: row.payment_status,
    amountPaise: Number(row.amount_paise),
    method: row.payment_method,
    failureReason: row.payment_status === "FAILED" || row.payment_status === "CANCELLED" ? row.failure_reason : null,
  };
}

function sessionFor(row: CashfreeAttemptRow, paymentSessionId: string, token: string): CashfreeCheckoutSession {
  return {
    provider: "CASHFREE",
    paymentSessionId,
    environment: row.payment_mode === "LIVE" ? "production" : "sandbox",
    cashfreeOrderId: row.cashfree_order_id,
    amountPaise: Number(row.amount_paise),
    currency: "INR",
    mode: row.payment_mode,
    orderId: row.order_id,
    token,
  };
}

/** The Cashfree order must be exactly the one PostBus asked for. */
function assertOrderMatches(order: CashfreeOrder, expected: { cashfreeOrderId: string; amountPaise: number; orderId: string }) {
  const tagOrder = order.order_tags?.postbus_order_id;
  if (
    order.order_id !== expected.cashfreeOrderId ||
    cashfreeAmountToPaise(order.order_amount) !== expected.amountPaise ||
    String(order.order_currency ?? "").toUpperCase() !== "INR" ||
    (tagOrder !== undefined && tagOrder !== expected.orderId)
  ) {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Cashfree returned an unexpected order. Please try again.");
  }
}

async function customerFor(admin: SupabaseClient, organizationId: string, orderId: string) {
  const { data: order } = await admin.from("orders").select("customer_id").eq("id", orderId).eq("organization_id", organizationId).maybeSingle();
  const customerId = (order as { customer_id?: string | null } | null)?.customer_id;
  if (!customerId) return null;
  const { data: customer } = await admin
    .from("customers")
    .select("name, phone, email")
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (customer as { name?: string | null; phone?: string | null; email?: string | null } | null) ?? null;
}

/**
 * Creates the Cashfree order on the merchant's account for a PostBus order the server already
 * priced. One attempt per PostBus order; Cashfree allows the customer to retry payment on the same
 * Cashfree order until it is paid. A retried create (timeout) is made safe by a stable
 * idempotency key and by adopting an already-created identical order.
 */
export async function createCashfreePayment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    orderId: string;
    orderNumber: string | null;
    kind: PaymentKind;
    amountDue: number;
    orderTotal: number;
    token: string;
    customer?: { name?: string | null; phone?: string | null; email?: string | null } | null;
    returnUrl?: string | null;
  },
  deps: Deps = {}
): Promise<CashfreeCheckoutSession> {
  const gateway = await activeCashfreeGateway(admin, input.organizationId, deps);
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

  const customer = input.customer?.phone ? input.customer : await customerFor(admin, input.organizationId, input.orderId);
  const phone = cashfreePhone(customer?.phone);
  if (!phone) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "A valid 10-digit mobile number is needed to pay online.");

  const cashfreeOrderId = cashfreeOrderIdFor(input.orderId);
  const request = {
    orderId: cashfreeOrderId,
    amountPaise,
    customer: {
      id: `pb${hashSecret(`postbus.cashfree.customer.v1\0${input.organizationId}\0${phone}`).slice(0, 30)}`,
      phone,
      name: customer?.name?.trim() || null,
      email: customer?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ? customer.email : null,
    },
    notifyUrl: cashfreeWebhookUrl(gateway.integration.webhook_token),
    returnUrl: safeCashfreeReturnUrl(input.returnUrl),
    note: `PostBus order ${input.orderNumber ?? input.orderId.slice(0, 8)}`,
    tags: { postbus_order_id: input.orderId, purpose: "postbus_storefront_order" },
    idempotencyKey: cashfreeIdempotencyKey(input.organizationId, input.orderId),
  };
  let cashfreeOrder: CashfreeOrder;
  try {
    cashfreeOrder = await gateway.client.createOrder(request);
  } catch (error) {
    // The first create succeeded at Cashfree but its response was lost: adopt that same order.
    if (!(error instanceof CashfreeConflictError)) throw error;
    cashfreeOrder = await gateway.client.getOrder(cashfreeOrderId);
  }
  assertOrderMatches(cashfreeOrder, { cashfreeOrderId, amountPaise, orderId: input.orderId });
  if (!cashfreeOrder.payment_session_id) {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Cashfree did not return a payment session. Please try again.");
  }

  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .insert({
      organization_id: input.organizationId,
      integration_id: gateway.integration.id,
      order_id: input.orderId,
      provider: "CASHFREE",
      payment_mode: gateway.credentials.mode,
      key_fingerprint: gateway.credentials.fingerprint,
      payment_kind: input.kind,
      cashfree_order_id: cashfreeOrderId,
      cashfree_cf_order_id: cashfreeOrder.cf_order_id != null ? String(cashfreeOrder.cf_order_id).slice(0, 64) : null,
      amount_paise: amountPaise,
      order_total_paise: totalPaise,
      currency: "INR",
      checkout_token_hash: paymentTokenHash(input.token),
    })
    .select(COLUMNS)
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
    after: { provider: "CASHFREE", amountPaise, kind: input.kind, mode: gateway.credentials.mode },
  });
  return sessionFor(data as CashfreeAttemptRow, cashfreeOrder.payment_session_id, input.token);
}

/**
 * Re-opens checkout for an unpaid attempt (after a cancel, failure or lost session). The session
 * comes fresh from Cashfree's Get Order; a PAID order is reconciled instead of reopened.
 */
export async function resumeCashfreePayment(
  admin: SupabaseClient,
  input: { organizationId: string; orderId: string; token: string },
  deps: Deps = {}
): Promise<{ state: BuyerCashfreeState; session: CashfreeCheckoutSession | null }> {
  let row = await attemptForBuyer(admin, input);
  if (row.payment_status === "PAID" || row.payment_status === "REFUNDED" || row.payment_status === "PROCESSING") {
    return { state: buyerState(row), session: null };
  }
  const { row: integration } = await loadCashfreeIntegration(admin, row.organization_id);
  const resolved = cashfreeUsable(integration) ? await cashfreeClientForAttempt(admin, row, deps) : null;
  if (!resolved) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, CASHFREE_UNAVAILABLE);
  const order = await resolved.client.getOrder(row.cashfree_order_id);
  assertOrderMatches(order, { cashfreeOrderId: row.cashfree_order_id, amountPaise: Number(row.amount_paise), orderId: row.order_id });
  const status = String(order.order_status ?? "").toUpperCase();
  if (status === "PAID") {
    row = (await reconcileCashfreeAttempt(admin, row, { resolved })) ?? row;
    return { state: buyerState(row), session: null };
  }
  if (status !== "ACTIVE" || !order.payment_session_id) {
    throw new AppError(ERROR_CODES.CONFLICT, "This payment link has expired. Please contact the store to complete your order.");
  }
  return { state: buyerState(row), session: sessionFor(row, order.payment_session_id, input.token) };
}

/**
 * Status for the customer (after the checkout closes, on return from a redirect, or polling).
 * `force` re-checks with Cashfree even if it was checked a moment ago (used right after checkout).
 */
export async function cashfreePaymentState(
  admin: SupabaseClient,
  input: { organizationId: string; orderId: string; token: string; force?: boolean },
  deps: Deps = {}
): Promise<BuyerCashfreeState> {
  let row = await attemptForBuyer(admin, input);
  const recentlyChecked = row.last_reconciled_at && Date.now() - Date.parse(row.last_reconciled_at) < (input.force ? 2_000 : 10_000);
  if (row.payment_status !== "PAID" && row.payment_status !== "REFUNDED" && !recentlyChecked) {
    row = (await reconcileCashfreeAttempt(admin, row, deps).catch(() => null)) ?? row;
  }
  return buyerState(row);
}

export async function applyCashfreePayment(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    cashfreeOrderId: string;
    payment: CashfreePayment;
    status: "PAID" | "PROCESSING" | "FAILED" | "CANCELLED";
    source: "CHECKOUT" | "WEBHOOK" | "RECONCILE";
  }
): Promise<ApplyResult> {
  const failure = input.payment.error_details?.error_description || input.payment.payment_message || null;
  const { data, error } = await admin.rpc("apply_merchant_cashfree_payment", {
    p_organization_id: input.organizationId,
    p_cashfree_order_id: input.cashfreeOrderId,
    p_cf_payment_id: String(input.payment.cf_payment_id),
    p_status: input.status,
    p_amount_paise: cashfreeAmountToPaise(input.payment.payment_amount),
    p_currency: String(input.payment.payment_currency ?? "").toUpperCase(),
    p_method: input.payment.payment_group ? String(input.payment.payment_group).slice(0, 40) : null,
    p_failure_reason: failure ? String(failure).slice(0, 300) : null,
    p_source: input.source,
  });
  if (error) {
    logError("merchant_cashfree.apply_failed", { organizationId: input.organizationId, source: input.source, code: error.code });
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not record the payment. It will be retried.");
  }
  const result = (data ?? { result: "unknown" }) as ApplyResult;
  if (result.result === "amount_mismatch") {
    logError("merchant_cashfree.amount_mismatch", { organizationId: input.organizationId, source: input.source });
  }
  if (result.result === "paid" && result.settled && result.order_id) {
    await notifyStorefrontPaymentSettled(admin, input.organizationId, result.order_id);
  }
  return result;
}

/**
 * Pulls the truth from Cashfree for one attempt and applies it: the earliest SUCCESS wins (later
 * ones are flagged as duplicates), else a PENDING payment means processing, else the latest
 * failed / dropped attempt. Recovers payments whose browser callback and webhook were both lost.
 */
export async function reconcileCashfreeAttempt(
  admin: SupabaseClient,
  row: CashfreeAttemptRow,
  deps: Deps & { resolved?: { client: MerchantCashfreeClient } | null; source?: "CHECKOUT" | "WEBHOOK" | "RECONCILE" } = {}
): Promise<CashfreeAttemptRow | null> {
  const resolved = deps.resolved !== undefined ? deps.resolved : await cashfreeClientForAttempt(admin, row, deps);
  const source = deps.source ?? "RECONCILE";
  await admin
    .from("merchant_storefront_payments")
    .update({ last_reconciled_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id);
  if (!resolved) return loadAttempt(admin, row.organization_id, row.order_id);

  const payments = (await resolved.client.getOrderPayments(row.cashfree_order_id)).filter(
    (payment) => !payment.order_id || payment.order_id === row.cashfree_order_id
  );
  const successes = payments.filter((payment) => attemptStatusOf(payment) === "PAID").sort((a, b) => paymentTime(a) - paymentTime(b));
  if (successes.length) {
    // Cashfree's order record must agree before anything is marked paid.
    const order = await resolved.client.getOrder(row.cashfree_order_id).catch((error) => {
      if (error instanceof CashfreeNotFoundError) return null;
      throw error;
    });
    if (!order) return loadAttempt(admin, row.organization_id, row.order_id);
    assertOrderMatches(order, { cashfreeOrderId: row.cashfree_order_id, amountPaise: Number(row.amount_paise), orderId: row.order_id });
    for (const payment of successes) {
      await applyCashfreePayment(admin, { organizationId: row.organization_id, cashfreeOrderId: row.cashfree_order_id, payment, status: "PAID", source });
    }
    return loadAttempt(admin, row.organization_id, row.order_id);
  }
  const pending = payments.filter((payment) => attemptStatusOf(payment) === "PROCESSING").sort((a, b) => paymentTime(b) - paymentTime(a))[0];
  if (pending) {
    await applyCashfreePayment(admin, { organizationId: row.organization_id, cashfreeOrderId: row.cashfree_order_id, payment: pending, status: "PROCESSING", source });
    return loadAttempt(admin, row.organization_id, row.order_id);
  }
  // A PROCESSING attempt whose payment has since failed: the latest ended attempt decides.
  const ended = payments
    .map((payment) => ({ payment, status: attemptStatusOf(payment) }))
    .filter((entry): entry is { payment: CashfreePayment; status: "FAILED" | "CANCELLED" } => entry.status === "FAILED" || entry.status === "CANCELLED")
    .sort((a, b) => paymentTime(b.payment) - paymentTime(a.payment));
  const latest =
    (row.payment_status === "PROCESSING" ? ended.find((entry) => String(entry.payment.cf_payment_id) === row.cashfree_payment_id) : null) ?? ended[0];
  if (latest) {
    await applyCashfreePayment(admin, { organizationId: row.organization_id, cashfreeOrderId: row.cashfree_order_id, payment: latest.payment, status: latest.status, source });
  }
  return loadAttempt(admin, row.organization_id, row.order_id);
}

const OPEN_STATUSES = ["CREATED", "FAILED", "CANCELLED", "PROCESSING"];

/** Reconciles open attempts made with this integration's current credentials (before replace/disconnect). */
export async function reconcileOpenCashfreeAttempts(admin: SupabaseClient, integration: MerchantPaymentIntegrationRow, deps: Deps = {}) {
  const creds = cashfreeCredentialsOf(integration);
  if (!creds) return { checked: 0 };
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select(COLUMNS)
    .eq("organization_id", integration.organization_id)
    .eq("integration_id", integration.id)
    .eq("provider", "CASHFREE")
    .eq("key_fingerprint", creds.fingerprint)
    .in("payment_status", OPEN_STATUSES)
    .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
    .limit(200);
  const client = (deps.client ?? merchantCashfreeClient)(creds);
  let checked = 0;
  for (const row of (data ?? []) as CashfreeAttemptRow[]) {
    await reconcileCashfreeAttempt(admin, row, { resolved: { client } }).catch(() => null);
    checked += 1;
  }
  return { checked };
}

/** Cron sweep for missed callbacks and webhooks (Cashfree attempts only). */
export async function sweepOpenCashfreePayments(admin: SupabaseClient, deps: Deps = {}) {
  const now = Date.now();
  const { data, error } = await admin
    .from("merchant_storefront_payments")
    .select(COLUMNS)
    .eq("provider", "CASHFREE")
    .in("payment_status", OPEN_STATUSES)
    .lte("created_at", new Date(now - 5 * 60_000).toISOString())
    .gte("created_at", new Date(now - 3 * 86_400_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205" || error.code === "42703") return { checked: 0, failed: 0 };
    throw new Error("Could not list open Cashfree payments.");
  }
  let checked = 0;
  let failed = 0;
  for (const row of (data ?? []) as CashfreeAttemptRow[]) {
    if (row.last_reconciled_at && now - Date.parse(row.last_reconciled_at) < 10 * 60_000) continue;
    try {
      await reconcileCashfreeAttempt(admin, row, deps);
      checked += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked, failed };
}

/** Dashboard view of a Cashfree-paid order. Organization comes from the tenant context. */
export function cashfreeAttemptView(row: CashfreeAttemptRow) {
  return {
    provider: "CASHFREE" as const,
    status: row.payment_status,
    mode: row.payment_mode,
    kind: row.payment_kind,
    amount: Number(row.amount_paise) / 100,
    orderTotal: Number(row.order_total_paise) / 100,
    currency: row.currency,
    providerOrderId: row.cashfree_order_id,
    providerPaymentId: row.cashfree_payment_id,
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

export async function cashfreeOrderPayment(admin: SupabaseClient, organizationId: string, orderId: string) {
  const row = await loadAttempt(admin, organizationId, orderId);
  return row ? cashfreeAttemptView(row) : null;
}

export async function reconcileCashfreeOrderPayment(admin: SupabaseClient, organizationId: string, orderId: string, deps: Deps = {}) {
  const row = await loadAttempt(admin, organizationId, orderId);
  if (!row) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This order has no online payment.");
  const resolved = await cashfreeClientForAttempt(admin, row, deps);
  if (!resolved) {
    throw new AppError(
      ERROR_CODES.INTEGRATION_NOT_CONNECTED,
      "The Cashfree account that took this payment is no longer connected. Check the payment in your Cashfree Dashboard."
    );
  }
  await reconcileCashfreeAttempt(admin, row, { resolved });
  return cashfreeOrderPayment(admin, organizationId, orderId);
}
