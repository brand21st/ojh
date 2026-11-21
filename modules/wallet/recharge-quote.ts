import { MICROS_PER_PAISA, type Micros } from "@/modules/wallet/money";

/**
 * GST-inclusive recharge split. Mirrors public.wallet_quote_recharge, which is
 * what actually writes the order; this copy lets the page show the split
 * before payment. Same rounding as splitInclusiveTax in modules/billing.
 */

export type RechargeQuote = {
  amountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstRateBps: number;
  placeOfSupply: "INTRA" | "INTER";
  creditMicros: Micros;
};

export type RechargeLimits = {
  presetsPaise: number[];
  minPaise: number;
  maxPaise: number;
  gstRateBps: number;
  placeOfSupply: "INTRA" | "INTER";
};

export function quoteRecharge(
  amountPaise: number,
  gstRateBps: number,
  placeOfSupply: "INTRA" | "INTER" = "INTRA"
): RechargeQuote {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new RangeError("Enter a whole rupee amount.");
  if (!Number.isInteger(gstRateBps) || gstRateBps < 0 || gstRateBps > 9999) throw new RangeError("GST rate is out of range.");
  const gross = BigInt(amountPaise);
  const divisor = BigInt(10000 + gstRateBps);
  const taxable = (gross * BigInt(10000) + divisor / BigInt(2)) / divisor;
  const tax = gross - taxable;
  const cgst = placeOfSupply === "INTER" ? BigInt(0) : tax / BigInt(2);
  const sgst = placeOfSupply === "INTER" ? BigInt(0) : tax - cgst;
  const igst = placeOfSupply === "INTER" ? tax : BigInt(0);
  return {
    amountPaise,
    taxablePaise: Number(taxable),
    taxPaise: Number(tax),
    cgstPaise: Number(cgst),
    sgstPaise: Number(sgst),
    igstPaise: Number(igst),
    gstRateBps,
    placeOfSupply,
    creditMicros: taxable * MICROS_PER_PAISA,
  };
}

/** Recharges are whole rupees between the configured limits. */
export function validateRechargeAmount(amountPaise: unknown, limits: Pick<RechargeLimits, "minPaise" | "maxPaise">) {
  const value = typeof amountPaise === "number" ? amountPaise : Number.NaN;
  if (!Number.isSafeInteger(value) || value % 100 !== 0) {
    return { ok: false as const, message: "Enter a whole rupee amount." };
  }
  if (value < limits.minPaise || value > limits.maxPaise) {
    const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
    return {
      ok: false as const,
      message: `Recharge between ${rupees(limits.minPaise)} and ${rupees(limits.maxPaise)}.`,
    };
  }
  return { ok: true as const, amountPaise: value };
}
