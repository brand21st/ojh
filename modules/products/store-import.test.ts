import { describe, expect, it } from "vitest";
import { fallbackSku, htmlToText, mapShopifyProduct, mapWooProduct } from "@/modules/products/store-import";

describe("store import mapping", () => {
  it("turns store HTML into plain text", () => {
    expect(htmlToText("<p>Soft &amp; warm</p><ul><li>Cotton</li></ul>")).toBe("Soft & warm\n• Cotton");
    expect(htmlToText("")).toBeNull();
  });

  it("builds a stable fallback SKU", () => {
    expect(fallbackSku("shopify", "4455")).toBe("SHOPIFY-4455");
    expect(fallbackSku("woocommerce", "12-34")).toBe("WOO-1234");
  });

  it("maps each Shopify variant to its own product with collections as categories", () => {
    const items = mapShopifyProduct({
      id: "gid://shopify/Product/1",
      title: "Kurti",
      status: "DRAFT",
      descriptionHtml: "<p>Cotton kurti</p>",
      productType: "Apparel",
      media: { nodes: [{ image: { url: "https://cdn.shopify.com/a.jpg" } }, {}] },
      collections: { nodes: [{ title: "Summer" }, { title: "Apparel" }] },
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/11",
            title: "S",
            sku: "KUR-S",
            price: "499.00",
            compareAtPrice: "799.00",
            inventoryQuantity: 7,
            inventoryItem: { measurement: { weight: { unit: "KILOGRAMS", value: 0.25 } } },
          },
          { id: "gid://shopify/ProductVariant/12", title: "M", sku: "", price: "499.00", compareAtPrice: null, inventoryQuantity: -2 },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      name: "Kurti - S",
      sku: "KUR-S",
      price: 499,
      compareAtPrice: 799,
      weightGrams: 250,
      stock: 7,
      visible: false,
      description: "Cotton kurti",
      imageUrls: ["https://cdn.shopify.com/a.jpg"],
      categories: ["Summer", "Apparel"],
    });
    expect(items[1]).toMatchObject({ sku: "SHOPIFY-12", stock: 0, compareAtPrice: null, weightGrams: 0 });
  });

  it("keeps the plain title for a single default Shopify variant", () => {
    const [item] = mapShopifyProduct({
      id: "gid://shopify/Product/2",
      title: "Mug",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/21", title: "Default Title", sku: "MUG", price: "199" }] },
    });
    expect(item.name).toBe("Mug");
    expect(item.visible).toBe(true);
    // Stock not shared (e.g. missing read_inventory) must stay unknown, never 0.
    expect(item.stock).toBeNull();
    expect(item.externalProductId).toBe("2");
  });

  it("maps a simple WooCommerce product using the store units and sale price", async () => {
    const [item] = await mapWooProduct(
      {
        id: 9,
        name: "Tea &amp; Biscuits",
        sku: "TEA-1",
        status: "publish",
        type: "simple",
        price: "150",
        regular_price: "200",
        sale_price: "150",
        weight: "500",
        dimensions: { length: "20", width: "10", height: "5" },
        stock_quantity: 4,
        images: [{ src: "https://shop.example/tea.jpg" }],
        categories: [{ name: "Uncategorized" }, { name: "Snacks" }],
      },
      { weightUnit: "g", dimensionUnit: "cm" }
    );
    expect(item).toMatchObject({
      name: "Tea & Biscuits",
      sku: "TEA-1",
      price: 150,
      compareAtPrice: 200,
      weightGrams: 500,
      box: { lengthCm: 20, widthCm: 10, heightCm: 5 },
      stock: 4,
      categories: ["Snacks"],
    });
  });

  it("expands WooCommerce variations", async () => {
    const items = await mapWooProduct(
      { id: 5, name: "Shirt", type: "variable", weight: "0.3", categories: [{ name: "Men" }] },
      { weightUnit: "kg", dimensionUnit: "cm" },
      [
        { id: 51, sku: "", price: "299", regular_price: "299", attributes: [{ name: "Size", option: "L" }] },
        { id: 52, sku: "SH-XL", price: "349", weight: "0.4", attributes: [{ name: "Size", option: "XL" }] },
      ]
    );
    expect(items.every((item) => item.stock === null && item.externalProductId === "5")).toBe(true);
    expect(items.map((item) => [item.name, item.sku, item.weightGrams])).toEqual([
      ["Shirt - L", "WOO-551", 300],
      ["Shirt - XL", "SH-XL", 400],
    ]);
  });
});
