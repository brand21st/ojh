/**
 * Pure coupon pricing. Works in integer paise so line prices, the order total, COD amounts and
 * invoices always add up. Orders have no discount column, so the discount is folded into line
 * unit prices (lines may split, exactly like bundle allocation) and recorded in order metadata.
 */

export type CouponDiscountType = "PERCENT" | "FIXED" | "BUY_X_GET_Y";
export type CouponScope = "ALL" | "PRODUCTS" | "CATEGORIES";
export type CouponStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export type CouponRule = {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  discountType: CouponDiscountType;
  value: number;
  maxDiscount: number | null;
  appliesTo: CouponScope;
  productIds: string[];
  categoryIds: string[];
  buyQuantity: number | null;
  getQuantity: number | null;
  minOrderAmount: number | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  firstOrderOnly: boolean;
  prepaidOnly: boolean;
  autoApply: boolean;
  startsAt: string | null;
  endsAt: string | null;
  status: CouponStatus;
};

export type CouponCartLine = {
  productId: string | null;
  unitPrice: number;
  quantity: number;
  /** Bundle lines are already discounted and never combine with a coupon. */
  fromBundle?: boolean;
  categoryIds?: string[];
};

export type CouponRejection =
  | "NOT_ACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "PREPAID_ONLY"
  | "MIN_ORDER"
  | "NO_ELIGIBLE"
  | "NEEDS_MORE_ITEMS";

export type CouponEvaluation<T extends CouponCartLine> =
  | { ok: true; discount: number; subtotal: number; eligibleSubtotal: number; total: number; lines: T[]; label: string }
  | { ok: false; reason: CouponRejection; message: string };

const paise = (rupees: number) => Math.round(Number(rupees) * 100);
const rupees = (value: number) => value / 100;
const inr = (value: number) =>
  `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 })}`;

/** Short customer-facing summary, e.g. "10% off up to ₹200 on orders over ₹999". */
export function describeCoupon(coupon: Pick<CouponRule, "discountType" | "value" | "maxDiscount" | "buyQuantity" | "getQuantity" | "minOrderAmount" | "appliesTo">) {
  let text: string;
  if (coupon.discountType === "PERCENT") {
    text = `${trimNumber(coupon.value)}% off${coupon.maxDiscount ? ` up to ${inr(coupon.maxDiscount)}` : ""}`;
  } else if (coupon.discountType === "FIXED") {
    text = `${inr(coupon.value)} off`;
  } else {
    const get = coupon.value >= 100 ? "free" : `at ${trimNumber(coupon.value)}% off`;
    text = `Buy ${coupon.buyQuantity ?? 1} get ${coupon.getQuantity ?? 1} ${get}`;
  }
  if (coupon.appliesTo !== "ALL") text += " on selected items";
  if (coupon.minOrderAmount) text += ` on orders over ${inr(coupon.minOrderAmount)}`;
  return text;
}

function trimNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function couponWindowState(coupon: Pick<CouponRule, "status" | "startsAt" | "endsAt">, now = new Date()): "ACTIVE" | "SCHEDULED" | "EXPIRED" | "PAUSED" | "ARCHIVED" {
  if (coupon.status === "ARCHIVED") return "ARCHIVED";
  if (coupon.status === "PAUSED") return "PAUSED";
  if (coupon.startsAt && new Date(coupon.startsAt) > now) return "SCHEDULED";
  if (coupon.endsAt && new Date(coupon.endsAt) <= now) return "EXPIRED";
  return "ACTIVE";
}

export function isLineEligible(coupon: Pick<CouponRule, "appliesTo" | "productIds" | "categoryIds">, line: CouponCartLine) {
  if (line.fromBundle || !line.productId || line.unitPrice <= 0) return false;
  if (coupon.appliesTo === "PRODUCTS") return coupon.productIds.includes(line.productId);
  if (coupon.appliesTo === "CATEGORIES") return (line.categoryIds ?? []).some((id) => coupon.categoryIds.includes(id));
  return true;
}

export function evaluateCoupon<T extends CouponCartLine>(
  coupon: CouponRule,
  input: { lines: T[]; preference: "PREPAID" | "COD"; now?: Date }
): CouponEvaluation<T> {
  const state = couponWindowState(coupon, input.now);
  if (state === "PAUSED" || state === "ARCHIVED") return reject("NOT_ACTIVE", "This coupon isn’t active.");
  if (state === "SCHEDULED") return reject("NOT_STARTED", "This coupon isn’t active yet.");
  if (state === "EXPIRED") return reject("EXPIRED", "This coupon has expired.");
  if (coupon.prepaidOnly && input.preference !== "PREPAID") return reject("PREPAID_ONLY", "This coupon works with prepaid orders only.");

  const amounts = input.lines.map((line) => paise(line.unitPrice) * line.quantity);
  const subtotal = amounts.reduce((sum, value) => sum + value, 0);
  const eligible = input.lines.map((line) => isLineEligible(coupon, line));
  const eligibleSubtotal = amounts.reduce((sum, value, index) => sum + (eligible[index] ? value : 0), 0);
  if (eligibleSubtotal <= 0) {
    return reject("NO_ELIGIBLE", coupon.appliesTo === "ALL" ? "This coupon can’t be used on bundles." : "This coupon doesn’t apply to items in your cart.");
  }
  if (coupon.minOrderAmount && eligibleSubtotal < paise(coupon.minOrderAmount)) {
    const short = paise(coupon.minOrderAmount) - eligibleSubtotal;
    return reject("MIN_ORDER", `Add ${inr(rupees(short))} more${coupon.appliesTo === "ALL" ? "" : " of eligible items"} to use this coupon.`);
  }

  // The order must keep a positive total, so the discount stops at least ₹1 short of the subtotal.
  const ceiling = subtotal - 100;
  if (ceiling <= 0) return reject("NO_ELIGIBLE", "This order is too small for a coupon.");

  let perLine: number[];
  if (coupon.discountType === "BUY_X_GET_Y") {
    const buy = coupon.buyQuantity ?? 1;
    const get = coupon.getQuantity ?? 1;
    const units = input.lines.flatMap((line, index) =>
      eligible[index] ? Array.from({ length: line.quantity }, () => ({ index, price: paise(line.unitPrice) })) : []
    );
    const groups = Math.floor(units.length / (buy + get));
    if (!groups) return reject("NEEDS_MORE_ITEMS", `Add ${buy + get - units.length} more eligible item${buy + get - units.length === 1 ? "" : "s"} to use this coupon.`);
    // Discount the cheapest units, as Shopify does.
    const discounted = [...units].sort((a, b) => a.price - b.price).slice(0, groups * get);
    perLine = input.lines.map(() => 0);
    for (const unit of discounted) perLine[unit.index] += Math.round((unit.price * Math.min(coupon.value, 100)) / 100);
    const total = perLine.reduce((sum, value) => sum + value, 0);
    if (total > ceiling) perLine = spread(Math.min(total, ceiling), perLine);
  } else {
    let target = coupon.discountType === "PERCENT" ? Math.round((eligibleSubtotal * coupon.value) / 100) : paise(coupon.value);
    if (coupon.discountType === "PERCENT" && coupon.maxDiscount) target = Math.min(target, paise(coupon.maxDiscount));
    target = Math.min(target, eligibleSubtotal, ceiling);
    perLine = spread(target, amounts.map((value, index) => (eligible[index] ? value : 0)));
  }

  const discount = perLine.reduce((sum, value) => sum + value, 0);
  if (discount <= 0) return reject("NO_ELIGIBLE", "This coupon doesn’t lower the price of your cart.");

  const lines = input.lines.flatMap((line, index) => splitLine(line, amounts[index] - perLine[index]));
  return {
    ok: true,
    discount: rupees(discount),
    subtotal: rupees(subtotal),
    eligibleSubtotal: rupees(eligibleSubtotal),
    total: rupees(subtotal - discount),
    lines,
    label: describeCoupon(coupon),
  };
}

function reject(reason: CouponRejection, message: string) {
  return { ok: false as const, reason, message };
}

/** Largest-remainder split of `total` paise across `weights`, never exceeding any weight. */
function spread(total: number, weights: number[]) {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const shares = weights.map((weight, index) => ({ index, amount: Math.floor((total * weight) / sum), remainder: (total * weight) % sum }));
  let remaining = total - shares.reduce((acc, share) => acc + share.amount, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    if (share.amount < weights[share.index]) {
      share.amount++;
      remaining--;
    }
  }
  return shares.map((share) => share.amount);
}

/** Re-expresses a line at a new total, splitting off units that carry the leftover paisa. */
function splitLine<T extends CouponCartLine>(line: T, amount: number): T[] {
  if (amount === paise(line.unitPrice) * line.quantity) return [line];
  const unit = Math.floor(amount / line.quantity);
  const extra = amount % line.quantity;
  return [
    ...(line.quantity > extra ? [{ ...line, quantity: line.quantity - extra, unitPrice: rupees(unit) }] : []),
    ...(extra ? [{ ...line, quantity: extra, unitPrice: rupees(unit + 1) }] : []),
  ];
}

/** Uppercase A-Z, 0-9, dash and underscore; what customers type is normalised the same way. */
export function normalizeCouponCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

export function generateCouponCode(prefix = "SAVE") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`.slice(0, 32);
}
