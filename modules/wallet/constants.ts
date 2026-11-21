export const WALLET_RECHARGE_PURPOSE = "wallet_recharge";

/** Defaults; the live values are in platform_settings (Super Admin can change them). */
export const DEFAULT_RECHARGE_PRESETS_PAISE = [10000, 25000, 50000, 100000, 200000] as const;
export const DEFAULT_RECHARGE_MIN_PAISE = 10000;
export const DEFAULT_RECHARGE_MAX_PAISE = 5000000;
export const DEFAULT_SIGNUP_PROMO_MICROS = "100000000";
export const DEFAULT_AI_CREDIT_RATE_MICROS = "200000";
export const DEFAULT_LOW_BALANCE_THRESHOLDS_MICROS = ["100000000", "50000000", "20000000"] as const;

export const DEFAULT_RESERVATION_TTL_SECONDS = 86_400;

export const LEDGER_CREDIT_TYPES = [
  "RECHARGE",
  "PROMO_CREDIT",
  "ADMIN_CREDIT",
  "ADMIN_REFUND",
  "USAGE_REVERSAL",
  "MIGRATION_OPENING",
] as const;
export const LEDGER_DEBIT_TYPES = ["USAGE_WHATSAPP", "USAGE_AI", "ADMIN_DEBIT", "RECHARGE_REVERSAL"] as const;
export type LedgerEntryType = (typeof LEDGER_CREDIT_TYPES)[number] | (typeof LEDGER_DEBIT_TYPES)[number];

export const ADJUSTMENT_KINDS = ["PROMO", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export const LEDGER_LABELS: Record<LedgerEntryType, string> = {
  RECHARGE: "Recharge",
  PROMO_CREDIT: "Promotional credit",
  ADMIN_CREDIT: "Credit from PostBus",
  ADMIN_REFUND: "Refund from PostBus",
  USAGE_REVERSAL: "Charge reversed",
  MIGRATION_OPENING: "AI credits moved to wallet",
  USAGE_WHATSAPP: "WhatsApp message",
  USAGE_AI: "AI usage",
  ADMIN_DEBIT: "Debit by PostBus",
  RECHARGE_REVERSAL: "Recharge refunded",
};

/** Server-only switch. Off: the old AI credit flow runs and nothing is charged to wallets. */
export function walletEnabled() {
  return (process.env.WALLET_ENABLED ?? "").trim().toLowerCase() === "true";
}
