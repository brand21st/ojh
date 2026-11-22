"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Paintbrush, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { STORE_THEMES, findTheme } from "@/modules/storefront/layout/themes";
import { buildStorefrontPreview, STORE_PREVIEW_PAGE_SIZE, type PreviewBundle, type PreviewCategory } from "@/modules/storefront/preview";
import type { StoreBuilderState } from "@/modules/storefront/builder";
import type { Paginated, ProductRecord } from "@/types/api";
import { StorefrontPreviewPane } from "./parts";
import { BUILDER_KEY, STOREFRONT_KEY, useCanEditStore, useStoreBuilder, useStorefront, useStorefrontSave } from "./use-store-builder";

const PROMPT_MAX = 1200;
const EXAMPLES = [
  "Handwoven Kerala kasavu sarees and set-mundu for Onam. Elegant, gold and cream, trust-building for first-time buyers. COD available.",
  "Ayurvedic skincare made in small batches with cold-pressed oils. Calm, natural look. Highlight ingredients and gentle routines.",
  "Trendy mobile accessories and chargers for students. Bold, fast, lots of products, show best sellers and combo offers.",
  "Handmade home decor and brass diyas for festive gifting. Warm, premium, gift-ready packaging, ships across India.",
  "Homemade Kerala snacks and pickles. Friendly and colourful, show categories as round icons, quick reorder.",
];
const STEPS = ["Reading your catalog", "Choosing a theme and colours", "Writing your home page", "Writing your product page", "Checking readability"];

type AiStatus = { enabled: boolean; model: string; creditCost: number; creditsRemaining: number };
type AiResult = {
  state: StoreBuilderState;
  seo: { title: string; description: string };
  summary: string;
  themeId: string;
  model: string;
  creditsUsed: number;
  creditsRemaining: number;
};

function modelLabel(id: string) {
  return id.replace(/^google\//, "").replace(/-/g, " ").replace(/\b(\w)/g, (m) => m.toUpperCase()).replace(/^Gemini/, "Gemini");
}

export function AiWebsiteBuilder() {
  const queryClient = useQueryClient();
  const { canWrite } = useCanEditStore();
  const storefront = useStorefront();
  const builder = useStoreBuilder();
  const saveSettings = useStorefrontSave();
  const status = useQuery({ queryKey: ["store-builder", "ai-status"], queryFn: () => api<AiStatus>("/api/v1/inventory/storefront/builder/ai") });
  const [prompt, setPrompt] = useState("");
  const [themeId, setThemeId] = useState("auto");
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<AiResult | null>(null);
  const [seoApplied, setSeoApplied] = useState(false);

  const generate = useMutation({
    mutationFn: () =>
      api<AiResult>("/api/v1/inventory/storefront/builder/ai", {
        method: "POST",
        body: JSON.stringify({ prompt, themeId, idempotencyKey: crypto.randomUUID(), expectedDraftUpdatedAt: builder.data?.draftUpdatedAt ?? null }),
      }),
    onSuccess: (data) => {
      setResult(data);
      setSeoApplied(false);
      queryClient.setQueryData(BUILDER_KEY, data.state);
      void queryClient.invalidateQueries({ queryKey: ["store-builder", "ai-status"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-credits"] });
      toast.success("Your new store design is ready in your draft.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Progress messages while the model works (typically 15-40 seconds).
  useEffect(() => {
    if (!generate.isPending) return;
    setStep(0);
    const timer = window.setInterval(() => setStep((current) => Math.min(current + 1, STEPS.length - 1)), 6000);
    return () => window.clearInterval(timer);
  }, [generate.isPending]);

  const categories = useQuery({ queryKey: ["product-categories"], enabled: Boolean(result), queryFn: () => api<PreviewCategory[]>("/api/v1/inventory/categories") });
  const products = useQuery({
    queryKey: ["products", "storefront-preview"],
    enabled: Boolean(result),
    queryFn: () => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=${STORE_PREVIEW_PAGE_SIZE}&active=true&storeVisible=true`),
  });
  const bundles = useQuery({ queryKey: ["inventory-bundles"], enabled: Boolean(result), retry: false, queryFn: () => api<PreviewBundle[]>("/api/v1/inventory/bundles") });
  const preview = useMemo(() => {
    if (!result || !storefront.data) return null;
    const draft = result.state.draft;
    return buildStorefrontPreview({
      settings: { ...storefront.data, seoDescription: result.seo.description || storefront.data.seoDescription },
      products: products.data?.items ?? [],
      productTotal: products.data?.total,
      categories: categories.data ?? [],
      bundles: bundles.data ?? [],
      drafts: { layout: draft.layout, footer: draft.footer, featuredProductIds: draft.featuredProductIds },
    });
  }, [bundles.data, categories.data, products.data, result, storefront.data]);

  const info = status.data;
  const short = info ? info.creditsRemaining < info.creditCost : false;
  const disabled = !canWrite || !info?.enabled || short || prompt.trim().length < 10 || generate.isPending;

  return (
    <div className="space-y-4">
      <section aria-labelledby="ai-title" className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="bg-[radial-gradient(120%_120%_at_0%_0%,rgba(225,29,72,0.12),transparent_55%),radial-gradient(120%_120%_at_100%_0%,rgba(124,58,237,0.12),transparent_55%)] p-5 sm:p-6">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-card/80 px-2.5 py-1 text-[11px] font-semibold text-brand ring-1 ring-border"><Sparkles className="size-3.5" aria-hidden />AI Website Builder</p>
          <h2 id="ai-title" className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">Describe your brand. Get a complete store.</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">AI designs your home page and product page with sections, colours, fonts and copy, using your real products and categories. It goes into your draft, so you can edit everything before customers see it.</p>
        </div>

        <div className="grid gap-4 p-5 sm:p-6">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="ai-prompt">What do you sell, and how should the store feel?</Label>
              <span className="text-[11px] tabular-nums text-muted">{prompt.length}/{PROMPT_MAX}</span>
            </div>
            <Textarea
              id="ai-prompt"
              className="mt-1.5 min-h-32 resize-y text-sm"
              maxLength={PROMPT_MAX}
              value={prompt}
              disabled={!canWrite || generate.isPending}
              placeholder="Example: Handloom cotton sarees from Kerala for women 25-45. Premium but warm. Free shipping above ₹999, COD available. Show categories as round icons and add a festive offer banner."
              onChange={(event) => setPrompt(event.target.value)}
              aria-describedby="ai-prompt-hint"
            />
            <p id="ai-prompt-hint" className="mt-1 text-xs text-muted">Mention your audience, mood, offers, and any YouTube Shorts links you want in a shoppable video section.</p>
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Example prompts">
              {EXAMPLES.map((example) => (
                <button key={example} type="button" disabled={!canWrite || generate.isPending} onClick={() => setPrompt(example)}
                  className="max-w-full truncate rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-brand hover:text-ink disabled:opacity-50 sm:max-w-[18rem]">
                  {example.split(".")[0]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_1fr] sm:items-end">
            <div>
              <Label htmlFor="ai-theme">Theme</Label>
              <select id="ai-theme" className="mt-1.5 h-9 w-full rounded-md border border-border bg-card px-2 text-sm" value={themeId} disabled={generate.isPending} onChange={(event) => setThemeId(event.target.value)}>
                <option value="auto">Let AI choose the best theme</option>
                {STORE_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.name} · {theme.tagline}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
              <p className="text-xs text-muted" aria-live="polite">
                {status.isPending ? "Checking AI credits…" : info ? <>Uses <strong className="text-ink">{info.creditCost}</strong> AI credits · you have <strong className={cn(short ? "text-red-600" : "text-ink")}>{info.creditsRemaining}</strong> · {modelLabel(info.model)}</> : null}
              </p>
              <Button type="button" disabled={disabled} onClick={() => generate.mutate()} className="min-w-44">
                {generate.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />}{generate.isPending ? "Designing…" : result ? "Generate again" : "Generate my store"}
              </Button>
            </div>
          </div>

          {info && !info.enabled ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />The AI Website Builder isn&apos;t switched on for PostBus yet. Ask support to enable it.</p>
          ) : null}
          {short ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />Not enough AI credits. <Link href="/dashboard/billing" className="font-medium underline">Buy AI credits</Link></p>
          ) : null}
          {builder.data?.hasUnpublishedChanges && !result ? (
            <p className="text-xs text-muted">Generating replaces your current unpublished draft. Anything you wrote yourself (reviews, videos, brand story) is kept as hidden sections, and your live store doesn&apos;t change until you publish.</p>
          ) : null}

          {generate.isPending ? (
            <ol className="grid gap-1.5 rounded-xl border border-border bg-surface-soft p-3" aria-live="polite" aria-label="Progress">
              {STEPS.map((label, index) => (
                <li key={label} className={cn("flex items-center gap-2 text-xs", index > step && "text-muted")}>
                  {index < step ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : index === step ? <Loader2 className="size-3.5 animate-spin text-brand" aria-hidden /> : <span aria-hidden className="size-3.5 rounded-full border border-border" />}
                  {label}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </section>

      {result ? (
        <section aria-labelledby="ai-result" className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 id="ai-result" className="text-sm font-semibold">Your new design</h3>
              <p className="mt-1 text-xs text-muted">{findTheme(result.themeId).name} theme · {result.state.draft.layout.sections.filter((s) => s.visible).length} sections · {result.creditsUsed} credits used</p>
              {result.summary ? <p className="mt-2 text-sm">{result.summary}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/dashboard/store-builder/customize" className={buttonVariants({ size: "sm" })}><Paintbrush />Edit and publish</Link>
                <Button type="button" size="sm" variant="secondary" disabled={generate.isPending || !canWrite} onClick={() => generate.mutate()}><RefreshCw />Try another</Button>
              </div>
              <p className="mt-2 text-[11px] text-muted">Saved as a draft. Customers see it only after you publish.</p>
            </div>
            {result.seo.title || result.seo.description ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">Suggested search listing</h3>
                <p className="mt-2 truncate text-sm text-[#1a0dab] dark:text-sky-400">{result.seo.title}</p>
                <p className="line-clamp-3 text-xs text-muted">{result.seo.description}</p>
                <Button type="button" size="xs" variant="secondary" className="mt-3" disabled={seoApplied || saveSettings.isPending || !canWrite}
                  onClick={() => saveSettings.mutate({ seoTitle: result.seo.title || null, seoDescription: result.seo.description || null }, {
                    onSuccess: () => { setSeoApplied(true); void queryClient.invalidateQueries({ queryKey: STOREFRONT_KEY }); toast.success("Search listing updated."); },
                  })}>
                  {seoApplied ? <><Check />Applied</> : "Use this listing"}
                </Button>
                <p className="mt-1 text-[11px] text-muted">This changes your live search title and description right away.</p>
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            {preview ? <StorefrontPreviewPane store={preview} published={storefront.data?.published ?? true} label="AI design preview" note="tap a product to see the product page" initialMode="desktop" /> : <Skeleton className="h-[60vh] w-full" />}
          </div>
        </section>
      ) : null}
    </div>
  );
}
