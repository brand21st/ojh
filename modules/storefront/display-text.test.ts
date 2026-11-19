import { describe, expect, it } from "vitest";
import { contrastText, onAccent, readableAccent } from "@/modules/storefront/config";
import { decodeTextEntities, mapPublicProduct } from "@/modules/storefront/public";

describe("decodeTextEntities", () => {
  it("decodes entities pasted from HTML sources", () => {
    expect(decodeTextEntities("fish &amp; meat")).toBe("fish & meat");
    expect(decodeTextEntities("&quot;Kerala&quot; &#39;style&#39; &ndash; 2&#x20AC;")).toBe("\"Kerala\" 'style' – 2€");
  });

  it("decodes only one level, so encoded markup stays text", () => {
    expect(decodeTextEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("leaves unknown entities and plain ampersands alone", () => {
    expect(decodeTextEntities("Salt & pepper &foo;")).toBe("Salt & pepper &foo;");
  });

  it("is applied to public product names and descriptions", () => {
    const product = mapPublicProduct({ id: "p1", name: "Knife &amp; board", description: "Teak &amp; steel", price: 10 });
    expect(product.name).toBe("Knife & board");
    expect(product.description).toBe("Teak & steel");
    expect(mapPublicProduct({ id: "p2", name: "X", description: null, price: 1 }).description).toBeNull();
  });
});

describe("accent helpers", () => {
  it("puts dark text on light accents and white text on dark ones", () => {
    expect(onAccent("#FF810A")).toEqual({ backgroundColor: "#FF810A", color: contrastText("#FF810A") });
    expect(contrastText("#FF810A")).toBe("#18181b");
    expect(contrastText("#1E3A8A")).toBe("#ffffff");
  });

  it("darkens a light accent until it reads as text on white, and keeps dark ones", () => {
    expect(readableAccent("#1E3A8A")).toBe("#1e3a8a");
    const orange = readableAccent("#FF810A");
    expect(orange).not.toBe("#ff810a");
    const lum = (hex: string) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255).map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    expect(1.05 / (lum(orange) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(readableAccent("not-a-colour")).toBe("#18181b");
  });
});
