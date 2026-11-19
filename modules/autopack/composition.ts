import { createHash } from "node:crypto";

/**
 * Exact shipment composition: which items, how many of each.
 * Shopify lines keep their numeric variant id, so existing history keys stay the same.
 * A catalog line with no Shopify variant uses `catalog:<product uuid>`.
 * The key is order-independent and ignores titles and SKUs, which merchants rename.
 * Any shippable line with neither id makes the whole composition unmatchable.
 */

export type CompositionLine = {
  variantId?: string | number | null;
  productId?: string | number | null;
  catalogProductId?: string | null;
  sku?: string | null;
  title?: string | null;
  quantity: number;
  requiresShipping?: boolean | null;
};

export type CompositionItem = {
  variantId: string;
  productId: string | null;
  sku: string | null;
  title: string | null;
  qty: number;
};

export type ShipmentComposition =
  | { ok: true; key: string; items: CompositionItem[]; unitCount: number }
  | { ok: false; reason: "MISSING_VARIANT_IDS" | "EMPTY_SHIPMENT" };

const COMPOSITION_KEY_VERSION = "v1";

export function normalizeShopifyId(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const tail = text.startsWith("gid://") ? text.slice(text.lastIndexOf("/") + 1) : text;
  return /^\d+$/.test(tail) && tail !== "0" ? tail : null;
}

const CATALOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Identity used only when a line has no Shopify variant. Prefixed so it cannot collide with a variant id. */
export function catalogCompositionId(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!CATALOG_ID.test(text)) return null;
  return `catalog:${text.toLowerCase()}`;
}

export function compositionKey(items: Array<{ variantId: string; qty: number }>) {
  const body = [...items]
    .sort((left, right) => left.variantId.localeCompare(right.variantId))
    .map((item) => `${item.variantId}:${item.qty}`)
    .join(",");
  return createHash("sha256").update(`${COMPOSITION_KEY_VERSION}|${body}`).digest("hex");
}

export function buildShipmentComposition(lines: CompositionLine[]): ShipmentComposition {
  const merged = new Map<string, CompositionItem>();
  let shippable = 0;
  for (const line of lines) {
    if (line.requiresShipping === false) continue;
    const qty = Math.floor(Number(line.quantity) || 0);
    if (qty <= 0) continue;
    shippable += 1;
    const variantId = normalizeShopifyId(line.variantId);
    const identity = variantId ?? catalogCompositionId(line.catalogProductId);
    if (!identity) return { ok: false, reason: "MISSING_VARIANT_IDS" };
    const existing = merged.get(identity);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    merged.set(identity, {
      variantId: identity,
      productId: variantId ? normalizeShopifyId(line.productId) : identity.slice("catalog:".length),
      sku: line.sku?.trim() || null,
      title: line.title?.trim() || null,
      qty,
    });
  }
  if (!shippable) return { ok: false, reason: "EMPTY_SHIPMENT" };
  const items = [...merged.values()].sort((left, right) => left.variantId.localeCompare(right.variantId));
  return {
    ok: true,
    key: compositionKey(items),
    items,
    unitCount: items.reduce((sum, item) => sum + item.qty, 0),
  };
}

/** Lines as stored in order_line_items. Remaining (unfulfilled) quantity wins over ordered quantity. */
export function compositionFromOrderLines(
  rows: Array<{
    shopify_variant_id?: string | null;
    shopify_product_id?: string | null;
    product_id?: string | null;
    sku?: string | null;
    title?: string | null;
    quantity?: number | null;
    unfulfilled_quantity?: number | null;
    requires_shipping?: boolean | null;
  }>
) {
  return buildShipmentComposition(
    rows.map((row) => ({
      variantId: row.shopify_variant_id ?? null,
      productId: row.shopify_product_id ?? null,
      catalogProductId: row.product_id ?? null,
      sku: row.sku ?? null,
      title: row.title ?? null,
      quantity: Number(row.unfulfilled_quantity ?? row.quantity ?? 0),
      requiresShipping: row.requires_shipping,
    }))
  );
}
