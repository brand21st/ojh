import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/logger";
import { hashSecret, safeEqual } from "@/lib/security/crypto";
import { loadIntegrationByWebhookToken, type MerchantPaymentIntegrationRow } from "../integration";
import { merchantCashfreeClient } from "./client";
import { CASHFREE_PROVIDER, cashfreeCredentialsOf } from "./integration";
import { loadCashfreeAttemptByCashfreeOrder, reconcileCashfreeAttempt } from "./payments";

/**
 * Merchant storefront Cashfree webhooks (Domain B), reached only through
 * /api/webhooks/merchant/cashfree/<integration token>. The token selects ONE merchant's Cashfree
 * integration and the signature must verify with THAT merchant's Client Secret.
 *
 * The body is used only to find which order to re-check. Payment status is then fetched from
 * Cashfree with the merchant's credentials, so out-of-order, delayed or replayed deliveries can
 * never move an order to a state Cashfree does not report.
 */

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

const LEASE_MS = 60_000;
export const CASHFREE_HANDLED_EVENTS = new Set(["PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK"]);

type Payload = {
  type?: string;
  data?: { order?: { order_id?: string }; payment?: { cf_payment_id?: string | number } };
};

type Deps = { client?: typeof merchantCashfreeClient; now?: () => number };

/** Cashfree: Base64(HMAC-SHA256(timestamp + rawBody, clientSecret)). Raw bytes, never re-serialised JSON. */
export function cashfreeWebhookSignature(timestamp: string, rawBody: string, clientSecret: string) {
  return createHmac("sha256", clientSecret).update(`${timestamp}${rawBody}`).digest("base64");
}

export function verifyCashfreeWebhookSignature(input: { timestamp: string; rawBody: string; signature: string; clientSecret: string }) {
  if (!input.signature || !input.timestamp || !/^\d{10,16}$/.test(input.timestamp)) return false;
  return safeEqual(cashfreeWebhookSignature(input.timestamp, input.rawBody, input.clientSecret), input.signature.trim());
}

function respond(status: number, body: Record<string, unknown>): WebhookOutcome {
  return { status, body };
}

async function claimEvent(
  admin: SupabaseClient,
  integration: MerchantPaymentIntegrationRow,
  input: { eventId: string; event: string; orderId: string | null; paymentId: string | null; payloadHash: string },
  now: number
) {
  const until = new Date(now + LEASE_MS).toISOString();
  const { data: inserted, error } = await admin
    .from("merchant_payment_webhook_events")
    .insert({
      organization_id: integration.organization_id,
      payment_integration_id: integration.id,
      provider: CASHFREE_PROVIDER,
      provider_event_id: input.eventId,
      event_type: input.event.slice(0, 80),
      provider_order_id: input.orderId,
      provider_payment_id: input.paymentId,
      payload_hash: input.payloadHash,
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
    .eq("provider_event_id", input.eventId)
    .maybeSingle();
  if (!existing) throw new Error("Could not load webhook event.");
  if (existing.processing_status === "PROCESSED" || existing.processing_status === "IGNORED") return { state: "duplicate" as const };
  const { data: claimed } = await admin
    .from("merchant_payment_webhook_events")
    .update({ processing_status: "PROCESSING", processing_until: until, attempts: Number(existing.attempts ?? 0) + 1, error: null })
    .eq("id", existing.id)
    .eq("organization_id", integration.organization_id)
    .or(`processing_status.in.(RECEIVED,FAILED),processing_until.lt.${new Date(now).toISOString()}`)
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

export async function handleMerchantCashfreeWebhook(
  admin: SupabaseClient,
  input: { token: string; rawBody: string; signature: string; timestamp: string; idempotencyKey: string | null },
  deps: Deps = {}
): Promise<WebhookOutcome> {
  const now = deps.now?.() ?? Date.now();
  const integration = await loadIntegrationByWebhookToken(admin, input.token, CASHFREE_PROVIDER);
  const creds = cashfreeCredentialsOf(integration);
  if (!integration || !creds || integration.connection_status === "NOT_CONNECTED") {
    return respond(404, { success: false, message: "Unknown webhook." });
  }
  if (!verifyCashfreeWebhookSignature({ timestamp: input.timestamp, rawBody: input.rawBody, signature: input.signature, clientSecret: creds.clientSecret })) {
    logError("merchant_cashfree.webhook_invalid_signature", { organizationId: integration.organization_id });
    return respond(400, { success: false, message: "Invalid webhook signature." });
  }

  // Signed by this merchant's Cashfree account: webhooks are reaching PostBus.
  await admin
    .from("merchant_payment_integrations")
    .update({ last_webhook_at: new Date(now).toISOString() })
    .eq("id", integration.id)
    .eq("organization_id", integration.organization_id);

  let payload: Payload;
  try {
    payload = JSON.parse(input.rawBody) as Payload;
  } catch {
    return respond(400, { success: false, message: "Invalid JSON." });
  }
  const event = String(payload.type ?? "unknown");
  if (!CASHFREE_HANDLED_EVENTS.has(event)) return respond(200, { success: true, ignored: true });

  const cashfreeOrderId = typeof payload.data?.order?.order_id === "string" ? payload.data.order.order_id.slice(0, 64) : null;
  const paymentId = payload.data?.payment?.cf_payment_id != null ? String(payload.data.payment.cf_payment_id).slice(0, 64) : null;
  const payloadHash = hashSecret(`${input.timestamp}${input.rawBody}`);
  // x-idempotency-key (webhook version 2025-01-01+) is unique per payload; older versions fall back
  // to a hash of the signed bytes.
  const eventId = input.idempotencyKey?.trim().slice(0, 120) || `sig:${payloadHash}`;

  let claim: Awaited<ReturnType<typeof claimEvent>>;
  try {
    claim = await claimEvent(admin, integration, { eventId, event, orderId: cashfreeOrderId, paymentId, payloadHash }, now);
  } catch {
    return respond(500, { success: false, message: "Could not store webhook." });
  }
  if (claim.state === "duplicate") return respond(200, { success: true, duplicate: true });
  if (claim.state === "busy") return respond(503, { success: false, message: "Webhook is being processed." });

  try {
    const result = await processEvent(admin, integration, creds, cashfreeOrderId, deps);
    await finishEvent(admin, integration.organization_id, claim.id, result.ignored ? "IGNORED" : "PROCESSED", result.result);
    return respond(200, { success: true, ignored: result.ignored, result: result.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "processing failed";
    logError("merchant_cashfree.webhook_failed", { organizationId: integration.organization_id, event });
    await finishEvent(admin, integration.organization_id, claim.id, "FAILED", message).catch(() => undefined);
    // Non-2xx makes Cashfree retry; the claim above keeps the retry safe.
    return respond(500, { success: false, message: "Webhook processing failed." });
  }
}

async function processEvent(
  admin: SupabaseClient,
  integration: MerchantPaymentIntegrationRow,
  creds: NonNullable<ReturnType<typeof cashfreeCredentialsOf>>,
  cashfreeOrderId: string | null,
  deps: Deps
): Promise<{ ignored: boolean; result: string }> {
  if (!cashfreeOrderId) return { ignored: true, result: "no_order" };
  // Payments on the merchant's Cashfree account that PostBus did not create are ignored.
  const attempt = await loadCashfreeAttemptByCashfreeOrder(admin, integration.organization_id, cashfreeOrderId);
  if (!attempt || attempt.integration_id !== integration.id || attempt.key_fingerprint !== creds.fingerprint) {
    return { ignored: true, result: "not_storefront_payment" };
  }
  const client = (deps.client ?? merchantCashfreeClient)(creds);
  const updated = await reconcileCashfreeAttempt(admin, attempt, { resolved: { client }, source: "WEBHOOK" });
  return { ignored: false, result: (updated?.payment_status ?? attempt.payment_status).toLowerCase() };
}
