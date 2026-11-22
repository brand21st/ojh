import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ hasAdminClient: () => false, createAdminClient: () => { throw new Error("no admin"); } }));

import { buildLayoutFromAi, contrastRatio, extractJsonObject } from "./ai-site";
import { isGeminiSiteModel, mergeSiteModels, sanitizeSiteBuilderModel } from "@/modules/openrouter/site-models";
import { makeSection, storeLayoutSchema } from "./layout/schema";

const cat = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const prod = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const store = {
  storeName: "Kala Handlooms",
  businessCategory: "ethnic",
  categories: [{ id: cat(1), name: "Sarees" }, { id: cat(2), name: "Set mundu" }],
  products: [{ id: prod(1), name: "Kasavu saree", price: 2499, categoryIds: [cat(1)] }, { id: prod(2), name: "Set mundu", price: 1899, categoryIds: [cat(2)] }],
  hasCovers: false,
  hasBundles: false,
  hasWhatsapp: true,
};

describe("AI website builder: turning the model reply into a safe layout", () => {
  it("parses fenced or chatty JSON", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a":2} hope it helps')).toEqual({ a: 2 });
    expect(() => extractJsonObject("no json here")).toThrow(/usable design/);
  });

  it("keeps only real ids, strips invented reviews, deadlines, images and video links", () => {
    const reply = {
      themeId: "aurum",
      tokens: { accent: "#9f1239", font: "playfair" },
      announcement: { text: "Free shipping above ₹999", style: "marquee" },
      sections: [
        { type: "hero", settings: { style: "covers", title: "Woven in Kerala" } },
        { type: "category_grid", settings: { style: "round", categoryIds: [cat(1), "not-a-real-id", cat(9)] } },
        { type: "collection", settings: { categoryId: cat(9), title: "Ghost" } },
        { type: "testimonials", settings: { items: [{ name: "Fake", quote: "Best ever!", rating: 5 }] } },
        { type: "countdown", settings: { title: "Ends tonight", endsAt: "2026-12-01T00:00:00Z" } },
        { type: "promo_banner", settings: { title: "Onam", imageUrl: "https://evil.example/x.jpg", ctaHref: "javascript:alert(1)" } },
        { type: "video_shopping", settings: { videos: [{ url: "https://youtu.be/abcdefghijk", productIds: [prod(1)] }] } },
        { type: "bundles", settings: {} },
        { type: "evil", settings: {} },
      ],
      featuredProductIds: [prod(2), prod(99), prod(2)],
      productPage: { highlights: [{ title: "Pure cotton", body: "Breathable for Kerala weather" }], guarantee: "Packed with care" },
      seo: { title: "Kala Handlooms · Kerala sarees", description: "Handwoven kasavu sarees." },
    };
    const { layout, featured, seo } = buildLayoutFromAi(reply, store, "Handwoven sarees for Onam", "auto", null);
    const types = layout.sections.map((s) => s.type);
    expect(layout.themeId).toBe("aurum");
    expect(types[0]).toBe("hero");
    expect(types.at(-1)).toBe("catalog");
    expect(types).not.toContain("collection"); // unknown category
    expect(types).not.toContain("video_shopping"); // URL not given by the merchant
    expect(types).not.toContain("bundles"); // store has none
    const hero = layout.sections.find((s) => s.type === "hero")!.settings as { style: string };
    expect(hero.style).toBe("intro"); // no covers to show
    const grid = layout.sections.find((s) => s.type === "category_grid")!.settings as { categoryIds: string[]; style: string };
    expect(grid).toMatchObject({ categoryIds: [cat(1)], style: "round" });
    expect((layout.sections.find((s) => s.type === "testimonials")!.settings as { items: unknown[] }).items).toEqual([]);
    expect((layout.sections.find((s) => s.type === "countdown")!.settings as { endsAt: unknown }).endsAt).toBeNull();
    const promo = layout.sections.find((s) => s.type === "promo_banner")!.settings as { imageUrl: string; ctaHref: string };
    expect(promo).toMatchObject({ imageUrl: "", ctaHref: "" });
    expect(featured).toEqual([prod(2)]);
    expect(layout.header.announcement).toMatchObject({ enabled: true, style: "marquee" });
    expect(layout.whatsappButton.enabled).toBe(true);
    expect(layout.productPage.highlights[0].title).toBe("Pure cotton");
    expect(seo.title).toContain("Kala");
  });

  it("allows video sections only for links the merchant wrote", () => {
    const reply = { sections: [{ type: "video_shopping", settings: { layout: "reels", videos: [{ url: "https://youtube.com/shorts/abcdefghijk", productIds: [prod(1), prod(77)] }] } }] };
    const { layout } = buildLayoutFromAi(reply, store, "Use my short https://youtube.com/shorts/abcdefghijk", "auto", null);
    const video = layout.sections.find((s) => s.type === "video_shopping")!.settings as { layout: string; videos: Array<{ productIds: string[] }> };
    expect(video.layout).toBe("reels");
    expect(video.videos[0].productIds).toEqual([prod(1)]);
  });

  it("falls back to the theme colours when the AI picks unreadable ones", () => {
    const { layout } = buildLayoutFromAi({ themeId: "glow", tokens: { background: "#222222", ink: "#333333" } }, store, "x".repeat(20), "auto", null);
    expect(contrastRatio(layout.tokens.ink, layout.tokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(layout.tokens.background).not.toBe("#222222");
  });

  it("respects a theme the merchant chose and keeps their own content hidden", () => {
    const current = storeLayoutSchema.parse({ sections: [makeSection("testimonials", "mine", { items: [{ name: "Asha", quote: "Lovely", rating: 5, location: "" }] }), makeSection("catalog", "catalog")] });
    const { layout } = buildLayoutFromAi({ themeId: "pulse", sections: [] }, store, "x".repeat(20), "verdant", current);
    expect(layout.themeId).toBe("verdant");
    expect(layout.sections.find((s) => s.id === "mine")).toMatchObject({ visible: false });
  });

  it("returns a valid layout even from an empty reply", () => {
    const { layout } = buildLayoutFromAi({}, store, "x".repeat(20), "auto", null);
    expect(layout.themeId).toBe("classic");
    expect(layout.sections.map((s) => s.type)).toEqual(["hero", "catalog"]);
  });
});

describe("site builder models (super admin)", () => {
  it("accepts Gemini text models only", () => {
    expect(isGeminiSiteModel("google/gemini-2.5-pro")).toBe(true);
    expect(isGeminiSiteModel("google/gemini-2.5-flash-image")).toBe(false);
    expect(isGeminiSiteModel("openai/gpt-4o")).toBe(false);
    expect(sanitizeSiteBuilderModel("openai/gpt-4o")).toBe("google/gemini-2.5-flash");
    expect(sanitizeSiteBuilderModel("google/gemini-3-pro-preview")).toBe("google/gemini-3-pro-preview");
  });

  it("lists curated models first and adds live and selected ones", () => {
    const list = mergeSiteModels([{ id: "google/gemini-3-flash", name: "Gemini 3 Flash" }, { id: "google/gemini-2.5-flash-image", name: "img" }], "google/gemini-exp-1");
    expect(list[0].id).toBe("google/gemini-2.5-flash");
    expect(list.map((m) => m.id)).toContain("google/gemini-3-flash");
    expect(list.map((m) => m.id)).toContain("google/gemini-exp-1");
    expect(list.map((m) => m.id)).not.toContain("google/gemini-2.5-flash-image");
  });
});
