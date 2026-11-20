"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  GripVertical,
  History,
  Loader2,
  Palette,
  Plus,
  Rocket,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import {
  MAX_SECTIONS,
  SECTION_LABELS,
  SECTION_TYPES,
  SINGLETON_SECTIONS,
  makeSection,
  type LayoutSection,
  type SectionType,
} from "@/modules/storefront/layout/schema";
import { findTheme } from "@/modules/storefront/layout/themes";
import { buildStorefrontPreview, STORE_PREVIEW_PAGE_SIZE, type PreviewBundle, type PreviewCategory } from "@/modules/storefront/preview";
import type { StoreDraft } from "@/modules/storefront/builder";
import type { Paginated, ProductRecord } from "@/types/api";
import { StorefrontFooterForm } from "./storefront-footer-form";
import { StorefrontPreviewPane } from "./parts";
import { HeaderForm, SectionSettingsForm, ThemeTokensForm, WhatsAppButtonForm } from "./section-editors";
import { VersionHistoryDialog } from "./version-history";
import styles from "./store-builder.module.css";
import { useBuilderMutations, useCanEditStore, useStoreBuilder, useStorefront } from "./use-store-builder";

type Panel = "sections" | "theme" | "header" | "footer" | "whatsapp";
const PANELS: Array<{ id: Panel; label: string }> = [
  { id: "sections", label: "Sections" },
  { id: "theme", label: "Theme" },
  { id: "header", label: "Header" },
  { id: "footer", label: "Footer" },
  { id: "whatsapp", label: "WhatsApp" },
];
const AUTOSAVE_MS = 1200;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sectionTitle(section: LayoutSection) {
  const title = (section.settings as { title?: string }).title;
  return title || SECTION_LABELS[section.type].label;
}

export function StoreCustomizer() {
  const { canWrite } = useCanEditStore();
  const storefront = useStorefront();
  const builder = useStoreBuilder();
  const { saveDraft, publish, discard } = useBuilderMutations();
  const categories = useQuery({ queryKey: ["product-categories"], queryFn: () => api<PreviewCategory[]>("/api/v1/inventory/categories") });
  const products = useQuery({
    queryKey: ["products", "storefront-preview"],
    queryFn: () => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=${STORE_PREVIEW_PAGE_SIZE}&active=true&storeVisible=true`),
  });
  const bundles = useQuery({ queryKey: ["inventory-bundles"], retry: false, queryFn: () => api<PreviewBundle[]>("/api/v1/inventory/bundles") });

  const [draft, setDraft] = useState<StoreDraft | null>(null);
  const [panel, setPanel] = useState<Panel>("sections");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const savedRef = useRef<StoreDraft | null>(null);
  const versionRef = useRef<string | null>(null);

  // Adopt the server draft on first load and whenever the server state is replaced (publish, discard, restore).
  const serverDraft = builder.data?.draft;
  const serverVersion = builder.data?.draftUpdatedAt ?? null;
  useEffect(() => {
    if (!serverDraft) return;
    const pending = draft && savedRef.current && !same(draft, savedRef.current);
    if (pending && serverVersion === versionRef.current) return;
    if (pending && saveDraft.isPending) return;
    savedRef.current = serverDraft;
    versionRef.current = serverVersion;
    if (!pending) setDraft(serverDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the server copy changes.
  }, [serverDraft, serverVersion]);

  const dirty = Boolean(draft && savedRef.current && !same(draft, savedRef.current));

  const flush = useCallback(
    async (next: StoreDraft | null = draft) => {
      if (!next || !canWrite || (savedRef.current && same(next, savedRef.current))) return true;
      try {
        const state = await saveDraft.mutateAsync({ ...next, expectedDraftUpdatedAt: versionRef.current });
        savedRef.current = next;
        versionRef.current = state.draftUpdatedAt;
        setConflict(false);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save the draft.";
        if (/changed this draft/i.test(message)) setConflict(true);
        else toast.error(message);
        return false;
      }
    },
    [canWrite, draft, saveDraft]
  );

  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [conflict, dirty, draft, flush]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (patch: Partial<StoreDraft["layout"]>) => setDraft((current) => (current ? { ...current, layout: { ...current.layout, ...patch } } : current));
  const setSections = (sections: LayoutSection[]) => update({ sections });

  const preview = useMemo(() => {
    if (!storefront.data || !draft) return null;
    return buildStorefrontPreview({
      settings: storefront.data,
      products: products.data?.items ?? [],
      productTotal: products.data?.total,
      categories: categories.data ?? [],
      bundles: bundles.data ?? [],
      drafts: { layout: draft.layout, footer: draft.footer, featuredProductIds: draft.featuredProductIds },
    });
  }, [bundles.data, categories.data, draft, products.data, storefront.data]);
  const deferredPreview = useDeferredValue(preview);

  if (storefront.isError || builder.isError) {
    const error = storefront.error ?? builder.error;
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <AlertTriangle className="mx-auto size-6 text-amber-500" aria-hidden />
        <p className="mt-2 font-semibold">Could not load the store editor.</p>
        <p className="mt-1 text-xs text-muted">{error instanceof Error ? error.message : "Please try again."}</p>
        <Button className="mt-3" size="sm" onClick={() => { void storefront.refetch(); void builder.refetch(); }}>Retry</Button>
      </div>
    );
  }
  if (!draft || !storefront.data || !deferredPreview || !builder.data) {
    return (
      <div role="status" aria-label="Loading store editor" className="grid gap-5 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /><Skeleton className="h-40 w-full" /></div>
        <Skeleton className="h-[min(72vh,760px)] w-full" />
      </div>
    );
  }

  const sections = draft.layout.sections;
  const selected = sections.find((section) => section.id === selectedId) ?? null;
  const theme = findTheme(draft.layout.themeId);
  const state = builder.data;
  const editorCategories = (categories.data ?? []).filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }));
  const unpublished = state.hasUnpublishedChanges || dirty;
  const switchingToBuilder = !state.publishedLayout;

  function move(index: number, to: number) {
    if (to < 0 || to >= sections.length || index === to) return;
    const next = [...sections];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    setSections(next);
  }
  function addSection(type: SectionType) {
    if (sections.length >= MAX_SECTIONS) return;
    const section = makeSection(type);
    const catalogIndex = sections.findIndex((s) => s.type === "catalog");
    const next = [...sections];
    next.splice(catalogIndex === -1 ? next.length : catalogIndex, 0, section);
    setSections(next);
    setSelectedId(section.id);
  }
  function onDrop(event: DragEvent, targetId: string) {
    event.preventDefault();
    if (!dragId) return;
    move(sections.findIndex((s) => s.id === dragId), sections.findIndex((s) => s.id === targetId));
    setDragId(null);
  }

  async function doPublish() {
    if (!(await flush())) return;
    try {
      await publish.mutateAsync(versionRef.current);
      setConfirmPublish(false);
      toast.success("Published. Your store is updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not publish.");
    }
  }

  const addable = SECTION_TYPES.filter((type) => !(SINGLETON_SECTIONS.includes(type) && sections.some((s) => s.type === type)));

  return (
    <div className="w-full min-w-0">
      {/* Sticky action bar: draft status, history, discard, publish. */}
      <div className="sticky top-0 z-20 -mx-1 mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-soft px-2 py-1 font-medium"><Palette className="size-3.5" aria-hidden />{theme.name}</span>
          <span role="status" aria-live="polite" className="flex items-center gap-1 text-muted">
            {saveDraft.isPending ? <><Loader2 className="size-3 animate-spin" />Saving draft…</>
              : conflict ? <span className="flex items-center gap-1 text-red-600"><X className="size-3" />Changed elsewhere</span>
                : dirty ? <>Unsaved changes</>
                  : unpublished ? <><Check className="size-3" />Draft saved · not published</>
                    : <><Check className="size-3" />Published</>}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={() => setHistoryOpen(true)}><History />History</Button>
          {canWrite && unpublished && state.draftUpdatedAt ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmDiscard(true)}><Undo2 />Discard</Button>
          ) : null}
          {canWrite ? (
            <Button type="button" size="xs" variant="secondary" disabled={!dirty || saveDraft.isPending} onClick={() => void flush().then((ok) => ok && toast.success("Draft saved."))}>Save draft</Button>
          ) : null}
          {canWrite ? (
            <Button type="button" size="xs" disabled={!unpublished || publish.isPending || conflict} onClick={() => setConfirmPublish(true)}>
              {publish.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}Publish
            </Button>
          ) : null}
        </div>
      </div>

      {conflict ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          <span>Someone else changed this draft. Reload to see their version (your unsaved edits here will be replaced).</span>
          <Button size="xs" variant="secondary" onClick={() => { setConflict(false); savedRef.current = null; void builder.refetch().then((r) => { if (r.data) { savedRef.current = r.data.draft; versionRef.current = r.data.draftUpdatedAt; setDraft(r.data.draft); } }); }}>Reload draft</Button>
        </div>
      ) : null}
      {!canWrite ? <p className="mb-3 rounded-lg bg-surface-soft px-3 py-2 text-xs text-muted">You can view the store design. Ask an owner, admin or manager to make changes.</p> : null}

      <div className="grid w-full min-w-0 gap-5 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className={styles.editor}>
          <div role="tablist" aria-label="Editor panels" className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface-soft p-1">
            {PANELS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={panel === item.id} onClick={() => setPanel(item.id)}
                className={cn("h-8 shrink-0 rounded-md px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand", panel === item.id ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink")}>
                {item.label}
              </button>
            ))}
          </div>

          <fieldset disabled={!canWrite} className="mt-1">
            {panel === "sections" ? (
              <section aria-labelledby="sections-title">
                {selected ? (
                  <div>
                    <Button type="button" size="xs" variant="ghost" className="-ml-2 mb-2" onClick={() => setSelectedId(null)}>← All sections</Button>
                    <SectionSettingsForm
                      section={selected}
                      categories={editorCategories}
                      featuredIds={draft.featuredProductIds}
                      featuredKnown={storefront.data.featuredProducts}
                      onSettings={(settings) => setSections(sections.map((s) => (s.id === selected.id ? { ...s, settings } : s)))}
                      onFeatured={(featuredProductIds) => setDraft({ ...draft, featuredProductIds })}
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 id="sections-title" className="text-sm font-semibold">Home page sections</h3>
                      <span className="text-[11px] tabular-nums text-muted">{sections.length}/{MAX_SECTIONS}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">Drag or use the arrows to reorder. Hidden sections stay saved.</p>
                    <ol className="mt-3 space-y-1">
                      {sections.map((section, index) => (
                        <li
                          key={section.id}
                          draggable={canWrite}
                          onDragStart={() => setDragId(section.id)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => onDrop(event, section.id)}
                          onDragEnd={() => setDragId(null)}
                          className={cn("flex min-h-11 items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-1", dragId === section.id && "opacity-50", !section.visible && "bg-surface-soft")}
                        >
                          <GripVertical className="size-4 shrink-0 cursor-grab text-muted" aria-hidden />
                          <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-brand" onClick={() => setSelectedId(section.id)}>
                            <span className={cn(!section.visible && "text-muted line-through")}>{sectionTitle(section)}</span>
                            <span className="block truncate text-[11px] font-normal text-muted">{SECTION_LABELS[section.type].label}</span>
                          </button>
                          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${sectionTitle(section)} up`} disabled={index === 0} onClick={() => move(index, index - 1)}><ArrowUp /></Button>
                          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${sectionTitle(section)} down`} disabled={index === sections.length - 1} onClick={() => move(index, index + 1)}><ArrowDown /></Button>
                          {section.type !== "catalog" ? (
                            <>
                              <Button type="button" size="icon-xs" variant="ghost" aria-pressed={!section.visible} aria-label={section.visible ? `Hide ${sectionTitle(section)}` : `Show ${sectionTitle(section)}`}
                                onClick={() => setSections(sections.map((s) => (s.id === section.id ? { ...s, visible: !s.visible } : s)))}>
                                {section.visible ? <Eye /> : <EyeOff />}
                              </Button>
                              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${sectionTitle(section)}`} onClick={() => setSections(sections.filter((s) => s.id !== section.id))}><Trash2 /></Button>
                            </>
                          ) : <span className="w-14 shrink-0 text-center text-[10px] text-muted">Required</span>}
                        </li>
                      ))}
                    </ol>
                    {canWrite ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" size="xs" variant="secondary" className="mt-3" disabled={sections.length >= MAX_SECTIONS}><Plus />Add section</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
                          {addable.filter((type) => type !== "catalog").map((type) => (
                            <DropdownMenuItem key={type} onSelect={() => addSection(type)} className="flex-col items-start gap-0">
                              <span className="text-xs font-medium">{SECTION_LABELS[type].label}</span>
                              <span className="text-[11px] text-muted">{SECTION_LABELS[type].description}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}

            {panel === "theme" ? (
              <section aria-labelledby="theme-title">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 id="theme-title" className="text-sm font-semibold">{theme.name} theme</h3>
                    <p className="mt-1 text-xs text-muted">{theme.description}</p>
                  </div>
                  <Link href="/dashboard/store-builder/themes" className={cn(buttonVariants({ size: "xs", variant: "secondary" }), "shrink-0")}>Change theme</Link>
                </div>
                <div className="mt-4"><ThemeTokensForm tokens={draft.layout.tokens} onChange={(tokens) => update({ tokens })} /></div>
              </section>
            ) : null}

            {panel === "header" ? (
              <section aria-label="Header and navigation">
                <HeaderForm header={draft.layout.header} sections={sections} categories={editorCategories} onChange={(header) => update({ header })} />
                <p className="mt-3 text-xs text-muted">Store name and logo are in <Link href="/dashboard/store-builder/settings" className="text-brand underline">Settings</Link> and update right away.</p>
              </section>
            ) : null}

            {panel === "footer" ? (
              <section aria-label="Footer">
                <StorefrontFooterForm value={draft.footer} disabled={!canWrite} onChange={(footer) => setDraft({ ...draft, footer })} onCommit={(footer) => setDraft({ ...draft, footer })} />
              </section>
            ) : null}

            {panel === "whatsapp" ? (
              <section aria-label="WhatsApp button">
                <WhatsAppButtonForm value={draft.layout.whatsappButton} phone={storefront.data.whatsappPhone} onChange={(whatsappButton) => update({ whatsappButton })} />
              </section>
            ) : null}
          </fieldset>
        </div>

        <aside className="w-full min-w-0 lg:sticky lg:top-14 lg:self-start">
          <StorefrontPreviewPane store={deferredPreview} published={storefront.data.published} label="Draft preview" note="your draft · customers see it after you publish" />
        </aside>
      </div>

      <Dialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish your store design?</DialogTitle>
            <DialogDescription>
              Customers will see the <span className="font-medium text-ink">{theme.name}</span> theme with {sections.filter((s) => s.visible).length} visible sections, your footer and {draft.featuredProductIds.length} featured products.
              {switchingToBuilder ? " Your store switches from the classic layout to this design. You can switch back from Settings at any time." : " The current live version is kept in History so you can restore it."}
            </DialogDescription>
          </DialogHeader>
          {!storefront.data.published ? <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">Your store is hidden, so customers won’t see it until you turn on Store visible in Settings.</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmPublish(false)}>Cancel</Button>
            <Button type="button" disabled={publish.isPending} onClick={() => void doPublish()}>{publish.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard draft changes?</DialogTitle>
            <DialogDescription>The editor goes back to what customers see now. Published versions in History are not affected.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button type="button" className="bg-red-600 hover:bg-red-700" disabled={discard.isPending} onClick={() => discard.mutate(undefined, {
              onSuccess: (next) => { savedRef.current = next.draft; versionRef.current = next.draftUpdatedAt; setDraft(next.draft); setSelectedId(null); setConfirmDiscard(false); toast.success("Draft discarded."); },
              onError: (error) => toast.error(error.message),
            })}>Discard draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VersionHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} canWrite={canWrite} onRestored={(next) => { savedRef.current = next.draft; versionRef.current = next.draftUpdatedAt; setDraft(next.draft); setSelectedId(null); }} />
    </div>
  );
}
