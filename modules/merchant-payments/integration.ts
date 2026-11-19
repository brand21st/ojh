import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { env } from "@/lib/env";
import { logError } from "@/lib/logger";
import { randomToken } from "@/lib/security/crypto";
import {
  keyFingerprint,
  keyIdHint,
  openSecret,
  sealSecret,
  validateRazorpayKeys,
  validateWebhookSecret,
  type MerchantPaymentMode,
} from "./credentials";
import { MerchantRazorpayAuthError, merchantRazorpayClient, type MerchantRazorpayClient } from "./razorpay";

/**
 * Per-organization Razorpay connection for storefront payments (Domain B).
 * Every function takes the organization id from the caller's verified context and filters on it.
 * Rows are read with the service role because browsers have no access to this table at all.
 */

export const MERCHANT_PAYMENT_PROVIDER = "RAZORPAY" as const;
export const MERCHANT_WEBHOOK_EVENTS = ["payment.captured", "payment.failed", "order.paid", "payment.authorized", "refund.processed"] as const;

export type MerchantConnectionStatus = "NOT_CONNECTED" | "CONNECTED" | "VERIFICATION_FAILED" | "CONFIGURATION_REQUIRED";

export type MerchantPaymentIntegrationRow = {
  id: string;
  organization_id: string;
  provider: string;
  webhook_token: string;
  encrypted_key_id: string | null;
  encrypted_key_secret: string | null;
  encrypted_webhook_secret: string | null;
  key_fingerprint: string | null;
  key_id_hint: string | null;
  payment_mode: MerchantPaymentMode;
  connection_status: MerchantConnectionStatus;
  enabled: boolean;
  last_verified_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  updated_at: string | null;
  last_webhook_at?: string | null;
};

export type MerchantPaymentIntegrationView = {
  provider: typeof MERCHANT_PAYMENT_PROVIDER;
  status: MerchantConnectionStatus;
  enabled: boolean;
  mode: MerchantPaymentMode;
  keyIdHint: string | null;
  hasKeySecret: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
  webhookEvents: string[];
  lastVerifiedAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  available: boolean;
};

export function isMissingTable(error: { code?: string } | null | undefined) {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

export function merchantWebhookUrl(token: string) {
  return `${env.appUrl.replace(/\/$/, "")}/api/webhooks/merchant/razorpay/${token}`;
}

/** Masked, browser-safe view. Contains no secret material, encrypted or otherwise. */
export function mapIntegrationView(row: MerchantPaymentIntegrationRow | null): MerchantPaymentIntegrationView {
  return {
    provider: MERCHANT_PAYMENT_PROVIDER,
    status: row?.connection_status ?? "NOT_CONNECTED",
    enabled: Boolean(row?.enabled),
    mode: row?.payment_mode ?? "TEST",
    keyIdHint: row?.encrypted_key_id ? row.key_id_hint : null,
    hasKeySecret: Boolean(row?.encrypted_key_secret),
    hasWebhookSecret: Boolean(row?.encrypted_webhook_secret),
    webhookUrl: row ? merchantWebhookUrl(row.webhook_token) : null,
    webhookEvents: [...MERCHANT_WEBHOOK_EVENTS],
    lastVerifiedAt: row?.last_verified_at ?? null,
    lastError: row?.last_error ?? null,
    connectedAt: row?.connected_at ?? null,
    available: true,
  };
}

export type MerchantPaymentProvider = "RAZORPAY" | "CASHFREE";

export const INTEGRATION_COLUMNS =
  "id, organization_id, provider, webhook_token, encrypted_key_id, encrypted_key_secret, encrypted_webhook_secret, key_fingerprint, key_id_hint, payment_mode, connection_status, enabled, last_verified_at, last_error, connected_at, disconnected_at, updated_at, last_webhook_at";
const COLUMNS = INTEGRATION_COLUMNS;

export async function loadIntegration(
  admin: SupabaseClient,
  organizationId: string,
  provider: MerchantPaymentProvider = MERCHANT_PAYMENT_PROVIDER
) {
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { row: null, available: false as const };
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not load the payment integration.");
  }
  return { row: (data as MerchantPaymentIntegrationRow | null) ?? null, available: true as const };
}

/** A webhook URL token only ever resolves to an integration of the provider whose route it hit. */
export async function loadIntegrationByWebhookToken(
  admin: SupabaseClient,
  token: string,
  provider: MerchantPaymentProvider = MERCHANT_PAYMENT_PROVIDER
) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .select(COLUMNS)
    .eq("webhook_token", token)
    .eq("provider", provider)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error("integration lookup failed");
  }
  return (data as MerchantPaymentIntegrationRow | null) ?? null;
}

export async function getIntegrationView(admin: SupabaseClient, organizationId: string): Promise<MerchantPaymentIntegrationView> {
  const loaded = await loadIntegration(admin, organizationId);
  if (!loaded.available) return { ...mapIntegrationView(null), available: false };
  return mapIntegrationView(loaded.row);
}

export type IntegrationCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
  fingerprint: string;
  mode: MerchantPaymentMode;
};

/** Decrypts a row's keys. Returns null when any required key is missing or unreadable. */
export function credentialsOf(row: MerchantPaymentIntegrationRow | null): IntegrationCredentials | null {
  if (!row) return null;
  const keyId = openSecret(row.encrypted_key_id);
  const keySecret = openSecret(row.encrypted_key_secret);
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    webhookSecret: openSecret(row.encrypted_webhook_secret),
    fingerprint: keyFingerprint(keyId),
    mode: row.payment_mode,
  };
}

function statusFor(hasWebhookSecret: boolean): MerchantConnectionStatus {
  return hasWebhookSecret ? "CONNECTED" : "CONFIGURATION_REQUIRED";
}

async function audit(admin: SupabaseClient, organizationId: string, actorId: string | null, action: string, after: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    organization_id: organizationId,
    actor_id: actorId,
    action,
    entity_type: "merchant_payment_integration",
    entity_id: organizationId,
    after,
  });
}

type Actor = { organizationId: string; userId: string | null };

async function verifyWithRazorpay(client: MerchantRazorpayClient) {
  try {
    await client.verify();
  } catch (error) {
    if (error instanceof MerchantRazorpayAuthError) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Razorpay rejected these keys. Check the Key ID and Key Secret, then try again.");
    }
    throw error;
  }
}

export type SaveCredentialsInput = {
  mode: MerchantPaymentMode;
  keyId?: string | null;
  keySecret?: string | null;
  webhookSecret?: string | null;
};

/**
 * Connects or updates the merchant's Razorpay keys. Keys are verified against Razorpay before they
 * are stored; invalid keys are rejected and never saved. When the Razorpay account changes, open
 * payment attempts are reconciled with the OLD keys first so nothing paid is left unrecorded.
 */
export async function saveMerchantRazorpay(
  admin: SupabaseClient,
  actor: Actor,
  input: SaveCredentialsInput,
  deps: { client?: typeof merchantRazorpayClient; reconcileOpen?: (row: MerchantPaymentIntegrationRow) => Promise<unknown> } = {}
) {
  const makeClient = deps.client ?? merchantRazorpayClient;
  const loaded = await loadIntegration(admin, actor.organizationId);
  if (!loaded.available) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Online payments are not available yet. Please try again later.");
  }
  const existing = loaded.row;
  const current = credentialsOf(existing);

  const newKeyId = input.keyId?.trim() || null;
  const newKeySecret = input.keySecret?.trim() || null;
  if (newKeyId && !newKeySecret) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter the Key Secret for the new Key ID.");
  }
  if (!newKeyId && newKeySecret && !current) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter your Razorpay Key ID.");
  }
  const keyId = newKeyId ?? current?.keyId ?? null;
  const keySecret = newKeySecret ?? current?.keySecret ?? null;
  if (!keyId || !keySecret) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter your Razorpay Key ID and Key Secret.");
  }
  const keys = validateRazorpayKeys({ keyId, keySecret, mode: input.mode });
  const fingerprint = keyFingerprint(keys.keyId);
  const accountChanged = Boolean(existing && current && current.fingerprint !== fingerprint);
  // A different Razorpay account (or mode) has its own webhook, so the old secret cannot carry over.
  const webhookSecret = input.webhookSecret?.trim()
    ? validateWebhookSecret(input.webhookSecret)
    : accountChanged
      ? null
      : current?.webhookSecret ?? null;

  const keysChanged = !current || current.keyId !== keys.keyId || current.keySecret !== keys.keySecret;
  if (keysChanged) await verifyWithRazorpay(makeClient(keys));
  if (accountChanged && existing && deps.reconcileOpen) {
    await deps.reconcileOpen(existing).catch((error) => {
      logError("merchant_razorpay.reconcile_before_replace_failed", {
        organizationId: actor.organizationId,
        message: error instanceof Error ? error.message : "reconcile failed",
      });
    });
  }

  const status = statusFor(Boolean(webhookSecret));
  const now = new Date().toISOString();
  const patch = {
    encrypted_key_id: sealSecret(keys.keyId),
    encrypted_key_secret: sealSecret(keys.keySecret),
    encrypted_webhook_secret: webhookSecret ? sealSecret(webhookSecret) : null,
    key_fingerprint: fingerprint,
    key_id_hint: keyIdHint(keys.keyId),
    payment_mode: input.mode,
    connection_status: status,
    // Moving to another account or mode needs a fresh, deliberate "enable".
    enabled: status === "CONNECTED" && Boolean(existing?.enabled) && !accountChanged,
    last_verified_at: keysChanged ? now : existing?.last_verified_at ?? now,
    last_error: null,
    connected_at: existing?.connected_at && existing.connection_status !== "NOT_CONNECTED" ? existing.connected_at : now,
    disconnected_at: null,
    updated_by: actor.userId,
  };

  const query = existing
    ? admin.from("merchant_payment_integrations").update(patch).eq("id", existing.id).eq("organization_id", actor.organizationId)
    : admin.from("merchant_payment_integrations").insert({
        ...patch,
        organization_id: actor.organizationId,
        provider: MERCHANT_PAYMENT_PROVIDER,
        webhook_token: randomToken(24),
        created_by: actor.userId,
      });
  const { data, error } = await query.select(COLUMNS).single();
  if (error || !data) {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not save the Razorpay integration.");
  }
  await audit(admin, actor.organizationId, actor.userId, existing?.encrypted_key_id ? "merchant_razorpay.updated" : "merchant_razorpay.connected", {
    mode: input.mode,
    keyIdHint: keyIdHint(keys.keyId),
    keysChanged,
    accountChanged,
    webhookSecretChanged: Boolean(input.webhookSecret?.trim()),
    status,
  });
  return mapIntegrationView(data as MerchantPaymentIntegrationRow);
}

/** Re-checks the stored keys with Razorpay and records the outcome. */
export async function verifyMerchantRazorpay(admin: SupabaseClient, actor: Actor, deps: { client?: typeof merchantRazorpayClient } = {}) {
  const loaded = await loadIntegration(admin, actor.organizationId);
  const row = loaded.row;
  const creds = credentialsOf(row);
  if (!row || !creds) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Connect your Razorpay account first.");
  }
  const now = new Date().toISOString();
  let status: MerchantConnectionStatus = statusFor(Boolean(creds.webhookSecret));
  let lastError: string | null = null;
  try {
    await (deps.client ?? merchantRazorpayClient)(creds).verify();
  } catch (error) {
    if (!(error instanceof MerchantRazorpayAuthError)) throw error;
    status = "VERIFICATION_FAILED";
    lastError = "Razorpay rejected the saved keys. Replace them with valid keys.";
  }
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .update({
      connection_status: status,
      last_verified_at: now,
      last_error: lastError,
      enabled: status === "CONNECTED" ? row.enabled : false,
      updated_by: actor.userId,
    })
    .eq("id", row.id)
    .eq("organization_id", actor.organizationId)
    .select(COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not update the Razorpay integration.");
  await audit(admin, actor.organizationId, actor.userId, "merchant_razorpay.verified", { status });
  return { ...mapIntegrationView(data as MerchantPaymentIntegrationRow), verified: status !== "VERIFICATION_FAILED" };
}

export async function setMerchantRazorpayEnabled(admin: SupabaseClient, actor: Actor, enabled: boolean) {
  const { row } = await loadIntegration(admin, actor.organizationId);
  if (!row) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Connect your Razorpay account first.");
  if (enabled && (row.connection_status !== "CONNECTED" || !credentialsOf(row)?.webhookSecret)) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      row.connection_status === "CONFIGURATION_REQUIRED"
        ? "Add your Razorpay webhook secret before turning on online payments."
        : "Verify your Razorpay keys before turning on online payments."
    );
  }
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .update({ enabled, updated_by: actor.userId })
    .eq("id", row.id)
    .eq("organization_id", actor.organizationId)
    .select(COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not update online payments.");
  await audit(admin, actor.organizationId, actor.userId, enabled ? "merchant_razorpay.enabled" : "merchant_razorpay.disabled", {});
  return mapIntegrationView(data as MerchantPaymentIntegrationRow);
}

/**
 * Disconnects the merchant's account. Open attempts are reconciled first while the keys still
 * exist; then the keys are wiped and the webhook URL is rotated. Payment history is kept.
 */
export async function disconnectMerchantRazorpay(
  admin: SupabaseClient,
  actor: Actor,
  deps: { reconcileOpen?: (row: MerchantPaymentIntegrationRow) => Promise<unknown> } = {}
) {
  const { row } = await loadIntegration(admin, actor.organizationId);
  if (!row) return mapIntegrationView(null);
  if (deps.reconcileOpen && credentialsOf(row)) {
    await deps.reconcileOpen(row).catch((error) => {
      logError("merchant_razorpay.reconcile_before_disconnect_failed", {
        organizationId: actor.organizationId,
        message: error instanceof Error ? error.message : "reconcile failed",
      });
    });
  }
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .update({
      encrypted_key_id: null,
      encrypted_key_secret: null,
      encrypted_webhook_secret: null,
      key_id_hint: null,
      connection_status: "NOT_CONNECTED",
      enabled: false,
      last_error: null,
      webhook_token: randomToken(24),
      disconnected_at: new Date().toISOString(),
      updated_by: actor.userId,
    })
    .eq("id", row.id)
    .eq("organization_id", actor.organizationId)
    .select(COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not disconnect Razorpay.");
  await audit(admin, actor.organizationId, actor.userId, "merchant_razorpay.disconnected", {});
  return mapIntegrationView(data as MerchantPaymentIntegrationRow);
}

export type ActiveMerchantGateway = {
  integration: MerchantPaymentIntegrationRow;
  credentials: IntegrationCredentials;
  client: MerchantRazorpayClient;
};

export const ONLINE_PAYMENT_UNAVAILABLE = "Online payment is not available for this store right now. Please choose another payment option.";

/**
 * Resolves the store's own Razorpay account for checkout. There is no fallback: when the merchant
 * has no usable, enabled configuration this throws, and PostBus platform keys are never used.
 */
export async function activeMerchantGateway(
  admin: SupabaseClient,
  organizationId: string,
  deps: { client?: typeof merchantRazorpayClient } = {}
): Promise<ActiveMerchantGateway> {
  const { row } = await loadIntegration(admin, organizationId);
  const credentials = credentialsOf(row);
  if (!row || !row.enabled || row.connection_status !== "CONNECTED" || !credentials?.webhookSecret || row.organization_id !== organizationId) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, ONLINE_PAYMENT_UNAVAILABLE);
  }
  return { integration: row, credentials, client: (deps.client ?? merchantRazorpayClient)(credentials) };
}

/** Public storefront flag only. Says nothing about the merchant's keys. */
export async function storefrontOnlinePaymentEnabled(admin: SupabaseClient, organizationId: string) {
  try {
    const { row } = await loadIntegration(admin, organizationId);
    return Boolean(row?.enabled && row.connection_status === "CONNECTED" && row.encrypted_webhook_secret);
  } catch {
    return false;
  }
}
