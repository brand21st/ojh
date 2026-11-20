import type { SupabaseClient } from "@supabase/supabase-js";
import { findAutoApplyCoupon, publicCouponSummary } from "@/modules/storefront/coupons/service";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { orIlike } from "@/lib/api/filters";
import { mapProductImageUrls } from "@/modules/products/images";
import { discountPercent } from "@/modules/storefront/pricing";
import { mapCategory } from "@/modules/products/categories";
import { listProductRecommendations } from "@/modules/products/recommendations";
import { eligibleCovers } from "@/modules/storefront/cover-model";
import { getStorefrontSettings } from "@/modules/storefront/service";
import type { PublicLinkRef } from "@/modules/customer-order-links/public";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { policyBodyForSlug, STORE_POLICY_SLUGS, STORE_POLICY_TITLES, type StorePolicySlug } from "@/modules/storefront/footer";
import { loadOrganizationPolicies } from "@/modules/vachat/policies";
import { env } from "@/lib/env";
import { listStoreBundles } from "./bundles";
import { allocateBundlePrices } from "./bundle-pricing";
import { storefrontOnlinePaymentProvider } from "@/modules/merchant-payments/checkout";
import { layoutCategoryRowIds, layoutCollectionCategoryIds, layoutProductIds, type LayoutSection, type StoreLayout } from "./layout/schema";

export function publicStoreClient() {
  if (!hasAdminClient()) {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "This store is temporarily unavailable.");
  }
  return createAdminClient();
}

export async function assertStorePublished(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase
    .from("storefront_settings")
    .select("published")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data?.published === false) {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Store temporarily unavailable.");
  }
}

async function organizationFromLink(supabase: SupabaseClient, ref: PublicLinkRef) {
  const { findPublicCollectionLink } = await import("@/modules/customer-order-links/public");
  const row = await findPublicCollectionLink(supabase, ref);
  if (!row || row.status !== "ACTIVE") {
    throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This store link is not valid.");
  }
  return row.organization_id;
}

function firstBalance(value: unknown) {
  if (!value) return 0;
  if (Array.isArray(value)) return Number(value[0]?.on_hand ?? 0);
  if (typeof value === "object" && value && "on_hand" in value) {
    return Number((value as { on_hand?: number }).on_hand ?? 0);
  }
  return 0;
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/** Decode HTML entities left in text pasted from Shopify or other HTML sources. React re-escapes on render. */
export function decodeTextEntities(value: string) {
  if (!value.includes("&")) return value;
  return value
    .replace(/&#(\d+);/g, (match, code: string) => safeCodePoint(Number(code)) ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => safeCodePoint(parseInt(code, 16)) ?? match)
    .replace(/&([a-z]+);/gi, (match, name: string) => (name.toLowerCase() === "amp" ? match : NAMED_ENTITIES[name.toLowerCase()] ?? match))
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(code: number) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

export function mapPublicProduct(row: Record<string, unknown>) {
  const price = Number(row.price ?? 0);
  const compareAt = row.compare_at_price == null ? null : Number(row.compare_at_price);
  const images = mapProductImageUrls(row.image_urls);
  const onHand = firstBalance(row.inventory_balances);
  return {
    id: String(row.id),
    name: decodeTextEntities(String(row.name)),
    sku: String(row.sku ?? ""),
    slug: String(row.public_slug ?? ""),
    description: typeof row.description === "string" ? decodeTextEntities(row.description) : null,
    price,
    compareAtPrice: compareAt != null && compareAt > price ? compareAt : null,
    discountPercent: discountPercent(price, compareAt),
    weightGrams: Number(row.weight_grams ?? 0),
    imageUrls: images.imageUrls,
    onHand,
    inStock: onHand > 0,
    prepaidEnabled: Boolean(row.prepaid_enabled),
    codEnabled: Boolean(row.cod_enabled),
    codAdvancePercent: Number(row.cod_advance_percent ?? 0),
    returnAvailable: row.return_available !== false,
    lowStockThreshold: Number(row.low_stock_threshold ?? 5),
    createdAt: String(row.created_at ?? ""),
  };
}

const PUBLIC_PRODUCT_SELECT =
  "id, name, sku, public_slug, price, compare_at_price, description, weight_grams, prepaid_enabled, cod_enabled, cod_advance_percent, return_available, low_stock_threshold, image_urls, created_at, inventory_balances(on_hand)";

async function publicBestSellerIds(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase.rpc("inventory_product_page", {
    p_organization_id: organizationId,
    p_from: "2000-01-01T00:00:00.000Z",
    p_to: new Date().toISOString(),
    p_best_seller: true,
    p_sort: "bestSeller",
    p_limit: 3,
    p_offset: 0,
  });
  return (data ?? [])
    .filter((row: { units_sold?: number | string }) => Number(row.units_sold ?? 0) > 0)
    .map((row: { product_id: string }) => String(row.product_id));
}

export async function loadPublicStorefront(supabase: SupabaseClient, ref: PublicLinkRef) {
  const organizationId = await organizationFromLink(supabase, ref);
  const settings = await getStorefrontSettings(supabase, {
    organizationId,
    userId: "",
    email: null,
    fullName: null,
    organizationName: "",
    role: "OWNER",
    permissions: [],
  });
  const { data: categories } = await supabase
    .from("product_categories")
    .select("id, organization_id, name, slug, description, image_path, sort_order, active, created_at, updated_at")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("sort_order", { ascending: true });

  const catalog = settings.published
    ? await listPublicProducts(supabase, organizationId, { page: 1, pageSize: 12 })
    : { items: [], page: 1, pageSize: 12, total: 0 };
  const featured = settings.published
    ? await loadPublicProductsByIds(supabase, organizationId, settings.featuredProductIds)
    : [];
  const layout = settings.published ? settings.publishedLayout : null;
  const marketplace = env.storefrontMarketplaceEnabled || Boolean(layout);
  const sectionProducts = layout
    ? await loadLayoutSectionProducts(supabase, organizationId, layout, (categories ?? []).map((row) => String(row.id)))
    : {};
  const autoCoupon = settings.published ? await findAutoApplyCoupon(supabase, organizationId) : null;
  const bundleRows = settings.published && marketplace ? await listStoreBundles(supabase, organizationId, true) : [];
  const bundleProducts = await loadPublicProductsByIds(supabase, organizationId, bundleRows.flatMap((bundle) => bundle.items.map((item) => item.productId)), 800);
  const bundles = bundleRows.flatMap((bundle) => {
    const components = bundle.items.map((item) => ({ ...item, product: bundleProducts.find((product) => product.id === item.productId) }));
    if (components.length < 2 || components.length > 8 || components.some((item) => !item.product || !item.product.inStock || item.product.onHand < item.quantity)) return [];
    try {
      const pricing = allocateBundlePrices(components.map((item) => ({ ...item, price: item.product!.price })), bundle.pricingMode, bundle.priceValue);
      return [{ ...bundle, ...pricing, components: components.map((item) => ({ product: item.product!, quantity: item.quantity })) }];
    } catch { return []; }
  });
  return {
    marketplace,
    layout,
    sectionProducts,
    whatsappPhone: layout?.whatsappButton.enabled ? settings.whatsappPhone : null,
    theme: settings.theme,
    tracking: settings.published && marketplace ? settings.tracking : undefined,
    bundles,
    published: settings.published,
    storeName: settings.storeName,
    logoUrl: settings.logoUrl,
    accentColor: settings.accentColor,
    seoTitle: settings.seoTitle,
    seoDescription: settings.seoDescription,
    slides: settings.published
      ? eligibleCovers(settings.slides.filter((slide) => slide.status !== "ARCHIVED"))
      : [],
    coverAutoplay: settings.coverAutoplay === true,
    categories: settings.published
      ? (categories ?? []).map((row) => mapCategory(row as Record<string, unknown>))
      : [],
    featuredProductIds: settings.published ? settings.featuredProductIds : [],
    products: { ...catalog, featured },
    workspace: settings.workspace,
    footer: settings.published ? settings.footerPreview ?? null : null,
    /** The store's auto-apply coupon, shown as a banner and applied at checkout. */
    promo: autoCoupon ? publicCouponSummary(autoCoupon) : null,
    ...(await (async () => {
      // Which of the merchant's own gateways takes online payment (Razorpay or Cashfree), if any.
      const provider = settings.published ? await storefrontOnlinePaymentProvider(supabase, organizationId) : null;
      return { onlinePayment: Boolean(provider), onlinePaymentProvider: provider };
    })()),
  };
}

/** Products for collection and video sections, keyed by section id, in one round trip per kind. */
export async function loadLayoutSectionProducts(supabase: SupabaseClient, organizationId: string, layout: StoreLayout, activeCategoryIds: string[] = []) {
  const result: Record<string, ReturnType<typeof mapPublicProduct>[]> = {};
  const collections = layout.sections
    .filter((section): section is LayoutSection<"collection"> => section.visible && section.type === "collection")
    .filter((section) => Boolean(section.settings.categoryId));
  const videoIds = layoutProductIds(layout);
  const rowCategories = layoutCategoryRowIds(layout, activeCategoryIds);
  const categoryIds = [...new Set([...layoutCollectionCategoryIds(layout), ...Object.values(rowCategories).flat()])];
  const { data: members } = categoryIds.length
    ? await supabase
        .from("product_category_members")
        .select("product_id, category_id")
        .eq("organization_id", organizationId)
        .in("category_id", categoryIds)
        .limit(600)
    : { data: [] as Array<{ product_id: string; category_id: string }> };
  const byCategory = new Map<string, string[]>();
  for (const row of members ?? []) {
    const list = byCategory.get(String(row.category_id)) ?? [];
    list.push(String(row.product_id));
    byCategory.set(String(row.category_id), list);
  }
  const wanted = [...new Set([
    ...videoIds,
    ...collections.flatMap((section) => (byCategory.get(section.settings.categoryId!) ?? []).slice(0, 40)),
    ...Object.values(rowCategories).flat().flatMap((id) => (byCategory.get(id) ?? []).slice(0, 24)),
  ])];
  const products = await loadPublicProductsByIds(supabase, organizationId, wanted, 300);
  const byId = new Map(products.map((product) => [product.id, product]));
  for (const section of collections) {
    result[section.id] = (byCategory.get(section.settings.categoryId!) ?? [])
      .map((id) => byId.get(id))
      .filter((product): product is ReturnType<typeof mapPublicProduct> => Boolean(product))
      .slice(0, section.settings.limit);
  }
  // Category rows: keyed "<sectionId>:<categoryId>", up to 8 in-stock-first products each.
  for (const [sectionId, ids] of Object.entries(rowCategories)) {
    for (const categoryId of ids) {
      const items = (byCategory.get(categoryId) ?? []).map((id) => byId.get(id)).filter((product): product is ReturnType<typeof mapPublicProduct> => Boolean(product));
      result[`${sectionId}:${categoryId}`] = [...items].sort((a, b) => Number(b.inStock) - Number(a.inStock)).slice(0, 8);
    }
  }
  for (const section of layout.sections) {
    if (!section.visible || section.type !== "video_shopping") continue;
    const ids = (section as LayoutSection<"video_shopping">).settings.videos.flatMap((video) => video.productIds);
    result[section.id] = [...new Set(ids)].map((id) => byId.get(id)).filter((product): product is ReturnType<typeof mapPublicProduct> => Boolean(product));
  }
  return result;
}

export async function listPublicProducts(
  supabase: SupabaseClient,
  organizationId: string,
  query: { page: number; pageSize: number; q?: string; categoryId?: string; sort?: string; priceMin?: number; priceMax?: number; inStock?: string }
) {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;
  let builder = supabase
    .from("products")
    .select(query.inStock === "true" ? PUBLIC_PRODUCT_SELECT.replace("inventory_balances(", "inventory_balances!inner(") : PUBLIC_PRODUCT_SELECT, { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("active", true)
    .eq("store_visible", true)
    .order(query.sort === "priceAsc" || query.sort === "priceDesc" ? "price" : query.sort === "name" ? "name" : "created_at", { ascending: query.sort === "priceAsc" || query.sort === "name" })
    .order("id")
    .range(from, to);
  if (query.priceMin !== undefined) builder = builder.gte("price", query.priceMin);
  if (query.priceMax !== undefined) builder = builder.lte("price", query.priceMax);
  if (query.inStock === "true") builder = builder.gt("inventory_balances.on_hand", 0);
  if (query.q) {
    const filter = orIlike(["name", "sku"], query.q);
    const { data: matchingCategories } = await supabase
      .from("product_categories")
      .select("id")
      .eq("organization_id", organizationId)
      .ilike("name", `%${query.q.replace(/[%_,]/g, "")}%`);
    const categoryIds = (matchingCategories ?? []).map((row) => String(row.id));
    let categoryProductIds: string[] = [];
    if (categoryIds.length) {
      const { data: members } = await supabase
        .from("product_category_members")
        .select("product_id")
        .eq("organization_id", organizationId)
        .in("category_id", categoryIds);
      categoryProductIds = [...new Set((members ?? []).map((row) => String(row.product_id)))];
    }
    const clauses = [filter, categoryProductIds.length ? `id.in.(${categoryProductIds.join(",")})` : null].filter(
      Boolean
    );
    if (clauses.length) builder = builder.or(clauses.join(","));
  }
  if (query.categoryId) {
    const { data: members } = await supabase
      .from("product_category_members")
      .select("product_id")
      .eq("organization_id", organizationId)
      .eq("category_id", query.categoryId);
    const ids = [...new Set((members ?? []).map((row) => String(row.product_id)))];
    if (!ids.length) return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    builder = builder.in("id", ids);
  }
  const { data, error, count } = await builder;
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const items = (data ?? []).map((row) => mapPublicProduct(row as unknown as Record<string, unknown>));
  const recs = await listProductRecommendations(
    supabase,
    organizationId,
    items.map((item) => item.id)
  );
  const { data: members } = items.length
    ? await supabase
        .from("product_category_members")
        .select("product_id, category_id")
        .eq("organization_id", organizationId)
        .in("product_id", items.map((item) => item.id))
    : { data: [] as Array<{ product_id: string; category_id: string }> };
  const categoriesByProduct = new Map<string, string[]>();
  for (const row of members ?? []) {
    const productId = String(row.product_id);
    const current = categoriesByProduct.get(productId) ?? [];
    current.push(String(row.category_id));
    categoriesByProduct.set(productId, current);
  }
  const relatedIds = [
    ...items.flatMap((item) => recs.get(item.id)?.upsellProductIds ?? []),
    ...items.flatMap((item) => recs.get(item.id)?.crossSellProductIds ?? []),
  ];
  const bestSellerIds = await publicBestSellerIds(supabase, organizationId);
  const [related, bestSellerProducts] = await Promise.all([
    loadPublicProductsByIds(supabase, organizationId, relatedIds),
    loadPublicProductsByIds(supabase, organizationId, bestSellerIds),
  ]);
  const bestSellerSet = new Set(bestSellerIds);
  return {
    items: items.map((item) => ({
      ...item,
      bestSeller: bestSellerSet.has(item.id),
      upsellIds: recs.get(item.id)?.upsellProductIds ?? [],
      crossSellIds: recs.get(item.id)?.crossSellProductIds ?? [],
      categoryIds: categoriesByProduct.get(item.id) ?? [],
    })),
    related: related.map((item) => ({ ...item, bestSeller: bestSellerSet.has(item.id) })),
    bestSellers: bestSellerProducts.map((item) => ({ ...item, bestSeller: true })),
    page: query.page,
    pageSize: query.pageSize,
    total: count ?? 0,
  };
}

export async function loadPublicProductsByIds(supabase: SupabaseClient, organizationId: string, ids: string[], limit = 24) {
  const unique = [...new Set(ids)].slice(0, limit);
  if (!unique.length) return [] as ReturnType<typeof mapPublicProduct>[];
  const { data } = await supabase
    .from("products")
    .select(PUBLIC_PRODUCT_SELECT)
    .eq("organization_id", organizationId)
    .eq("active", true)
    .eq("store_visible", true)
    .in("id", unique);
  // `.in()` returns rows in table order; keep the merchant's featured order.
  const rank = new Map(unique.map((id, index) => [id, index]));
  return (data ?? [])
    .map((row) => mapPublicProduct(row as Record<string, unknown>))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

export async function getPublicProduct(supabase: SupabaseClient, organizationId: string, id: string) {
  const { data, error } = await supabase
    .from("products")
    .select(PUBLIC_PRODUCT_SELECT)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("active", true)
    .eq("store_visible", true)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Product not found.");
  const mapped = mapPublicProduct(data as Record<string, unknown>);
  const recs = await listProductRecommendations(supabase, organizationId, [id]);
  const { data: members } = await supabase
    .from("product_category_members")
    .select("category_id")
    .eq("organization_id", organizationId)
    .eq("product_id", id);
  return {
    ...mapped,
    categoryIds: [...new Set((members ?? []).map((row) => String(row.category_id)))],
    upsellIds: recs.get(id)?.upsellProductIds ?? [],
    crossSellIds: recs.get(id)?.crossSellProductIds ?? [],
  };
}

export async function getPublicProductBySlug(
  supabase: SupabaseClient,
  organizationId: string,
  slug: string
) {
  const { data, error } = await supabase
    .from("products")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("public_slug", slug)
    .eq("active", true)
    .eq("store_visible", true)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Product not found.");
  return getPublicProduct(supabase, organizationId, String(data.id));
}

export function isStorePolicySlug(value: string): value is StorePolicySlug {
  return (STORE_POLICY_SLUGS as readonly string[]).includes(value);
}

export async function getPublicStorePolicy(supabase: SupabaseClient, workspace: string, slug: StorePolicySlug) {
  const store = await loadPublicStorefront(supabase, { kind: "path", workspace });
  const organizationId = await organizationFromLink(supabase, { kind: "path", workspace });
  const policies = await loadOrganizationPolicies(supabase, organizationId);
  const body = policyBodyForSlug(slug, policies);
  if (!body) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This policy is not published.");
  return {
    store,
    slug,
    title: STORE_POLICY_TITLES[slug],
    body,
  };
}

export { organizationFromLink };
