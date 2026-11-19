import { describe, expect, it } from "vitest";
import { describeCoupon, evaluateCoupon, normalizeCouponCode, type CouponCartLine, type CouponRule } from "./engine";

const base: CouponRule = {
  id: "c1",
  code: "SAVE10",
  title: null,
  description: null,
  discountType: "PERCENT",
  value: 10,
  maxDiscount: null,
  appliesTo: "ALL",
  productIds: [],
  categoryIds: [],
  buyQuantity: null,
  getQuantity: null,
  minOrderAmount: null,
  usageLimit: null,
  perCustomerLimit: null,
  firstOrderOnly: false,
  prepaidOnly: false,
  autoApply: false,
  startsAt: null,
  endsAt: null,
  status: "ACTIVE",
};

const lines: CouponCartLine[] = [
  { productId: "a", unitPrice: 499, quantity: 2, categoryIds: ["shirts"] },
  { productId: "b", unitPrice: 299, quantity: 1, categoryIds: ["caps"] },
];

const sum = (rows: CouponCartLine[]) => Math.round(rows.reduce((total, line) => total + line.unitPrice * line.quantity * 100, 0)) / 100;

describe("evaluateCoupon", () => {
  it("takes a percentage off and keeps line totals equal to the order total", () => {
    const result = evaluateCoupon(base, { lines, preference: "COD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subtotal).toBe(1297);
    expect(result.discount).toBe(129.7);
    expect(result.total).toBe(1167.3);
    expect(sum(result.lines)).toBe(result.total);
  });

  it("caps percentage discounts", () => {
    const result = evaluateCoupon({ ...base, maxDiscount: 50 }, { lines, preference: "PREPAID" });
    expect(result.ok && result.discount).toBe(50);
  });

  it("takes a fixed amount off but never makes the order free", () => {
    const result = evaluateCoupon({ ...base, discountType: "FIXED", value: 5000 }, { lines, preference: "PREPAID" });
    expect(result.ok && result.total).toBe(1);
  });

  it("limits discounts to selected products and categories", () => {
    const products = evaluateCoupon({ ...base, appliesTo: "PRODUCTS", productIds: ["b"] }, { lines, preference: "PREPAID" });
    expect(products.ok && products.discount).toBe(29.9);
    const categories = evaluateCoupon({ ...base, appliesTo: "CATEGORIES", categoryIds: ["shirts"] }, { lines, preference: "PREPAID" });
    expect(categories.ok && categories.discount).toBe(99.8);
    const none = evaluateCoupon({ ...base, appliesTo: "PRODUCTS", productIds: ["z"] }, { lines, preference: "PREPAID" });
    expect(none).toMatchObject({ ok: false, reason: "NO_ELIGIBLE" });
  });

  it("gives the cheapest items free in Buy X get Y", () => {
    const coupon = { ...base, discountType: "BUY_X_GET_Y" as const, value: 100, buyQuantity: 2, getQuantity: 1 };
    const result = evaluateCoupon(coupon, { lines, preference: "PREPAID" });
    expect(result.ok && result.discount).toBe(299);
    const short = evaluateCoupon(coupon, { lines: [lines[0]], preference: "PREPAID" });
    expect(short).toMatchObject({ ok: false, reason: "NEEDS_MORE_ITEMS" });
  });

  it("enforces prepaid-only, minimum order, dates and status", () => {
    expect(evaluateCoupon({ ...base, prepaidOnly: true }, { lines, preference: "COD" })).toMatchObject({ reason: "PREPAID_ONLY" });
    expect(evaluateCoupon({ ...base, minOrderAmount: 2000 }, { lines, preference: "COD" })).toMatchObject({ reason: "MIN_ORDER" });
    expect(evaluateCoupon({ ...base, endsAt: "2020-01-01T00:00:00Z" }, { lines, preference: "COD" })).toMatchObject({ reason: "EXPIRED" });
    expect(evaluateCoupon({ ...base, startsAt: "2999-01-01T00:00:00Z" }, { lines, preference: "COD" })).toMatchObject({ reason: "NOT_STARTED" });
    expect(evaluateCoupon({ ...base, status: "PAUSED" }, { lines, preference: "COD" })).toMatchObject({ reason: "NOT_ACTIVE" });
  });

  it("never discounts bundle lines", () => {
    const result = evaluateCoupon(base, { lines: [{ productId: "a", unitPrice: 400, quantity: 1, fromBundle: true }], preference: "COD" });
    expect(result).toMatchObject({ ok: false, reason: "NO_ELIGIBLE" });
  });

  it("splits odd paise across units without losing money", () => {
    const result = evaluateCoupon({ ...base, value: 33 }, { lines: [{ productId: "a", unitPrice: 100, quantity: 3 }], preference: "COD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sum(result.lines)).toBe(result.total);
    expect(result.lines.reduce((total, line) => total + line.quantity, 0)).toBe(3);
  });
});

describe("coupon helpers", () => {
  it("describes coupons for customers", () => {
    expect(describeCoupon({ ...base, maxDiscount: 200, minOrderAmount: 999 })).toBe("10% off up to ₹200 on orders over ₹999");
    expect(describeCoupon({ ...base, discountType: "BUY_X_GET_Y", value: 100, buyQuantity: 2, getQuantity: 1 })).toBe("Buy 2 get 1 free");
  });

  it("normalises typed codes", () => {
    expect(normalizeCouponCode(" save 10 ")).toBe("SAVE10");
  });
});
