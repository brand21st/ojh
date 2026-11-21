import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { walletEnabled } from "@/modules/wallet/constants";
import { countryFromE164 } from "@/modules/wallet/pricing";

/**
 * Wallet billing for WhatsApp notices sent through the PostBus (platform)
 * VaChat account. The notice's external_ref is the idempotency key end to end.
 */

export const HELD_FOR_BALANCE_STATUS = "held_balance";

export type NoticeHoldPayload = {
  event: string;
  shipmentId: string | null;
  orderId: string | null;
  eventCode: string | null;
  occurredAt: string | null;
};

function walletDb(): SupabaseClient | null {
  if (!walletEnabled() || !hasAdminClient()) return null;
  return createAdminClient();
}

/**
 * Holds the price of one notice before sending. proceed=false only when the
 * wallet cannot pay; any billing fault lets the notice go out unbilled so a
 * customer's delivery update is never lost to a billing error.
 */
export async function holdWhatsappNotice(
  organizationId: string,
  input: { externalRef: string; event: string; phone?: string | null; category?: string }
): Promise<{ proceed: boolean; billed: boolean; status: string }> {
  const db = walletDb();
  if (!db) return { proceed: true, billed: false, status: "WALLET_OFF" };
  const { data, error } = await db.rpc("wallet_whatsapp_reserve", {
    p_org: organizationId,
    p_external_ref: input.externalRef,
    p_event: input.event,
    p_category: input.category ?? "UTILITY",
    p_country_code: countryFromE164(input.phone),
    p_provider: "vachat",
    p_ttl_seconds: 72 * 3600,
  });
  if (error) {
    if (error.code !== "PGRST202") {
      logError("wallet.whatsapp_hold_failed", { organizationId, externalRef: input.externalRef, message: error.message });
    }
    return { proceed: true, billed: false, status: "ERROR" };
  }
  const status = String(((data ?? {}) as Record<string, unknown>).status);
  if (status === "INSUFFICIENT_BALANCE" || status === "WALLET_FROZEN") {
    logInfo("wallet.whatsapp_held_for_balance", { organizationId, externalRef: input.externalRef, status });
    return { proceed: false, billed: false, status };
  }
  if (status === "UNPRICED") {
    logError("wallet.whatsapp_unpriced", { organizationId, event: input.event, category: input.category ?? "UTILITY" });
  }
  return { proceed: true, billed: status === "HELD" || status === "DUPLICATE", status };
}

export type WhatsappOutcome = "sent" | "delivered" | "read" | "failed" | "not_billable" | "send_error";

/** Maps one provider status (webhook or send result) onto the notice's charge. */
export async function settleWhatsappNotice(
  organizationId: string,
  input: {
    externalRef: string;
    outcome: WhatsappOutcome;
    category?: string | null;
    providerMessageId?: string | null;
    whatsappMessageId?: string | null;
  }
) {
  const db = walletDb();
  if (!db) return { status: "WALLET_OFF" };
  const { data, error } = await db.rpc("wallet_whatsapp_settle", {
    p_org: organizationId,
    p_external_ref: input.externalRef,
    p_outcome: input.outcome,
    p_category: input.category ?? null,
    p_provider_message_id: input.providerMessageId ?? null,
    p_whatsapp_message_id: input.whatsappMessageId ?? null,
  });
  if (error) {
    if (error.code !== "PGRST202") {
      logError("wallet.whatsapp_settle_failed", { organizationId, externalRef: input.externalRef, message: error.message });
    }
    return { status: "ERROR" };
  }
  return { status: String(((data ?? {}) as Record<string, unknown>).status) };
}

/** Webhook status plus Meta's pricing block (when the provider forwards it) as one outcome. */
export function whatsappOutcomeFromWebhook(
  status: string,
  pricing?: { billable?: unknown; category?: unknown } | null
): { outcome: WhatsappOutcome | null; category: string | null } {
  const key = status.trim().toLowerCase();
  const category = typeof pricing?.category === "string" ? pricing.category.trim().toUpperCase() : null;
  if (pricing && pricing.billable === false && (key === "delivered" || key === "read" || key === "sent")) {
    return { outcome: "not_billable", category };
  }
  if (key === "sent" || key === "delivered" || key === "read" || key === "failed") return { outcome: key, category };
  return { outcome: null, category };
}

/**
 * Sends notices that were held for low balance again, once the wallet can
 * pay. Only notices younger than the Super Admin window are resent, so a
 * customer never gets a days-old "Booked" message.
 */
export async function resumeHeldWhatsappNotices(options: { organizationId?: string; limit?: number } = {}) {
  const db = walletDb();
  if (!db) return { resumed: 0 };
  const { data: settings } = await db
    .from("platform_settings")
    .select("wallet_whatsapp_resume_hours")
    .eq("id", 1)
    .maybeSingle();
  const hours = Number(settings?.wallet_whatsapp_resume_hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return { resumed: 0 };
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  let query = db
    .from("vachat_notification_logs")
    .select("id, organization_id, wallet_hold_payload, shipment_id, order_id")
    .eq("status", HELD_FOR_BALANCE_STATUS)
    .gte("updated_at", since)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(options.limit ?? 200, 1000)));
  if (options.organizationId) query = query.eq("organization_id", options.organizationId);
  const { data: held, error } = await query;
  if (error) {
    if (error.code !== "42703" && error.code !== "PGRST204") logError("wallet.whatsapp_resume_list_failed", { message: error.message });
    return { resumed: 0 };
  }

  const affordable = new Map<string, boolean>();
  let resumed = 0;
  const { createBackgroundJob } = await import("@/modules/jobs/service");
  for (const row of held ?? []) {
    const organizationId = String(row.organization_id);
    if (!affordable.has(organizationId)) {
      const { data: wallet } = await db
        .from("wallets")
        .select("status, balance_micros::text, reserved_micros::text, credit_limit_micros::text")
        .eq("organization_id", organizationId)
        .maybeSingle();
      const available = wallet
        ? BigInt(String(wallet.balance_micros)) + BigInt(String(wallet.credit_limit_micros)) - BigInt(String(wallet.reserved_micros))
        : BigInt(0);
      affordable.set(organizationId, wallet?.status === "ACTIVE" && available > BigInt(0));
    }
    if (!affordable.get(organizationId)) continue;
    const payload = (row.wallet_hold_payload ?? null) as NoticeHoldPayload | null;
    const entityId = payload?.shipmentId ?? payload?.orderId ?? row.shipment_id ?? row.order_id;
    if (!payload?.event || !entityId) continue;
    await createBackgroundJob(db, {
      organizationId,
      jobType: "vachat-notify",
      entityType: payload.shipmentId ? "shipment" : "order",
      entityId: String(entityId),
      progress: { ...payload, resumedFromWalletHold: true },
    });
    await db
      .from("vachat_notification_logs")
      .update({ status: "queued", error: null, wallet_hold_payload: null })
      .eq("id", row.id)
      .eq("status", HELD_FOR_BALANCE_STATUS);
    resumed += 1;
  }
  if (resumed) logInfo("wallet.whatsapp_resumed", { resumed, organizationId: options.organizationId ?? null });
  return { resumed };
}
