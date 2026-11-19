import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { cashfreeUsable, loadCashfreeIntegration } from "./cashfree/integration";
import { credentialsOf, isMissingTable, loadIntegration, type MerchantPaymentIntegrationRow, type MerchantPaymentProvider } from "./integration";

/**
 * Which of the merchant's OWN gateways takes storefront online payments.
 *
 * Rules:
 *  - The merchant's explicit default wins. If that gateway is disabled, disconnected or failing,
 *    online payment is unavailable: PostBus never silently routes money to the other gateway.
 *  - With no default chosen, the single enabled gateway is used (so a Razorpay-only merchant keeps
 *    working). Two enabled gateways without a choice → unavailable until the merchant picks one.
 *  - Enabling a gateway when no default exists makes it the default (see ensureDefaultProvider).
 */

export const MERCHANT_PROVIDERS: MerchantPaymentProvider[] = ["RAZORPAY", "CASHFREE"];

type Actor = { organizationId: string; userId: string | null };

export function razorpayUsable(row: MerchantPaymentIntegrationRow | null) {
  return Boolean(row && row.enabled && row.connection_status === "CONNECTED" && credentialsOf(row)?.webhookSecret);
}

export async function loadDefaultProvider(admin: SupabaseClient, organizationId: string): Promise<MerchantPaymentProvider | null> {
  const { data, error } = await admin
    .from("merchant_payment_settings")
    .select("default_provider")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not load payment settings.");
  }
  const value = (data as { default_provider?: string | null } | null)?.default_provider ?? null;
  return value === "RAZORPAY" || value === "CASHFREE" ? value : null;
}

async function loadBoth(admin: SupabaseClient, organizationId: string) {
  const [razorpay, cashfree] = await Promise.all([
    loadIntegration(admin, organizationId).catch(() => ({ row: null, available: false as const })),
    loadCashfreeIntegration(admin, organizationId).catch(() => ({ row: null, available: false as const })),
  ]);
  return { RAZORPAY: razorpay.row, CASHFREE: cashfree.row } as Record<MerchantPaymentProvider, MerchantPaymentIntegrationRow | null>;
}

function usable(provider: MerchantPaymentProvider, row: MerchantPaymentIntegrationRow | null) {
  return provider === "RAZORPAY" ? razorpayUsable(row) : cashfreeUsable(row);
}

/** The gateway new storefront checkouts must use, or null when online payment is unavailable. */
export async function resolveCheckoutProvider(admin: SupabaseClient, organizationId: string): Promise<MerchantPaymentProvider | null> {
  const [defaultProvider, rows] = await Promise.all([loadDefaultProvider(admin, organizationId), loadBoth(admin, organizationId)]);
  if (defaultProvider) return usable(defaultProvider, rows[defaultProvider]) ? defaultProvider : null;
  const enabled = MERCHANT_PROVIDERS.filter((provider) => usable(provider, rows[provider]));
  return enabled.length === 1 ? enabled[0] : null;
}

async function upsertDefault(admin: SupabaseClient, actor: Actor, provider: MerchantPaymentProvider | null) {
  const { data: existing } = await admin
    .from("merchant_payment_settings")
    .select("organization_id")
    .eq("organization_id", actor.organizationId)
    .maybeSingle();
  const query = existing
    ? admin
        .from("merchant_payment_settings")
        .update({ default_provider: provider, updated_by: actor.userId })
        .eq("organization_id", actor.organizationId)
    : admin.from("merchant_payment_settings").insert({ organization_id: actor.organizationId, default_provider: provider, updated_by: actor.userId });
  const { error } = await query.select("organization_id").maybeSingle();
  if (error) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not save the default payment gateway.");
}

/** Called after a gateway is enabled: becomes the default only when none was chosen yet. */
export async function ensureDefaultProvider(admin: SupabaseClient, actor: Actor, provider: MerchantPaymentProvider) {
  try {
    if (await loadDefaultProvider(admin, actor.organizationId)) return;
    await upsertDefault(admin, actor, provider);
  } catch {
    // Settings table not deployed yet: single-gateway resolution still works.
  }
}

export type GatewayOverview = {
  available: boolean;
  defaultProvider: MerchantPaymentProvider | null;
  /** Gateway new checkouts use right now; null = online payment is off for the store. */
  activeProvider: MerchantPaymentProvider | null;
  providers: Record<MerchantPaymentProvider, { connected: boolean; enabled: boolean; usable: boolean; mode: "TEST" | "LIVE" | null; status: string }>;
  /** Why online payment is off, in merchant language. Null when it is on. */
  notice: string | null;
};

const NAMES: Record<MerchantPaymentProvider, string> = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" };

export async function gatewayOverview(admin: SupabaseClient, organizationId: string): Promise<GatewayOverview> {
  let available = true;
  let defaultProvider: MerchantPaymentProvider | null = null;
  try {
    const { error } = await admin.from("merchant_payment_settings").select("organization_id").eq("organization_id", organizationId).maybeSingle();
    if (error && isMissingTable(error)) available = false;
    defaultProvider = available ? await loadDefaultProvider(admin, organizationId) : null;
  } catch {
    available = false;
  }
  const rows = await loadBoth(admin, organizationId);
  const providers = Object.fromEntries(
    MERCHANT_PROVIDERS.map((provider) => {
      const row = rows[provider];
      return [
        provider,
        {
          connected: Boolean(row && row.connection_status !== "NOT_CONNECTED"),
          enabled: Boolean(row?.enabled),
          usable: usable(provider, row),
          mode: row && row.connection_status !== "NOT_CONNECTED" ? row.payment_mode : null,
          status: row?.connection_status ?? "NOT_CONNECTED",
        },
      ];
    })
  ) as GatewayOverview["providers"];
  const activeProvider = await resolveCheckoutProvider(admin, organizationId).catch(() => null);
  let notice: string | null = null;
  if (!activeProvider) {
    const enabledCount = MERCHANT_PROVIDERS.filter((provider) => providers[provider].usable).length;
    if (defaultProvider && !providers[defaultProvider].usable) {
      notice = `${NAMES[defaultProvider]} is your default gateway but it is not enabled and verified, so online payments are off. Turn it on, or choose another default.`;
    } else if (enabledCount > 1) {
      notice = "Choose a default gateway to turn on online payments.";
    } else {
      notice = "Online payments are off. Connect and enable Razorpay or Cashfree.";
    }
  }
  return { available, defaultProvider, activeProvider, providers, notice };
}

/** Explicit merchant choice. The chosen gateway must be connected, verified and enabled. */
export async function setDefaultProvider(admin: SupabaseClient, actor: Actor, provider: MerchantPaymentProvider) {
  const rows = await loadBoth(admin, actor.organizationId);
  if (!usable(provider, rows[provider])) {
    throw new AppError(ERROR_CODES.CONFLICT, `Connect, verify and enable ${NAMES[provider]} before making it the default gateway.`);
  }
  await upsertDefault(admin, actor, provider);
  await admin.from("audit_logs").insert({
    organization_id: actor.organizationId,
    actor_id: actor.userId,
    action: "merchant_payment.default_gateway_changed",
    entity_type: "merchant_payment_settings",
    entity_id: actor.organizationId,
    after: { provider },
  });
  return gatewayOverview(admin, actor.organizationId);
}
