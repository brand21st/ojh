"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EyeOff, ImagePlus, Loader2, Monitor, RotateCcw, Smartphone, Trash2 } from "lucide-react";
import styles from "./store-builder.module.css";
import { STORE_PREVIEW_MESSAGE, STORE_PREVIEW_READY } from "@/modules/storefront/preview";
import type { StorePayload } from "@/components/storefront/store-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shared Store Builder building blocks, moved out of the old Inventory → Storefront tab. */

export type PreviewMode = "iphone" | "android" | "desktop";
export const PREVIEW_MODES: Record<PreviewMode, { label: string; size: string; frame: string; height: string }> = {
  iphone: { label: "iPhone", size: "390 × 844", frame: "w-[410px] rounded-[2.75rem] border-[10px] border-zinc-900", height: "h-[min(72vh,844px)]" },
  android: { label: "Android", size: "412 × 915", frame: "w-[432px] rounded-[2rem] border-[10px] border-zinc-900", height: "h-[min(72vh,915px)]" },
  desktop: { label: "Desktop", size: "Full width", frame: "w-full rounded-lg border border-border", height: "h-[min(72vh,760px)]" },
};
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
export const ACCENT_PRESETS = ["#E11D48", "#EA580C", "#D97706", "#059669", "#0891B2", "#2563EB", "#7C3AED", "#18181B"];

export function Collapsible({ id, title, meta, children }: { id: string; title: string; meta?: string; children: ReactNode }) {
  return (
    <details id={id} className="scroll-mt-4">
      <summary>
        <span className="inline-flex w-[calc(100%-1.25rem)] items-center justify-between gap-2 align-middle">
          <span>{title}</span>
          {meta ? <span className="text-xs font-normal text-muted">{meta}</span> : null}
        </span>
      </summary>
      <div>{children}</div>
    </details>
  );
}

export function CharCount({ value, max }: { value: string; max: number }) {
  const near = value.length > max * 0.9;
  return <span className={cn("text-[11px] tabular-nums", near ? "text-amber-600" : "text-muted")}>{value.length}/{max}</span>;
}

/** Image slot with upload / replace / remove, used for the logo and the payment QR. */
export function AssetField({
  id,
  label,
  hint,
  imageUrl,
  imageAlt,
  canWrite,
  uploading,
  busy,
  onPick,
  onRemove,
}: {
  id: string;
  label: string;
  hint: string;
  imageUrl: string | null;
  imageAlt: string;
  canWrite: boolean;
  uploading: boolean;
  busy: boolean;
  onPick: (input: HTMLInputElement) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium">{label}</p>
      <div className="mt-1 flex min-w-0 items-center gap-3">
        <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-border bg-white">
          {uploading ? (
            <Loader2 className="size-4 animate-spin text-zinc-400" aria-label="Uploading" />
          ) : imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt={imageAlt} className="size-full object-contain" />
          ) : (
            <ImagePlus className="size-5 text-zinc-400" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {canWrite ? (
            <div className="flex flex-wrap gap-1.5">
              <input
                ref={input}
                id={id}
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                onChange={(event) => onPick(event.currentTarget)}
              />
              <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                {imageUrl ? "Replace" : "Upload"}
              </Button>
              {imageUrl ? (
                <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onRemove} aria-label={`Remove ${label.toLowerCase()}`}>
                  <Trash2 />Remove
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="mt-1 text-xs text-muted">{hint}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the draft store in a same-origin iframe so device widths, media queries, fixed sheets,
 * scroll locks and store fonts behave as they do on the live store without leaking into the dashboard.
 */
export function StorefrontPreviewPane({ store, published, label = "Live preview", note = "updates as you edit · orders can’t be placed here", initialMode = "iphone" }: { store: StorePayload; published: boolean; label?: string; note?: string; initialMode?: PreviewMode }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(store);
  const [mode, setMode] = useState<PreviewMode>(initialMode);
  const [ready, setReady] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const device = PREVIEW_MODES[mode];

  useEffect(() => {
    latest.current = store;
    if (ready) frame.current?.contentWindow?.postMessage({ type: STORE_PREVIEW_MESSAGE, store }, window.location.origin);
  }, [ready, store]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type !== STORE_PREVIEW_READY) return;
      setReady(true);
      frame.current?.contentWindow?.postMessage({ type: STORE_PREVIEW_MESSAGE, store: latest.current }, window.location.origin);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className={styles.preview}>
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold">{label}</p>
          <p className="text-xs text-muted">{device.size} · {note}</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Preview device" className="flex min-w-0 rounded-xl border border-border bg-surface-soft p-1">
            {(Object.keys(PREVIEW_MODES) as PreviewMode[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                title={`${PREVIEW_MODES[key].label} preview`}
                className={`inline-flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand ${mode === key ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                onClick={() => setMode(key)}
              >
                {key === "desktop" ? <Monitor className="size-3.5" /> : <Smartphone className="size-3.5" />}
                <span className="hidden sm:inline">{PREVIEW_MODES[key].label}</span>
              </button>
            ))}
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Restart preview"
            title="Restart preview (clears the preview cart and search)"
            onClick={() => {
              setReady(false);
              setFrameKey((key) => key + 1);
            }}
          >
            <RotateCcw />
          </Button>
        </div>
      </div>
      {!published ? (
        <p className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <EyeOff className="size-3.5 shrink-0" />Store is hidden. Customers can’t open it until you turn on Store visible.
        </p>
      ) : null}
      <div className={cn("relative mx-auto max-w-full overflow-hidden bg-white shadow-sm", device.frame)}>
        <iframe
          key={frameKey}
          ref={frame}
          src="/store-preview"
          title="Storefront preview"
          className={cn("block w-full border-0 bg-white", device.height)}
        />
        {!ready ? (
          <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-white text-xs text-zinc-500">
            <Loader2 className="size-4 animate-spin" />Loading preview…
          </div>
        ) : null}
      </div>
    </div>
  );
}
