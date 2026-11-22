import {
  defaultSections,
  layoutTokensSchema,
  makeSection,
  normalizeSections,
  type LayoutSection,
  type LayoutTokens,
  type SectionType,
  type StoreLayout,
  storeLayoutSchema,
} from "./schema";

/** The 20 business categories merchants pick from; drive theme recommendations. */
export const BUSINESS_CATEGORIES = [
  { id: "fashion", label: "Fashion & Apparel" },
  { id: "ethnic", label: "Sarees & Ethnic Wear" },
  { id: "jewellery", label: "Jewellery & Accessories" },
  { id: "beauty", label: "Beauty & Cosmetics" },
  { id: "ayurveda", label: "Skincare & Ayurveda" },
  { id: "wellness", label: "Health & Wellness" },
  { id: "food", label: "Food & Snacks" },
  { id: "grocery", label: "Spices & Groceries" },
  { id: "home-decor", label: "Home Decor" },
  { id: "kitchen", label: "Kitchen & Dining" },
  { id: "furniture", label: "Furniture" },
  { id: "electronics", label: "Electronics & Gadgets" },
  { id: "mobile", label: "Mobile Accessories" },
  { id: "books", label: "Books & Stationery" },
  { id: "kids", label: "Toys & Kids" },
  { id: "baby", label: "Baby Care" },
  { id: "handicrafts", label: "Handicrafts & Art" },
  { id: "gifts", label: "Gifts & Festive" },
  { id: "pets", label: "Pet Supplies" },
  { id: "sports", label: "Sports & Fitness" },
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number]["id"];
export const BUSINESS_CATEGORY_IDS = BUSINESS_CATEGORIES.map((c) => c.id) as BusinessCategory[];

export type StoreThemeDefinition = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  recommendedFor: BusinessCategory[];
  tokens: LayoutTokens;
  /** Section types in order; existing merchant content is reused by type on install. */
  sections: SectionType[];
  /** Conversion features the theme leans on, shown in the marketplace card. */
  highlights: string[];
  /** Presentation settings (never content) the theme applies to its sections, e.g. hero or category layout. */
  presentation?: { hero?: LayoutSection<"hero">["settings"]["style"]; categories?: LayoutSection<"category_grid">["settings"]["style"]; categoriesEyebrow?: string; announcement?: "static" | "marquee" };
  /** Seed a starter header menu when the merchant has none (inline / split headers show links in the bar). */
  starterMenu?: boolean;
};

const t = (tokens: Partial<LayoutTokens>) => layoutTokensSchema.parse(tokens);

export const STORE_THEMES: StoreThemeDefinition[] = [
  {
    id: "classic",
    name: "Classic",
    tagline: "Clean and familiar",
    description: "The PostBus default. A bright, fast catalog-first store that works for any product.",
    recommendedFor: [...BUSINESS_CATEGORY_IDS],
    tokens: t({}),
    sections: ["hero", "trust_badges", "category_grid", "featured_products", "bundles", "best_sellers", "catalog"],
    highlights: ["Search-first header", "COD and delivery badges", "Bundles row"],
  },
  {
    id: "couture",
    name: "Couture",
    tagline: "Editorial fashion",
    description: "Serif headlines, sharp edges and big imagery for apparel and ethnic wear brands.",
    recommendedFor: ["fashion", "ethnic", "jewellery"],
    tokens: t({ accent: "#18181b", secondary: "#9f1239", background: "#ffffff", ink: "#111111", font: "inter", headingFont: "playfair", radius: "sharp", card: "plain", header: "centered" }),
    sections: ["hero", "collection", "featured_products", "video_shopping", "testimonials", "catalog"],
    highlights: ["Centered logo header", "Collection rows", "Lookbook videos"],
  },
  {
    id: "lumiere",
    name: "Lumière",
    tagline: "Quiet luxury",
    description: "Ivory and gold with refined serif type. Built for jewellery, fragrance and premium gifting.",
    recommendedFor: ["jewellery", "beauty", "gifts"],
    tokens: t({ accent: "#a16207", secondary: "#1e293b", background: "#faf7f0", ink: "#1c1917", font: "manrope", headingFont: "dm-serif", radius: "sharp", card: "elevated", header: "centered" }),
    sections: ["hero", "trust_badges", "featured_products", "rich_text", "testimonials", "catalog"],
    highlights: ["Brand story block", "Elevated product cards", "Reviews"],
  },
  {
    id: "glow",
    name: "Glow",
    tagline: "Soft and bright beauty",
    description: "Blush tones and rounded pills that make skincare and cosmetics feel friendly.",
    recommendedFor: ["beauty", "ayurveda", "baby"],
    tokens: t({ accent: "#db2777", secondary: "#7c3aed", background: "#fff7f9", ink: "#1f1720", font: "poppins", headingFont: "poppins", radius: "pill", card: "elevated", header: "classic" }),
    sections: ["hero", "trust_badges", "best_sellers", "video_shopping", "bundles", "testimonials", "catalog"],
    highlights: ["Routine bundles", "Tutorial videos", "Ratings"],
  },
  {
    id: "ayur",
    name: "Ayur",
    tagline: "Natural and herbal",
    description: "Earthy greens and calm spacing for Ayurveda, wellness and natural products.",
    recommendedFor: ["ayurveda", "wellness", "grocery", "food"],
    tokens: t({ accent: "#3f6212", secondary: "#a16207", background: "#f7f7f0", ink: "#1a2e05", font: "manrope", headingFont: "dm-serif", radius: "rounded", card: "bordered", header: "classic" }),
    sections: ["hero", "trust_badges", "category_grid", "featured_products", "rich_text", "testimonials", "catalog"],
    highlights: ["Ingredients story", "Trust badges", "Category tiles"],
  },
  {
    id: "fresh-mart",
    name: "Fresh Mart",
    tagline: "Quick grocery shopping",
    description: "Dense, scannable grids and best sellers up top so repeat buyers check out fast.",
    recommendedFor: ["food", "grocery", "kitchen", "pets"],
    tokens: t({ accent: "#16a34a", secondary: "#ea580c", background: "#f6f8f5", ink: "#14231a", font: "inter", headingFont: "inter", radius: "rounded", card: "bordered", header: "classic", density: "compact" }),
    sections: ["hero", "category_grid", "best_sellers", "promo_banner", "bundles", "catalog"],
    highlights: ["Compact grid", "Offer banner", "Combo packs"],
  },
  {
    id: "volt",
    name: "Volt",
    tagline: "Tech and gadgets",
    description: "Crisp blue on slate with sharp cards and spec-friendly product rows.",
    recommendedFor: ["electronics", "mobile", "sports"],
    tokens: t({ accent: "#2563eb", secondary: "#0f172a", background: "#f4f6fa", ink: "#0b1220", font: "inter", headingFont: "inter", radius: "sharp", card: "bordered", header: "minimal", density: "compact" }),
    sections: ["hero", "trust_badges", "featured_products", "video_shopping", "upsell", "best_sellers", "catalog"],
    highlights: ["Product demo videos", "Upsell accessories", "Minimal header"],
  },
  {
    id: "nest",
    name: "Nest",
    tagline: "Warm home living",
    description: "Warm sand tones and serif headings for decor, furniture and kitchenware.",
    recommendedFor: ["home-decor", "furniture", "kitchen", "handicrafts"],
    tokens: t({ accent: "#b45309", secondary: "#365314", background: "#faf6f0", ink: "#292524", font: "manrope", headingFont: "playfair", radius: "rounded", card: "elevated", header: "centered" }),
    sections: ["hero", "category_grid", "collection", "featured_products", "testimonials", "catalog"],
    highlights: ["Room-by-room collections", "Large imagery", "Reviews"],
  },
  {
    id: "bazaar",
    name: "Bazaar",
    tagline: "Festive and vibrant",
    description: "Saffron and magenta energy for festive drops, handicrafts and gifting seasons.",
    recommendedFor: ["gifts", "handicrafts", "ethnic", "food"],
    tokens: t({ accent: "#ea580c", secondary: "#be185d", background: "#fff8f0", ink: "#2a1606", font: "poppins", headingFont: "poppins", radius: "pill", card: "elevated", header: "classic" }),
    sections: ["hero", "promo_banner", "category_grid", "featured_products", "bundles", "testimonials", "catalog"],
    highlights: ["Festival offer banner", "Gift bundles", "Bright CTAs"],
  },
  {
    id: "playtime",
    name: "Playtime",
    tagline: "Fun for families",
    description: "Cheerful colour and chunky rounded shapes for toys, kids, books and pets.",
    recommendedFor: ["kids", "baby", "books", "pets"],
    tokens: t({ accent: "#f59e0b", secondary: "#7c3aed", background: "#fffdf5", ink: "#1e1b4b", font: "poppins", headingFont: "poppins", radius: "pill", card: "elevated", header: "classic" }),
    sections: ["hero", "category_grid", "best_sellers", "bundles", "testimonials", "catalog"],
    highlights: ["Age/category tiles", "Gift sets", "Parent reviews"],
  },
  {
    id: "verdant",
    name: "Verdant",
    tagline: "Lush and immersive",
    description: "Deep greens, a full-bleed hero, a photo mosaic of categories and a floating tab bar on phones. Made for plants, organic and outdoor brands.",
    recommendedFor: ["home-decor", "ayurveda", "wellness", "gifts"],
    tokens: t({ accent: "#166534", secondary: "#a3b18a", background: "#f5f7f2", ink: "#0f2417", font: "inter", headingFont: "playfair", radius: "pill", card: "plain", header: "inline", mobileNav: true }),
    sections: ["hero", "category_grid", "featured_products", "best_sellers", "testimonials", "catalog"],
    highlights: ["Category mosaic", "Bottom tab bar on phones", "Scrolling offers bar"],
    presentation: { hero: "covers", categories: "mosaic", announcement: "marquee" },
    starterMenu: true,
  },
  {
    id: "aurum",
    name: "Aurum",
    tagline: "Gallery-clean luxury",
    description: "Generous white space, serif headings, edge-to-edge banners and captioned square photos. Lets jewellery and premium products shine.",
    recommendedFor: ["jewellery", "beauty", "handicrafts", "ethnic"],
    tokens: t({ accent: "#1f6f5c", secondary: "#b08d57", background: "#ffffff", ink: "#1c1917", font: "manrope", headingFont: "playfair", radius: "sharp", card: "plain", header: "inline" }),
    sections: ["hero", "category_grid", "featured_products", "rich_text", "best_sellers", "catalog"],
    highlights: ["Menu in the header", "Captioned category photos", "Brand story"],
    presentation: { hero: "covers", categories: "photo" },
    starterMenu: true,
  },
  {
    id: "mono",
    name: "Mono",
    tagline: "Bold fashion statement",
    description: "Black and white with an oversized headline hero and a row of products for every category. Built for apparel and lifestyle drops.",
    recommendedFor: ["fashion", "ethnic", "sports", "mobile"],
    tokens: t({ accent: "#111111", secondary: "#dc2626", background: "#ffffff", ink: "#0a0a0a", font: "inter", headingFont: "inter", radius: "pill", card: "plain", header: "inline" }),
    sections: ["hero", "category_grid", "featured_products", "promo_banner", "catalog"],
    highlights: ["Statement headline hero", "Products by category rows", "Black pill buttons"],
    presentation: { hero: "statement", categories: "rows", categoriesEyebrow: "Curated for you" },
    starterMenu: true,
  },
  {
    id: "atelier",
    name: "Atelier",
    tagline: "Refined boutique",
    description: "Split hero, a centred logo with menu on the left, a scrolling offers bar and a countdown for limited drops. For bags, shoes and designer goods.",
    recommendedFor: ["fashion", "jewellery", "furniture", "gifts"],
    tokens: t({ accent: "#4a2c21", secondary: "#b45309", background: "#f7f5f2", ink: "#1c1917", font: "inter", headingFont: "manrope", radius: "sharp", card: "plain", header: "split" }),
    sections: ["hero", "countdown", "featured_products", "category_grid", "testimonials", "catalog"],
    highlights: ["Split hero", "Limited-drop countdown", "Centred logo header"],
    presentation: { hero: "split", categories: "photo", announcement: "marquee" },
    starterMenu: true,
  },
  {
    id: "pulse",
    name: "Pulse",
    tagline: "Bold performance",
    description: "High-contrast red and black with strong type for sports, fitness and supplements.",
    recommendedFor: ["sports", "wellness", "fashion"],
    tokens: t({ accent: "#dc2626", secondary: "#18181b", background: "#f7f7f7", ink: "#0a0a0a", font: "inter", headingFont: "inter", radius: "sharp", card: "plain", header: "minimal" }),
    sections: ["hero", "promo_banner", "featured_products", "video_shopping", "best_sellers", "catalog"],
    highlights: ["Launch banner", "Training videos", "Best sellers"],
  },
];

export function findTheme(id: string | null | undefined) {
  return STORE_THEMES.find((theme) => theme.id === id) ?? STORE_THEMES[0];
}

/** Themes made for the category first (most specific first), then the rest. Classic is always offered. */
export function recommendThemes(category: string | null | undefined): StoreThemeDefinition[] {
  if (!category || !BUSINESS_CATEGORY_IDS.includes(category as BusinessCategory)) return STORE_THEMES;
  const score = (theme: StoreThemeDefinition) => {
    if (theme.id === "classic") return 50;
    const index = theme.recommendedFor.indexOf(category as BusinessCategory);
    return index === -1 ? 100 : index;
  };
  return [...STORE_THEMES].sort((a, b) => score(a) - score(b));
}

export function isRecommended(theme: StoreThemeDefinition, category: string | null | undefined) {
  return Boolean(category) && theme.id !== "classic" && theme.recommendedFor.includes(category as BusinessCategory);
}

/** Sections a merchant filled in themselves; installing a theme must never drop them. */
export function hasMerchantContent(section: LayoutSection) {
  const settings = section.settings as Record<string, unknown>;
  switch (section.type) {
    case "testimonials":
      return Array.isArray(settings.items) && settings.items.length > 0;
    case "video_shopping":
      return Array.isArray(settings.videos) && settings.videos.length > 0;
    case "rich_text":
      return Boolean(settings.body);
    case "promo_banner":
      return Boolean(settings.body || settings.ctaHref || settings.imageUrl);
    case "collection":
      return Boolean(settings.categoryId);
    default:
      return false;
  }
}

/**
 * Applies a theme to a draft layout. Tokens come from the theme (optionally keeping the
 * merchant's brand colours). With applyLayout, the section order follows the theme but every
 * existing section's settings are reused by type, and filled-in sections the theme does not
 * use are kept (hidden) at the end. Nothing the merchant wrote is ever deleted.
 */
export function installTheme(
  current: StoreLayout | null,
  theme: StoreThemeDefinition,
  options: { keepBrandColors?: boolean; applyLayout?: boolean } = {}
): StoreLayout {
  const base = current ?? storeLayoutSchema.parse({ sections: defaultSections() });
  const tokens: LayoutTokens = options.keepBrandColors
    ? { ...theme.tokens, accent: base.tokens.accent, secondary: base.tokens.secondary }
    : { ...theme.tokens };
  if (!options.applyLayout) {
    const sections = base.sections.map((section) => withPresentation(section, theme));
    return { ...base, themeId: theme.id, tokens, header: themedHeader(base, theme, sections), sections };
  }

  const pool = [...base.sections];
  const take = (type: SectionType) => {
    const index = pool.findIndex((section) => section.type === type);
    return index === -1 ? null : pool.splice(index, 1)[0];
  };
  const ordered: LayoutSection[] = theme.sections.map((type) => {
    const existing = take(type);
    return existing ? { ...existing, visible: true } : makeSection(type, type === "catalog" ? "catalog" : undefined);
  });
  const catalogIndex = ordered.findIndex((section) => section.type === "catalog");
  const kept = pool.filter(hasMerchantContent).map((section) => ({ ...section, visible: false }));
  ordered.splice(catalogIndex === -1 ? ordered.length : catalogIndex, 0, ...kept);
  const sections = normalizeSections(ordered.map((section) => withPresentation(section, theme)));
  return { ...base, themeId: theme.id, tokens, header: themedHeader(base, theme, sections), sections };
}

/** Applies a theme's presentation choices (layout styles only; never merchant text, products or dates). */
export function withPresentation(section: LayoutSection, theme: StoreThemeDefinition): LayoutSection {
  const look = theme.presentation;
  if (!look) return section;
  if (section.type === "hero" && look.hero) return { ...section, settings: { ...section.settings, style: look.hero } as LayoutSection["settings"] };
  if (section.type === "category_grid" && look.categories) {
    const settings = section.settings as LayoutSection<"category_grid">["settings"];
    return { ...section, settings: { ...settings, style: look.categories, eyebrow: settings.eyebrow || look.categoriesEyebrow || "" } as LayoutSection["settings"] };
  }
  if (section.type === "countdown") {
    const settings = section.settings as LayoutSection<"countdown">["settings"];
    // A fresh countdown needs an end date to show; default to one week out.
    if (!settings.endsAt) return { ...section, settings: { ...settings, endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } as LayoutSection["settings"] };
  }
  return section;
}

export function themedHeader(base: StoreLayout, theme: StoreThemeDefinition, sections: LayoutSection[]): StoreLayout["header"] {
  const header = { ...base.header, announcement: { ...base.header.announcement } };
  if (theme.presentation?.announcement) header.announcement.style = theme.presentation.announcement;
  if (theme.starterMenu && !header.menu.length) {
    const visible = (type: SectionType) => sections.find((section) => section.type === type && section.visible);
    const menu: StoreLayout["header"]["menu"] = [{ label: "Shop all", kind: "section", value: "catalog" }];
    const categories = visible("category_grid");
    if (categories) menu.push({ label: "Collections", kind: "section", value: categories.id });
    const best = visible("best_sellers") ?? visible("featured_products");
    if (best) menu.push({ label: best.type === "best_sellers" ? "Best sellers" : "New in", kind: "section", value: best.id });
    menu.push({ label: "Shipping", kind: "policy", value: "shipping" });
    header.menu = menu;
  }
  return header;
}
