import { z } from "zod";
import { COUPON_CODE_PATTERN, normalizeCouponCode } from "./engine";

const money = z.number().positive().max(10_000_000);
const optionalMoney = money.nullable().optional().transform((value) => value ?? null);
const optionalCount = z.number().int().positive().max(1_000_000).nullable().optional().transform((value) => value ?? null);
const optionalDate = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const couponCodeSchema = z
  .string()
  .transform(normalizeCouponCode)
  .refine((value) => COUPON_CODE_PATTERN.test(value), "Use 3–32 letters, numbers, dashes or underscores.");

export const couponInputSchema = z
  .object({
    code: couponCodeSchema,
    title: z.string().trim().max(80).nullable().optional().transform((value) => value || null),
    description: z.string().trim().max(160).nullable().optional().transform((value) => value || null),
    discountType: z.enum(["PERCENT", "FIXED", "BUY_X_GET_Y"]),
    value: money,
    maxDiscount: optionalMoney,
    appliesTo: z.enum(["ALL", "PRODUCTS", "CATEGORIES"]).default("ALL"),
    productIds: z.array(z.string().uuid()).max(200).default([]),
    categoryIds: z.array(z.string().uuid()).max(50).default([]),
    buyQuantity: z.number().int().min(1).max(20).nullable().optional().transform((value) => value ?? null),
    getQuantity: z.number().int().min(1).max(20).nullable().optional().transform((value) => value ?? null),
    minOrderAmount: z.number().min(0).max(10_000_000).nullable().optional().transform((value) => value || null),
    usageLimit: optionalCount,
    perCustomerLimit: optionalCount,
    firstOrderOnly: z.boolean().default(false),
    prepaidOnly: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    startsAt: optionalDate,
    endsAt: optionalDate,
    status: z.enum(["ACTIVE", "PAUSED"]).default("ACTIVE"),
  })
  .superRefine((value, ctx) => {
    if (value.discountType === "PERCENT" && value.value >= 100) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage must be below 100%." });
    }
    if (value.discountType === "BUY_X_GET_Y") {
      if (!value.buyQuantity || !value.getQuantity) ctx.addIssue({ code: "custom", path: ["buyQuantity"], message: "Set how many to buy and how many they get." });
      if (value.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "Discount on free items can’t exceed 100%." });
    }
    if (value.discountType !== "PERCENT" && value.maxDiscount) {
      ctx.addIssue({ code: "custom", path: ["maxDiscount"], message: "A cap only applies to percentage coupons." });
    }
    if (value.appliesTo === "PRODUCTS" && !value.productIds.length) ctx.addIssue({ code: "custom", path: ["productIds"], message: "Choose at least one product." });
    if (value.appliesTo === "CATEGORIES" && !value.categoryIds.length) ctx.addIssue({ code: "custom", path: ["categoryIds"], message: "Choose at least one category." });
    if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End date must be after the start date." });
    }
    if (value.usageLimit && value.perCustomerLimit && value.perCustomerLimit > value.usageLimit) {
      ctx.addIssue({ code: "custom", path: ["perCustomerLimit"], message: "Per-customer limit can’t exceed the total limit." });
    }
  });

export type CouponInput = z.infer<typeof couponInputSchema>;

export const couponStatusPatchSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) });

export const couponRangeSchema = z.enum(["7d", "30d", "90d", "all"]).default("30d");
