"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Check, Eye, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { BUSINESS_CATEGORIES, installTheme, isRecommended, recommendThemes, type StoreThemeDefinition } from "@/modules/storefront/layout/themes";
import { buildStorefrontPreview, STORE_PREVIEW_PAGE_SIZE, type PreviewBundle, type PreviewCategory } from "@/modules/storefront/preview";
import type { LayoutTokens } from "@/modules/storefront/layout/schema";
import type { Paginated, ProductRecord } from "@/types/api";
import { StorefrontPreviewPane, type PreviewMode } from "./parts";
import { useBuilderMutations, useCanEditStore, useStoreBuilder, useStorefront } from "./use-store-builder";

const FONT_STACK: Record<LayoutTokens["font"], string> = {
  geist: "var(--font-geist-sans), system-ui, sans-serif",
  inter: "Inter, system-ui, sans-serif",
  manrope: "Manrope, system-ui, sans-serif",
  poppins: "Poppins, system-ui, sans-serif",
  playfair: "'Playfair Display', Georgia, serif",
  "dm-serif": "'DM Serif Display', Georgia, serif",
};
const RADIUS: Record<LayoutTokens["radius"], string> = { sharp: "2px", rounded: "8px", pill: "16px" };

/** A small static mock of the theme: header, hero, product cards. Rendered with the theme tokens. */
function ThemeThumbnail({ theme, storeName }: { theme: StoreThemeDefinition; storeName: string }) {
  const t = theme.tokens;
  const radius = RADIUS[t.radius];
  const card: CSSProperties =
    t.card === "elevated" ? { boxShadow: "0 6px 14px -8px rgb(0 0 0 / .35)", background: "#fff" }
      : t.card === "plain" ? { background: "transparent" }
        : { border: "1px solid rgb(0 0 0 / .1)", background: "#fff" };
  return (
    <div aria-hidden className="relative aspect-[4/3] w-full overflow-hidden" style={{ background: t.background, color: t.ink, fontFamily: FONT_STACK[t.font] }}>
      <div className={cn("flex items-center gap-1.5 px-3 py-2", t.header === "centered" && "justify-center", t.header !== "minimal" && "border-b border-black/5 bg-white/70")}>
        <span className="grid size-4 place-items-center text-[8px] font-bold text-white" style={{ background: t.accent, borderRadius: radius }}>{storeName.charAt(0).toUpperCase()}</span>
        <span className="truncate text-[10px] font-bold" style={{ fontFamily: FONT_STACK[t.headingFont] }}>{storeName}</span>
      </div>
      <div className="mx-3 mt-2 flex h-[34%] flex-col justify-end gap-1 p-2" style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.secondary})`, borderRadius: radius }}>
        <span className="h-2 w-2/3 rounded-sm bg-white/90" />
        <span className="h-1.5 w-1/3 rounded-sm bg-white/60" />
      </div>
      <div className={cn("mx-3 mt-2 grid grid-cols-3", t.density === "compact" ? "gap-1" : "gap-1.5")}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="overflow-hidden p-1" style={{ ...card, borderRadius: radius }}>
            <div className="aspect-square w-full" style={{ background: `color-mix(in srgb, ${t.accent} ${12 + i * 6}%, #f4f4f5)`, borderRadius: `calc(${radius} - 2px)` }} />
            <div className="mt-1 h-1 w-3/4 rounded-sm bg-black/20" />
            <div className="mt-1 h-2.5 w-full" style={{ background: t.accent, borderRadius: t.radius === "pill" ? "999px" : radius }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ThemeMarketplace() {
  const router = useRouter();
  const { canWrite } = useCanEditStore();
  const storefront = useStorefront();
  const builder = useStoreBuilder();
  const { saveDraft, setCategory } = useBuilderMutations();
  const [previewTheme, setPreviewTheme] = useState<StoreThemeDefinition | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [installing, setInstalling] = useState<StoreThemeDefinition | null>(null);
  const [keepBrandColors, setKeepBrandColors] = useState(false);
  const [applyLayout, setApplyLayout] = useState(true);
  const categories = useQuery({ queryKey: ["product-categories"], enabled: Boolean(previewTheme), queryFn: () => api<PreviewCategory[]>("/api/v1/inventory/categories") });
  const products = useQuery({
    queryKey: ["products", "storefront-preview"],
    enabled: Boolean(previewTheme),
    queryFn: () => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=${STORE_PREVIEW_PAGE_SIZE}&active=true&storeVisible=true`),
  });
  const bundles = useQuery({ queryKey: ["inventory-bundles"], enabled: Boolean(previewTheme), retry: false, queryFn: () => api<PreviewBundle[]>("/api/v1/inventory/bundles") });

  const category = builder.data?.businessCategory ?? null;
  const themes = useMemo(() => recommendThemes(category), [category]);
  const draftThemeId = builder.data?.draft.layout.themeId;
  const liveThemeId = builder.data?.publishedLayout?.themeId ?? null;
  const storeName = storefront.data?.storeName ?? "Your store";

  const preview = useMemo(() => {
    if (!previewTheme || !storefront.data || !builder.data) return null;
    const layout = installTheme(builder.data.draft.layout, previewTheme, { keepBrandColors, applyLayout });
    return buildStorefrontPreview({
      settings: storefront.data,
      products: products.data?.items ?? [],
      productTotal: products.data?.total,
      categories: categories.data ?? [],
      bundles: bundles.data ?? [],
      drafts: { layout, footer: builder.data.draft.footer, featuredProductIds: builder.data.draft.featuredProductIds },
    });
  }, [applyLayout, builder.data, bundles.data, categories.data, keepBrandColors, previewTheme, products.data, storefront.data]);

  async function install(theme: StoreThemeDefinition) {
    if (!builder.data) return;
    const layout = installTheme(builder.data.draft.layout, theme, { keepBrandColors, applyLayout });
    try {
      await saveDraft.mutateAsync({ ...builder.data.draft, layout, expectedDraftUpdatedAt: builder.data.draftUpdatedAt });
      toast.success(`${theme.name} added to your draft. Customize it, then publish.`);
      setInstalling(null);
      setPreviewTheme(null);
      router.push("/dashboard/store-builder/customize");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not install the theme.");
    }
  }

  if (builder.isError) {
    return <div className="rounded-xl border border-border bg-card p-6 text-center text-sm">Could not load themes. <Button size="xs" variant="ghost" onClick={() => void builder.refetch()}>Retry</Button></div>;
  }

  return (
    <div className="space-y-5">
      <section aria-labelledby="biz-cat" className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="biz-cat" className="text-sm font-semibold">What do you sell?</h2>
            <p className="mt-0.5 text-xs text-muted">We recommend themes designed for your category. You can install any theme.</p>
          </div>
          <div className="w-full sm:w-72">
            <Label htmlFor="business-category" className="sr-only">Business category</Label>
            <select
              id="business-category"
              className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm"
              value={category ?? ""}
              disabled={!canWrite || setCategory.isPending || !builder.data}
              onChange={(event) => setCategory.mutate(event.target.value || null)}
            >
              <option value="">Choose your business category…</option>
              {BUSINESS_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
        </div>
      </section>

      <section aria-labelledby="theme-gallery">
        <h2 id="theme-gallery" className="sr-only">Themes</h2>
        {!builder.data ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="aspect-[4/5] w-full rounded-xl" />)}</div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {themes.map((theme) => {
              const recommended = isRecommended(theme, category);
              const inDraft = draftThemeId === theme.id && builder.data?.draftUpdatedAt;
              const live = liveThemeId === theme.id;
              return (
                <li key={theme.id} className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md">
                  <button type="button" className="relative block w-full text-left focus-visible:outline-2 focus-visible:outline-brand" onClick={() => setPreviewTheme(theme)} aria-label={`Preview ${theme.name}`}>
                    <ThemeThumbnail theme={theme} storeName={storeName} />
                    <span className="absolute left-2 top-2 flex gap-1">
                      {recommended ? <span className="inline-flex items-center gap-1 rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white"><Sparkles className="size-3" />Recommended</span> : null}
                      {live ? <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">Live</span> : null}
                      {inDraft && !live ? <span className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">In draft</span> : null}
                    </span>
                  </button>
                  <div className="flex flex-1 flex-col gap-2 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">{theme.name}</h3>
                      <span className="truncate text-[11px] text-muted">{theme.tagline}</span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted">{theme.description}</p>
                    <ul className="flex flex-wrap gap-1">
                      {theme.highlights.map((item) => <li key={item} className="rounded bg-surface-soft px-1.5 py-0.5 text-[10px] text-muted">{item}</li>)}
                    </ul>
                    <div className="mt-auto flex gap-2 pt-1">
                      <Button type="button" size="xs" variant="secondary" className="flex-1" onClick={() => setPreviewTheme(theme)}><Eye />Preview</Button>
                      {canWrite ? <Button type="button" size="xs" className="flex-1" onClick={() => setInstalling(theme)}>{inDraft ? <><Check />Reinstall</> : "Install"}</Button> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={Boolean(previewTheme)} onOpenChange={(open) => !open && setPreviewTheme(null)}>
        <DialogContent className="max-h-[95vh] w-[min(1100px,96vw)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewTheme?.name} preview</DialogTitle>
            <DialogDescription>Your products, covers and footer in this theme. Nothing is saved until you install.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2"><Switch checked={applyLayout} onCheckedChange={setApplyLayout} aria-label="Use the theme's section layout" />Use the theme’s section layout</label>
            <label className="flex items-center gap-2"><Switch checked={keepBrandColors} onCheckedChange={setKeepBrandColors} aria-label="Keep my brand colours" />Keep my brand colours</label>
          </div>
          {preview && storefront.data ? (
            <StorefrontPreviewPane key={`${previewTheme?.id}-${previewMode}`} store={preview} published initialMode={previewMode} label="Theme preview" note="desktop and mobile · orders can’t be placed here" />
          ) : (
            <Skeleton className="h-[60vh] w-full" />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPreviewMode(previewMode === "desktop" ? "iphone" : "desktop")}>Start in {previewMode === "desktop" ? "mobile" : "desktop"} view</Button>
            {canWrite && previewTheme ? <Button type="button" onClick={() => setInstalling(previewTheme)}>Install {previewTheme.name}</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(installing)} onOpenChange={(open) => !open && setInstalling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install {installing?.name}?</DialogTitle>
            <DialogDescription>
              The theme goes into your draft. Customers keep seeing your current store until you publish. Your products, covers, coupons, bundles, reviews and videos are never deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <label className="flex items-start justify-between gap-3">
              <span><span className="font-medium">Use the theme’s section layout</span><span className="block text-xs text-muted">Reorders sections to match the theme. Sections you filled in that the theme doesn’t use are kept, hidden.</span></span>
              <Switch checked={applyLayout} onCheckedChange={setApplyLayout} aria-label="Use the theme's section layout" />
            </label>
            <label className="flex items-start justify-between gap-3">
              <span><span className="font-medium">Keep my brand colours</span><span className="block text-xs text-muted">Keeps your accent and secondary colour instead of the theme’s.</span></span>
              <Switch checked={keepBrandColors} onCheckedChange={setKeepBrandColors} aria-label="Keep my brand colours" />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setInstalling(null)}>Cancel</Button>
            <Button type="button" disabled={saveDraft.isPending} onClick={() => installing && void install(installing)}>
              {saveDraft.isPending ? <Loader2 className="animate-spin" /> : null}Install to draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
