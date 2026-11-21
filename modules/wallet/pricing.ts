import { ZERO, toMicros, type Micros } from "@/modules/wallet/money";

/**
 * Mirrors public.wallet_charge_micros in 20261121120000_tenant_wallet.sql.
 * The database is the authority when a charge is posted; this copy is for
 * quotes and estimates shown before the call. A test asserts both agree.
 */

export type WalletService = "whatsapp" | "ai";

export const WHATSAPP_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE", "OTHER"] as const;
export type WhatsappCategory = (typeof WHATSAPP_CATEGORIES)[number];

export type PricingRule = {
  id: string;
  service: WalletService;
  organizationId: string | null;
  whatsappCategory: WhatsappCategory | "*";
  countryCode: string;
  provider: string;
  aiFeature: string;
  aiModel: string;
  perUnitMicros: Micros;
  per1kInputTokensMicros: Micros;
  per1kOutputTokensMicros: Micros;
  markupBps: number;
  discountBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type Usage = {
  units?: number | bigint;
  inputTokens?: number | bigint;
  outputTokens?: number | bigint;
};

const THOUSAND = BigInt(1000);
const TEN_THOUSAND = BigInt(10_000);

function nonNegative(value: number | bigint | undefined, label: string): bigint {
  if (value === undefined) return ZERO;
  const v = typeof value === "bigint" ? value : BigInt(Number.isSafeInteger(value) ? value : NaN);
  if (v < ZERO) throw new RangeError(`${label} cannot be negative`);
  return v;
}

function bps(value: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`${label} is out of range`);
  return BigInt(value);
}

function ceilDiv(n: bigint, d: bigint) {
  return (n + d - BigInt(1)) / d;
}

/** base + ceil(base * markup) - floor(marked * discount), all in micros. */
export function chargeMicros(
  rule: Pick<
    PricingRule,
    "perUnitMicros" | "per1kInputTokensMicros" | "per1kOutputTokensMicros" | "markupBps" | "discountBps"
  >,
  usage: Usage = {}
): Micros {
  const units = usage.units === undefined ? BigInt(1) : nonNegative(usage.units, "Units");
  const input = nonNegative(usage.inputTokens, "Input tokens");
  const output = nonNegative(usage.outputTokens, "Output tokens");
  const markup = bps(rule.markupBps, 100_000, "Markup");
  const discount = bps(rule.discountBps, 10_000, "Discount");

  const base =
    toMicros(rule.perUnitMicros) * units +
    ceilDiv(input * toMicros(rule.per1kInputTokensMicros), THOUSAND) +
    ceilDiv(output * toMicros(rule.per1kOutputTokensMicros), THOUSAND);
  const marked = base + ceilDiv(base * markup, TEN_THOUSAND);
  return marked - (marked * discount) / TEN_THOUSAND;
}

export type PriceQuery = {
  service: WalletService;
  organizationId?: string | null;
  whatsappCategory?: string | null;
  countryCode?: string | null;
  provider?: string | null;
  aiFeature?: string | null;
  aiModel?: string | null;
  at?: Date;
};

/**
 * Same precedence as public.wallet_resolve_price: tenant override first, then
 * the rule that names the category, model, feature, country and provider
 * instead of '*'; the newest effective rule breaks ties.
 */
export function resolvePrice(rules: PricingRule[], query: PriceQuery): PricingRule | null {
  const at = (query.at ?? new Date()).getTime();
  const want = {
    category: (query.whatsappCategory ?? "*").toUpperCase(),
    country: (query.countryCode ?? "*").toUpperCase(),
    provider: (query.provider ?? "*").toLowerCase(),
    feature: query.aiFeature ?? "*",
    model: query.aiModel ?? "*",
  };
  const matches = (value: string, wanted: string) => value === "*" || value === wanted;

  const candidates = rules.filter(
    (rule) =>
      rule.service === query.service &&
      (rule.organizationId === null || rule.organizationId === (query.organizationId ?? null)) &&
      matches(rule.whatsappCategory, want.category) &&
      matches(rule.countryCode, want.country) &&
      matches(rule.provider, want.provider) &&
      matches(rule.aiFeature, want.feature) &&
      matches(rule.aiModel, want.model) &&
      new Date(rule.effectiveFrom).getTime() <= at &&
      (rule.effectiveTo === null || new Date(rule.effectiveTo).getTime() > at)
  );

  const rank = (rule: PricingRule) => [
    rule.organizationId !== null ? 1 : 0,
    rule.whatsappCategory !== "*" ? 1 : 0,
    rule.aiModel !== "*" ? 1 : 0,
    rule.aiFeature !== "*" ? 1 : 0,
    rule.countryCode !== "*" ? 1 : 0,
    rule.provider !== "*" ? 1 : 0,
    new Date(rule.effectiveFrom).getTime(),
  ];

  candidates.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return rb[i] - ra[i];
    }
    return 0;
  });
  return candidates[0] ?? null;
}

/** ISO country from an E.164 number for WhatsApp pricing. Unknown prefixes price as '*'. */
export function countryFromE164(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return "IN";
  if (digits.startsWith("971")) return "AE";
  if (digits.startsWith("966")) return "SA";
  if (digits.startsWith("44")) return "GB";
  if (digits.startsWith("1") && digits.length === 11) return "US";
  return "*";
}
