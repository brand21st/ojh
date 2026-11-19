import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/logger";
import { hashSecret } from "@/lib/security/crypto";
import { verifyWebhookSignature } from "@/modules/razorpay/signature";
import { credentialsOf, loadIntegrationByWebhookToken, type MerchantPaymentIntegrationRow } from "./integration";
import { applyPayment, type StorefrontPaymentRow } from "./payments";
import { merchantRazorpayClient, type MerchantRazorpayPayment } from "./razorpay";

/**
 * Merchant storefront webhooks (Domain B). Reached only through
 * /api/webhooks/merchant/razorpay/<integration token>. The token picks ONE merchant integration;
 * the body must be signed with THAT merchant's webhook secret; every update is scoped to that
 * merchant's organization. This path never calls SaaS billing code, and the SaaS billing webhook
 * (/api/webhooks/razorpay) never reaches this module.
 */

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

const LEASE_MS = 60_000;
const HANDLED_EVENTS = new Set(["payment.captured", "order.paid", "payment.authorized", "payment.failed", "refund.processed"]);

type Payload = {
  event?: string;
  payload?: {
    payment?: { entity?: MerchantRazorpayPayment };
    order?: { entity?: { id?: string } };
    refund?: { entity?: { payment_id?: string } };
  };
};

type Deps = { client?: typeof merchantRazorpayClient; now?: () => number };

function respond(status: number, body: Record<string, unknown>): WebhookOutcome {
  return { status, body };
}

async function claimEvent(admin: SupabaseClient, integration: MerchantPaymentIntegrationRow, eventId: string, event: string, ids: { orderId: string | null; paymentId: string | null }, now: number) {
  const until = new Date(now + LEASE_MS).toISOString();
  const { data: inserted, error } = await admin
    .from("merchant_payment_webhook_events")
    .insert({
      organization_id: integration.organization_id,
      payment_integration_id: integration.id,
      provider_event_id: eventId,
      event_type: event.slice(0, 80),
      razorpay_order_id: ids.orderId,
      razorpay_payment_id: ids.paymentId,
      processing_status: "PROCESSING",
      processing_until: until,
      attempts: 1,
    })
    .select("id")
    .maybeSingle();
  if (inserted?.id) return { state: "claimed" as const, id: inserted.id as string };
  if (error?.code !== "23505") throw new Error("Could not store webhook event.");

  const { data: existing } = await admin
    .from("merchant_payment_webhook_events")
    .select("id, processing_status, processing_until, attempts")
    .eq("payment_integration_id", integration.id)
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (!existing) throw new Error("Could not load webhook event.");
  if (existing.processing_status === "PROCESSED" || existing.processing_status === "IGNORED") {
    return { state: "duplicate" as const };
  }
  const nowIso = new Date(now).toISOString();
  // Retry a failed or stale event; a live lease means another delivery is working on it.
  const { data: claimed } = await admin
    .from("merchant_payment_webhook_events")
    .update({ processing_status: "PROCESSING", processing_until: until, attempts: Number(existing.attempts ?? 0) + 1, error: null })
    .eq("id", existing.id)
    .eq("organization_id", integration.organization_id)
    .or(`processing_status.in.(RECEIVED,FAILED),processing_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();
  if (!claimed?.id) return { state: "busy" as const };
  return { state: "claimed" as const, id: claimed.id as string };
}

async function finishEvent(admin: SupabaseClient, organizationId: string, id: string, status: "PROCESSED" | "IGNORED" | "FAILED", result: string) {
  await admin
    .from("merchant_payment_webhook_events")
    .update({
      processing_status: status,
      processing_until: null,
      result: result.slice(0, 80),
      error: status === "FAILED" ? result.slice(0, 200) : null,
      processed_at: status === "FAILED" ? null : new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", organizationId);
}

async function attemptFor(admin: SupabaseClient, integration: MerchantPaymentIntegrationRow, razorpayOrderId: string) {
  const { data } = await admin
    .from("merchant_storefront_payments")
    .select("id, organization_id, integration_id, order_id, key_fingerprint, razorpay_order_id, payment_status")
    .eq("organization_id", integration.organization_id)
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();
  return (data as Pick<StorefrontPaymentRow, "id" | "organization_id" | "integration_id" | "order_id" | "key_fingerprint" | "razorpay_order_id" | "payment_status"> | null) ?? null;
}

export async function handleMerchantRazorpayWebhook(
  admin: SupabaseClient,
  input: { token: string; rawBody: string; signature: string; eventId: string | null },
  deps: Deps = {}
): Promise<WebhookOutcome> {
  const now = deps.now?.() ?? Date.now();
  const integration = await loadIntegrationByWebhookToken(admin, input.token);
  const creds = credentialsOf(integration);
  if (!integration || !creds?.webhookSecret || integration.connection_status === "NOT_CONNECTED") {
    return respond(404, { success: false, message: "Unknown webhook." });
  }
  if (!input.signature || !verifyWebhookSignature(input.rawBody, input.signature, creds.webhookSecret)) {
    logError("merchant_razorpay.webhook_invalid_signature", { organizationId: integration.organization_id });
    return respond(400, { success: false, message: "Invalid webhook signature." });
  }

  let payload: Payload;
  try {
    payload = JSON.parse(input.rawBody) as Payload;
  } catch {
    return respond(400, { success: false, message: "Invalid JSON." });
  }
  const event = String(payload.event ?? "unknown");
  if (!HANDLED_EVENTS.has(event)) return respond(200, { success: true, ignored: true });

  const payment = payload.payload?.payment?.entity ?? null;
  const razorpayOrderId = payment?.order_id ?? payload.payload?.order?.entity?.id ?? null;
  const paymentId = payment?.id ?? payload.payload?.refund?.entity?.payment_id ?? null;
  const eventId = input.eventId?.trim().slice(0, 120) || `body:${hashSecret(input.rawBody)}`;

  let claim: Awaited<ReturnType<typeof claimEvent>>;
  try {
    claim = await claimEvent(admin, integration, eventId, event, { orderId: razorpayOrderId, paymentId }, now);
  } catch {
    return respond(500, { success: false, message: "Could not store webhook." });
  }
  if (claim.state === "duplicate") return respond(200, { success: true, duplicate: true });
  if (claim.state === "busy") return respond(503, { success: false, message: "Webhook is being processed." });

  try {
    const result = await processEvent(admin, integration, creds, event, payment, razorpayOrderId, paymentId, deps);
    await finishEvent(admin, integration.organization_id, claim.id, result.ignored ? "IGNORED" : "PROCESSED", result.result);
    return respond(200, { success: true, ignored: result.ignored, result: result.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "processing failed";
    logError("merchant_razorpay.webhook_failed", { organizationId: integration.organization_id, event });
    await finishEvent(admin, integration.organization_id, claim.id, "FAILED", message).catch(() => undefined);
    // Non-2xx makes Razorpay retry; the claim above makes the retry safe.
    return respond(500, { success: false, message: "Webhook processing failed." });
  }
}

async function processEvent(
  admin: SupabaseClient,
  integration: MerchantPaymentIntegrationRow,
  creds: NonNullable<ReturnType<typeof credentialsOf>>,
  event: string,
  payment: MerchantRazorpayPayment | null,
  razorpayOrderId: string | null,
  paymentId: string | null,
  deps: Deps
): Promise<{ ignored: boolean; result: string }> {
  const client = () => (deps.client ?? merchantRazorpayClient)(creds);

  if (event === "refund.processed") {
    if (!paymentId) return { ignored: true, result: "no_payment" };
    const fetched = await client().fetchPayment(paymentId);
    if (!fetched.order_id) return { ignored: true, result: "no_order" };
    const attempt = await attemptFor(admin, integration, fetched.order_id);
    if (!attempt || attempt.integration_id !== integration.id || attempt.key_fingerprint !== creds.fingerprint) {
      return { ignored: true, result: "not_storefront_payment" };
    }
    if (String(fetched.status).toLowerCase() !== "refunded") return { ignored: true, result: "partial_refund" };
    const applied = await applyPayment(admin, {
      organizationId: integration.organization_id,
      razorpayOrderId: fetched.order_id,
      payment: fetched,
      status: "REFUNDED",
      source: "WEBHOOK",
    });
    return { ignored: applied.result === "ignored" || applied.result === "not_found", result: applied.result };
  }

  if (!payment?.id || !razorpayOrderId) return { ignored: true, result: "no_payment" };
  // Payments on the merchant's account that PostBus did not create (their other channels) are ignored.
  const attempt = await attemptFor(admin, integration, razorpayOrderId);
  if (!attempt || attempt.integration_id !== integration.id || attempt.key_fingerprint !== creds.fingerprint) {
    return { ignored: true, result: "not_storefront_payment" };
  }

  const status =
    event === "payment.failed"
      ? "FAILED"
      : event === "payment.authorized"
        ? "AUTHORIZED"
        : String(payment.status).toLowerCase() === "captured"
          ? "PAID"
          : null;
  if (!status) return { ignored: true, result: "not_captured" };
  const applied = await applyPayment(admin, {
    organizationId: integration.organization_id,
    razorpayOrderId,
    payment,
    status,
    source: "WEBHOOK",
  });
  return { ignored: applied.result === "ignored" || applied.result === "not_found", result: applied.result };
}
