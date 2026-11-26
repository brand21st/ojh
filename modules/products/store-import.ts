import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { assertPublicHttpsUrl } from "@/lib/security/outbound-url";
import { slugify } from "@/modules/products/categories";
import { ALLOWED_PRODUCT_IMAGE_TYPES, MAX_PRODUCT_IMAGE_BYTES, MAX_PRODUCT_IMAGES } from "@/modules/products/images";

/**
 * Imports a merchant's catalogue (products + categories) from the store they connected on the
 * Integrations page. Existing SKUs are never touched, so the import is safe to run again: a re-run only
 * adds what is new. Work runs in time-boxed batches; the client keeps calling with `cursor` until done.
 */

export const IMPORT_SOURCES = ["shopify", "woocommerce"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const productImportSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  cursor: z.string().max(512).nullable().optional(),
  includeImages: z.boolean().default(true),
});

export type ProductImportInput = z.infer<typeof productImportSchema>;

export type RemoteCatalogItem = {
  /** Store variant id (Shopify variant, Woo product or "parent-variation"). */
  externalId: string;
  /** Store product id the variant belongs to. */
  externalProductId: string;
  name: string;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  description: string | null;
  weightGrams: number;
  box: { lengthCm: number; widthCm: number; heightCm: number } | null;
  /** Null when the store does not track stock (or did not share it); never overwrite PostBus then. */
  stock: number | null;
  imageUrls: string[];
  categories: string[];
  visible: boolean;
};

export type ProductImportResult = {
  source: ImportSource;
  created: number;
  skipped: number;
  failed: number;
  categoriesCreated: number;
  nextCursor: string | null;
  done: boolean;
  errors: string[];
};

const BATCH_TIME_BUDGET_MS = 35_000;
const PAGE_SIZE = 20;
const MAX_ERRORS = 5;

// ---------------------------------------------------------------- shared helpers

export function htmlToText(html: string | null | undefined) {
  if (!html) return null;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, 4000) : null;
}

function money(value: unknown) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A stable SKU when the store has none, so re-imports recognise the same item. */
export function fallbackSku(source: ImportSource, externalId: string) {
  const prefix = source === "shopify" ? "SHOPIFY" : "WOO";
  return `${prefix}-${externalId.replace(/[^A-Za-z0-9]+/g, "")}`.slice(0, 64);
}

function variantName(base: string, variant: string | null | undefined) {
  const label = clean(variant, 120);
  if (!label || /^default title$/i.test(label)) return base.slice(0, 200);
  return `${base} - ${label}`.slice(0, 200);
}

function boxOrNull(length: number | null, width: number | null, height: number | null) {
  if (length == null || width == null || height == null) return null;
  if (length <= 0 || width <= 0 || height <= 0) return null;
  if (length > 150 || width > 150 || height > 150) return null;
  return { lengthCm: length, widthCm: width, heightCm: height };
}

// ---------------------------------------------------------------- Shopify

const SHOPIFY_COLLECTIONS_QUERY = `#graphql
  query PostbusImportCollections($after: String) {
    collections(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { title }
    }
  }
`;

const SHOPIFY_PRODUCT_FIELDS = `
        id
        title
        status
        descriptionHtml
        productType
        media(first: 3) { nodes { ... on MediaImage { image { url } } } }
        collections(first: 10) { nodes { title } }
        variants(first: 50) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
            inventoryItem { measurement { weight { unit value } } }
          }
        }
`;

const SHOPIFY_PRODUCTS_QUERY = `#graphql
  query PostbusImportProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ${SHOPIFY_PRODUCT_FIELDS} }
    }
  }
`;

export const SHOPIFY_PRODUCT_QUERY = `#graphql
  query PostbusSyncProduct($id: ID!) {
    product(id: $id) { ${SHOPIFY_PRODUCT_FIELDS} }
  }
`;

export type ShopifyProductNode = {
  id: string;
  title?: string | null;
  status?: string | null;
  descriptionHtml?: string | null;
  productType?: string | null;
  media?: { nodes?: Array<{ image?: { url?: string | null } | null }> } | null;
  collections?: { nodes?: Array<{ title?: string | null }> } | null;
  variants?: {
    nodes?: Array<{
      id: string;
      title?: string | null;
      sku?: string | null;
      price?: string | null;
      compareAtPrice?: string | null;
      inventoryQuantity?: number | null;
      inventoryItem?: { measurement?: { weight?: { unit?: string | null; value?: number | null } | null } | null } | null;
    }>;
  } | null;
};

const SHOPIFY_WEIGHT_TO_GRAMS: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

export function gidTail(gid: string) {
  return gid.split("/").pop() ?? gid;
}

export function mapShopifyProduct(node: ShopifyProductNode): RemoteCatalogItem[] {
  const title = clean(node.title, 200) || "Untitled product";
  const description = htmlToText(node.descriptionHtml);
  const images = (node.media?.nodes ?? [])
    .map((media) => media?.image?.url ?? "")
    .filter((url): url is string => Boolean(url))
    .slice(0, MAX_PRODUCT_IMAGES);
  const categories = [
    ...(node.collections?.nodes ?? []).map((collection) => clean(collection.title, 80)),
    clean(node.productType, 80),
  ].filter(Boolean);
  const visible = (node.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
  const variants = node.variants?.nodes ?? [];
  const externalProductId = gidTail(node.id);
  return variants.map((variant) => {
    const externalId = gidTail(variant.id);
    const weight = variant.inventoryItem?.measurement?.weight;
    const factor = SHOPIFY_WEIGHT_TO_GRAMS[String(weight?.unit ?? "").toUpperCase()] ?? 0;
    const grams = weight?.value && factor ? Math.max(0, Math.round(weight.value * factor)) : 0;
    const price = money(variant.price) ?? 0;
    const compare = money(variant.compareAtPrice);
    return {
      externalId,
      externalProductId,
      name: variantName(title, variants.length > 1 ? variant.title : null),
      sku: clean(variant.sku, 64) || fallbackSku("shopify", externalId),
      price,
      compareAtPrice: compare != null && compare > price ? compare : null,
      description,
      weightGrams: grams,
      box: null,
      stock: typeof variant.inventoryQuantity === "number" ? Math.max(0, Math.trunc(variant.inventoryQuantity)) : null,
      imageUrls: images,
      categories: [...new Set(categories)],
      visible,
    };
  });
}

export async function shopifyClient(supabase: SupabaseClient, organizationId: string) {
  const { loadShopifyConnection, resolveShopifyAdminToken, shopifyReadyToSync } = await import("@/modules/shopify/orders");
  const row = await loadShopifyConnection(supabase, organizationId);
  if (!row || row.status !== "CONNECTED" || !shopifyReadyToSync(row) || !row.shop_domain) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Connect your Shopify store on the Integrations page first.");
  }
  const token = await resolveShopifyAdminToken(row);
  if (!token) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Shopify did not accept the saved connection. Reconnect Shopify and try again.");
  }
  const { shopifyAdminGraphql } = await import("@/modules/shopify/graphql/client");
  const shop = String(row.shop_domain);
  return <T,>(query: string, variables: Record<string, unknown>) => shopifyAdminGraphql<T>(shop, token, query, variables);
}

type CatalogPager = {
  /** All category names in the store (fetched on the first batch only). */
  categories: () => Promise<string[]>;
  page: (cursor: string | null) => Promise<{ items: RemoteCatalogItem[]; nextCursor: string | null }>;
};

async function shopifyPager(supabase: SupabaseClient, organizationId: string): Promise<CatalogPager> {
  const graphql = await shopifyClient(supabase, organizationId);
  return {
    async categories() {
      const names: string[] = [];
      let after: string | null = null;
      type CollectionsPage = {
        collections?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ title?: string | null }> };
      };
      for (let page = 0; page < 5; page += 1) {
        const response: { data: CollectionsPage } = await graphql<CollectionsPage>(SHOPIFY_COLLECTIONS_QUERY, { after });
        const data = response.data;
        for (const node of data.collections?.nodes ?? []) {
          const name = clean(node.title, 80);
          if (name) names.push(name);
        }
        const info: { hasNextPage?: boolean; endCursor?: string | null } | undefined = data.collections?.pageInfo;
        if (!info?.hasNextPage || !info.endCursor) break;
        after = info.endCursor;
      }
      return names;
    },
    async page(cursor) {
      const { data } = await graphql<{
        products?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: ShopifyProductNode[] };
      }>(SHOPIFY_PRODUCTS_QUERY, { first: PAGE_SIZE, after: cursor });
      const items = (data.products?.nodes ?? []).flatMap(mapShopifyProduct);
      const info = data.products?.pageInfo;
      return { items, nextCursor: info?.hasNextPage && info.endCursor ? info.endCursor : null };
    },
  };
}

// ---------------------------------------------------------------- WooCommerce

type WooImage = { src?: string | null };
type WooDimensions = { length?: string; width?: string; height?: string };

export type WooProductNode = {
  id: number;
  name?: string;
  sku?: string;
  status?: string;
  type?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  description?: string;
  short_description?: string;
  weight?: string;
  dimensions?: WooDimensions;
  stock_quantity?: number | null;
  images?: WooImage[];
  categories?: Array<{ name?: string }>;
};

export type WooVariationNode = {
  id: number;
  sku?: string;
  status?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  weight?: string;
  dimensions?: WooDimensions;
  stock_quantity?: number | null;
  image?: WooImage | null;
  attributes?: Array<{ name?: string; option?: string }>;
};

export type WooUnits = { weightUnit: string; dimensionUnit: string };

function wooPricing(item: { price?: string; regular_price?: string; sale_price?: string }) {
  const regular = money(item.regular_price);
  const sale = money(item.sale_price);
  const price = (sale != null && item.sale_price !== "" ? sale : null) ?? money(item.price) ?? regular ?? 0;
  const compare = regular != null && regular > price ? regular : null;
  return { price, compareAtPrice: compare };
}

export async function mapWooProduct(
  node: WooProductNode,
  units: WooUnits,
  variations: WooVariationNode[] = []
): Promise<RemoteCatalogItem[]> {
  const { normalizeWooLengthToCm, normalizeWooWeightToGrams } = await import("@/modules/woocommerce/units");
  const title = clean(htmlToText(node.name), 200) || "Untitled product";
  const description = htmlToText(node.description) ?? htmlToText(node.short_description);
  const images = (node.images ?? [])
    .map((image) => image?.src ?? "")
    .filter((src): src is string => Boolean(src))
    .slice(0, MAX_PRODUCT_IMAGES);
  const categories = [...new Set((node.categories ?? []).map((c) => clean(htmlToText(c.name), 80)).filter(Boolean))]
    .filter((name) => !/^uncategori[sz]ed$/i.test(name));
  const visible = (node.status ?? "publish") === "publish";
  const box = (dims: WooDimensions | undefined) =>
    boxOrNull(
      normalizeWooLengthToCm(dims?.length, units.dimensionUnit),
      normalizeWooLengthToCm(dims?.width, units.dimensionUnit),
      normalizeWooLengthToCm(dims?.height, units.dimensionUnit)
    );
  const parentWeight = normalizeWooWeightToGrams(node.weight, units.weightUnit) ?? 0;
  const parentBox = box(node.dimensions);

  if (node.type === "variable" && variations.length) {
    return variations.map((variation) => {
      const externalId = `${node.id}-${variation.id}`;
      const label = (variation.attributes ?? []).map((a) => clean(a.option, 60)).filter(Boolean).join(" / ");
      const variationImage = variation.image?.src ? [variation.image.src] : [];
      return {
        externalId,
        externalProductId: String(node.id),
        name: variantName(title, label),
        sku: clean(variation.sku, 64) || fallbackSku("woocommerce", externalId),
        ...wooPricing(variation),
        description,
        weightGrams: normalizeWooWeightToGrams(variation.weight, units.weightUnit) ?? parentWeight,
        box: box(variation.dimensions) ?? parentBox,
        stock: typeof variation.stock_quantity === "number" ? Math.max(0, Math.trunc(variation.stock_quantity)) : null,
        imageUrls: [...new Set([...variationImage, ...images])].slice(0, MAX_PRODUCT_IMAGES),
        categories,
        visible: visible && (variation.status ?? "publish") === "publish",
      };
    });
  }

  const externalId = String(node.id);
  return [
    {
      externalId,
      externalProductId: externalId,
      name: title,
      sku: clean(node.sku, 64) || fallbackSku("woocommerce", externalId),
      ...wooPricing(node),
      description,
      weightGrams: parentWeight,
      box: parentBox,
      stock: typeof node.stock_quantity === "number" ? Math.max(0, Math.trunc(node.stock_quantity)) : null,
      imageUrls: images,
      categories,
      visible,
    },
  ];
}

export async function wooClient(supabase: SupabaseClient, organizationId: string) {
  const { credentialsFromConnection, loadWooConnection } = await import("@/modules/woocommerce/connect");
  const { wooRequest } = await import("@/modules/woocommerce/client");
  const row = await loadWooConnection(supabase, organizationId);
  const creds = row?.status === "CONNECTED" ? credentialsFromConnection(row) : null;
  if (!row || !creds) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Connect your WooCommerce store on the Integrations page first.");
  }
  const units: WooUnits = {
    weightUnit: (row.weight_unit || "kg").toLowerCase(),
    dimensionUnit: (row.dimension_unit || "cm").toLowerCase(),
  };
  const request = <T,>(path: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}) =>
    wooRequest<T>(creds, path, init);
  /** Maps one store product, pulling its variations when it is a variable product. */
  async function itemsFor(node: WooProductNode) {
    let variations: WooVariationNode[] = [];
    if (node.type === "variable") {
      const listed = await request<WooVariationNode[]>(`/wp-json/wc/v3/products/${node.id}/variations`, {
        query: { per_page: "100" },
      });
      variations = listed.data ?? [];
    }
    return mapWooProduct(node, units, variations);
  }
  return { row, creds, units, request, itemsFor };
}

async function wooPager(supabase: SupabaseClient, organizationId: string): Promise<CatalogPager> {
  const { request: wooGet, itemsFor } = await wooClient(supabase, organizationId);
  return {
    async categories() {
      const names: string[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const result = await wooGet<Array<{ name?: string }>>("/wp-json/wc/v3/products/categories", {
          query: { per_page: "100", page: String(page), hide_empty: "false" },
        });
        for (const category of result.data ?? []) {
          const name = clean(htmlToText(category.name), 80);
          if (name && !/^uncategori[sz]ed$/i.test(name)) names.push(name);
        }
        const totalPages = Number(result.headers["x-wp-totalpages"]);
        if (!Number.isFinite(totalPages) || page >= totalPages) break;
      }
      return names;
    },
    async page(cursor) {
      const page = Math.max(1, Number(cursor) || 1);
      const result = await wooGet<WooProductNode[]>("/wp-json/wc/v3/products", {
        query: { per_page: String(PAGE_SIZE), page: String(page), orderby: "id", order: "asc", status: "any" },
      });
      const items: RemoteCatalogItem[] = [];
      for (const node of result.data ?? []) {
        items.push(...(await itemsFor(node)));
      }
      const totalPages = Number(result.headers["x-wp-totalpages"]);
      const more = Number.isFinite(totalPages) ? page < totalPages : (result.data ?? []).length === PAGE_SIZE;
      return { items, nextCursor: more ? String(page + 1) : null };
    },
  };
}

// ---------------------------------------------------------------- sources

export type ImportSourceSummary = {
  source: ImportSource;
  name: string;
  connected: boolean;
  storeLabel: string;
};

/** Which stores this workspace has connected, so the UI only offers those. */
export async function listProductImportSources(supabase: SupabaseClient, organizationId: string): Promise<ImportSourceSummary[]> {
  const [shopify, woo] = await Promise.all([
    (async () => {
      try {
        const { loadShopifyConnection, shopifyReadyToSync } = await import("@/modules/shopify/orders");
        const row = await loadShopifyConnection(supabase, organizationId);
        const connected = Boolean(row && row.status === "CONNECTED" && shopifyReadyToSync(row) && row.shop_domain);
        return { connected, storeLabel: connected ? String(row?.shop_domain ?? "") : "" };
      } catch {
        return { connected: false, storeLabel: "" };
      }
    })(),
    (async () => {
      const { data, error } = await supabase
        .from("woocommerce_connections")
        .select("status, store_host")
        .eq("organization_id", organizationId)
        .maybeSingle();
      const connected = !error && data?.status === "CONNECTED";
      return { connected, storeLabel: connected ? String(data?.store_host ?? "") : "" };
    })(),
  ]);
  return [
    { source: "shopify", name: "Shopify", ...shopify },
    { source: "woocommerce", name: "WooCommerce", ...woo },
  ];
}

// ---------------------------------------------------------------- writing to PostBus

export type CategoryIndex = Map<string, string>;

export async function loadCategoryIndex(supabase: SupabaseClient, organizationId: string): Promise<CategoryIndex> {
  const { data, error } = await supabase
    .from("product_categories")
    .select("id, name, slug")
    .eq("organization_id", organizationId);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const index: CategoryIndex = new Map();
  for (const row of data ?? []) {
    index.set(String(row.name).trim().toLowerCase(), String(row.id));
    index.set(`slug:${String(row.slug)}`, String(row.id));
  }
  return index;
}

export async function ensureCategories(
  supabase: SupabaseClient,
  organizationId: string,
  index: CategoryIndex,
  names: string[]
) {
  let created = 0;
  for (const raw of names) {
    const name = raw.trim().slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (index.has(key)) continue;
    const slug = slugify(name);
    const bySlug = index.get(`slug:${slug}`);
    if (bySlug) {
      index.set(key, bySlug);
      continue;
    }
    const { data, error } = await supabase
      .from("product_categories")
      .insert({ organization_id: organizationId, name, slug, active: true, sort_order: index.size })
      .select("id")
      .single();
    if (error || !data) {
      logError("products.import.category_failed", { organizationId, message: error?.message ?? "no row" });
      continue;
    }
    index.set(key, String(data.id));
    index.set(`slug:${slug}`, String(data.id));
    created += 1;
  }
  return created;
}

async function existingSkus(supabase: SupabaseClient, organizationId: string, skus: string[]) {
  if (!skus.length) return new Set<string>();
  const { data, error } = await supabase
    .from("products")
    .select("sku")
    .eq("organization_id", organizationId)
    .in("sku", [...new Set(skus)]);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return new Set((data ?? []).map((row) => String(row.sku).trim().toLowerCase()));
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Downloads a store image into a File, refusing private hosts, non-images and anything over 5 MB. */
export async function downloadProductImage(rawUrl: string, fetcher: typeof fetch = fetch): Promise<File | null> {
  try {
    const checked = await assertPublicHttpsUrl(rawUrl);
    const response = await fetcher(checked.url.toString(), { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_PRODUCT_IMAGE_TYPES.includes(type as (typeof ALLOWED_PRODUCT_IMAGE_TYPES)[number])) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PRODUCT_IMAGE_BYTES) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_PRODUCT_IMAGE_BYTES) return null;
    return new File([buffer], `import.${IMAGE_EXTENSIONS[type]}`, { type });
  } catch {
    return null;
  }
}

/** Remembers which store variant a PostBus product mirrors. Best effort: sync falls back to SKU. */
export async function recordStoreLink(
  supabase: SupabaseClient,
  organizationId: string,
  source: ImportSource,
  productId: string,
  item: Pick<RemoteCatalogItem, "externalId" | "externalProductId">
) {
  const { error } = await supabase.from("product_store_links").upsert(
    {
      organization_id: organizationId,
      product_id: productId,
      source,
      external_product_id: item.externalProductId.slice(0, 64),
      external_variant_id: item.externalId.slice(0, 64),
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,source,external_variant_id" }
  );
  if (error && error.code !== "PGRST205" && error.code !== "42P01") {
    logError("products.sync.link_failed", { organizationId, source, message: error.message });
  }
}

export async function uploadStoreImages(supabase: SupabaseClient, ctx: TenantContext, productId: string, urls: string[]) {
  const { uploadProductImage } = await import("@/modules/products/images");
  const files = await Promise.all(urls.slice(0, MAX_PRODUCT_IMAGES).map((url) => downloadProductImage(url)));
  for (const file of files) {
    if (!file) continue;
    try {
      await uploadProductImage(supabase, ctx, productId, file);
    } catch (error) {
      logError("products.import.image_failed", {
        organizationId: ctx.organizationId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

/** Creates a PostBus product from a store item, links it to the store and (optionally) copies photos. */
export async function createImportedProduct(
  supabase: SupabaseClient,
  ctx: TenantContext,
  source: ImportSource,
  item: RemoteCatalogItem,
  categoryIds: string[],
  includeImages: boolean
) {
  const { createProduct } = await import("@/modules/products/service");
  const product = await createProduct(supabase, ctx, {
    name: item.name,
    sku: item.sku,
    price: item.price,
    compareAtPrice: item.compareAtPrice,
    description: item.description,
    weightGrams: item.weightGrams,
    lengthCm: item.box?.lengthCm ?? null,
    widthCm: item.box?.widthCm ?? null,
    heightCm: item.box?.heightCm ?? null,
    openingStock: item.stock ?? 0,
    prepaidEnabled: true,
    codEnabled: true,
    returnAvailable: true,
    storeVisible: item.visible,
    categoryIds: categoryIds.length ? categoryIds.slice(0, 20) : undefined,
  });
  const productId = String(product.id);
  await recordStoreLink(supabase, ctx.organizationId, source, productId, item);
  if (includeImages && item.imageUrls.length) await uploadStoreImages(supabase, ctx, productId, item.imageUrls);
  return productId;
}

function friendlyError(error: unknown) {
  if (error instanceof AppError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/SHOPIFY_AUTH|rejected the app token/i.test(message)) return "Shopify rejected the saved connection. Reconnect Shopify and try again.";
  return message ? message.slice(0, 200) : "The store could not be reached. Try again shortly.";
}

/** One time-boxed batch of the import. Call again with `nextCursor` until `done` is true. */
export async function runProductImport(
  supabase: SupabaseClient,
  ctx: TenantContext,
  input: ProductImportInput,
  now: () => number = Date.now
): Promise<ProductImportResult> {
  const started = now();
  const pager = input.source === "shopify"
    ? await shopifyPager(supabase, ctx.organizationId)
    : await wooPager(supabase, ctx.organizationId);
  const result: ProductImportResult = {
    source: input.source,
    created: 0,
    skipped: 0,
    failed: 0,
    categoriesCreated: 0,
    nextCursor: input.cursor ?? null,
    done: false,
    errors: [],
  };
  const index = await loadCategoryIndex(supabase, ctx.organizationId);

  let cursor = input.cursor ?? null;
  try {
    if (!cursor) {
      // First batch: bring over every store category, even empty ones.
      result.categoriesCreated += await ensureCategories(supabase, ctx.organizationId, index, await pager.categories());
    }
    do {
      const page = await pager.page(cursor);
      result.categoriesCreated += await ensureCategories(
        supabase,
        ctx.organizationId,
        index,
        page.items.flatMap((item) => item.categories)
      );
      const taken = await existingSkus(supabase, ctx.organizationId, page.items.map((item) => item.sku));
      const seen = new Set<string>();
      for (const item of page.items) {
        const key = item.sku.trim().toLowerCase();
        if (taken.has(key) || seen.has(key)) {
          result.skipped += 1;
          continue;
        }
        seen.add(key);
        const categoryIds = [...new Set(item.categories.map((name) => index.get(name.trim().toLowerCase())).filter((id): id is string => Boolean(id)))];
        try {
          await createImportedProduct(supabase, ctx, input.source, item, categoryIds, input.includeImages);
          result.created += 1;
        } catch (error) {
          if (error instanceof AppError && error.code === ERROR_CODES.CONFLICT) {
            result.skipped += 1;
            continue;
          }
          result.failed += 1;
          if (result.errors.length < MAX_ERRORS) result.errors.push(`${item.name}: ${friendlyError(error)}`);
        }
      }
      cursor = page.nextCursor;
    } while (cursor && now() - started < BATCH_TIME_BUDGET_MS);
  } catch (error) {
    logError("products.import.batch_failed", {
      organizationId: ctx.organizationId,
      source: input.source,
      message: error instanceof Error ? error.message : "unknown",
    });
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, friendlyError(error));
  }

  result.nextCursor = cursor;
  result.done = !cursor;
  return result;
}
