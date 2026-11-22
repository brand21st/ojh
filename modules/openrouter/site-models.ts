import { env } from "@/lib/env";

/**
 * Models for the AI Website Builder. Google Gemini on OpenRouter: long JSON output, fast and
 * cheap enough for whole-page generation. The super admin picks one in Admin → Settings.
 */
export const DEFAULT_SITE_BUILDER_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_SITE_BUILDER_CREDIT_COST = 20;

export type SiteBuilderModel = { id: string; name: string };

export const GEMINI_SITE_MODELS: SiteBuilderModel[] = [
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
];

/** Text Gemini models only: image, audio and embedding variants can't write a site layout. */
export function isGeminiSiteModel(id: string) {
  const model = id.trim();
  return /^google\/gemini-[a-z0-9.\-:]+$/i.test(model) && !/image|embedding|audio|tts|live|vision-only/i.test(model) && model.length <= 80;
}

export function sanitizeSiteBuilderModel(value?: string | null) {
  const model = String(value ?? "").trim();
  return isGeminiSiteModel(model) ? model : DEFAULT_SITE_BUILDER_MODEL;
}

export function mergeSiteModels(live: SiteBuilderModel[], selected?: string | null): SiteBuilderModel[] {
  const byId = new Map(GEMINI_SITE_MODELS.map((model) => [model.id, model]));
  for (const model of live) if (isGeminiSiteModel(model.id) && !byId.has(model.id)) byId.set(model.id, model);
  const chosen = selected?.trim();
  if (chosen && isGeminiSiteModel(chosen) && !byId.has(chosen)) byId.set(chosen, { id: chosen, name: chosen.replace(/^google\//, "") });
  const curated = GEMINI_SITE_MODELS.map((model) => byId.get(model.id)!);
  const rest = [...byId.values()].filter((model) => !GEMINI_SITE_MODELS.some((c) => c.id === model.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [...curated, ...rest];
}

export async function fetchGeminiSiteModels(apiKey?: string): Promise<SiteBuilderModel[]> {
  try {
    const headers: Record<string, string> = { "HTTP-Referer": (env.appUrl || "https://postbus.in").replace(/\/$/, ""), "X-Title": "PostBus" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch("https://openrouter.ai/api/v1/models", { headers, signal: AbortSignal.timeout(12000) });
    const json = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string; name?: string }> };
    if (!response.ok || !Array.isArray(json.data)) return [];
    return json.data
      .map((row) => ({ id: String(row.id ?? "").trim(), name: String(row.name ?? "").replace(/^Google:\s*/i, "").trim() }))
      .filter((row) => isGeminiSiteModel(row.id));
  } catch {
    return [];
  }
}
