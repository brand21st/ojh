"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ShopifyLogo } from "@/components/brand/shopify-logo";
import { WooCommerceLogo } from "@/components/brand/woocommerce-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Source = "shopify" | "woocommerce";
type LiveSync = { enabled: boolean; available: boolean; lastEventAt: string | null; lastError: string | null };
type SourceSummary = { source: Source; name: string; connected: boolean; storeLabel: string; liveSync?: LiveSync };
type BatchResult = {
  created: number;
  skipped: number;
  failed: number;
  categoriesCreated: number;
  nextCursor: string | null;
  done: boolean;
  errors: string[];
};
type Totals = { created: number; skipped: number; failed: number; categoriesCreated: number; errors: string[] };

const EMPTY: Totals = { created: 0, skipped: 0, failed: 0, categoriesCreated: 0, errors: [] };

function SourceLogo({ source }: { source: Source }) {
  return source === "shopify" ? <ShopifyLogo className="h-6" /> : <WooCommerceLogo className="h-6" />;
}

export function StoreImportButton() {
  const [open, setOpen] = useState(false);
  const sources = useQuery({
    queryKey: ["inventory-import-sources"],
    queryFn: () => api<{ sources: SourceSummary[] }>("/api/v1/inventory/import/sources"),
    staleTime: 60_000,
  });
  const connected = (sources.data?.sources ?? []).filter((source) => source.connected);
  const liveCount = connected.filter((source) => source.liveSync?.enabled).length;

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {liveCount ? <RefreshCw className="size-4 text-emerald-600" aria-label="Live sync on" /> : <Download className="size-4" />}
        {liveCount ? "Store sync" : "Import from store"}
        {connected.length ? (
          <span className="ml-1 flex items-center gap-1" aria-hidden>
            {connected.map((source) => (
              <SourceLogo key={source.source} source={source.source} />
            ))}
          </span>
        ) : null}
      </Button>
      {open ? (
        <StoreImportDialog
          sources={connected}
          loading={sources.isLoading}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function StoreImportDialog({
  sources,
  loading,
  onOpenChange,
}: {
  sources: SourceSummary[];
  loading: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Source | null>(null);
  const [includeImages, setIncludeImages] = useState(true);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [totals, setTotals] = useState<Totals>(EMPTY);
  const stopRef = useRef(false);
  const source = picked ?? (sources.length === 1 ? sources[0].source : null);
  const sourceName = sources.find((entry) => entry.source === source)?.name ?? "your store";

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    void queryClient.invalidateQueries({ queryKey: ["product-categories"] });
    void queryClient.invalidateQueries({ queryKey: ["inventory-analytics"] });
    void queryClient.invalidateQueries({ queryKey: ["inventory-overview"] });
  }

  async function start() {
    if (!source) return;
    stopRef.current = false;
    setRunning(true);
    setFinished(false);
    setTotals(EMPTY);
    let cursor: string | null = null;
    let sum: Totals = EMPTY;
    try {
      do {
        const batch: BatchResult = await api<BatchResult>("/api/v1/inventory/import", {
          method: "POST",
          body: JSON.stringify({ source, cursor, includeImages }),
        });
        sum = {
          created: sum.created + batch.created,
          skipped: sum.skipped + batch.skipped,
          failed: sum.failed + batch.failed,
          categoriesCreated: sum.categoriesCreated + batch.categoriesCreated,
          errors: [...sum.errors, ...batch.errors].slice(0, 5),
        };
        setTotals(sum);
        refresh();
        cursor = batch.done ? null : batch.nextCursor;
      } while (cursor && !stopRef.current);
      setFinished(true);
      toast.success(
        stopRef.current
          ? `Import stopped. ${sum.created} products added.`
          : `Imported ${sum.created} products from ${sourceName}.`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed.");
      if (sum.created || sum.categoriesCreated) setFinished(true);
    } finally {
      setRunning(false);
      refresh();
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (running ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import products and categories</DialogTitle>
          <DialogDescription>
            Copy your catalogue from a connected store. Products whose SKU already exists here are skipped, so you can run this again
            safely.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="h-24 animate-pulse rounded-lg bg-surface-soft motion-reduce:animate-none" role="status" aria-label="Loading stores" />
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
            <PlugZap className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No store connected yet</p>
              <p className="text-sm text-muted-foreground">Connect Shopify or WooCommerce, then come back to import your products.</p>
            </div>
            <Link href="/dashboard/integrations" className={buttonVariants({ size: "sm" })}>
              Go to Integrations
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2" role="radiogroup" aria-label="Store to import from">
              {sources.map((entry) => {
                const active = entry.source === source;
                return (
                  <button
                    key={entry.source}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={running}
                    onClick={() => setPicked(entry.source)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-60",
                      active ? "border-brand bg-brand/5" : "hover:bg-surface-soft"
                    )}
                  >
                    <SourceLogo source={entry.source} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{entry.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{entry.storeLabel || "Connected"}</span>
                    </span>
                    {active ? <CheckCircle2 className="size-5 text-brand" /> : null}
                  </button>
                );
              })}
            </div>

            <LiveSyncSettings sources={sources} disabled={running} />

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="import-images" className="text-sm font-normal">
                Import product photos (up to 3 each)
              </Label>
              <Switch id="import-images" checked={includeImages} disabled={running} onCheckedChange={setIncludeImages} />
            </div>

            {running || finished ? (
              <div className="space-y-2 rounded-lg bg-surface-soft p-3 text-sm" aria-live="polite">
                <div className="flex items-center gap-2 font-medium">
                  {running ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
                  {running ? `Importing from ${sourceName}…` : "Import finished"}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums sm:grid-cols-4">
                  <div><dt className="text-xs text-muted-foreground">Added</dt><dd>{totals.created}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Already here</dt><dd>{totals.skipped}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Failed</dt><dd>{totals.failed}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">New categories</dt><dd>{totals.categoriesCreated}</dd></div>
                </dl>
                {totals.errors.length ? (
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-600">
                    {totals.errors.map((message, index) => <li key={index}>{message}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {running ? (
            <Button type="button" variant="secondary" onClick={() => { stopRef.current = true; }}>
              Stop after this batch
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {finished ? "Close" : "Cancel"}
            </Button>
          )}
          {sources.length ? (
            <Button type="button" disabled={!source || running} onClick={() => void start()}>
              {running ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Download className="size-4" />}
              {finished ? "Import again" : "Start import"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LiveSyncSettings({ sources, disabled }: { sources: SourceSummary[]; disabled: boolean }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (input: { source: Source; enabled: boolean }) =>
      api<{ warning: string | null }>("/api/v1/inventory/import/live-sync", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["inventory-import-sources"] });
      if (result.warning) toast.warning(result.warning);
      else toast.success(input.enabled ? "Live sync is on. New products and stock changes will sync automatically." : "Live sync is off.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not change live sync."),
  });

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">Keep in sync automatically</p>
        <p className="text-xs text-muted-foreground">
          New and edited store products appear here, and stock stays the same on both sides. Store details (name, price, photos)
          win; stock changes made in PostBus are sent to the store.
        </p>
      </div>
      {sources.map((entry) => {
        const state = entry.liveSync;
        const id = `live-sync-${entry.source}`;
        const pending = toggle.isPending && toggle.variables?.source === entry.source;
        return (
          <div key={entry.source} className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={id} className="flex items-center gap-2 text-sm font-normal">
                <SourceLogo source={entry.source} />
                {entry.name} live sync
              </Label>
              <Switch
                id={id}
                checked={Boolean(state?.enabled)}
                disabled={disabled || pending || state?.available === false}
                onCheckedChange={(enabled) => toggle.mutate({ source: entry.source, enabled })}
              />
            </div>
            {state?.available === false ? (
              <p className="text-xs text-muted-foreground">Live sync is being set up for your workspace. Try again later.</p>
            ) : state?.lastError ? (
              <p className="text-xs text-red-600">{state.lastError}</p>
            ) : state?.enabled && state.lastEventAt ? (
              <p className="text-xs text-muted-foreground">Last update from {entry.name}: {formatDate(state.lastEventAt, true)}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
