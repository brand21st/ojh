import { describe, expect, it } from "vitest";
import { isWooProductTopic, planShopifyStockWrite, storeDetailsPatch, sumAvailable } from "@/modules/products/store-sync";

const level = (location: string, available: number) => ({
  location: { id: `gid://shopify/Location/${location}` },
  quantities: [{ name: "available", quantity: available }],
});

describe("live store sync", () => {
  it("adds up available stock across Shopify locations", () => {
    expect(sumAvailable([level("1", 4), level("2", 6), { quantities: null }])).toBe(10);
    expect(sumAvailable(null)).toBe(0);
  });

  it("writes the difference to the first location so the store total matches PostBus", () => {
    expect(planShopifyStockWrite([level("1", 4), level("2", 6)], 7)).toEqual({
      locationId: "gid://shopify/Location/1",
      changeFromQuantity: 4,
      quantity: 1,
    });
    expect(planShopifyStockWrite([level("1", 4)], 9)).toMatchObject({ quantity: 9, changeFromQuantity: 4 });
  });

  it("skips the write when the store already matches (the echo of our own push)", () => {
    expect(planShopifyStockWrite([level("1", 4), level("2", 6)], 10)).toBeNull();
    expect(planShopifyStockWrite([], 3)).toBeNull();
  });

  it("never writes a negative quantity", () => {
    expect(planShopifyStockWrite([level("1", 1), level("2", 8)], 2)).toMatchObject({ quantity: 0 });
  });

  it("lets store details win but keeps PostBus parcel data when the store has none", () => {
    const base = {
      externalId: "1",
      externalProductId: "1",
      name: "Mug",
      sku: "MUG",
      price: 199,
      compareAtPrice: null,
      description: null,
      weightGrams: 0,
      box: null,
      stock: null,
      imageUrls: [],
      categories: [],
      visible: false,
    };
    const patch = storeDetailsPatch(base);
    expect(patch).toMatchObject({ name: "Mug", price: 199, store_visible: false, active: true });
    expect(patch).not.toHaveProperty("weight_grams");
    expect(patch).not.toHaveProperty("length_cm");
    expect(storeDetailsPatch({ ...base, weightGrams: 300, box: { lengthCm: 20, widthCm: 10, heightCm: 5 } })).toMatchObject({
      weight_grams: 300,
      length_cm: 20,
    });
  });

  it("recognises WooCommerce product topics", () => {
    expect(isWooProductTopic("product.updated")).toBe(true);
    expect(isWooProductTopic("order.updated")).toBe(false);
  });
});
