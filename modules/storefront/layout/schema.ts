import { z } from "zod";

/**
 * Store Builder layout: the structured, theme-driven description of a store's home page.
 * The editor writes it to storefront_settings.draft_layout; Publish copies it to
 * published_layout (and the branding fields to the legacy columns other readers use).
 * Sections only reference products/categories by id — product data stays in inventory.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (fallback: string) => z.string().trim().regex(HEX, "Use a hex color like #E11D48.").catch(fallback);
const text = (max: number) => z.string().trim().max(max).catch("");
const title = (fallback: string) => z.string().trim().max(80).catch(fallback).default(fallback);
/** Same-site paths, store anchors and http(s) links only: never javascript: or data: URLs. */
const href = z
  .string()
  .trim()
  .max(300)
  .refine((value) => !value || value.startsWith("/") || value.startsWith("#") || /^https?:\/\//i.test(value), "Use a link starting with https://, / or #.")
  .catch("");

export const MAX_SECTIONS = 30;
export const MAX_MENU_LINKS = 8;

export const STORE_FONTS = ["geist", "inter", "manrope", "poppins", "playfair", "dm-serif"] as const;

export const layoutTokensSchema = z.object({
  accent: hex("#E11D48").default("#E11D48"),
  secondary: hex("#0f766e").default("#0f766e"),
  /** Page background and heading ink let themes go dark, warm or editorial. */
  background: hex("#ffffff").default("#ffffff"),
  ink: hex("#18181b").default("#18181b"),
  font: z.enum(STORE_FONTS).catch("geist").default("geist"),
  headingFont: z.enum(STORE_FONTS).catch("geist").default("geist"),
  radius: z.enum(["sharp", "rounded", "pill"]).catch("rounded").default("rounded"),
  card: z.enum(["plain", "bordered", "elevated"]).catch("bordered").default("bordered"),
  /** classic: logo left + search; centered: logo centred; minimal: no bar; inline: menu links in the header row; split: links left, logo centred, icons right. */
  header: z.enum(["classic", "centered", "minimal", "inline", "split"]).catch("classic").default("classic"),
  density: z.enum(["comfortable", "compact"]).catch("comfortable").default("comfortable"),
  /** Floating bottom tab bar on phones: Home, Shop, Categories, Cart. */
  mobileNav: z.boolean().catch(false).default(false),
});
export type LayoutTokens = z.infer<typeof layoutTokensSchema>;

const menuLinkSchema = z.object({
  label: z.string().trim().min(1).max(30),
  kind: z.enum(["category", "policy", "section", "url"]),
  /** Category id, policy slug, section id or URL depending on kind. */
  value: z.string().trim().min(1).max(300),
});
export type MenuLink = z.infer<typeof menuLinkSchema>;

export const layoutHeaderSchema = z.object({
  announcement: z
    .object({
      enabled: z.boolean().catch(false).default(false),
      text: text(120).default(""),
      href: href.default(""),
      /** "marquee" scrolls the message (paused for reduced motion). */
      style: z.enum(["static", "marquee"]).catch("static").default("static"),
    })
    .catch({ enabled: false, text: "", href: "", style: "static" })
    .default({ enabled: false, text: "", href: "", style: "static" }),
  menu: z.array(menuLinkSchema).max(MAX_MENU_LINKS).catch([]).default([]),
  showCategoryBar: z.boolean().catch(true).default(true),
});

const testimonialSchema = z.object({
  name: z.string().trim().min(1).max(60),
  quote: z.string().trim().min(1).max(400),
  rating: z.number().int().min(1).max(5).catch(5).default(5),
  location: text(60).default(""),
});
const videoSchema = z.object({
  url: z.string().trim().url().max(300),
  caption: text(120).default(""),
  productIds: z.array(z.string().uuid()).max(4).catch([]).default([]),
});
const trustItemSchema = z.object({ title: z.string().trim().min(1).max(40), body: text(80).default("") });

/** Settings per section type. Unknown keys are dropped; bad values fall back to defaults. */
export const SECTION_SETTINGS = {
  hero: z.object({
    title: text(80).default(""),
    subtitle: text(200).default(""),
    ctaLabel: text(30).default(""),
    /** covers: Cover Studio banner; intro: brand intro; split: image half + copy half; statement: oversized headline over a photo. */
    style: z.enum(["covers", "intro", "split", "statement"]).catch("covers").default("covers"),
  }),
  trust_badges: z.object({ items: z.array(trustItemSchema).max(4).catch([]).default([]) }),
  category_grid: z.object({
    title: title("Shop by category"),
    eyebrow: text(40).default(""),
    categoryIds: z.array(z.string().uuid()).max(12).catch([]).default([]),
    /** tiles: square tiles; round: circular photos in a swipeable row; mosaic: one large + smaller photo tiles; photo: photos with captions; rows: banner tile + products per category. */
    style: z.enum(["tiles", "round", "mosaic", "photo", "rows"]).catch("tiles").default("tiles"),
  }),
  featured_products: z.object({ title: title("Featured picks") }),
  collection: z.object({ title: title("Collection"), categoryId: z.string().uuid().nullable().catch(null).default(null), limit: z.number().int().min(2).max(12).catch(8).default(8) }),
  promo_banner: z.object({
    title: title("Limited time offer"),
    body: text(200).default(""),
    ctaLabel: text(30).default(""),
    ctaHref: href.default(""),
    imageUrl: href.default(""),
    tone: z.enum(["accent", "dark", "light"]).catch("accent").default("accent"),
  }),
  video_shopping: z.object({
    title: title("Watch and shop"),
    /** grid: 16:9 players; reels: vertical 9:16 cards with the product pinned under each video. */
    layout: z.enum(["grid", "reels"]).catch("grid").default("grid"),
    videos: z.array(videoSchema).max(8).catch([]).default([]),
  }),
  bundles: z.object({ title: title("Better together") }),
  upsell: z.object({ title: title("You may also like") }),
  best_sellers: z.object({ title: title("Best sellers") }),
  testimonials: z.object({ title: title("What customers say"), items: z.array(testimonialSchema).max(12).catch([]).default([]) }),
  rich_text: z.object({ title: text(80).default(""), body: text(1500).default("") }),
  countdown: z.object({
    eyebrow: text(40).default("Limited drop"),
    title: title("Ends soon"),
    body: text(160).default(""),
    endsAt: z.string().datetime({ offset: true }).nullable().catch(null).default(null),
    ctaLabel: text(30).default("Shop the drop"),
    ctaHref: href.default("#all-products"),
  }),
  catalog: z.object({ title: title("All products") }),
} as const;

export type SectionType = keyof typeof SECTION_SETTINGS;
export const SECTION_TYPES = Object.keys(SECTION_SETTINGS) as SectionType[];
/** Sections that may appear only once. The catalog is required so shoppers can always browse. */
export const SINGLETON_SECTIONS: SectionType[] = ["hero", "trust_badges", "featured_products", "bundles", "upsell", "best_sellers", "catalog"];

export const SECTION_LABELS: Record<SectionType, { label: string; description: string }> = {
  hero: { label: "Hero banner", description: "Your live covers, or a branded intro when there are none." },
  trust_badges: { label: "Trust badges", description: "Delivery, COD and returns promises." },
  category_grid: { label: "Featured categories", description: "Tiles that open a category." },
  featured_products: { label: "Featured products", description: "Your hand-picked products, in order." },
  collection: { label: "Collection", description: "A row of products from one category." },
  promo_banner: { label: "Promotional banner", description: "An offer with a call to action." },
  video_shopping: { label: "Video shopping", description: "YouTube or Vimeo videos with shoppable products." },
  bundles: { label: "Bundles", description: "Your product bundles with savings." },
  upsell: { label: "Upsells", description: "Products linked as upsells and cross-sells." },
  best_sellers: { label: "Best sellers", description: "Your top-selling products, automatically." },
  testimonials: { label: "Testimonials", description: "Customer reviews and ratings." },
  rich_text: { label: "Text block", description: "A heading and a paragraph about your brand." },
  countdown: { label: "Countdown", description: "A limited-time drop with a live timer." },
  catalog: { label: "Product grid", description: "All products with search, filters and sort." },
};

export type LayoutSection<T extends SectionType = SectionType> = {
  id: string;
  type: T;
  visible: boolean;
  settings: z.infer<(typeof SECTION_SETTINGS)[T]>;
};

const SECTION_ID = /^[a-z0-9_-]{1,40}$/i;

function parseSection(raw: unknown): LayoutSection | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const type = value.type as SectionType;
  if (!SECTION_TYPES.includes(type)) return null;
  const id = typeof value.id === "string" && SECTION_ID.test(value.id) ? value.id : null;
  if (!id) return null;
  const settings = SECTION_SETTINGS[type].safeParse(value.settings ?? {});
  return {
    id,
    type,
    visible: value.visible !== false,
    settings: (settings.success ? settings.data : SECTION_SETTINGS[type].parse({})) as LayoutSection["settings"],
  };
}

/** Drops unknown/invalid sections, duplicate ids and duplicate singletons, and guarantees a catalog. */
export function normalizeSections(raw: unknown): LayoutSection[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: LayoutSection[] = [];
  const ids = new Set<string>();
  const singles = new Set<SectionType>();
  for (const item of list) {
    const section = parseSection(item);
    if (!section || ids.has(section.id)) continue;
    if (SINGLETON_SECTIONS.includes(section.type)) {
      if (singles.has(section.type)) continue;
      singles.add(section.type);
    }
    ids.add(section.id);
    out.push(section);
    if (out.length >= MAX_SECTIONS) break;
  }
  if (!singles.has("catalog")) {
    if (out.length >= MAX_SECTIONS) out.pop();
    out.push(makeSection("catalog", "catalog"));
  }
  // The catalog cannot be hidden: it is the only way to reach every product.
  return out.map((section) => (section.type === "catalog" ? { ...section, visible: true } : section));
}

export function makeSection<T extends SectionType>(type: T, id?: string, settings?: Partial<LayoutSection<T>["settings"]>): LayoutSection<T> {
  return {
    id: id ?? `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    visible: true,
    settings: SECTION_SETTINGS[type].parse(settings ?? {}) as LayoutSection<T>["settings"],
  };
}

/** Today's marketplace home, in order. A store with no layout renders exactly this. */
export function defaultSections(): LayoutSection[] {
  return [
    makeSection("hero", "hero"),
    makeSection("trust_badges", "trust"),
    makeSection("category_grid", "categories"),
    makeSection("featured_products", "featured"),
    makeSection("bundles", "bundles"),
    makeSection("best_sellers", "best-sellers"),
    makeSection("catalog", "catalog"),
  ];
}

export const whatsappButtonSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  position: z.enum(["right", "left"]).catch("right").default("right"),
  message: text(200).default("Hi, I have a question about your products."),
});

/** Product page extras shown on every product: short selling points, a guarantee line, the related-products heading. */
export const productPageSchema = z.object({
  highlights: z.array(z.object({ title: z.string().trim().min(1).max(40), body: text(90).default("") })).max(4).catch([]).default([]),
  guarantee: text(160).default(""),
  relatedTitle: title("You may also like"),
});
export type ProductPageConfig = z.infer<typeof productPageSchema>;

export const storeLayoutSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  themeId: z.string().trim().max(40).catch("classic").default("classic"),
  tokens: layoutTokensSchema.catch(layoutTokensSchema.parse({})).default(layoutTokensSchema.parse({})),
  header: layoutHeaderSchema.catch(layoutHeaderSchema.parse({})).default(layoutHeaderSchema.parse({})),
  sections: z.unknown().transform(normalizeSections),
  whatsappButton: whatsappButtonSchema.catch(whatsappButtonSchema.parse({})).default(whatsappButtonSchema.parse({})),
  productPage: productPageSchema.catch(productPageSchema.parse({})).default(productPageSchema.parse({})),
});
export type StoreLayout = z.infer<typeof storeLayoutSchema>;

export function normalizeStoreLayout(raw: unknown): StoreLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = storeLayoutSchema.safeParse({ sections: defaultSections(), ...(raw as object) });
  return parsed.success ? parsed.data : null;
}

/** Product ids a layout points at, so the public loader can fetch them in one query. */
export function layoutProductIds(layout: StoreLayout | null | undefined): string[] {
  if (!layout) return [];
  const ids = new Set<string>();
  for (const section of layout.sections) {
    if (!section.visible || section.type !== "video_shopping") continue;
    for (const video of (section as LayoutSection<"video_shopping">).settings.videos) for (const id of video.productIds) ids.add(id);
  }
  return [...ids];
}

/** Categories shown as product rows (category grid in "rows" style), max 4. */
export function layoutCategoryRowIds(layout: StoreLayout | null | undefined, allCategoryIds: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!layout) return result;
  for (const section of layout.sections) {
    if (!section.visible || section.type !== "category_grid") continue;
    const settings = (section as LayoutSection<"category_grid">).settings;
    if (settings.style !== "rows") continue;
    result[section.id] = (settings.categoryIds.length ? settings.categoryIds : allCategoryIds).slice(0, 4);
  }
  return result;
}

/** Category ids used by collection sections. */
export function layoutCollectionCategoryIds(layout: StoreLayout | null | undefined): string[] {
  if (!layout) return [];
  return [
    ...new Set(
      layout.sections
        .filter((section): section is LayoutSection<"collection"> => section.visible && section.type === "collection")
        .map((section) => section.settings.categoryId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
}
