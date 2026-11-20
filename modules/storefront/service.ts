import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeStoreTheme, normalizeStoreTracking } from "./config";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { env } from "@/lib/env";
import { mapProductImageUrls, productImagePublicUrl } from "@/modules/products/images";
import { getMerchantCollectionLink } from "@/modules/customer-order-links/service";
import { customerOrderLinkPath, customerOrderWorkspaceSlug } from "@/modules/customer-order-links/schema";
import type { z } from "zod";
import { assembleStoreFooter, normalizeStorefrontFooterConfig } from "@/modules/storefront/footer";
import { loadStoreFooterContext } from "@/modules/storefront/footer-context";
import { mapCover, selectOrgCovers } from "@/modules/storefront/covers";
import { storeAddressSchema, type storefrontSettingsSchema, type storefrontSlideSchema } from "@/modules/storefront/schema";
import { storeSubdomainSuffix, storeSubdomainUrl, storeSubdomainsEnabled } from "@/modules/storefront/host";
import { forgetStoreHost } from "@/modules/storefront/host-resolver";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { normalizeStoreLayout } from "@/modules/storefront/layout/schema";
import { extractIndiaMobileDigits } from "@/lib/phone/india-whatsapp";

type SettingsInput = z.infer<typeof storefrontSettingsSchema>;
type SlideInput = z.infer<typeof storefrontSlideSchema>;

const MAX_SLIDES = 8;

export function mapSlide(row: Record<string, unknown>) {
  return mapCover(row);
}

function storefrontUrls(workspace: string, publicId: string | null) {
  const storePath = `/store/${workspace}`;
  const legacyPath = publicId ? customerOrderLinkPath(workspace, publicId) : storePath;
  const origin = env.appUrl.replace(/\/$/, "");
  const subdomainsEnabled = storeSubdomainsEnabled();
  return {
    workspace,
    publicId,
    storePath,
    legacyPath,
    /** The address customers use: `https://{slug}.postbus.in` once subdomains are live. */
    storeUrl: subdomainsEnabled ? storeSubdomainUrl(workspace) : `${origin}${storePath}`,
    /** Always the subdomain form, so the dashboard can show it before the switch. */
    storeSubdomainUrl: storeSubdomainUrl(workspace),
    storeHostSuffix: storeSubdomainSuffix(),
    subdomainsEnabled,
    legacyUrl: `${origin}${legacyPath}`,
  };
}

export async function storefrontPublicPath(
  supabase: SupabaseClient,
  organizationId: string,
  ctx?: TenantContext | null
) {
  if (ctx?.userId) {
    const collection = await getMerchantCollectionLink(supabase, ctx);
    return storefrontUrls(collection.slug, collection.publicId);
  }
  const [{ data: org }, { data: link }] = await Promise.all([
    supabase.from("organizations").select("name, slug").eq("id", organizationId).maybeSingle(),
    supabase
      .from("customer_order_links")
      .select("public_workspace, public_code")
      .eq("organization_id", organizationId)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const workspace =
    (link?.public_workspace as string | undefined) ||
    customerOrderWorkspaceSlug((org?.name as string) ?? "store", org?.slug as string | null);
  const publicId = (link?.public_code as string | undefined) ?? "";
  return storefrontUrls(workspace, publicId || null);
}

export async function getStorefrontSettings(supabase: SupabaseClient, ctx: TenantContext) {
  const [{ data: settings, error: settingsError }, { data: slides }, link, { data: org }] = await Promise.all([
    supabase.from("storefront_settings").select("*").eq("organization_id", ctx.organizationId).maybeSingle(),
    selectOrgCovers(supabase, ctx.organizationId),
    storefrontPublicPath(supabase, ctx.organizationId, ctx),
    supabase.from("organizations").select("name").eq("id", ctx.organizationId).maybeSingle(),
  ]);
  // Showing defaults on a read error would let the next save overwrite real settings with them.
  if (settingsError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, settingsError.message);
  const featuredProductIds = Array.isArray(settings?.featured_product_ids)
    ? (settings?.featured_product_ids as string[])
    : [];
  const storeName = (settings?.store_name as string | null) || (org?.name as string | null) || "Store";
  const logoUrl = productImagePublicUrl(settings?.logo_path as string | null);
  const accentColor = (settings?.accent_color as string | null) || "#E11D48";
  const seoDescription = (settings?.seo_description as string | null) ?? null;
  const footerConfig = normalizeStorefrontFooterConfig(settings?.footer);
  const publishedLayout = normalizeStoreLayout(settings?.published_layout);
  const [{ data: categories }, footerContext, featuredProducts] = await Promise.all([
    supabase
      .from("product_categories")
      .select("name, slug, active")
      .eq("organization_id", ctx.organizationId)
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    loadStoreFooterContext(supabase, ctx.organizationId),
    loadFeaturedProductSummaries(supabase, ctx.organizationId, featuredProductIds),
  ]);
  const mappedCategories = (categories ?? []).map((row) => ({ name: String(row.name), slug: String(row.slug) }));
  const footerSources = {
    organization: footerContext.organization,
    email: footerContext.email,
    payments: footerContext.payments,
    policies: {
      privacyPolicyBody: footerContext.policies.privacyPolicyBody.trim() ? "." : "",
      privacyPolicyEnabled: footerContext.policies.privacyPolicyEnabled,
      termsBody: footerContext.policies.termsBody.trim() ? "." : "",
      termsEnabled: footerContext.policies.termsEnabled,
      shippingPolicyBody: footerContext.policies.shippingPolicyBody.trim() ? "." : "",
      shippingPolicyEnabled: footerContext.policies.shippingPolicyEnabled,
      returnsBody: footerContext.policies.returnsBody.trim() ? "." : "",
      returnsEnabled: footerContext.policies.returnsEnabled,
    },
  };
  const footerPreview = assembleStoreFooter(footerConfig, {
    storeName,
    logoUrl,
    tagline: seoDescription,
    accentColor,
    workspace: link.workspace,
    organization: footerContext.organization,
    email: footerContext.email,
    policies: footerContext.policies,
    categories: mappedCategories,
    hasProducts: true,
    hasBestSellers: true,
    payments: footerContext.payments,
  });
  return {
    storeName,
    logoUrl,
    logoPath: (settings?.logo_path as string | null) ?? null,
    theme: normalizeStoreTheme(settings?.theme),
    tracking: normalizeStoreTracking(settings?.tracking),
    accentColor,
    published: settings?.published !== false,
    seoTitle: (settings?.seo_title as string | null) ?? null,
    seoDescription,
    featuredProductIds,
    featuredProducts,
    slides: (Array.isArray(slides) ? slides : []).map((row) => mapSlide(row as Record<string, unknown>)),
    footer: footerConfig,
    footerPreview,
    footerSources,
    coverAutoplay: settings?.cover_autoplay === true,
    // Lets the dashboard preview render the same layout the public store uses.
    // A store published from the Store Builder always uses the marketplace renderer.
    marketplace: env.storefrontMarketplaceEnabled || Boolean(publishedLayout),
    /** Store Builder layout customers see. Null = the classic layout. Drafts are never exposed here. */
    publishedLayout,
    businessCategory: (settings?.business_category as string | null) ?? null,
    /** 10-digit WhatsApp number for the floating chat button, from the business profile. */
    whatsappPhone: footerContext.organization?.phone ? extractIndiaMobileDigits(footerContext.organization.phone) : null,
    brandKit: (settings?.brand_kit && typeof settings.brand_kit === "object" ? settings.brand_kit : {}) as Record<string, unknown>,
    upiId: (settings?.upi_id as string | null) ?? null,
    gpayNumber: (settings?.gpay_number as string | null) ?? null,
    qrImageUrl: productImagePublicUrl(settings?.qr_image_path as string | null),
    qrImagePath: (settings?.qr_image_path as string | null) ?? null,
    ...link,
  };
}

export type FeaturedProductSummary = {
  id: string;
  name: string;
  sku: string | null;
  imageUrl: string | null;
  /** False when the product is inactive, hidden from the store, or deleted: customers won't see it. */
  visible: boolean;
  missing: boolean;
};

/** Featured picks in the merchant's order, with enough detail to manage them without paging the catalog. */
export async function loadFeaturedProductSummaries(
  supabase: SupabaseClient,
  organizationId: string,
  ids: string[]
): Promise<FeaturedProductSummary[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("products")
    .select("id, name, sku, active, store_visible, image_urls")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const byId = new Map((data ?? []).map((row) => [String(row.id), row as Record<string, unknown>]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, name: "Deleted product", sku: null, imageUrl: null, visible: false, missing: true };
    return {
      id,
      name: String(row.name ?? ""),
      sku: (row.sku as string | null) ?? null,
      imageUrl: mapProductImageUrls(row.image_urls).imageUrls[0] ?? null,
      visible: row.active !== false && row.store_visible !== false,
      missing: false,
    };
  });
}

/** Best effort: a leftover file only costs storage, so never fail the request over it. */
async function removeStorefrontObject(supabase: SupabaseClient, organizationId: string, path: string | null | undefined) {
  if (!path || !path.startsWith(`${organizationId}/storefront/`)) return;
  try {
    await supabase.storage.from("product-images").remove([path]);
  } catch {
    /* ignore */
  }
}

export async function updateStorefrontSettings(
  supabase: SupabaseClient,
  ctx: TenantContext,
  input: SettingsInput
) {
  const patch: Record<string, unknown> = {
    organization_id: ctx.organizationId,
  };
  if (input.storeName !== undefined) patch.store_name = input.storeName?.trim() || null;
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.tracking !== undefined) {
    if (ctx.role !== "OWNER" && ctx.role !== "ADMIN") throw new AppError(ERROR_CODES.FORBIDDEN, "Only owners and admins can change tracking.");
    patch.tracking = input.tracking;
  }
  if (input.accentColor !== undefined) patch.accent_color = input.accentColor;
  if (input.published !== undefined) patch.published = input.published;
  if (input.seoTitle !== undefined) patch.seo_title = input.seoTitle?.trim() || null;
  if (input.seoDescription !== undefined) patch.seo_description = input.seoDescription?.trim() || null;
  if (input.footer !== undefined) patch.footer = normalizeStorefrontFooterConfig(input.footer);
  if (input.upiId !== undefined) patch.upi_id = input.upiId?.trim() || null;
  if (input.gpayNumber !== undefined) patch.gpay_number = input.gpayNumber?.trim() || null;
  if (input.coverAutoplay !== undefined) patch.cover_autoplay = input.coverAutoplay;
  if (input.brandKit !== undefined) patch.brand_kit = input.brandKit;
  const clearing = [
    input.logoPath === null ? "logo_path" : null,
    input.qrImagePath === null ? "qr_image_path" : null,
  ].filter((column): column is string => Boolean(column));
  let previousPaths: Array<string | null> = [];
  if (clearing.length) {
    const { data: current } = await supabase
      .from("storefront_settings")
      .select(clearing.join(", "))
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    previousPaths = clearing.map((column) => ((current as Record<string, unknown> | null)?.[column] as string | null) ?? null);
    for (const column of clearing) patch[column] = null;
  }
  if (input.featuredProductIds) {
    const unique = [...new Set(input.featuredProductIds)];
    if (unique.length) {
      const { count, error: featuredError } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .in("id", unique);
      if (featuredError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, featuredError.message);
      if ((count ?? 0) !== unique.length) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One or more featured products were not found.");
      }
    }
    patch.featured_product_ids = unique;
  }
  const { error } = await supabase.from("storefront_settings").upsert(patch, { onConflict: "organization_id" });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  await Promise.all(previousPaths.map((path) => removeStorefrontObject(supabase, ctx.organizationId, path)));
  return getStorefrontSettings(supabase, ctx);
}

function assertCanChangeStoreAddress(ctx: TenantContext) {
  if (ctx.role !== "OWNER" && ctx.role !== "ADMIN") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Only owners and admins can change the store address.");
  }
}

/** Store addresses share one namespace with the active customer order links (unique index on lower(public_workspace)). */
export async function checkStoreAddress(supabase: SupabaseClient, ctx: TenantContext, raw: unknown) {
  const parsed = storeAddressSchema.safeParse({ slug: raw });
  if (!parsed.success) {
    return { slug: String(raw ?? "").trim().toLowerCase(), available: false, reason: parsed.error.issues[0].message };
  }
  const slug = parsed.data.slug;
  // RLS hides other merchants' rows, so uniqueness must be read platform-wide.
  const reader = hasAdminClient() ? createAdminClient() : supabase;
  const [{ data, error }, { data: page, error: pageError }] = await Promise.all([
    reader
      .from("customer_order_links")
      .select("organization_id")
      .eq("status", "ACTIVE")
      .eq("public_workspace", slug)
      .limit(1)
      .maybeSingle(),
    // Tracking pages live on the same {slug}.postbus.in hosts.
    reader.from("tracking_pages").select("organization_id").eq("subdomain", slug).maybeSingle(),
  ]);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (pageError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, pageError.message);
  if ((data && data.organization_id !== ctx.organizationId) || (page && page.organization_id !== ctx.organizationId)) {
    return { slug, available: false, reason: "That address is already taken." };
  }
  return { slug, available: true, reason: null };
}

export async function updateStoreAddress(supabase: SupabaseClient, ctx: TenantContext, raw: unknown) {
  assertCanChangeStoreAddress(ctx);
  const { slug } = storeAddressSchema.parse({ slug: raw });
  const link = await getMerchantCollectionLink(supabase, ctx);
  if (link.slug === slug) return getStorefrontSettings(supabase, ctx);
  const availability = await checkStoreAddress(supabase, ctx, slug);
  if (!availability.available) throw new AppError(ERROR_CODES.CONFLICT, availability.reason ?? "That address is already taken.");
  const { error } = await supabase
    .from("customer_order_links")
    .update({ public_workspace: slug })
    .eq("id", link.id)
    .eq("organization_id", ctx.organizationId);
  if (error) {
    // Another merchant claimed it between the check and the update.
    if (error.code === "23505") throw new AppError(ERROR_CODES.CONFLICT, "That address is already taken.");
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  forgetStoreHost(link.slug, slug);
  await supabase.from("audit_logs").insert({
    organization_id: ctx.organizationId,
    actor_id: ctx.userId,
    action: "storefront.address_changed",
    entity_type: "customer_order_link",
    entity_id: link.id,
    before: { storeAddress: link.slug },
    after: { storeAddress: slug },
  });
  return getStorefrontSettings(supabase, ctx);
}

export async function uploadStorefrontAsset(
  supabase: SupabaseClient,
  ctx: TenantContext,
  file: File,
  kind: "logo" | "slide" | "qr"
) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Upload a PNG, JPEG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Images must be 5 MB or smaller.");
  }
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${ctx.organizationId}/storefront/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("product-images").upload(path, file, {
    upsert: false,
    contentType: file.type,
    cacheControl: "31536000",
  });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);

  if (kind === "logo" || kind === "qr") {
    const column = kind === "logo" ? "logo_path" : "qr_image_path";
    const { data: current } = await supabase
      .from("storefront_settings")
      .select(column)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    const { error: upsertError } = await supabase.from("storefront_settings").upsert(
      { organization_id: ctx.organizationId, [column]: path },
      { onConflict: "organization_id" }
    );
    if (upsertError) {
      await removeStorefrontObject(supabase, ctx.organizationId, path);
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, upsertError.message);
    }
    const previous = (current as Record<string, unknown> | null)?.[column] as string | null | undefined;
    if (previous && previous !== path) await removeStorefrontObject(supabase, ctx.organizationId, previous);
    return getStorefrontSettings(supabase, ctx);
  }

  const { count } = await supabase
    .from("storefront_slides")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId);
  if ((count ?? 0) >= MAX_SLIDES) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "You can add up to 8 cover slides.");
  }
  const { error: insertError } = await supabase.from("storefront_slides").insert({
    organization_id: ctx.organizationId,
    image_path: path,
    sort_order: count ?? 0,
    enabled: true,
  });
  if (insertError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, insertError.message);
  return getStorefrontSettings(supabase, ctx);
}

export async function updateStorefrontSlide(
  supabase: SupabaseClient,
  ctx: TenantContext,
  id: string,
  input: SlideInput
) {
  const { updateCover } = await import("@/modules/storefront/covers");
  await updateCover(supabase, ctx, id, input);
  return getStorefrontSettings(supabase, ctx);
}

export async function duplicateStorefrontSlide(
  supabase: SupabaseClient,
  ctx: TenantContext,
  id: string
) {
  const { duplicateCover } = await import("@/modules/storefront/covers");
  await duplicateCover(supabase, ctx, id);
  return getStorefrontSettings(supabase, ctx);
}

export async function deleteStorefrontSlide(supabase: SupabaseClient, ctx: TenantContext, id: string) {
  const { data, error } = await supabase
    .from("storefront_slides")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Slide not found.");
  return getStorefrontSettings(supabase, ctx);
}

export async function inventorySummary(supabase: SupabaseClient, ctx: TenantContext) {
  const org = ctx.organizationId;
  const [all, active, out, low] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", org),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("active", true),
    supabase
      .from("inventory_balances")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("on_hand", 0),
    supabase
      .from("inventory_balances")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .gt("on_hand", 0)
      .lte("on_hand", 5),
  ]);
  const { data: stockRows } = await supabase
    .from("inventory_balances")
    .select("on_hand")
    .eq("organization_id", org);
  const totalStock = (stockRows ?? []).reduce((sum, row) => sum + Number(row.on_hand ?? 0), 0);
  return {
    totalProducts: all.count ?? 0,
    activeProducts: active.count ?? 0,
    totalStock,
    lowStock: low.count ?? 0,
    outOfStock: out.count ?? 0,
  };
}
