import { describe, expect, it } from "vitest";
import { chargeMicros, countryFromE164, resolvePrice, type PricingRule } from "@/modules/wallet/pricing";

const B = (v: number) => BigInt(v);
const ORG = "30000000-0000-4000-8000-000000000001";

function rule(overrides: Partial<PricingRule>): PricingRule {
  return {
    id: "r",
    service: "whatsapp",
    organizationId: null,
    whatsappCategory: "*",
    countryCode: "*",
    provider: "*",
    aiFeature: "*",
    aiModel: "*",
    perUnitMicros: B(0),
    per1kInputTokensMicros: B(0),
    per1kOutputTokensMicros: B(0),
    markupBps: 0,
    discountBps: 0,
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
    ...overrides,
  };
}

describe("chargeMicros", () => {
  it("prices a utility message with markup exactly", () => {
    // ₹0.115 Meta rate + 20% PostBus markup = ₹0.138
    expect(chargeMicros(rule({ perUnitMicros: B(115_000), markupBps: 2000 }))).toBe(B(138_000));
  });

  it("rounds token cost and markup up, discount down", () => {
    const r = rule({ service: "ai", per1kInputTokensMicros: B(1_001), per1kOutputTokensMicros: B(3), markupBps: 1 });
    // input ceil(1500*1001/1000)=1502, output ceil(7*3/1000)=1 → base 1503; markup ceil(0.1503)=1 → 1504
    expect(chargeMicros(r, { units: 0, inputTokens: 1500, outputTokens: 7 })).toBe(B(1504));
    const d = rule({ perUnitMicros: B(999), discountBps: 3333 });
    // 999 - floor(999*0.3333)=999-332
    expect(chargeMicros(d)).toBe(B(667));
  });

  it("combines a fixed fee with tokens", () => {
    const r = rule({
      service: "ai",
      perUnitMicros: B(50_000),
      per1kInputTokensMicros: B(20_000),
      per1kOutputTokensMicros: B(80_000),
    });
    expect(chargeMicros(r, { inputTokens: 2000, outputTokens: 500 })).toBe(B(50_000 + 40_000 + 40_000));
  });

  it("refuses negative usage and out-of-range percentages", () => {
    expect(() => chargeMicros(rule({}), { units: -1 })).toThrow();
    expect(() => chargeMicros(rule({ discountBps: 10_001 }))).toThrow();
    expect(() => chargeMicros(rule({ markupBps: 1.5 }))).toThrow();
  });
});

describe("resolvePrice", () => {
  const rules = [
    rule({ id: "global", perUnitMicros: B(1) }),
    rule({ id: "utility", whatsappCategory: "UTILITY", perUnitMicros: B(2) }),
    rule({ id: "utility-in", whatsappCategory: "UTILITY", countryCode: "IN", perUnitMicros: B(3) }),
    rule({ id: "tenant", organizationId: ORG, perUnitMicros: B(4) }),
    rule({ id: "old", whatsappCategory: "MARKETING", effectiveTo: "2026-06-01T00:00:00Z" }),
    rule({ id: "new", whatsappCategory: "MARKETING", effectiveFrom: "2026-06-01T00:00:00Z" }),
  ];

  it("prefers the most specific rule", () => {
    expect(resolvePrice(rules, { service: "whatsapp", whatsappCategory: "utility", countryCode: "in" })?.id).toBe("utility-in");
    expect(resolvePrice(rules, { service: "whatsapp", whatsappCategory: "UTILITY", countryCode: "AE" })?.id).toBe("utility");
    expect(resolvePrice(rules, { service: "whatsapp", whatsappCategory: "SERVICE" })?.id).toBe("global");
  });

  it("lets a tenant override win", () => {
    expect(resolvePrice(rules, { service: "whatsapp", organizationId: ORG, whatsappCategory: "UTILITY" })?.id).toBe("tenant");
  });

  it("keeps the rate that applied at the time", () => {
    expect(resolvePrice(rules, { service: "whatsapp", whatsappCategory: "MARKETING", at: new Date("2026-05-31T23:59:59Z") })?.id).toBe("old");
    expect(resolvePrice(rules, { service: "whatsapp", whatsappCategory: "MARKETING", at: new Date("2026-06-01T00:00:00Z") })?.id).toBe("new");
  });

  it("returns null when nothing matches", () => {
    expect(resolvePrice(rules, { service: "ai" })).toBeNull();
  });
});

describe("countryFromE164", () => {
  it("maps Indian numbers and falls back to '*'", () => {
    expect(countryFromE164("+91 98765 43210")).toBe("IN");
    expect(countryFromE164("971501234567")).toBe("AE");
    expect(countryFromE164("12")).toBe("*");
    expect(countryFromE164(null)).toBe("*");
  });
});
