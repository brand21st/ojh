import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError, logInfo } from "@/lib/logger";
import {
  IMPORT_SOURCES,
  SHOPIFY_PRODUCT_QUERY,
  createImportedProduct,
  ensureCategories,
  gidTail,
  loadCategoryIndex,
  mapShopifyProduct,
  recordStoreLink,
  shopifyClient,
  uploadStoreImages,
  wooClient,
  type ImportSource,
  type RemoteCatalogItem,
  type ShopifyProductNode,
  type WooProductNode,
} from "@/modules/products/store-import";

/**
 * Live sync between PostBus inventory and the merchant's connected store, switched on per store.
 *
 *  Store → PostBus: product create/update/delete webhooks (and Shopify inventory-level webhooks)
 *  re-read the product from the store and update the linked PostBus product. New store products are
 *  created here automatically. Stock is set to the store's absolute quantity, so repeats are no-ops.
 *
 *  PostBus → store: stock changes made in PostBus (manual adjustments, India Post booking commits)
 *  push the new on-hand quantity to the store. The store's echo webhook then carries the same number
 *  back, which is a no-op, so the two sides cannot loop.
 */

export const productSyncToggleSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  enabled: z.boolean(),
});

export type LiveSyncState = {
  enabled: boolean;
  available: boolean;
  lastEventAt: string | null;
  lastError: string | null;
};

const SOURCE_LABEL: Record<ImportSource, string> = { shopify: "Shopify", woocommerce: "WooCommerce" };

async function adminClient() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient();
}

function missingTable(error: { code?: string; message?: string } | null | undefined) {
  return Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || /product_store_sync_settings|product_store_links/.test(error.message ?? "")));
}

export function systemContext(organizationId: string): TenantContext {
  return {
    userId: "",
    email: null,
    fullName: null,
    organizationId,
    organizationName: "",
    role: "OWNER",
    permissions: [],
  } as TenantContext;
}

// ---------------------------------------------------------------- settings

export async function getLiveSyncStates(organizationId: string): Promise<Record<ImportSource, LiveSyncState>> {
  const off: LiveSyncState = { enabled: false, available: true, lastEventAt: null, lastError: null };
  const states: Record<ImportSource, LiveSyncState> = { shopify: { ...off }, woocommerce: { ...off } };
  const admin = await adminClient();
  const { data, error } = await admin
    .from("product_store_sync_settings")
    .select("source, enabled, last_event_at, last_error")
    .eq("organization_id", organizationId);
  if (error) {
    if (missingTable(error)) {
      states.shopify.available = false;
      states.woocommerce.available = false;
      return states;
    }
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  for (const row of data ?? []) {
    const source = row.source as ImportSource;
    if (!states[source]) continue;
    states[source] = {
      enabled: Boolean(row.enabled),
      available: true,
      lastEventAt: (row.last_event_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
    };
  }
  return states;
}

export async function isLiveSyncEnabled(organizationId: string, source: ImportSource) {
  try {
    return (await getLiveSyncStates(organizationId))[source].enabled;
  } catch {
    return false;
  }
}

async function noteSyncEvent(organizationId: string, source: ImportSource, lastError: string | null) {
  const admin = await adminClient();
  const { error } = await admin
    .from("product_store_sync_settings")
    .update({ last_event_at: new Date().toISOString(), last_error: lastError, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("source", source);
  if (error && !missingTable(error)) logError("products.sync.note_failed", { organizationId, source, message: error.message });
}

/** Switches live sync on/off for one store. Turning it on (re)registers the store's product webhooks. */
export async function setLiveSync(supabase: SupabaseClient, ctx: TenantContext, input: z.infer<typeof productSyncToggleSchema>) {
  const { listProductImportSources } = await import("@/modules/products/store-import");
  const summary = (await listProductImportSources(supabase, ctx.organizationId)).find((entry) => entry.source === input.source);
  if (input.enabled && !summary?.connected) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Connect ${SOURCE_LABEL[input.source]} on the Integrations page first.`);
  }

  let warning: string | null = null;
  if (input.enabled) {
    try {
      await registerProductWebhooks(supabase, ctx, input.source);
    } catch (error) {
      warning =
        error instanceof AppError
          ? error.message
          : `${SOURCE_LABEL[input.source]} did not accept the product webhooks. Reconnect the store and try again.`;
    }
  }

  const admin = await adminClient();
  const { error } = await admin.from("product_store_sync_settings").upsert(
    {
      organization_id: ctx.organizationId,
      source: input.source,
      enabled: input.enabled,
      last_error: warning,
      updated_by: ctx.userId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,source" }
  );
  if (error) {
    if (missingTable(error)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Live sync is not available yet. Ask PostBus support to finish the update.");
    }
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  }
  await supabase.from("audit_logs").insert({
    organization_id: ctx.organizationId,
    actor_id: ctx.userId || null,
    action: input.enabled ? "products.live_sync_enabled" : "products.live_sync_disabled",
    entity_type: "product_store_sync",
    entity_id: null,
    metadata: { source: input.source },
  });
  return { states: await getLiveSyncStates(ctx.organizationId), warning };
}

async function registerProductWebhooks(supabase: SupabaseClient, ctx: TenantContext, source: ImportSource) {
  if (source === "woocommerce") {
    // Re-installs every PostBus webhook on the store, now including the product topics.
    const { registerWooWebhooks } = await import("@/modules/woocommerce/connect");
    await registerWooWebhooks(supabase, ctx);
    return;
  }
  const { loadShopifyConnection, resolveShopifyAdminToken, registerShopifyOrderWebhooks } = await import("@/modules/shopify/orders");
  const { isAppInstallationConnection } = await import("@/modules/shopify/token-source");
  const row = await loadShopifyConnection(supabase, ctx.organizationId);
  // App Store installs get their webhooks from shopify.app.toml; only bring-your-own-app shops register here.
  if (!row?.shop_domain || isAppInstallationConnection(row)) return;
  const token = await resolveShopifyAdminToken(row);
  if (!token) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Shopify did not accept the saved connection. Reconnect Shopify.");
  await registerShopifyOrderWebhooks(String(row.shop_domain), token);
}

// ---------------------------------------------------------------- store → PostBus

type ProductRow = { id: string; sku: string };

async function linkedProductId(supabase: SupabaseClient, organizationId: string, source: ImportSource, externalVariantId: string) {
  const { data, error } = await supabase
    .from("product_store_links")
    .select("product_id")
    .eq("organization_id", organizationId)
    .eq("source", source)
    .eq("external_variant_id", externalVariantId)
    .maybeSingle();
  if (error) return null;
  return data?.product_id ? String(data.product_id) : null;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function productBySku(supabase: SupabaseClient, organizationId: string, sku: string): Promise<ProductRow | null> {
  const { data } = await supabase
    .from("products")
    .select("id, sku")
    .eq("organization_id", organizationId)
    .ilike("sku", escapeLike(sku.trim()))
    .limit(1)
    .maybeSingle();
  return data ? { id: String(data.id), sku: String(data.sku) } : null;
}

async function findProductFor(supabase: SupabaseClient, organizationId: string, source: ImportSource, item: Pick<RemoteCatalogItem, "externalId" | "sku">) {
  return (await linkedProductId(supabase, organizationId, source, item.externalId)) ?? (await productBySku(supabase, organizationId, item.sku))?.id ?? null;
}

/** Sets PostBus on-hand stock to the store's quantity. Never drops below what PostBus has reserved. */
export async function setStockFromStore(
  supabase: SupabaseClient,
  organizationId: string,
  productId: string,
  target: number,
  source: ImportSource
) {
  const { data } = await supabase
    .from("inventory_balances")
    .select("on_hand, reserved")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .maybeSingle();
  const onHand = Number(data?.on_hand ?? 0);
  const reserved = Number(data?.reserved ?? 0);
  const next = Math.max(Math.trunc(target), reserved, 0);
  const delta = next - onHand;
  if (delta === 0) return 0;
  const { error } = await supabase.rpc("adjust_inventory", {
    p_organization_id: organizationId,
    p_product_id: productId,
    p_quantity_delta: delta,
    p_reason: "ADJUSTMENT",
    p_note: `Synced from ${SOURCE_LABEL[source]}`,
    p_created_by: null,
    p_order_id: null,
    p_order_line_item_id: null,
  });
  if (error) throw new Error(error.message);
  return delta;
}

async function addCategories(supabase: SupabaseClient, organizationId: string, productId: string, categoryIds: string[]) {
  if (!categoryIds.length) return;
  const { data } = await supabase
    .from("product_category_members")
    .select("category_id")
    .eq("organization_id", organizationId)
    .eq("product_id", productId);
  const have = new Set((data ?? []).map((row) => String(row.category_id)));
  const missing = categoryIds.filter((id) => !have.has(id));
  if (!missing.length) return;
  await supabase.from("product_category_members").insert(
    missing.map((categoryId) => ({ organization_id: organizationId, product_id: productId, category_id: categoryId }))
  );
}

/** Store details win: name, price, description, visibility and parcel data follow the store. */
export function storeDetailsPatch(item: RemoteCatalogItem) {
  const patch: Record<string, unknown> = {
    name: item.name,
    price: item.price,
    compare_at_price: item.compareAtPrice,
    description: item.description,
    store_visible: item.visible,
    active: true,
  };
  if (item.weightGrams > 0) patch.weight_grams = item.weightGrams;
  if (item.box) {
    patch.length_cm = item.box.lengthCm;
    patch.width_cm = item.box.widthCm;
    patch.height_cm = item.box.heightCm;
  }
  return patch;
}

export type ApplyResult = { created: number; updated: number; stockChanged: number };

/** Creates or updates PostBus products for every variant of one store product. */
export async function applyStoreItems(
  supabase: SupabaseClient,
  organizationId: string,
  source: ImportSource,
  items: RemoteCatalogItem[]
): Promise<ApplyResult> {
  const ctx = systemContext(organizationId);
  const result: ApplyResult = { created: 0, updated: 0, stockChanged: 0 };
  if (!items.length) return result;
  const index = await loadCategoryIndex(supabase, organizationId);
  await ensureCategories(supabase, organizationId, index, items.flatMap((item) => item.categories));

  for (const item of items) {
    const categoryIds = [
      ...new Set(item.categories.map((name) => index.get(name.trim().toLowerCase())).filter((id): id is string => Boolean(id))),
    ];
    const existing = await findProductFor(supabase, organizationId, source, item);
    if (!existing) {
      await createImportedProduct(supabase, ctx, source, item, categoryIds, true);
      result.created += 1;
      continue;
    }
    const patch = storeDetailsPatch(item);
    const { error } = await supabase.from("products").update(patch).eq("organization_id", organizationId).eq("id", existing);
    if (error) throw new Error(error.message);
    // A SKU edited in the store follows along when it does not clash with another PostBus product.
    await supabase.from("products").update({ sku: item.sku }).eq("organization_id", organizationId).eq("id", existing).neq("sku", item.sku);
    await addCategories(supabase, organizationId, existing, categoryIds);
    await recordStoreLink(supabase, organizationId, source, existing, item);
    if (item.imageUrls.length) {
      const { data } = await supabase.from("products").select("image_urls").eq("id", existing).maybeSingle();
      const images = Array.isArray(data?.image_urls) ? data.image_urls : [];
      if (!images.length) await uploadStoreImages(supabase, ctx, existing, item.imageUrls);
    }
    if (item.stock != null && (await setStockFromStore(supabase, organizationId, existing, item.stock, source)) !== 0) {
      result.stockChanged += 1;
    }
    result.updated += 1;
  }
  return result;
}

/** A product removed from the store is hidden in PostBus (never deleted: orders may reference it). */
export async function hideStoreProduct(supabase: SupabaseClient, organizationId: string, source: ImportSource, externalProductId: string) {
  const { data } = await supabase
    .from("product_store_links")
    .select("product_id")
    .eq("organization_id", organizationId)
    .eq("source", source)
    .eq("external_product_id", externalProductId);
  const ids = (data ?? []).map((row) => String(row.product_id));
  if (!ids.length) return 0;
  await supabase.from("products").update({ active: false, store_visible: false }).eq("organization_id", organizationId).in("id", ids);
  return ids.length;
}

// Shopify -----------------------------------------------------------------------------------------

const SHOPIFY_INVENTORY_ITEM_QUERY = `#graphql
  query PostbusSyncInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      sku
      variant { id product { id } }
      inventoryLevels(first: 50) { nodes { quantities(names: ["available"]) { name quantity } } }
    }
  }
`;

type InventoryLevelNode = { location?: { id: string } | null; quantities?: Array<{ name?: string; quantity?: number | null }> | null };

export function sumAvailable(levels: InventoryLevelNode[] | null | undefined) {
  return (levels ?? []).reduce((total, level) => {
    const available = (level.quantities ?? []).find((entry) => entry.name === "available")?.quantity;
    return total + (typeof available === "number" ? available : 0);
  }, 0);
}

export const SHOPIFY_PRODUCT_SYNC_TOPICS = new Set(["products/create", "products/update", "products/delete", "inventory_levels/update"]);

/** Applies one Shopify product or inventory webhook. Safe to call for any shop; ignored while sync is off. */
export async function handleShopifyProductWebhook(
  supabase: SupabaseClient,
  input: { organizationId: string; topic: string; payload: Record<string, unknown> }
) {
  if (!SHOPIFY_PRODUCT_SYNC_TOPICS.has(input.topic)) return { ignored: true, reason: "topic" };
  if (!(await isLiveSyncEnabled(input.organizationId, "shopify"))) return { ignored: true, reason: "sync_off" };
  try {
    if (input.topic === "products/delete") {
      const hidden = await hideStoreProduct(supabase, input.organizationId, "shopify", String(input.payload.id ?? ""));
      await noteSyncEvent(input.organizationId, "shopify", null);
      return { hidden };
    }
    const graphql = await shopifyClient(supabase, input.organizationId);
    if (input.topic === "inventory_levels/update") {
      const itemId = String(input.payload.inventory_item_id ?? "");
      if (!itemId) return { ignored: true, reason: "no_item" };
      const { data } = await graphql<{
        inventoryItem?: {
          sku?: string | null;
          variant?: { id: string; product?: { id: string } | null } | null;
          inventoryLevels?: { nodes?: InventoryLevelNode[] } | null;
        } | null;
      }>(SHOPIFY_INVENTORY_ITEM_QUERY, { id: `gid://shopify/InventoryItem/${itemId}` });
      const inventoryItem = data.inventoryItem;
      if (!inventoryItem?.variant) return { ignored: true, reason: "no_variant" };
      const variantId = gidTail(inventoryItem.variant.id);
      const productId = await findProductFor(supabase, input.organizationId, "shopify", {
        externalId: variantId,
        sku: inventoryItem.sku || `SHOPIFY-${variantId}`,
      });
      if (!productId) {
        // Not in PostBus yet: pull the whole product so it arrives with its stock.
        if (inventoryItem.variant.product?.id) return syncShopifyProduct(supabase, input.organizationId, graphql, inventoryItem.variant.product.id);
        return { ignored: true, reason: "unknown_product" };
      }
      const delta = await setStockFromStore(supabase, input.organizationId, productId, sumAvailable(inventoryItem.inventoryLevels?.nodes), "shopify");
      await noteSyncEvent(input.organizationId, "shopify", null);
      return { stockDelta: delta };
    }
    const gid = String(input.payload.admin_graphql_api_id ?? `gid://shopify/Product/${input.payload.id ?? ""}`);
    return syncShopifyProduct(supabase, input.organizationId, graphql, gid);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shopify product sync failed.";
    logError("products.sync.shopify_failed", { organizationId: input.organizationId, topic: input.topic, message });
    await noteSyncEvent(input.organizationId, "shopify", message.slice(0, 300));
    throw error;
  }
}

async function syncShopifyProduct(
  supabase: SupabaseClient,
  organizationId: string,
  graphql: Awaited<ReturnType<typeof shopifyClient>>,
  productGid: string
) {
  const { data } = await graphql<{ product?: ShopifyProductNode | null }>(SHOPIFY_PRODUCT_QUERY, { id: productGid });
  if (!data.product) return { ignored: true, reason: "missing_product" };
  const result = await applyStoreItems(supabase, organizationId, "shopify", mapShopifyProduct(data.product));
  await noteSyncEvent(organizationId, "shopify", null);
  logInfo("products.sync.shopify", { organizationId, ...result });
  return result;
}

// WooCommerce -------------------------------------------------------------------------------------

export function isWooProductTopic(topic: string) {
  return topic.startsWith("product.");
}

/** Applies one WooCommerce product webhook (product.created / updated / deleted / restored). */
export async function handleWooProductWebhook(
  supabase: SupabaseClient,
  input: { organizationId: string; topic: string; productId: string }
) {
  if (!(await isLiveSyncEnabled(input.organizationId, "woocommerce"))) return { ignored: true, reason: "sync_off" };
  try {
    if (input.topic === "product.deleted") {
      const hidden = await hideStoreProduct(supabase, input.organizationId, "woocommerce", input.productId);
      await noteSyncEvent(input.organizationId, "woocommerce", null);
      return { hidden };
    }
    const woo = await wooClient(supabase, input.organizationId);
    let { data: node } = await woo.request<WooProductNode & { parent_id?: number }>(`/wp-json/wc/v3/products/${encodeURIComponent(input.productId)}`);
    // A variation's webhook carries the variation; sync its parent so every sibling stays aligned.
    if (node?.type === "variation" && node.parent_id) {
      node = (await woo.request<WooProductNode>(`/wp-json/wc/v3/products/${node.parent_id}`)).data;
    }
    if (!node) return { ignored: true, reason: "missing_product" };
    if (node.status === "trash") {
      const hidden = await hideStoreProduct(supabase, input.organizationId, "woocommerce", String(node.id));
      return { hidden };
    }
    const result = await applyStoreItems(supabase, input.organizationId, "woocommerce", await woo.itemsFor(node));
    await noteSyncEvent(input.organizationId, "woocommerce", null);
    logInfo("products.sync.woocommerce", { organizationId: input.organizationId, ...result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "WooCommerce product sync failed.";
    logError("products.sync.woocommerce_failed", { organizationId: input.organizationId, topic: input.topic, message });
    await noteSyncEvent(input.organizationId, "woocommerce", message.slice(0, 300));
    throw error;
  }
}

// ---------------------------------------------------------------- PostBus → store

const SHOPIFY_VARIANT_STOCK_QUERY = `#graphql
  query PostbusVariantStock($id: ID!) {
    productVariant(id: $id) {
      id
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 20) { nodes { location { id } quantities(names: ["available"]) { name quantity } } }
      }
    }
  }
`;

const SHOPIFY_VARIANT_BY_SKU_QUERY = `#graphql
  query PostbusVariantBySku($query: String!) {
    productVariants(first: 1, query: $query) { nodes { id product { id } } }
  }
`;

const SHOPIFY_SET_QUANTITY = `#graphql
  mutation PostbusSetStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { code field message }
    }
  }
`;

/**
 * Where to write so the store's total equals PostBus: the first location absorbs the difference,
 * other locations keep their stock. Null when nothing needs to change.
 */
export function planShopifyStockWrite(levels: InventoryLevelNode[], target: number) {
  const first = levels.find((level) => level.location?.id);
  if (!first?.location) return null;
  const total = sumAvailable(levels);
  const delta = Math.trunc(target) - total;
  if (delta === 0) return null;
  const current = (first.quantities ?? []).find((entry) => entry.name === "available")?.quantity ?? 0;
  return { locationId: first.location.id, changeFromQuantity: current, quantity: Math.max(0, current + delta) };
}

async function storeLinks(supabase: SupabaseClient, organizationId: string, productId: string) {
  const { data, error } = await supabase
    .from("product_store_links")
    .select("source, external_product_id, external_variant_id")
    .eq("organization_id", organizationId)
    .eq("product_id", productId);
  if (error) return [];
  return (data ?? []) as Array<{ source: ImportSource; external_product_id: string; external_variant_id: string }>;
}

async function pushShopifyStock(supabase: SupabaseClient, organizationId: string, product: { id: string; sku: string; onHand: number }) {
  const graphql = await shopifyClient(supabase, organizationId);
  let variantId = (await storeLinks(supabase, organizationId, product.id)).find((link) => link.source === "shopify")?.external_variant_id;
  if (!variantId) {
    const { data } = await graphql<{ productVariants?: { nodes?: Array<{ id: string; product?: { id: string } | null }> } }>(
      SHOPIFY_VARIANT_BY_SKU_QUERY,
      { query: `sku:"${product.sku.replace(/"/g, "")}"` }
    );
    const match = data.productVariants?.nodes?.[0];
    if (!match) return "not_in_store";
    variantId = gidTail(match.id);
    await recordStoreLink(supabase, organizationId, "shopify", product.id, {
      externalId: variantId,
      externalProductId: gidTail(match.product?.id ?? match.id),
    });
  }
  const { data } = await graphql<{
    productVariant?: { inventoryItem?: { id: string; tracked?: boolean; inventoryLevels?: { nodes?: InventoryLevelNode[] } } | null } | null;
  }>(SHOPIFY_VARIANT_STOCK_QUERY, { id: `gid://shopify/ProductVariant/${variantId}` });
  const inventoryItem = data.productVariant?.inventoryItem;
  if (!inventoryItem) return "not_in_store";
  if (inventoryItem.tracked === false) return "untracked";
  const plan = planShopifyStockWrite(inventoryItem.inventoryLevels?.nodes ?? [], product.onHand);
  if (!plan) return "unchanged";
  const { data: result } = await graphql<{ inventorySetQuantities?: { userErrors?: Array<{ message?: string }> } }>(SHOPIFY_SET_QUANTITY, {
    idempotencyKey: randomUUID(),
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: `postbus://inventory/${product.id}`,
      quantities: [{ inventoryItemId: inventoryItem.id, locationId: plan.locationId, quantity: plan.quantity, changeFromQuantity: plan.changeFromQuantity }],
    },
  });
  const userError = result.inventorySetQuantities?.userErrors?.[0]?.message;
  if (userError) throw new Error(`Shopify: ${userError}`);
  return "pushed";
}

async function pushWooStock(supabase: SupabaseClient, organizationId: string, product: { id: string; sku: string; onHand: number }) {
  const woo = await wooClient(supabase, organizationId);
  let link = (await storeLinks(supabase, organizationId, product.id)).find((entry) => entry.source === "woocommerce");
  if (!link) {
    const { data } = await woo.request<Array<{ id: number; parent_id?: number; type?: string }>>("/wp-json/wc/v3/products", {
      query: { sku: product.sku, per_page: "1" },
    });
    const match = data?.[0];
    if (!match) return "not_in_store";
    const parent = match.type === "variation" && match.parent_id ? match.parent_id : null;
    link = {
      source: "woocommerce",
      external_product_id: String(parent ?? match.id),
      external_variant_id: parent ? `${parent}-${match.id}` : String(match.id),
    };
    await recordStoreLink(supabase, organizationId, "woocommerce", product.id, {
      externalId: link.external_variant_id,
      externalProductId: link.external_product_id,
    });
  }
  const [parentId, variationId] = link.external_variant_id.includes("-")
    ? link.external_variant_id.split("-")
    : [link.external_variant_id, null];
  const path = variationId
    ? `/wp-json/wc/v3/products/${parentId}/variations/${variationId}`
    : `/wp-json/wc/v3/products/${parentId}`;
  await woo.request(path, { method: "PUT", body: { manage_stock: true, stock_quantity: Math.max(0, Math.trunc(product.onHand)) } });
  return "pushed";
}

/** Pushes PostBus on-hand stock for these products to every store with live sync on. Never throws. */
export async function pushStockToStores(organizationId: string, productIds: string[]) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    const states = await getLiveSyncStates(organizationId);
    const sources = IMPORT_SOURCES.filter((source) => states[source].enabled);
    if (!sources.length) return;
    const supabase = await adminClient();
    const { data } = await supabase
      .from("products")
      .select("id, sku, inventory_balances(on_hand)")
      .eq("organization_id", organizationId)
      .in("id", ids);
    for (const row of data ?? []) {
      const balance = Array.isArray(row.inventory_balances) ? row.inventory_balances[0] : row.inventory_balances;
      const product = { id: String(row.id), sku: String(row.sku), onHand: Number((balance as { on_hand?: number } | null)?.on_hand ?? 0) };
      for (const source of sources) {
        try {
          const outcome = source === "shopify"
            ? await pushShopifyStock(supabase, organizationId, product)
            : await pushWooStock(supabase, organizationId, product);
          logInfo("products.sync.stock_push", { organizationId, source, productId: product.id, outcome });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Stock push failed.";
          logError("products.sync.stock_push_failed", { organizationId, source, productId: product.id, message });
          await noteSyncEvent(organizationId, source, `Could not update stock for ${product.sku}: ${message}`.slice(0, 300));
        }
      }
    }
  } catch (error) {
    logError("products.sync.stock_push_batch_failed", {
      organizationId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

/** Fire-and-forget wrapper for request paths that must not wait on the store. */
export function queueStockPush(organizationId: string, productIds: string[]) {
  void pushStockToStores(organizationId, productIds);
}
