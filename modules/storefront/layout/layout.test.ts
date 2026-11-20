import { describe, expect, it } from "vitest";
import {
  MAX_SECTIONS,
  layoutCategoryRowIds,
  defaultSections,
  layoutCollectionCategoryIds,
  layoutProductIds,
  makeSection,
  normalizeSections,
  normalizeStoreLayout,
  storeLayoutSchema,
} from "./schema";
import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_IDS, STORE_THEMES, findTheme, installTheme, isRecommended, recommendThemes } from "./themes";
import { videoEmbed } from "./video";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("store layout schema", () => {
  it("default sections reproduce today's marketplace home order", () => {
    expect(defaultSections().map((s) => s.type)).toEqual(["hero", "trust_badges", "category_grid", "featured_products", "bundles", "best_sellers", "catalog"]);
  });

  it("drops unknown types, duplicate ids and duplicate singletons", () => {
    const sections = normalizeSections([
      { id: "a", type: "hero" },
      { id: "b", type: "hero" },
      { id: "a", type: "rich_text" },
      { id: "c", type: "evil_script" },
      { id: "d", type: "collection" },
      { id: "e", type: "collection" },
    ]);
    expect(sections.map((s) => `${s.id}:${s.type}`)).toEqual(["a:hero", "d:collection", "e:collection", "catalog:catalog"]);
  });

  it("always keeps a visible catalog", () => {
    expect(normalizeSections([]).map((s) => s.type)).toEqual(["catalog"]);
    expect(normalizeSections([{ id: "cat", type: "catalog", visible: false }])[0].visible).toBe(true);
  });

  it("caps the number of sections", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: "rich_text" }));
    const sections = normalizeSections(many);
    expect(sections).toHaveLength(MAX_SECTIONS);
    expect(sections.at(-1)?.type).toBe("catalog");
  });

  it("falls back to defaults for bad settings instead of failing the whole layout", () => {
    const [section] = normalizeSections([{ id: "p", type: "promo_banner", settings: { title: 42, ctaHref: "javascript:alert(1)", tone: "neon" } }]);
    expect(section.settings).toMatchObject({ title: "Limited time offer", ctaHref: "", tone: "accent" });
  });

  it("rejects script and data URLs in links", () => {
    const layout = storeLayoutSchema.parse({ header: { announcement: { enabled: true, text: "Hi", href: "data:text/html,boom" } }, sections: [] });
    expect(layout.header.announcement.href).toBe("");
  });

  it("normalizes tokens and keeps hex colours valid", () => {
    const layout = normalizeStoreLayout({ tokens: { accent: "red", font: "comic-sans" } });
    expect(layout?.tokens.accent).toBe("#E11D48");
    expect(layout?.tokens.font).toBe("geist");
    expect(normalizeStoreLayout(null)).toBeNull();
    expect(normalizeStoreLayout("nope")).toBeNull();
  });

  it("collects referenced product and category ids from visible sections only", () => {
    const layout = storeLayoutSchema.parse({
      sections: [
        makeSection("video_shopping", "v1", { videos: [{ url: "https://youtu.be/abcdefghijk", caption: "", productIds: [uuid(1), uuid(2)] }] }),
        { ...makeSection("video_shopping", "v2", { videos: [{ url: "https://youtu.be/abcdefghijk", caption: "", productIds: [uuid(3)] }] }), visible: false },
        makeSection("collection", "c1", { categoryId: uuid(9) }),
      ],
    });
    expect(layoutProductIds(layout)).toEqual([uuid(1), uuid(2)]);
    expect(layoutCollectionCategoryIds(layout)).toEqual([uuid(9)]);
  });
});

describe("themes", () => {
  it("has 20 business categories and every one has a dedicated theme", () => {
    expect(BUSINESS_CATEGORIES).toHaveLength(20);
    for (const category of BUSINESS_CATEGORY_IDS) {
      expect(STORE_THEMES.some((theme) => theme.id !== "classic" && theme.recommendedFor.includes(category))).toBe(true);
    }
  });

  it("every theme parses, has a catalog and unique id", () => {
    const ids = new Set<string>();
    for (const theme of STORE_THEMES) {
      expect(ids.has(theme.id)).toBe(false);
      ids.add(theme.id);
      expect(theme.sections).toContain("catalog");
      expect(storeLayoutSchema.safeParse({ themeId: theme.id, tokens: theme.tokens, sections: [] }).success).toBe(true);
    }
  });

  it("recommends category themes first and keeps all themes available", () => {
    const list = recommendThemes("jewellery");
    expect(list).toHaveLength(STORE_THEMES.length);
    expect(isRecommended(list[0], "jewellery")).toBe(true);
    expect(recommendThemes(null)).toEqual(STORE_THEMES);
    expect(findTheme("missing").id).toBe("classic");
  });

  it("installing a theme never deletes merchant content", () => {
    const base = storeLayoutSchema.parse({
      sections: [
        makeSection("hero", "hero", { title: "Diwali drop" }),
        makeSection("testimonials", "reviews", { items: [{ name: "Asha", quote: "Great!", rating: 5, location: "" }] }),
        makeSection("video_shopping", "vids", { videos: [{ url: "https://youtu.be/abcdefghijk", caption: "Demo", productIds: [] }] }),
        makeSection("catalog", "catalog"),
      ],
    });
    const fresh = installTheme(base, findTheme("fresh-mart"), { applyLayout: true });
    expect(fresh.themeId).toBe("fresh-mart");
    expect(fresh.tokens.accent).toBe(findTheme("fresh-mart").tokens.accent);
    const hero = fresh.sections.find((s) => s.type === "hero");
    expect(hero?.id).toBe("hero");
    expect((hero?.settings as { title: string }).title).toBe("Diwali drop");
    // Fresh Mart has no testimonials or video sections: they are kept, hidden.
    expect(fresh.sections.find((s) => s.id === "reviews")).toMatchObject({ visible: false });
    expect(fresh.sections.find((s) => s.id === "vids")).toMatchObject({ visible: false });
    expect(fresh.sections.at(-1)?.type).toBe("catalog");
  });

  it("style-only install keeps sections and can keep brand colours", () => {
    const base = storeLayoutSchema.parse({ tokens: { accent: "#123456", secondary: "#654321" }, sections: defaultSections() });
    const next = installTheme(base, findTheme("couture"), { keepBrandColors: true });
    expect(next.sections).toEqual(base.sections);
    expect(next.tokens.accent).toBe("#123456");
    expect(next.tokens.headingFont).toBe("playfair");
  });
});

describe("videoEmbed", () => {
  it("turns YouTube and Vimeo links into privacy embeds", () => {
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.embedUrl).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbed("https://youtu.be/dQw4w9WgXcQ")?.provider).toBe("youtube");
    expect(videoEmbed("https://youtube.com/shorts/dQw4w9WgXcQ")?.provider).toBe("youtube");
    expect(videoEmbed("https://vimeo.com/76979871")?.embedUrl).toBe("https://player.vimeo.com/video/76979871?dnt=1");
  });

  it("rejects anything else", () => {
    expect(videoEmbed("https://evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(videoEmbed("javascript:alert(1)")).toBeNull();
    expect(videoEmbed("not a url")).toBeNull();
  });
});

describe("reference-style themes (Verdant, Aurum, Mono, Atelier)", () => {
  it("apply their presentation without touching merchant text", () => {
    const base = storeLayoutSchema.parse({
      sections: [makeSection("hero", "hero", { title: "Monsoon edit" }), makeSection("category_grid", "cats", { title: "Browse" }), makeSection("catalog", "catalog")],
    });
    const mono = installTheme(base, findTheme("mono"), { applyLayout: true });
    const hero = mono.sections.find((s) => s.type === "hero")!.settings as { style: string; title: string };
    const grid = mono.sections.find((s) => s.type === "category_grid")!.settings as { style: string; title: string; eyebrow: string };
    expect(hero).toMatchObject({ style: "statement", title: "Monsoon edit" });
    expect(grid).toMatchObject({ style: "rows", title: "Browse", eyebrow: "Curated for you" });
    expect(mono.tokens.header).toBe("inline");
  });

  it("seed a starter menu only when the merchant has none", () => {
    const empty = installTheme(storeLayoutSchema.parse({ sections: defaultSections() }), findTheme("aurum"), { applyLayout: true });
    expect(empty.header.menu[0]).toEqual({ label: "Shop all", kind: "section", value: "catalog" });
    const own = storeLayoutSchema.parse({ header: { menu: [{ label: "Sale", kind: "url", value: "https://example.com" }] }, sections: [] });
    expect(installTheme(own, findTheme("aurum"), { applyLayout: true }).header.menu).toEqual(own.header.menu);
  });

  it("Atelier gives a new countdown an end date and a scrolling ticker; Verdant turns on the phone tab bar", () => {
    const atelier = installTheme(null, findTheme("atelier"), { applyLayout: true });
    const countdown = atelier.sections.find((s) => s.type === "countdown")!.settings as { endsAt: string | null };
    expect(countdown.endsAt && new Date(countdown.endsAt).getTime()).toBeGreaterThan(Date.now());
    expect(atelier.header.announcement.style).toBe("marquee");
    expect(atelier.tokens.header).toBe("split");
    expect(installTheme(null, findTheme("verdant")).tokens.mobileNav).toBe(true);
  });

  it("category rows pick at most 4 categories, defaulting to the active ones", () => {
    const layout = storeLayoutSchema.parse({ sections: [makeSection("category_grid", "rows", { style: "rows" }), makeSection("catalog", "catalog")] });
    expect(layoutCategoryRowIds(layout, [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)])).toEqual({ rows: [uuid(1), uuid(2), uuid(3), uuid(4)] });
  });

  it("older layouts without the new fields still parse", () => {
    const layout = normalizeStoreLayout({ tokens: { header: "classic" }, header: { announcement: { enabled: true, text: "Hi" } }, sections: [{ id: "h", type: "hero", settings: { style: "covers" } }] });
    expect(layout?.tokens.mobileNav).toBe(false);
    expect(layout?.header.announcement.style).toBe("static");
  });
});
