/**
 * Wallet money is integer micro-rupees (1 rupee = 1,000,000 micros,
 * 1 paisa = 10,000 micros), held as bigint. No floating point ever touches a
 * balance. Postgres returns these values as strings in wallet RPC results.
 */

export type Micros = bigint;

export const ZERO = BigInt(0);
export const MICROS_PER_RUPEE = BigInt(1_000_000);
export const MICROS_PER_PAISA = BigInt(10_000);
const TEN = BigInt(10);

/** Postgres bigint range, the hard ceiling for any stored amount. */
export const MAX_MICROS = BigInt("9223372036854775807");

export function toMicros(value: unknown): Micros {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("Micros must be a safe integer");
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed > MAX_MICROS || parsed < -MAX_MICROS) throw new RangeError("Micros out of range");
    return parsed;
  }
  throw new TypeError("Micros must be an integer");
}

export function paiseToMicros(paise: number | bigint): Micros {
  const value = typeof paise === "bigint" ? paise : BigInt(assertSafeInteger(paise));
  return value * MICROS_PER_PAISA;
}

/** Whole paise, rounding toward zero. Callers decide when that is acceptable. */
export function microsToPaiseFloor(micros: Micros): bigint {
  return micros / MICROS_PER_PAISA;
}

export function rupeesToMicros(rupees: number): Micros {
  return BigInt(assertSafeInteger(rupees)) * MICROS_PER_RUPEE;
}

/**
 * Parses an amount typed by a person ("12", "0.115", "1,250.50") into micros.
 * Accepts at most six decimal places and rejects anything else.
 */
export function parseRupeesToMicros(input: string): Micros {
  const cleaned = input.trim().replace(/^₹\s*/, "").replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(cleaned);
  if (!match) throw new TypeError("Enter an amount like 100 or 0.115");
  const [, sign, whole, fraction = ""] = match;
  const micros = BigInt(whole) * MICROS_PER_RUPEE + BigInt(fraction.padEnd(6, "0"));
  if (micros > MAX_MICROS) throw new RangeError("Amount is too large");
  return sign ? -micros : micros;
}

function groupIndian(digits: string) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/**
 * Formats micros as rupees with Indian digit grouping.
 * Shows two decimals, and up to `maxFractionDigits` when the value needs more
 * (a ₹0.115 rate stays ₹0.115 instead of rounding to ₹0.12).
 */
export function formatMicros(
  micros: Micros,
  options: { maxFractionDigits?: number; symbol?: boolean } = {}
): string {
  const maxDigits = Math.min(6, Math.max(2, options.maxFractionDigits ?? 2));
  const negative = micros < ZERO;
  const abs = negative ? -micros : micros;

  const scale = TEN ** BigInt(6 - maxDigits);
  // Round half away from zero at the shown precision.
  const rounded = (abs + scale / BigInt(2)) / scale;
  const unit = TEN ** BigInt(maxDigits);
  const whole = rounded / unit;
  let fraction = (rounded % unit).toString().padStart(maxDigits, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);

  const body = `${groupIndian(whole.toString())}.${fraction}`;
  const symbol = options.symbol === false ? "" : "₹";
  return `${negative ? "-" : ""}${symbol}${body}`;
}

/** For JSON and RPC arguments: bigint never goes through JSON as a number. */
export function microsToString(micros: Micros): string {
  return micros.toString();
}

export function minMicros(a: Micros, b: Micros): Micros {
  return a < b ? a : b;
}

export function maxMicros(a: Micros, b: Micros): Micros {
  return a > b ? a : b;
}

function assertSafeInteger(value: number) {
  if (!Number.isSafeInteger(value)) throw new RangeError("Amount must be a whole number");
  return value;
}
