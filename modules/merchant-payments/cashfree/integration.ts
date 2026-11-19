import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { env } from "@/lib/env";
import { logError } from "@/lib/logger";
import { randomToken } from "@/lib/security/crypto";
import { openSecret, sealSecret, type MerchantPaymentMode } from "../credentials";
import {
  INTEGRATION_COLUMNS,
  loadIntegration,
  type MerchantConnectionStatus,
  type MerchantPaymentIntegrationRow,
} from "../integration";
import {
  CashfreeAuthError,
  CashfreeForbiddenError,
  CashfreeUnavailableError,
  merchantCashfreeClient,
  type MerchantCashfreeClient,
  type MerchantCashfreeCredentials,
} from "./client";
import { cashfreeClientIdHint, cashfreeEnvironmentLabel, cashfreeFingerprint, validateCashfreeCredentials } from "./credentials";

/**
 * Per-organization Cashfree Payment Gateway connection for storefront payments (Domain B).
 * The organization always comes from the caller's verified tenant context. Rows are read with the
 * service role; browsers have no access to merchant_payment_integrations at all.
 */

export const CASHFREE_PROVIDER = "CASHFREE" as const;
export const CASHFREE_WEBHOOK_EVENTS = ["PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK"] as const;

type Actor = { organizationId: string; userId: string | null };
type Deps = { client?: typeof merchantCashfreeClient };

export type CashfreeIntegrationView = {
  provider: typeof CASHFREE_PROVIDER;
  status: MerchantConnectionStatus;
  enabled: boolean;
  mode: MerchantPaymentMode;
  environment: "Sandbox" | "Production";
  clientIdHint: string | null;
  hasClientSecret: boolean;
  webhookUrl: string | null;
  webhookEvents: string[];
  lastVerifiedAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  available: boolean;
};

export function cashfreeWebhookUrl(token: string) {
  return `${env.appUrl.replace(/\/$/, "")}/api/webhooks/merchant/cashfree/${token}`;
}

/** Masked, browser-safe view. Contains no secret material, encrypted or otherwise. */
export function mapCashfreeView(row: MerchantPaymentIntegrationRow | null): CashfreeIntegrationView {
  const mode = row?.payment_mode ?? "TEST";
  return {
    provider: CASHFREE_PROVIDER,
    status: row?.connection_status ?? "NOT_CONNECTED",
    enabled: Boolean(row?.enabled),
    mode,
    environment: cashfreeEnvironmentLabel(mode),
    clientIdHint: row?.encrypted_key_id ? row.key_id_hint : null,
    hasClientSecret: Boolean(row?.encrypted_key_secret),
    webhookUrl: row && row.connection_status !== "NOT_CONNECTED" ? cashfreeWebhookUrl(row.webhook_token) : null,
    webhookEvents: [...CASHFREE_WEBHOOK_EVENTS],
    lastVerifiedAt: row?.last_verified_at ?? null,
    lastWebhookAt: row?.last_webhook_at ?? null,
    lastError: row?.last_error ?? null,
    connectedAt: row?.connected_at ?? null,
    available: true,
  };
}

export async function loadCashfreeIntegration(admin: SupabaseClient, organizationId: string) {
  return loadIntegration(admin, organizationId, CASHFREE_PROVIDER);
}

export async function getCashfreeView(admin: SupabaseClient, organizationId: string): Promise<CashfreeIntegrationView> {
  const loaded = await loadCashfreeIntegration(admin, organizationId);
  if (!loaded.available) return { ...mapCashfreeView(null), available: false };
  return mapCashfreeView(loaded.row);
}

export type CashfreeCredentials = MerchantCashfreeCredentials & { fingerprint: string };

/** Decrypts a row's credentials. Null when any part is missing or unreadable. */
export function cashfreeCredentialsOf(row: MerchantPaymentIntegrationRow | null): CashfreeCredentials | null {
  if (!row || row.provider !== CASHFREE_PROVIDER) return null;
  const clientId = openSecret(row.encrypted_key_id);
  const clientSecret = openSecret(row.encrypted_key_secret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, mode: row.payment_mode, fingerprint: cashfreeFingerprint(clientId, row.payment_mode) };
}

async function audit(admin: SupabaseClient, actor: Actor, action: string, after: Record<string, unknown>) {
  await admin.from("audit_logs").insert({
    organization_id: actor.organizationId,
    actor_id: actor.userId,
    action,
    entity_type: "merchant_payment_integration",
    entity_id: actor.organizationId,
    after,
  });
}

/**
 * Proves the credentials with Cashfree and turns every failure into a message a merchant can act
 * on. On 401 the other environment is probed (read-only) so a Sandbox/Production mix-up gets its
 * own message instead of "invalid credentials".
 */
export async function checkCashfreeCredentials(creds: MerchantCashfreeCredentials, makeClient: typeof merchantCashfreeClient) {
  try {
    await makeClient(creds).verify();
    return;
  } catch (error) {
    if (error instanceof CashfreeAuthError) {
      const other: MerchantPaymentMode = creds.mode === "LIVE" ? "TEST" : "LIVE";
      const otherWorks = await makeClient({ ...creds, mode: other })
        .verify()
        .then(() => true)
        .catch(() => false);
      if (otherWorks) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `These are ${cashfreeEnvironmentLabel(other)} credentials, but ${cashfreeEnvironmentLabel(creds.mode)} is selected. Switch the environment or use your ${cashfreeEnvironmentLabel(creds.mode)} keys.`
        );
      }
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Cashfree rejected these credentials. Check the Client ID and Client Secret, then try again.");
    }
    if (error instanceof CashfreeForbiddenError) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `${error.message} Complete your Cashfree account activation, or contact Cashfree support to enable Payment Gateway API access.`
      );
    }
    if (error instanceof CashfreeUnavailableError) throw error;
    throw error;
  }
}

export type SaveCashfreeInput = {
  mode: MerchantPaymentMode;
  clientId?: string | null;
  clientSecret?: string | null;
};

/**
 * Connects or replaces the merchant's Cashfree credentials (also used to switch environment).
 * Credentials are verified with Cashfree before anything is stored. When the account or
 * environment changes, open attempts are reconciled with the OLD credentials first, and online
 * checkout has to be switched on again deliberately.
 */
export async function saveMerchantCashfree(
  admin: SupabaseClient,
  actor: Actor,
  input: SaveCashfreeInput,
  deps: Deps & { reconcileOpen?: (row: MerchantPaymentIntegrationRow) => Promise<unknown> } = {}
) {
  const makeClient = deps.client ?? merchantCashfreeClient;
  const loaded = await loadCashfreeIntegration(admin, actor.organizationId);
  if (!loaded.available) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Online payments are not available yet. Please try again later.");
  }
  const existing = loaded.row;
  const current = cashfreeCredentialsOf(existing);

  const newClientId = input.clientId?.trim() || null;
  const newClientSecret = input.clientSecret?.trim() || null;
  if (newClientId && !newClientSecret && newClientId !== current?.clientId) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter the Client Secret for the new Client ID.");
  }
  const clientId = newClientId ?? current?.clientId ?? null;
  const clientSecret = newClientSecret ?? current?.clientSecret ?? null;
  if (!clientId || !clientSecret) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter your Cashfree Client ID and Client Secret.");
  }
  const keys = validateCashfreeCredentials({ clientId, clientSecret, mode: input.mode });
  const fingerprint = cashfreeFingerprint(keys.clientId, input.mode);
  const accountChanged = Boolean(existing && current && current.fingerprint !== fingerprint);
  const credentialsChanged =
    !current || current.clientId !== keys.clientId || current.clientSecret !== keys.clientSecret || current.mode !== input.mode;

  if (credentialsChanged) await checkCashfreeCredentials({ ...keys, mode: input.mode }, makeClient);
  if ((accountChanged || (current && current.clientSecret !== keys.clientSecret)) && existing && deps.reconcileOpen) {
    await deps.reconcileOpen(existing).catch((error) => {
      logError("merchant_cashfree.reconcile_before_replace_failed", {
        organizationId: actor.organizationId,
        message: error instanceof Error ? error.message : "reconcile failed",
      });
    });
  }

  const now = new Date().toISOString();
  const patch = {
    encrypted_key_id: sealSecret(keys.clientId),
    encrypted_key_secret: sealSecret(keys.clientSecret),
    encrypted_webhook_secret: null,
    key_fingerprint: fingerprint,
    key_id_hint: cashfreeClientIdHint(keys.clientId),
    payment_mode: input.mode,
    connection_status: "CONNECTED" as MerchantConnectionStatus,
    // Moving to another account or environment needs a fresh, deliberate "enable".
    enabled: Boolean(existing?.enabled) && existing?.connection_status === "CONNECTED" && !accountChanged,
    last_verified_at: credentialsChanged ? now : existing?.last_verified_at ?? now,
    last_error: null,
    connected_at: existing?.connected_at && existing.connection_status !== "NOT_CONNECTED" && !accountChanged ? existing.connected_at : now,
    disconnected_at: null,
    updated_by: actor.userId,
  };

  const query = existing
    ? admin.from("merchant_payment_integrations").update(patch).eq("id", existing.id).eq("organization_id", actor.organizationId)
    : admin.from("merchant_payment_integrations").insert({
        ...patch,
        organization_id: actor.organizationId,
        provider: CASHFREE_PROVIDER,
        webhook_token: randomToken(24),
        created_by: actor.userId,
      });
  const { data, error } = await query.select(INTEGRATION_COLUMNS).single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not save the Cashfree integration.");
  await audit(admin, actor, existing?.encrypted_key_id ? "merchant_cashfree.updated" : "merchant_cashfree.connected", {
    mode: input.mode,
    clientIdHint: cashfreeClientIdHint(keys.clientId),
    credentialsChanged,
    accountChanged,
  });
  return mapCashfreeView(data as MerchantPaymentIntegrationRow);
}

/** Re-checks the stored credentials with Cashfree and records the outcome. */
export async function verifyMerchantCashfree(admin: SupabaseClient, actor: Actor, deps: Deps = {}) {
  const { row } = await loadCashfreeIntegration(admin, actor.organizationId);
  const creds = cashfreeCredentialsOf(row);
  if (!row || !creds) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Connect your Cashfree account first.");
  let status: MerchantConnectionStatus = "CONNECTED";
  let lastError: string | null = null;
  try {
    await checkCashfreeCredentials(creds, deps.client ?? merchantCashfreeClient);
  } catch (error) {
    // A network blip says nothing about the credentials: keep the status, surface the error.
    if (error instanceof CashfreeUnavailableError) throw error;
    status = "VERIFICATION_FAILED";
    lastError = error instanceof AppError ? error.message : "Cashfree rejected the saved credentials.";
  }
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .update({
      connection_status: status,
      last_verified_at: new Date().toISOString(),
      last_error: lastError,
      enabled: status === "CONNECTED" ? row.enabled : false,
      updated_by: actor.userId,
    })
    .eq("id", row.id)
    .eq("organization_id", actor.organizationId)
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not update the Cashfree integration.");
  await audit(admin, actor, "merchant_cashfree.verified", { status });
  return { ...mapCashfreeView(data as MerchantPaymentIntegrationRow), verified: status === "CONNECTED" };
}

export async function setMerchantCashfreeEnabled(admin: SupabaseClient, actor: Actor, enabled: boolean) {
  const { row } = await loadCashfreeIntegration(admin, actor.organizationId);
  if (!row) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Connect your Cashfree account first.");
  if (enabled && (row.connection_status !== "CONNECTED" || !cashfreeCredentialsOf(row))) {
    throw new AppError(ERROR_CODES.CONFLICT, "Verify your Cashfree credentials before turning on online payments.");
  }
  const { data, error } = await admin
    .from("merchant_payment_integrations")
    .update({ enabled, updated_by: actor.userId })
    .eq("id", row.id)
    .eq("organization_id", actor.organizationId)
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not update online payments.");
  await audit(admin, actor, enabled ? "merchant_cashfree.enabled" : "merchant_cashfree.disabled", {});
  return mapCashfreeView(data as MerchantPaymentIntegrationRow);
}

/**
 * Disconnects Cashfree. Open attempts are reconciled first while the credentials still exist; then
 * credentials are wiped and the webhook URL is rotated. Payment history is kept.
 */
export async function disconnectMerchantCashfree(
  admin: SupabaseClient,
  actor: Actor,
  deps: { reconcileOpen?: (row: MerchantPaymentIntegrationRow) => Promise<unknown> } = {}
) {
  const { row } = await loadCashfreeIntegration(admin, actor.organizationId);
  if (!row) return mapCashfreeView(null);
  if (deps.reconcileOpen && cashfreeCredentialsOf(row)) {
    await deps.reconcileOpen(row).catch((error) => {
      logError("merchant_cashfree.reconcile_before_disconnect_failed", {
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
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error || !data) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not disconnect Cashfree.");
  await audit(admin, actor, "merchant_cashfree.disconnected", {});
  return mapCashfreeView(data as MerchantPaymentIntegrationRow);
}

/** True when this Cashfree integration may take NEW checkouts. */
export function cashfreeUsable(row: MerchantPaymentIntegrationRow | null) {
  return Boolean(row && row.enabled && row.connection_status === "CONNECTED" && cashfreeCredentialsOf(row));
}

export type ActiveCashfreeGateway = {
  integration: MerchantPaymentIntegrationRow;
  credentials: CashfreeCredentials;
  client: MerchantCashfreeClient;
};

export const CASHFREE_UNAVAILABLE = "Online payment is not available for this store right now. Please choose another payment option.";

/** The store's own Cashfree account for a new checkout. No fallback of any kind. */
export async function activeCashfreeGateway(admin: SupabaseClient, organizationId: string, deps: Deps = {}): Promise<ActiveCashfreeGateway> {
  const { row } = await loadCashfreeIntegration(admin, organizationId);
  const credentials = cashfreeCredentialsOf(row);
  if (!row || !credentials || !cashfreeUsable(row) || row.organization_id !== organizationId) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, CASHFREE_UNAVAILABLE);
  }
  return { integration: row, credentials, client: (deps.client ?? merchantCashfreeClient)(credentials) };
}
