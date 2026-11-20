import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { normalizeStoreTheme, type StoreTheme } from "./config";
import { normalizeStorefrontFooterConfig, type StorefrontFooterConfig } from "./footer";
import { defaultSections, layoutTokensSchema, normalizeStoreLayout, storeLayoutSchema, type StoreLayout } from "./layout/schema";
import { BUSINESS_CATEGORY_IDS } from "./layout/themes";

/**
 * Store Builder draft = the layout plus the branding fields that used to autosave live
 * (footer, featured products). Publishing copies it to the columns the public store reads.
 */
export type StoreDraft = {
  layout: StoreLayout;
  footer: StorefrontFooterConfig;
  featuredProductIds: string[];
};

export type StoreBuilderState = {
  draft: StoreDraft;
  /** Null until the merchant saves a draft; the draft above is then derived from the live store. */
  draftUpdatedAt: string | null;
  publishedLayout: StoreLayout | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  businessCategory: string | null;
};

export type StoreLayoutVersion = {
  id: string;
  label: "published" | "before-store-builder" | "reverted-to-classic";
  publishedAt: string;
  publishedBy: string | null;
  themeId: string | null;
  sectionCount: number;
  accentColor: string | null;
};

export const storeDraftSchema = z.object({
  layout: z.unknown(),
  footer: z.unknown(),
  featuredProductIds: z.array(z.string().uuid()).max(24),
  /** Optimistic concurrency: the draftUpdatedAt the editor loaded. */
  expectedDraftUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const publishSchema = z.object({
  expectedDraftUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const businessCategorySchema = z.object({
  businessCategory: z.enum(BUSINESS_CATEGORY_IDS as [string, ...string[]]).nullable(),
});

const LEGACY_FONTS = new Set<StoreTheme["font"]>(["geist", "inter", "manrope"]);

/** The layout a store that never used the builder effectively has, built from its live columns. */
export function layoutFromLegacy(row: Record<string, unknown> | null): StoreLayout {
  const theme = normalizeStoreTheme(row?.theme);
  const accent = typeof row?.accent_color === "string" && /^#[0-9a-f]{6}$/i.test(row.accent_color) ? row.accent_color : "#E11D48";
  return storeLayoutSchema.parse({
    themeId: "classic",
    tokens: layoutTokensSchema.parse({ accent, secondary: theme.secondaryColor, font: theme.font, headingFont: theme.font }),
    sections: defaultSections(),
  });
}

/** Branding columns for the classic readers (checkout emails, classic store, footer). */
export function legacyColumnsFromDraft(draft: StoreDraft) {
  const font = LEGACY_FONTS.has(draft.layout.tokens.font as StoreTheme["font"]) ? (draft.layout.tokens.font as StoreTheme["font"]) : "geist";
  return {
    accentColor: draft.layout.tokens.accent.toUpperCase(),
    theme: { version: 1 as const, secondaryColor: draft.layout.tokens.secondary, font },
    footer: normalizeStorefrontFooterConfig(draft.footer),
    featuredProductIds: [...new Set(draft.featuredProductIds)],
  };
}

function draftFromRow(row: Record<string, unknown> | null): StoreDraft {
  const stored = row?.draft_layout as Record<string, unknown> | null | undefined;
  if (stored && typeof stored === "object") {
    const layout = normalizeStoreLayout(stored.layout);
    if (layout) {
      return {
        layout,
        footer: normalizeStorefrontFooterConfig(stored.footer),
        featuredProductIds: z.array(z.string().uuid()).max(24).catch([]).parse(stored.featuredProductIds),
      };
    }
  }
  return {
    layout: normalizeStoreLayout(row?.published_layout) ?? layoutFromLegacy(row),
    footer: normalizeStorefrontFooterConfig(row?.footer),
    featuredProductIds: Array.isArray(row?.featured_product_ids) ? (row.featured_product_ids as string[]) : [],
  };
}

function liveDraft(row: Record<string, unknown> | null): StoreDraft {
  return draftFromRow(row ? { ...row, draft_layout: null } : null);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function loadRow(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("storefront_settings")
    .select("organization_id, accent_color, theme, footer, featured_product_ids, draft_layout, published_layout, draft_updated_at, published_at, business_category, updated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

export async function getStoreBuilderState(supabase: SupabaseClient, ctx: TenantContext): Promise<StoreBuilderState> {
  const row = await loadRow(supabase, ctx.organizationId);
  const draft = draftFromRow(row);
  const live = liveDraft(row);
  const publishedLayout = normalizeStoreLayout(row?.published_layout);
  return {
    draft,
    draftUpdatedAt: (row?.draft_updated_at as string | null) ?? null,
    publishedLayout,
    publishedAt: (row?.published_at as string | null) ?? null,
    // A never-published store always has something to publish once a draft exists.
    hasUnpublishedChanges: Boolean(row?.draft_layout) && (!publishedLayout || !same(draft, live)),
    businessCategory: (row?.business_category as string | null) ?? null,
  };
}

async function assertOwnProducts(supabase: SupabaseClient, organizationId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const { count, error } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("id", unique);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if ((count ?? 0) !== unique.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One or more products were not found.");
}

async function assertOwnCategories(supabase: SupabaseClient, organizationId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const { count, error } = await supabase
    .from("product_categories")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("id", unique);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if ((count ?? 0) !== unique.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One or more categories were not found.");
}

/** Every product/category id a draft references must belong to this merchant. */
async function assertDraftReferences(supabase: SupabaseClient, organizationId: string, draft: StoreDraft) {
  const productIds = new Set(draft.featuredProductIds);
  const categoryIds = new Set<string>();
  for (const section of draft.layout.sections) {
    const settings = section.settings as Record<string, unknown>;
    if (section.type === "video_shopping") {
      for (const video of (settings.videos as Array<{ productIds: string[] }>) ?? []) video.productIds.forEach((id) => productIds.add(id));
    }
    if (section.type === "collection" && typeof settings.categoryId === "string") categoryIds.add(settings.categoryId);
    if (section.type === "category_grid") ((settings.categoryIds as string[]) ?? []).forEach((id) => categoryIds.add(id));
  }
  for (const link of draft.layout.header.menu) if (link.kind === "category") categoryIds.add(link.value);
  await Promise.all([
    assertOwnProducts(supabase, organizationId, [...productIds]),
    assertOwnCategories(supabase, organizationId, [...categoryIds].filter((id) => z.string().uuid().safeParse(id).success)),
  ]);
}

export function parseDraft(input: z.infer<typeof storeDraftSchema>): StoreDraft {
  const layout = normalizeStoreLayout(input.layout);
  if (!layout) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "The store layout is not valid.");
  return {
    layout,
    footer: normalizeStorefrontFooterConfig(input.footer),
    featuredProductIds: [...new Set(input.featuredProductIds)],
  };
}

function assertNotStale(row: Record<string, unknown> | null, expected: string | null | undefined) {
  if (expected === undefined) return;
  const current = (row?.draft_updated_at as string | null) ?? null;
  const toMs = (value: string | null) => (value ? new Date(value).getTime() : null);
  if (toMs(current) !== toMs(expected ?? null)) {
    throw new AppError(ERROR_CODES.CONFLICT, "Someone else changed this draft. Reload to see the latest version.");
  }
}

export async function saveStoreDraft(supabase: SupabaseClient, ctx: TenantContext, input: z.infer<typeof storeDraftSchema>) {
  const draft = parseDraft(input);
  await assertDraftReferences(supabase, ctx.organizationId, draft);
  const row = await loadRow(supabase, ctx.organizationId);
  assertNotStale(row, input.expectedDraftUpdatedAt);
  const { error } = await supabase
    .from("storefront_settings")
    .upsert(
      { organization_id: ctx.organizationId, draft_layout: draft, draft_updated_at: new Date().toISOString() },
      { onConflict: "organization_id" }
    );
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return getStoreBuilderState(supabase, ctx);
}

export async function discardStoreDraft(supabase: SupabaseClient, ctx: TenantContext) {
  const { error } = await supabase
    .from("storefront_settings")
    .update({ draft_layout: null, draft_updated_at: null })
    .eq("organization_id", ctx.organizationId);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return getStoreBuilderState(supabase, ctx);
}

function rpcError(error: { message: string; code?: string }): never {
  if (error.code === "40001") throw new AppError(ERROR_CODES.CONFLICT, error.message);
  if (error.code === "42501") throw new AppError(ERROR_CODES.FORBIDDEN, "You don't have permission to publish this store.");
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
}

export async function publishStoreDraft(supabase: SupabaseClient, ctx: TenantContext, input: z.infer<typeof publishSchema>) {
  const row = await loadRow(supabase, ctx.organizationId);
  if (!row?.draft_layout) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "There are no changes to publish.");
  assertNotStale(row, input.expectedDraftUpdatedAt);
  const draft = draftFromRow(row);
  // Re-check ownership at publish time: products may have been deleted since the draft was saved.
  await assertDraftReferences(supabase, ctx.organizationId, draft);
  const legacy = legacyColumnsFromDraft(draft);
  const { error } = await supabase.rpc("publish_storefront_layout", {
    p_organization_id: ctx.organizationId,
    p_layout: draft.layout,
    p_accent_color: legacy.accentColor,
    p_theme: legacy.theme,
    p_footer: legacy.footer,
    p_featured_product_ids: legacy.featuredProductIds,
    p_expected_draft_updated_at: row.draft_updated_at ?? null,
  });
  if (error) rpcError(error);
  // The draft now equals the live store; clear it so the editor starts from what customers see.
  await supabase.from("storefront_settings").update({ draft_layout: null, draft_updated_at: null }).eq("organization_id", ctx.organizationId);
  await supabase.from("audit_logs").insert({
    organization_id: ctx.organizationId,
    actor_id: ctx.userId,
    action: "storefront.layout_published",
    entity_type: "storefront_settings",
    entity_id: ctx.organizationId,
    after: { themeId: draft.layout.themeId, sections: draft.layout.sections.length },
  });
  return getStoreBuilderState(supabase, ctx);
}

/** Switches the live store back to the classic layout. Branding columns are kept as they are. */
export async function revertToClassicLayout(supabase: SupabaseClient, ctx: TenantContext) {
  const { error } = await supabase.rpc("publish_storefront_layout", {
    p_organization_id: ctx.organizationId,
    p_layout: null,
    p_accent_color: null,
    p_theme: null,
    p_footer: null,
    p_featured_product_ids: null,
    p_expected_draft_updated_at: null,
  });
  if (error) rpcError(error);
  return getStoreBuilderState(supabase, ctx);
}

export async function listStoreLayoutVersions(supabase: SupabaseClient, ctx: TenantContext): Promise<StoreLayoutVersion[]> {
  const { data, error } = await supabase
    .from("storefront_layout_versions")
    .select("id, label, snapshot, published_by, published_at")
    .eq("organization_id", ctx.organizationId)
    .order("published_at", { ascending: false })
    .limit(25);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return (data ?? []).map((row) => {
    const snapshot = (row.snapshot ?? {}) as Record<string, unknown>;
    const layout = normalizeStoreLayout(snapshot.layout);
    return {
      id: String(row.id),
      label: row.label as StoreLayoutVersion["label"],
      publishedAt: String(row.published_at),
      publishedBy: (row.published_by as string | null) ?? null,
      themeId: layout?.themeId ?? null,
      sectionCount: layout?.sections.length ?? 0,
      accentColor: (snapshot.accentColor as string | null) ?? null,
    };
  });
}

/** Copies a published version into the draft. The live store changes only when the merchant publishes. */
export async function restoreStoreLayoutVersion(supabase: SupabaseClient, ctx: TenantContext, versionId: string) {
  if (!z.string().uuid().safeParse(versionId).success) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Version not found.");
  const { data, error } = await supabase
    .from("storefront_layout_versions")
    .select("snapshot")
    .eq("organization_id", ctx.organizationId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Version not found.");
  const snapshot = (data.snapshot ?? {}) as Record<string, unknown>;
  const legacyRow = { accent_color: snapshot.accentColor, theme: snapshot.theme };
  const layout = normalizeStoreLayout(snapshot.layout) ?? layoutFromLegacy(legacyRow);
  const featured = z.array(z.string().uuid()).catch([]).parse(snapshot.featuredProductIds);
  // Products deleted since that version can't be featured any more.
  const { data: existing } = featured.length
    ? await supabase.from("products").select("id").eq("organization_id", ctx.organizationId).in("id", featured)
    : { data: [] as Array<{ id: string }> };
  const alive = new Set((existing ?? []).map((row) => String(row.id)));
  const draft: StoreDraft = {
    layout,
    footer: normalizeStorefrontFooterConfig(snapshot.footer),
    featuredProductIds: featured.filter((id) => alive.has(id)),
  };
  const { error: saveError } = await supabase
    .from("storefront_settings")
    .upsert({ organization_id: ctx.organizationId, draft_layout: draft, draft_updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (saveError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, saveError.message);
  return getStoreBuilderState(supabase, ctx);
}

export async function setBusinessCategory(supabase: SupabaseClient, ctx: TenantContext, input: z.infer<typeof businessCategorySchema>) {
  const { error } = await supabase
    .from("storefront_settings")
    .upsert({ organization_id: ctx.organizationId, business_category: input.businessCategory }, { onConflict: "organization_id" });
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return getStoreBuilderState(supabase, ctx);
}

export const storefrontAnalyticsRangeSchema = z.enum(["7d", "30d", "90d"]).catch("30d");

const FUNNEL = ["PRODUCT_VIEW", "ADD_TO_CART", "CHECKOUT_STARTED", "PURCHASE"] as const;

/** Shopper funnel and top products from storefront_events, scoped to this merchant. */
export async function storefrontAnalytics(supabase: SupabaseClient, ctx: TenantContext, range: z.infer<typeof storefrontAnalyticsRangeSchema>) {
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const counts = await Promise.all(
    FUNNEL.map(async (type) => {
      const { count, error } = await supabase
        .from("storefront_events")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ctx.organizationId)
        .eq("event_type", type)
        .gte("created_at", since);
      if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
      return [type, count ?? 0] as const;
    })
  );
  const { data: purchases, error: purchaseError } = await supabase
    .from("storefront_events")
    .select("event_type, value, product_id, created_at")
    .eq("organization_id", ctx.organizationId)
    .in("event_type", ["PURCHASE", "PRODUCT_VIEW"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (purchaseError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, purchaseError.message);
  const funnel = Object.fromEntries(counts) as Record<(typeof FUNNEL)[number], number>;
  let revenue = 0;
  const views = new Map<string, number>();
  const daily = new Map<string, { views: number; orders: number }>();
  for (const row of purchases ?? []) {
    const day = String(row.created_at).slice(0, 10);
    const bucket = daily.get(day) ?? { views: 0, orders: 0 };
    if (row.event_type === "PURCHASE") {
      revenue += Number(row.value ?? 0);
      bucket.orders += 1;
    } else if (row.product_id) {
      views.set(String(row.product_id), (views.get(String(row.product_id)) ?? 0) + 1);
      bucket.views += 1;
    }
    daily.set(day, bucket);
  }
  const topIds = [...views.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const { data: products } = topIds.length
    ? await supabase.from("products").select("id, name").eq("organization_id", ctx.organizationId).in("id", topIds.map(([id]) => id))
    : { data: [] as Array<{ id: string; name: string }> };
  const names = new Map((products ?? []).map((row) => [String(row.id), String(row.name)]));
  const series = [...Array(days).keys()].map((offset) => {
    const day = new Date(Date.now() - (days - 1 - offset) * 86_400_000).toISOString().slice(0, 10);
    return { day, ...(daily.get(day) ?? { views: 0, orders: 0 }) };
  });
  return {
    range,
    funnel,
    revenue: Math.round(revenue * 100) / 100,
    conversionRate: funnel.PRODUCT_VIEW ? Math.round((funnel.PURCHASE / funnel.PRODUCT_VIEW) * 10_000) / 100 : 0,
    topProducts: topIds.map(([id, count]) => ({ id, name: names.get(id) ?? "Deleted product", views: count })),
    series,
  };
}
