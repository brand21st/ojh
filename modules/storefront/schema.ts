import { z } from "zod";
import { RESERVED_STORE_SUBDOMAINS, STORE_SUBDOMAIN_PATTERN, isReservedStoreSubdomain } from "./host";
import { storeThemeSchema, storeTrackingSchema } from "./config";
import { bundleSelectionSchema } from "./bundle-pricing";
import type { PublicLinkRef } from "@/modules/customer-order-links/public";

/** NPCI VPA shape: handle@psp. Shared with the dashboard so it can flag mistakes before saving. */
export const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
/** 10-digit Indian mobile, optionally prefixed with +91 / 91 / 0. */
export const INDIAN_MOBILE = /^(?:\+?91|0)?[6-9]\d{9}$/;

export function storeLinkRef(parsed: { workspace?: string; token?: string; code?: string }): PublicLinkRef {
  if (parsed.token) return { kind: "token", token: parsed.token };
  return { kind: "path", workspace: parsed.workspace ?? "", publicId: parsed.code };
}

export const storeLinkFields = {
  workspace: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "This store link is not valid.")
    .optional(),
  token: z.string().trim().optional(),
  code: z.string().trim().optional(),
};

export const publicCouponLookupSchema = z
  .object({
    ...storeLinkFields,
    coupon: z.string().trim().min(1).max(40),
    /** "link" when the shopper arrived through a ?discount= magic link (counted once per session). */
    source: z.enum(["link", "manual"]).default("manual"),
    sessionId: z.string().trim().max(80).optional(),
  })
  .refine((value) => Boolean(value.workspace || value.token), { message: "This store link is not valid." });

export const publicStoreQuery = z.object(storeLinkFields).refine((value) => Boolean(value.workspace || value.token), {
  message: "This store link is not valid.",
});

export const publicCatalogQuery = z
  .object({
    ...storeLinkFields,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(48).default(12),
    q: z.string().trim().max(80).optional(),
    categoryId: z.string().uuid().optional(),
    sort: z.enum(["newest", "priceAsc", "priceDesc", "name"]).default("newest"),
    priceMin: z.coerce.number().min(0).optional(),
    priceMax: z.coerce.number().min(0).optional(),
    inStock: z.enum(["true", "false"]).optional(),
  })
  .refine((value) => Boolean(value.workspace || value.token), {
    message: "This store link is not valid.",
  });

export const publicProductQuery = z
  .object({
    ...storeLinkFields,
    id: z.string().uuid("Product not found."),
  })
  .refine((value) => Boolean(value.workspace || value.token), {
    message: "This store link is not valid.",
  });

export const publicStoreQuoteSchema = z
  .object({
    ...storeLinkFields,
    paymentPreference: z.enum(["PREPAID", "COD"]),
    couponCode: z.string().trim().max(40).optional().nullable(),
    /** When true the store's auto-apply coupon is skipped (customer removed it). */
    skipAutoCoupon: z.boolean().optional(),
    /** Set only by the explicit "Apply" action so re-quotes don't inflate the funnel. */
    trackCouponApply: z.boolean().optional(),
    bundles: bundleSelectionSchema,
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.coerce.number().int().min(1).max(99),
        })
      )
      .max(50),
  })
  .refine((value) => Boolean(value.workspace || value.token), {
    message: "This store link is not valid.",
  });

/** Path segments and words that would collide with app routes or read as PostBus-owned stores. */
/** Store slugs are `{slug}.postbus.in` hosts, so they also avoid every system and future PostBus name. */
export const RESERVED_STORE_ADDRESSES = RESERVED_STORE_SUBDOMAINS;

export const storeAddressSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Use at least 3 characters.")
    .max(48, "Use 48 characters or fewer.")
    .regex(STORE_SUBDOMAIN_PATTERN, "Use lowercase letters, numbers and single hyphens, like my-shop.")
    .refine((slug) => !isReservedStoreSubdomain(slug), "That address is reserved. Try another."),
});

export const storefrontSettingsSchema = z.object({
  theme: storeThemeSchema.optional(),
  tracking: storeTrackingSchema.optional(),
  storeName: z.string().trim().max(80).optional().nullable(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Use a hex color like #E11D48.")
    .optional()
    .nullable(),
  published: z.boolean().optional(),
  featuredProductIds: z.array(z.string().uuid()).max(24).optional(),
  seoTitle: z.string().trim().max(70).optional().nullable(),
  seoDescription: z.string().trim().max(180).optional().nullable(),
  footer: z.unknown().optional(),
  upiId: z
    .string()
    .trim()
    .max(80)
    .refine((value) => !value || UPI_ID.test(value), "Use a UPI ID like name@okbank.")
    .optional()
    .nullable(),
  gpayNumber: z
    .string()
    .trim()
    .max(20)
    .refine((value) => !value || INDIAN_MOBILE.test(value.replace(/[\s-]/g, "")), "Use a 10-digit Indian mobile number.")
    .optional()
    .nullable(),
  /** Only null is accepted: clears the logo. Uploads go through POST inventory/storefront/logo. */
  logoPath: z.null().optional(),
  /** Only null is accepted: clears the payment QR. Uploads go through POST inventory/storefront/qr. */
  qrImagePath: z.null().optional(),
  coverAutoplay: z.boolean().optional(),
  brandKit: z
    .object({
      secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      tone: z.enum(["premium", "friendly", "direct", "festive"]).optional(),
      ctaStyle: z.enum(["pill", "bar", "outline"]).optional(),
    })
    .optional(),
});

export function parseSafeCoverHref(value: string | null | undefined) {
  if (value == null) return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed.slice(0, 200);
  if (trimmed.startsWith("#")) return trimmed.slice(0, 200);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return trimmed.slice(0, 200);
  } catch {
    /* invalid */
  }
  return null;
}

const coverHref = z
  .string()
  .trim()
  .max(200)
  .optional()
  .nullable()
  .superRefine((value, ctx) => {
    if (value == null || value === "") return;
    if (parseSafeCoverHref(value) == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use a store path, #anchor, or http(s) link." });
    }
  });

const focalSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  })
  .optional()
  .nullable();

export const COVER_TYPES = [
  "homepage_hero",
  "promotional",
  "collection",
  "product_launch",
  "festival_offer",
  "brand_campaign",
  "mobile_hero",
  "custom",
] as const;

export const COVER_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

export const storefrontSlideSchema = z.object({
  title: z.string().trim().max(80).optional().nullable(),
  subtitle: z.string().trim().max(160).optional().nullable(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaHref: coverHref,
  enabled: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export const storefrontCoverSchema = storefrontSlideSchema.extend({
  name: z.string().trim().max(80).optional().nullable(),
  hook: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(240).optional().nullable(),
  offerBadge: z.string().trim().max(40).optional().nullable(),
  discountPercent: z.number().int().min(0).max(90).optional().nullable(),
  coverType: z.enum(COVER_TYPES).optional(),
  status: z.enum(COVER_STATUSES).optional(),
  textPosition: z.enum(["left", "center", "right"]).optional(),
  overlayStrength: z.number().int().min(0).max(80).optional(),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  desktopFocal: focalSchema,
  mobileFocal: focalSchema,
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  festival: z.string().trim().max(40).optional().nullable(),
  preset: z.string().trim().max(40).optional().nullable(),
  sourceAssetId: z.string().uuid().optional().nullable(),
  aiAssetId: z.string().uuid().optional().nullable(),
  desktopImagePath: z.string().trim().max(400).optional().nullable(),
  mobileImagePath: z.string().trim().max(400).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "End date must be after the start date.", path: ["endsAt"] });
  }
});

export const publicStoreEventSchema = z
  .object({
    ...storeLinkFields,
    eventType: z.enum([
      "PRODUCT_VIEW",
      "PRODUCT_CLICK",
      "ADD_TO_CART",
      "CART_OPENED",
      "CHECKOUT_STARTED",
      "PURCHASE",
      "COVER_IMPRESSION",
      "COVER_CLICK",
    ]),
    productId: z.string().uuid().optional(),
    slideId: z.string().uuid().optional(),
    quantity: z.coerce.number().int().min(1).max(99).optional(),
    value: z.coerce.number().min(0).max(10_000_000).optional(),
    sessionId: z.string().trim().max(100).optional(),
    device: z.enum(["desktop", "mobile", "unknown"]).optional(),
  })
  .refine((value) => Boolean(value.workspace || value.token), {
    message: "This store link is not valid.",
  })
  .superRefine((value, ctx) => {
    if ((value.eventType === "COVER_IMPRESSION" || value.eventType === "COVER_CLICK") && !value.slideId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Cover events need a slide id.", path: ["slideId"] });
    }
  });

