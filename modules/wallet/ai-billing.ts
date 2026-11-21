import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_AI_CREDIT_RATE_MICROS, walletEnabled } from "@/modules/wallet/constants";
import { toMicros } from "@/modules/wallet/money";

/**
 * Wallet side of AI billing. modules/ai-credits/service.ts calls these for an
 * organization whose AI credits have moved to the wallet (wallet_ai_mode =
 * 'wallet'); every other organization keeps the legacy credit functions.
 */

export const AI_FEATURES = [
  "data_extraction",
  "address_checker",
  "address_validation",
  "product_copy",
  "cover_copy",
  "prompt_enhance",
  "order_error_explain",
  "image_studio",
  "cover_studio",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  data_extraction: "AI data processing (WhatsApp orders)",
  address_checker: "AI address checker",
  address_validation: "AI address validation",
  product_copy: "AI product copy",
  cover_copy: "AI cover copy",
  prompt_enhance: "AI prompt rewrite",
  order_error_explain: "AI order error explanations",
  image_studio: "AI Image Studio",
  cover_studio: "AI Cover Studio",
};

/** Legacy reason codes when a caller does not name its feature. */
const REASON_FEATURE: Record<string, AiFeature> = {
  AI_ADDRESS_EXTRACTION: "data_extraction",
  AI_PRODUCT_COPY: "product_copy",
  AI_PROMPT_ENHANCE: "prompt_enhance",
  AI_IMAGE_STUDIO: "image_studio",
  AI_ERROR_STATUS: "order_error_explain",
};

export function featureForReason(reason: string | null | undefined, feature?: AiFeature | null): AiFeature | "*" {
  if (feature) return feature;
  return (reason && REASON_FEATURE[reason]) || "*";
}

export type AiUsage = { inputTokens?: number | null; outputTokens?: number | null };

/** Filled in by an OpenRouter call so the caller can bill the tokens and model it actually used. */
export type AiUsageSink = { inputTokens?: number; outputTokens?: number; model?: string };

function walletDb(): SupabaseClient | null {
  if (!walletEnabled() || !hasAdminClient()) return null;
  return createAdminClient();
}

function tokens(value: number | null | undefined) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** True when this organization pays for AI from its wallet. */
export async function walletBillsAi(organizationId: string) {
  const db = walletDb();
  if (!db) return false;
  const { data, error } = await db.rpc("wallet_ai_mode", { p_org: organizationId });
  if (error) {
    // Before the wallet migrations are applied, everyone stays on credits.
    if (error.code !== "PGRST202" && error.code !== "42883") {
      logError("wallet.ai_mode_failed", { organizationId, message: error.message });
    }
    return false;
  }
  return data === "wallet";
}

/**
 * The wallet balance shown in credit terms (balance / the cutover rate of
 * Rs 0.20 per credit), so existing AI screens and their "out of credits"
 * checks keep working for wallet-billed organizations.
 */
export async function walletCreditEquivalent(organizationId: string) {
  const db = walletDb();
  if (!db) return 0;
  const [{ data: wallet }, { data: settings }] = await Promise.all([
    db
      .from("wallets")
      .select("status, balance_micros::text, reserved_micros::text, credit_limit_micros::text")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    db.from("platform_settings").select("wallet_ai_credit_rate_micros::text").eq("id", 1).maybeSingle(),
  ]);
  if (!wallet || wallet.status !== "ACTIVE") return 0;
  const available =
    toMicros(String(wallet.balance_micros)) + toMicros(String(wallet.credit_limit_micros)) - toMicros(String(wallet.reserved_micros));
  const rate = toMicros(String(settings?.wallet_ai_credit_rate_micros ?? DEFAULT_AI_CREDIT_RATE_MICROS));
  if (rate <= BigInt(0) || available <= BigInt(0)) return 0;
  return Number(available / rate);
}

export type WalletAiChargeResult = {
  status: string;
  charged: boolean;
  duplicate: boolean;
  chargeMicros: string | null;
};

/** Charges an AI operation that already ran. Once per idempotency key. */
export async function chargeWalletAi(input: {
  organizationId: string;
  feature: AiFeature | "*";
  model?: string | null;
  idempotencyKey?: string | null;
  units?: number;
  usage?: AiUsage;
  parentOperationId?: string | null;
}): Promise<WalletAiChargeResult> {
  const db = walletDb();
  if (!db) return { status: "DISABLED", charged: false, duplicate: false, chargeMicros: null };
  const key = input.idempotencyKey?.trim() || `auto:${randomUUID()}`;
  const { data, error } = await db.rpc("wallet_ai_charge", {
    p_org: input.organizationId,
    p_feature: input.feature,
    p_model: input.model || "*",
    p_idempotency_key: key,
    p_units: Math.max(0, Math.floor(input.units ?? 1)),
    p_input_tokens: tokens(input.usage?.inputTokens),
    p_output_tokens: tokens(input.usage?.outputTokens),
    p_parent_operation_id: input.parentOperationId ?? null,
    p_metadata: {},
  });
  if (error) {
    logError("wallet.ai_charge_failed", { organizationId: input.organizationId, feature: input.feature, message: error.message });
    return { status: "ERROR", charged: false, duplicate: false, chargeMicros: null };
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  const status = String(raw.status);
  const charged = status === "CHARGED" || status === "FREE" || status === "DUPLICATE";
  if (!charged) {
    logInfo("wallet.ai_charge_refused", { organizationId: input.organizationId, feature: input.feature, status });
  }
  return {
    status,
    charged,
    duplicate: status === "DUPLICATE",
    chargeMicros: typeof raw.chargeMicros === "string" ? raw.chargeMicros : null,
  };
}

/** Holds the price of a slow AI job before it runs. */
export async function reserveWalletAi(input: {
  organizationId: string;
  feature: AiFeature | "*";
  model?: string | null;
  idempotencyKey: string;
  units?: number;
  usage?: AiUsage;
  ttlSeconds?: number;
}) {
  const db = walletDb();
  if (!db) return { status: "DISABLED", held: false, duplicate: false };
  const { data, error } = await db.rpc("wallet_ai_reserve", {
    p_org: input.organizationId,
    p_feature: input.feature,
    p_model: input.model || "*",
    p_idempotency_key: input.idempotencyKey,
    p_units: Math.max(0, Math.floor(input.units ?? 1)),
    p_input_tokens: tokens(input.usage?.inputTokens),
    p_output_tokens: tokens(input.usage?.outputTokens),
    p_ttl_seconds: input.ttlSeconds ?? 7200,
    p_metadata: {},
  });
  if (error) {
    logError("wallet.ai_reserve_failed", { organizationId: input.organizationId, message: error.message });
    return { status: "ERROR", held: false, duplicate: false };
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  const status = String(raw.status);
  return {
    status,
    held: status === "HELD" || status === "FREE",
    duplicate: status === "DUPLICATE",
  };
}

/** Finishes a held AI job: charge on success, release on failure. */
export async function settleWalletAi(input: {
  organizationId: string;
  idempotencyKey: string;
  success: boolean;
  usage?: AiUsage;
  reason?: string;
}) {
  const db = walletDb();
  if (!db) return { status: "DISABLED" };
  const { data, error } = await db.rpc("wallet_ai_settle", {
    p_org: input.organizationId,
    p_idempotency_key: input.idempotencyKey,
    p_success: input.success,
    p_input_tokens: input.usage?.inputTokens == null ? null : tokens(input.usage.inputTokens),
    p_output_tokens: input.usage?.outputTokens == null ? null : tokens(input.usage.outputTokens),
    p_reason: input.reason ?? null,
  });
  if (error) {
    logError("wallet.ai_settle_failed", { organizationId: input.organizationId, message: error.message });
    return { status: "ERROR" };
  }
  return { status: String(((data ?? {}) as Record<string, unknown>).status) };
}

/** Reads OpenRouter's usage block. Missing or malformed counts become zero. */
export function openRouterUsage(json: unknown): AiUsage {
  const usage = (json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return { inputTokens: n(usage?.prompt_tokens), outputTokens: n(usage?.completion_tokens) };
}
