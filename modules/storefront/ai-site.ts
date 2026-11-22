import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { ZERO_AI_CREDITS_MESSAGE } from "@/modules/ai-credits/constants";
import { consumeAiCredit, getAiCreditsRemaining } from "@/modules/ai-credits/service";
import { OPENROUTER_API_BASE, getPlatformOpenRouterConfig, openRouterReferer } from "@/modules/openrouter/platform-config";
import { DEFAULT_SITE_BUILDER_CREDIT_COST, sanitizeSiteBuilderModel } from "@/modules/openrouter/site-models";
import { getStoreBuilderState, saveStoreDraft } from "./builder";
import {
  SECTION_TYPES,
  layoutTokensSchema,
  makeSection,
  normalizeSections,
  productPageSchema,
  storeLayoutSchema,
  type LayoutSection,
  type LayoutTokens,
  type SectionType,
  type StoreLayout,
} from "./layout/schema";
import { BUSINESS_CATEGORIES, STORE_THEMES, findTheme, hasMerchantContent, themedHeader } from "./layout/themes";
import { videoEmbed } from "./layout/video";

export const AI_CREDIT_REASON_SITE_BUILDER = "AI_SITE_BUILDER";
export const AI_SITE_PROMPT_MAX = 1200;

export const aiSiteRequestSchema = z.object({
  prompt: z.string().trim().min(10, "Describe your store in a sentence or two.").max(AI_SITE_PROMPT_MAX),
  /** "auto" lets the AI pick a theme; otherwise it designs within the chosen one. */
  themeId: z.string().trim().max(40).default("auto"),
  idempotencyKey: z.string().uuid().optional(),
  expectedDraftUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export type SiteBuilderAiConfig = { enabled: boolean; apiKey: string; model: string; creditCost: number };

/** Platform OpenRouter key + the super admin's Website Builder model and price. */
export async function getSiteBuilderAiConfig(): Promise<SiteBuilderAiConfig> {
  const base = await getPlatformOpenRouterConfig();
  let model = sanitizeSiteBuilderModel(null);
  let creditCost = DEFAULT_SITE_BUILDER_CREDIT_COST;
  if (hasAdminClient()) {
    const { data, error } = await createAdminClient().from("platform_settings").select("openrouter_site_model, ai_site_credit_cost").eq("id", 1).maybeSingle();
    if (error) logError("ai_site.settings_load_failed", { message: error.message });
    model = sanitizeSiteBuilderModel(data?.openrouter_site_model as string | null);
    creditCost = Math.min(500, Math.max(1, Math.floor(Number(data?.ai_site_credit_cost) || DEFAULT_SITE_BUILDER_CREDIT_COST)));
  }
  return { enabled: base.enabled, apiKey: base.apiKey, model, creditCost };
}

export async function siteBuilderAiStatus(supabase: SupabaseClient, ctx: TenantContext) {
  const [config, credits] = await Promise.all([getSiteBuilderAiConfig(), getAiCreditsRemaining(supabase, ctx.organizationId)]);
  return { enabled: config.enabled, model: config.model, creditCost: config.creditCost, creditsRemaining: credits };
}

type StoreContext = {
  storeName: string;
  businessCategory: string | null;
  categories: Array<{ id: string; name: string }>;
  products: Array<{ id: string; name: string; price: number; categoryIds: string[] }>;
  hasCovers: boolean;
  hasBundles: boolean;
  hasWhatsapp: boolean;
};

const SECTION_GUIDE = `Section types and their "settings" keys (all text optional, keep it short and specific to this store):
- hero: { style: "covers" | "intro" | "split" | "statement", title, subtitle, ctaLabel }  (use "covers" only if hasCovers is true)
- trust_badges: { items: [{ title, body }] } up to 4, only true facts (India Post delivery, COD if offered, returns)
- category_grid: { title, eyebrow, style: "tiles" | "round" | "mosaic" | "photo" | "rows", categoryIds: [] }
- featured_products: { title }
- collection: { title, categoryId, limit }  (categoryId from the list)
- promo_banner: { title, body, ctaLabel, ctaHref: "#all-products" or "/category/<slug>", tone: "accent" | "dark" | "light" }
- video_shopping: { title, layout: "grid" | "reels", videos: [{ url, caption, productIds }] }  (ONLY with video URLs the merchant wrote)
- bundles: { title }   (only if hasBundles)
- upsell: { title }
- best_sellers: { title }
- testimonials: { title }   (never write reviews yourself; the merchant adds real ones)
- rich_text: { title, body }  (brand story, 2-4 sentences, no invented facts)
- countdown: { eyebrow, title, body, ctaLabel }  (only if the merchant mentions a sale or drop)
- catalog: { title }  (always last)`;

function systemPrompt(themeIds: string[]) {
  return `You are a senior e-commerce designer building a high-converting Shopify-quality storefront for an Indian D2C merchant on PostBus.
Return ONE JSON object only, no markdown, with keys:
{
  "themeId": one of ${JSON.stringify(themeIds)},
  "tokens": { "accent": "#hex", "secondary": "#hex", "background": "#hex (light)", "ink": "#hex (dark, readable on background)", "font": "geist|inter|manrope|poppins|playfair|dm-serif", "headingFont": same set, "radius": "sharp|rounded|pill", "card": "plain|bordered|elevated", "header": "classic|centered|minimal|inline|split", "density": "comfortable|compact", "mobileNav": boolean },
  "announcement": { "text": "short offer or delivery line", "style": "static|marquee" },
  "sections": [ { "type": "...", "settings": { ... } } ],
  "productPage": { "highlights": [{ "title": "2-4 words", "body": "one short line" }], "guarantee": "one reassuring line", "relatedTitle": "heading" },
  "featuredProductIds": [ up to 8 ids from the product list ],
  "seo": { "title": "under 60 chars", "description": "under 160 chars" },
  "summary": "one sentence describing the design for the merchant"
}
${SECTION_GUIDE}
Design rules:
- 6 to 10 sections, hero first, catalog last. Mix product sections with storytelling for a premium feel.
- Pick colours that fit the brand and category; background must be light and ink dark enough for WCAG AA.
- Write in the merchant's language (English if unclear). Indian context: prices in rupees, COD and India Post delivery are common.
- Only use category and product ids from the lists given. Never invent prices, discounts, reviews, certifications, ratings, deadlines, URLs or claims the merchant did not state.`;
}

function userPrompt(input: z.infer<typeof aiSiteRequestSchema>, store: StoreContext) {
  const category = BUSINESS_CATEGORIES.find((c) => c.id === store.businessCategory)?.label ?? "not set";
  return JSON.stringify({
    merchantBrief: input.prompt,
    storeName: store.storeName,
    businessCategory: category,
    requestedTheme: input.themeId === "auto" ? "choose the best fit" : input.themeId,
    hasCovers: store.hasCovers,
    hasBundles: store.hasBundles,
    hasWhatsapp: store.hasWhatsapp,
    categories: store.categories,
    products: store.products,
  });
}

/** Pulls the first JSON object out of a model reply (tolerates ```json fences and prose). */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new AppError(ERROR_CODES.PROVIDER_ERROR, "The AI reply wasn't a usable design. Try again.");
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const n = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Turns the model's JSON into a safe StoreLayout: unknown keys dropped, ids limited to this
 * merchant's catalog, no invented reviews / videos / images / deadlines, readable colours.
 */
export function buildLayoutFromAi(raw: unknown, store: StoreContext, brief: string, requestedTheme: string, current: StoreLayout | null) {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const themeId = requestedTheme !== "auto" && STORE_THEMES.some((t) => t.id === requestedTheme)
    ? requestedTheme
    : STORE_THEMES.some((t) => t.id === data.themeId) ? String(data.themeId) : "classic";
  const theme = findTheme(themeId);
  const aiTokens = layoutTokensSchema.partial().safeParse(data.tokens);
  let tokens: LayoutTokens = layoutTokensSchema.parse({ ...theme.tokens, ...(aiTokens.success ? stripUndefined(aiTokens.data) : {}) });
  if (contrastRatio(tokens.ink, tokens.background) < 4.5 || luminance(tokens.background) < 0.6) {
    tokens = { ...tokens, background: theme.tokens.background, ink: theme.tokens.ink };
  }

  const categoryIds = new Set(store.categories.map((c) => c.id));
  const productIds = new Set(store.products.map((p) => p.id));
  const briefLower = brief.toLowerCase();
  const rawSections = Array.isArray(data.sections) ? data.sections : [];
  const sections: LayoutSection[] = [];
  for (const item of rawSections.slice(0, 14)) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type as SectionType;
    if (!SECTION_TYPES.includes(type)) continue;
    const settings = { ...(((item as { settings?: unknown }).settings ?? {}) as Record<string, unknown>) };
    if (type === "hero" && settings.style === "covers" && !store.hasCovers) settings.style = "intro";
    if (type === "category_grid") settings.categoryIds = (Array.isArray(settings.categoryIds) ? settings.categoryIds : []).filter((id) => categoryIds.has(String(id)));
    if (type === "collection" && !categoryIds.has(String(settings.categoryId))) continue;
    if (type === "bundles" && !store.hasBundles) continue;
    if (type === "promo_banner") settings.imageUrl = "";
    if (type === "testimonials") settings.items = []; // real reviews only, added by the merchant
    if (type === "countdown") settings.endsAt = null; // no invented deadlines
    if (type === "video_shopping") {
      const videos = (Array.isArray(settings.videos) ? settings.videos : []) as Array<Record<string, unknown>>;
      settings.videos = videos
        .filter((video) => typeof video.url === "string" && briefLower.includes(video.url.toLowerCase()) && videoEmbed(video.url))
        .map((video) => ({ ...video, productIds: (Array.isArray(video.productIds) ? video.productIds : []).filter((id) => productIds.has(String(id))).slice(0, 4) }));
      if (!(settings.videos as unknown[]).length) continue;
    }
    sections.push(makeSection(type, undefined, settings as never));
  }
  if (!sections.some((s) => s.type === "hero")) sections.unshift(makeSection("hero", undefined, { style: store.hasCovers ? "covers" : "intro" }));
  const withoutCatalog = sections.filter((s) => s.type !== "catalog");
  // Keep anything the merchant filled in by hand (reviews, videos, story), hidden, so nothing is lost.
  const kept = (current?.sections ?? []).filter(hasMerchantContent).map((s) => ({ ...s, visible: false }));
  const ordered = normalizeSections([...withoutCatalog, ...kept, makeSection("catalog", "catalog")]);

  const announcement = (data.announcement ?? {}) as Record<string, unknown>;
  const base = storeLayoutSchema.parse({
    themeId,
    tokens,
    sections: ordered,
    header: {
      announcement: { enabled: typeof announcement.text === "string" && announcement.text.trim().length > 0, text: announcement.text, style: announcement.style },
      showCategoryBar: true,
    },
    whatsappButton: { enabled: store.hasWhatsapp },
    productPage: productPageSchema.safeParse(data.productPage).data ?? {},
  });
  const layout: StoreLayout = { ...base, header: themedHeader(base, theme, base.sections) };
  const featured = (Array.isArray(data.featuredProductIds) ? data.featuredProductIds : []).map(String).filter((id) => productIds.has(id)).slice(0, 8);
  const seo = z.object({ title: z.string().trim().max(70).catch(""), description: z.string().trim().max(180).catch("") }).catch({ title: "", description: "" }).parse(data.seo ?? {});
  const summary = typeof data.summary === "string" ? data.summary.trim().slice(0, 240) : "";
  return { layout, featured: [...new Set(featured)], seo, summary };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function loadStoreContext(supabase: SupabaseClient, ctx: TenantContext): Promise<StoreContext> {
  const org = ctx.organizationId;
  const [{ data: settings }, { data: categories }, { data: products }, { count: covers }, { count: bundles }, { data: orgRow }] = await Promise.all([
    supabase.from("storefront_settings").select("store_name, business_category").eq("organization_id", org).maybeSingle(),
    supabase.from("product_categories").select("id, name").eq("organization_id", org).eq("active", true).order("sort_order").limit(30),
    supabase.from("products").select("id, name, price, product_category_members(category_id)").eq("organization_id", org).eq("active", true).eq("store_visible", true).order("created_at", { ascending: false }).limit(40),
    supabase.from("storefront_slides").select("id", { count: "exact", head: true }).eq("organization_id", org).neq("status", "ARCHIVED"),
    supabase.from("storefront_bundles").select("id", { count: "exact", head: true }).eq("organization_id", org),
    supabase.from("organizations").select("name, phone").eq("id", org).maybeSingle(),
  ]);
  return {
    storeName: (settings?.store_name as string | null) || (orgRow?.name as string | null) || ctx.organizationName || "Store",
    businessCategory: (settings?.business_category as string | null) ?? null,
    categories: (categories ?? []).map((row) => ({ id: String(row.id), name: String(row.name) })),
    products: (products ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name).slice(0, 80),
      price: Number(row.price ?? 0),
      categoryIds: ((row as { product_category_members?: Array<{ category_id: string }> }).product_category_members ?? []).map((m) => String(m.category_id)),
    })),
    hasCovers: (covers ?? 0) > 0,
    hasBundles: (bundles ?? 0) > 0,
    hasWhatsapp: Boolean(orgRow?.phone),
  };
}

async function callModel(config: SiteBuilderAiConfig, system: string, user: string) {
  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": openRouterReferer(),
      "X-Title": "PostBus Website Builder",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.7,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const json = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };
  if (!response.ok) {
    const message = (typeof json.error === "object" ? json.error?.message : json.error) || `OpenRouter request failed (${response.status}).`;
    throw new Error(message);
  }
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("The AI returned an empty reply.");
  return content;
}

/** Generates a full store design into the DRAFT. The live store changes only when the merchant publishes. */
export async function generateAiSite(supabase: SupabaseClient, ctx: TenantContext, input: z.infer<typeof aiSiteRequestSchema>) {
  const limited = rateLimit(`ai-site:${ctx.organizationId}`, 6, 10 * 60_000);
  if (!limited.ok) throw new AppError(ERROR_CODES.RATE_LIMITED, "You've generated a few designs in a row. Wait a few minutes and try again.");
  const config = await getSiteBuilderAiConfig();
  if (!config.enabled) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "The AI Website Builder isn't switched on yet. Ask PostBus support to enable it.");
  const credits = await getAiCreditsRemaining(supabase, ctx.organizationId);
  if (credits < config.creditCost) {
    throw new AppError(ERROR_CODES.CONFLICT, credits <= 0 ? ZERO_AI_CREDITS_MESSAGE : `This needs ${config.creditCost} AI credits and you have ${credits}.`);
  }

  const [store, state] = await Promise.all([loadStoreContext(supabase, ctx), getStoreBuilderState(supabase, ctx)]);
  let built: ReturnType<typeof buildLayoutFromAi>;
  try {
    const content = await callModel(config, systemPrompt(STORE_THEMES.map((t) => t.id)), userPrompt(input, store));
    built = buildLayoutFromAi(extractJsonObject(content), store, input.prompt, input.themeId, state.draft.layout);
  } catch (error) {
    if (error instanceof AppError) throw error;
    logError("ai_site.generate_failed", { message: error instanceof Error ? error.message : "unknown", model: config.model });
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Couldn't design your store right now. No credits were used. Try again.");
  }

  const saved = await saveStoreDraft(supabase, ctx, {
    layout: built.layout,
    footer: state.draft.footer,
    featuredProductIds: built.featured.length ? built.featured : state.draft.featuredProductIds,
    expectedDraftUpdatedAt: input.expectedDraftUpdatedAt === undefined ? state.draftUpdatedAt : input.expectedDraftUpdatedAt,
  });
  const remaining = await consumeAiCredit(supabase, ctx.organizationId, {
    reason: AI_CREDIT_REASON_SITE_BUILDER,
    idempotencyKey: input.idempotencyKey ?? null,
    qty: config.creditCost,
  });
  return {
    state: saved,
    seo: built.seo,
    summary: built.summary,
    themeId: built.layout.themeId,
    model: config.model,
    creditsUsed: config.creditCost,
    creditsRemaining: remaining ?? Math.max(0, credits - config.creditCost),
  };
}
