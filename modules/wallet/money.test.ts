import { describe, expect, it } from "vitest";
import {
  MICROS_PER_PAISA,
  formatMicros,
  microsToPaiseFloor,
  paiseToMicros,
  parseRupeesToMicros,
  rupeesToMicros,
  toMicros,
} from "@/modules/wallet/money";

const B = (v: number | string) => BigInt(v);

describe("wallet money", () => {
  it("converts paise and rupees exactly", () => {
    expect(paiseToMicros(10000)).toBe(B(100_000_000));
    expect(rupeesToMicros(100)).toBe(B(100_000_000));
    expect(MICROS_PER_PAISA).toBe(B(10_000));
    expect(microsToPaiseFloor(B(1_159_999))).toBe(B(115));
  });

  it("refuses fractional or unsafe numbers", () => {
    expect(() => paiseToMicros(10.5)).toThrow();
    expect(() => toMicros(0.1)).toThrow();
    expect(() => toMicros(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(() => toMicros("12.5")).toThrow();
    expect(() => toMicros("99999999999999999999")).toThrow();
  });

  it("reads Postgres bigint strings", () => {
    expect(toMicros("9007199254740993")).toBe(B("9007199254740993"));
    expect(toMicros("-250000")).toBe(B(-250000));
  });

  it("parses typed amounts with up to six decimals", () => {
    expect(parseRupeesToMicros("0.115")).toBe(B(115_000));
    expect(parseRupeesToMicros("₹1,250.50")).toBe(B(1_250_500_000));
    expect(parseRupeesToMicros("0.000001")).toBe(B(1));
    expect(parseRupeesToMicros("-5")).toBe(B(-5_000_000));
    expect(() => parseRupeesToMicros("0.0000001")).toThrow();
    expect(() => parseRupeesToMicros("1e3")).toThrow();
    expect(() => parseRupeesToMicros("abc")).toThrow();
  });

  it("formats with Indian grouping and keeps fractional-paisa rates", () => {
    expect(formatMicros(B(123_456_789_000_000))).toBe("₹12,34,56,789.00");
    expect(formatMicros(B(12_345_678_900_000))).toBe("₹1,23,45,678.90");
    expect(formatMicros(B(115_000))).toBe("₹0.12");
    expect(formatMicros(B(115_000), { maxFractionDigits: 4 })).toBe("₹0.115");
    expect(formatMicros(B(-847_460_000))).toBe("-₹847.46");
    expect(formatMicros(B(0))).toBe("₹0.00");
    expect(formatMicros(B(999), { symbol: false })).toBe("0.00");
    expect(formatMicros(B(5_000))).toBe("₹0.01");
  });
});
