import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/logger";
import { DEFAULT_RESERVATION_TTL_SECONDS, type AdjustmentKind } from "@/modules/wallet/constants";
import { ZERO, toMicros, type Micros } from "@/modules/wallet/money";
import type { WalletService } from "@/modules/wallet/pricing";

/**
 * Typed wrappers around the wallet RPCs. Every call needs a service-role
 * client: the RPCs are not granted to anon or authenticated, so a tenant's
 * session cannot move money even if a route forgets a check.
 */

export type WalletDb = Pick<SupabaseClient, "rpc">;

export type WalletSnapshot = {
  walletId: string;
  organizationId: string;
  status: "ACTIVE" | "FROZEN";
  balanceMicros: Micros;
  reservedMicros: Micros;
  availableMicros: Micros;
};

export type WalletResult<S extends string> = {
  status: S;
  snapshot: WalletSnapshot | null;
  raw: Record<string, unknown>;
};

export class WalletRpcError extends Error {
  constructor(
    readonly fn: string,
    message: string,
    readonly code?: string
  ) {
    super(`${fn}: ${message}`);
    this.name = "WalletRpcError";
  }
}

function asRecord(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  throw new TypeError("Wallet RPC returned an unexpected shape");
}

export function parseSnapshot(raw: Record<string, unknown>): WalletSnapshot | null {
  if (typeof raw.walletId !== "string") return null;
  return {
    walletId: raw.walletId,
    organizationId: String(raw.organizationId),
    status: raw.walletStatus === "FROZEN" ? "FROZEN" : "ACTIVE",
    balanceMicros: toMicros(raw.balanceMicros ?? "0"),
    reservedMicros: toMicros(raw.reservedMicros ?? "0"),
    availableMicros: toMicros(raw.availableMicros ?? "0"),
  };
}

async function call<S extends string>(
  db: WalletDb,
  fn: string,
  args: Record<string, unknown>
): Promise<WalletResult<S>> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    logError("wallet.rpc_failed", { fn, code: error.code, message: error.message });
    throw new WalletRpcError(fn, error.message, error.code);
  }
  const raw = asRecord(data);
  return { status: String(raw.status) as S, snapshot: parseSnapshot(raw), raw };
}

function positive(amount: Micros, label: string) {
  if (amount <= ZERO) throw new RangeError(`${label} must be positive`);
  return amount.toString();
}

export function reserveFunds(
  db: WalletDb,
  input: {
    organizationId: string;
    service: WalletService;
    amountMicros: Micros;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
    pricingRuleId?: string | null;
    ttlSeconds?: number;
    metadata?: Record<string, unknown>;
  }
) {
  return call<"HELD" | "DUPLICATE" | "INSUFFICIENT_BALANCE" | "WALLET_FROZEN">(db, "wallet_reserve", {
    p_org: input.organizationId,
    p_service: input.service,
    p_amount_micros: positive(input.amountMicros, "Hold amount"),
    p_idempotency_key: input.idempotencyKey,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: input.referenceId ?? null,
    p_pricing_rule_id: input.pricingRuleId ?? null,
    p_ttl_seconds: input.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS,
    p_metadata: input.metadata ?? {},
  });
}

export function captureReservation(
  db: WalletDb,
  input: {
    reservationId: string;
    amountMicros: Micros;
    description?: string;
    metadata?: Record<string, unknown>;
    pricingRuleId?: string | null;
  }
) {
  if (input.amountMicros < ZERO) throw new RangeError("Capture amount cannot be negative");
  return call<"CAPTURED" | "RELEASED" | "DUPLICATE" | "NOT_HELD" | "EXCEEDS_HOLD" | "NOT_FOUND">(
    db,
    "wallet_capture",
    {
      p_reservation_id: input.reservationId,
      p_amount_micros: input.amountMicros.toString(),
      p_description: input.description ?? null,
      p_metadata: input.metadata ?? {},
      p_pricing_rule_id: input.pricingRuleId ?? null,
    }
  );
}

export function releaseReservation(db: WalletDb, reservationId: string, reason?: string) {
  return call<"RELEASED" | "DUPLICATE" | "ALREADY_CAPTURED" | "NOT_FOUND">(db, "wallet_release", {
    p_reservation_id: reservationId,
    p_reason: reason ?? null,
  });
}

export function debitWallet(
  db: WalletDb,
  input: {
    organizationId: string;
    service: WalletService;
    amountMicros: Micros;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
    pricingRuleId?: string | null;
    description?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return call<"CHARGED" | "DUPLICATE" | "INSUFFICIENT_BALANCE" | "WALLET_FROZEN">(db, "wallet_debit", {
    p_org: input.organizationId,
    p_service: input.service,
    p_amount_micros: positive(input.amountMicros, "Charge"),
    p_idempotency_key: input.idempotencyKey,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: input.referenceId ?? null,
    p_pricing_rule_id: input.pricingRuleId ?? null,
    p_description: input.description ?? null,
    p_metadata: input.metadata ?? {},
  });
}

export function reverseUsage(db: WalletDb, ledgerId: string, reason: string, actorUserId?: string | null) {
  return call<"REVERSED" | "DUPLICATE" | "NOT_FOUND">(db, "wallet_reverse_usage", {
    p_ledger_id: ledgerId,
    p_reason: reason,
    p_actor: actorUserId ?? null,
  });
}

export function fulfillRecharge(
  db: WalletDb,
  input: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    amountPaise: number;
    method?: string | null;
    expectedOrganizationId?: string | null;
  }
) {
  return call<"CREDITED" | "DUPLICATE" | "NOT_FOUND" | "FORBIDDEN" | "AMOUNT_MISMATCH">(
    db,
    "wallet_fulfill_recharge",
    {
      p_razorpay_order_id: input.razorpayOrderId,
      p_razorpay_payment_id: input.razorpayPaymentId,
      p_amount_paise: input.amountPaise,
      p_method: input.method ?? null,
      p_expected_org: input.expectedOrganizationId ?? null,
    }
  );
}

export function markRechargeFailed(db: WalletDb, razorpayOrderId: string, reason?: string) {
  return call<"FAILED" | "UNCHANGED">(db, "wallet_mark_recharge_failed", {
    p_razorpay_order_id: razorpayOrderId,
    p_reason: reason ?? null,
  });
}

export function reverseRecharge(
  db: WalletDb,
  input: { razorpayPaymentId: string; refundId: string; refundPaise: number }
) {
  return call<"REVERSED" | "DUPLICATE" | "NOT_FOUND" | "NOT_PAID">(db, "wallet_reverse_recharge", {
    p_razorpay_payment_id: input.razorpayPaymentId,
    p_refund_id: input.refundId,
    p_refund_paise: input.refundPaise,
  });
}

export function adminAdjustWallet(
  db: WalletDb,
  input: {
    organizationId: string;
    kind: AdjustmentKind;
    amountMicros: Micros;
    reason: string;
    adminUserId: string;
    adminEmail?: string | null;
    idempotencyKey: string;
  }
) {
  return call<"ADJUSTED" | "DUPLICATE" | "INSUFFICIENT_BALANCE">(db, "wallet_admin_adjust", {
    p_org: input.organizationId,
    p_kind: input.kind,
    p_amount_micros: positive(input.amountMicros, "Adjustment"),
    p_reason: input.reason,
    p_admin_user_id: input.adminUserId,
    p_admin_email: input.adminEmail ?? null,
    p_idempotency_key: input.idempotencyKey,
  });
}

export function setWalletStatus(
  db: WalletDb,
  input: { organizationId: string; status: "ACTIVE" | "FROZEN"; reason: string; adminUserId: string }
) {
  return call<"UPDATED" | "UNCHANGED" | "BALANCE_SHORT">(db, "wallet_set_status", {
    p_org: input.organizationId,
    p_status: input.status,
    p_reason: input.reason,
    p_admin_user_id: input.adminUserId,
  });
}

export async function quoteWalletPrice(
  db: WalletDb,
  input: {
    service: WalletService;
    organizationId?: string | null;
    whatsappCategory?: string;
    countryCode?: string;
    provider?: string;
    aiFeature?: string;
    aiModel?: string;
    units?: number;
    inputTokens?: number;
    outputTokens?: number;
    at?: Date;
  }
): Promise<{ status: "OK"; pricingRuleId: string; chargeMicros: Micros } | { status: "NO_PRICE" }> {
  const { raw } = await call<"OK" | "NO_PRICE">(db, "wallet_quote", {
    p_service: input.service,
    p_org: input.organizationId ?? null,
    p_whatsapp_category: input.whatsappCategory ?? "*",
    p_country_code: input.countryCode ?? "*",
    p_provider: input.provider ?? "*",
    p_ai_feature: input.aiFeature ?? "*",
    p_ai_model: input.aiModel ?? "*",
    p_units: input.units ?? 1,
    p_input_tokens: input.inputTokens ?? 0,
    p_output_tokens: input.outputTokens ?? 0,
    p_at: (input.at ?? new Date()).toISOString(),
  });
  if (raw.status !== "OK") return { status: "NO_PRICE" };
  return { status: "OK", pricingRuleId: String(raw.pricingRuleId), chargeMicros: toMicros(raw.chargeMicros) };
}

export async function reconcileWallets(db: WalletDb, organizationId?: string | null) {
  const { data, error } = await db.rpc("wallet_reconcile", { p_org: organizationId ?? null });
  if (error) throw new WalletRpcError("wallet_reconcile", error.message, error.code);
  return Number(data ?? 0);
}

export async function expireReservations(db: WalletDb, limit = 500) {
  const { data, error } = await db.rpc("wallet_expire_reservations", { p_limit: limit });
  if (error) throw new WalletRpcError("wallet_expire_reservations", error.message, error.code);
  return Number(data ?? 0);
}

export async function migrateAiCredits(db: WalletDb, organizationId: string) {
  return call<"MIGRATED" | "DUPLICATE" | "RESERVATIONS_PENDING" | "NOT_FOUND">(db, "wallet_migrate_ai_credits", {
    p_org: organizationId,
  });
}
