"use client";

import Link from "next/link";
import { Copy, ExternalLink, MessageCircle, Paintbrush } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useStoreBuilder, useStorefront } from "./use-store-builder";

/** Store identity, live status and share actions shown above every Store Builder page. */
export function StoreStatusBar() {
  const store = useStorefront();
  const builder = useStoreBuilder();
  const settings = store.data;
  if (store.isError) return null;
  if (!settings) return <Skeleton className="h-12 w-full rounded-xl" />;
  const displayUrl = settings.storeUrl.replace(/^https?:\/\//, "");
  const shareText = `Shop ${settings.storeName || "our store"} online: ${settings.storeUrl}`;
  const unpublished = builder.data?.hasUnpublishedChanges;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {settings.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={settings.logoUrl} alt="" className="size-9 shrink-0 rounded-md border border-border bg-white object-contain" />
        ) : (
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md text-sm font-semibold text-white" style={{ backgroundColor: settings.accentColor }}>
            {(settings.storeName || "S").trim().charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold">{settings.storeName}</p>
            <span className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", settings.published ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300")}>
              <span aria-hidden className={cn("size-1.5 rounded-full", settings.published ? "bg-emerald-500" : "bg-amber-500")} />
              {settings.published ? "Live" : "Hidden"}
            </span>
            {unpublished ? (
              <Link href="/dashboard/store-builder/customize" className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-300">
                <Paintbrush className="size-3" aria-hidden />Unpublished changes
              </Link>
            ) : null}
          </div>
          <a href={settings.storeUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted hover:text-ink hover:underline">{displayUrl}</a>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={buttonVariants({ size: "icon-xs", variant: "secondary" })}
          aria-label="Copy store link"
          title="Copy store link"
          onClick={() => void navigator.clipboard.writeText(settings.storeUrl).then(() => toast.success("Store link copied.")).catch(() => toast.error("Could not copy link."))}
        >
          <Copy />
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer" aria-label="Share store link on WhatsApp" title="Share on WhatsApp" className={buttonVariants({ size: "icon-xs", variant: "secondary" })}>
          <MessageCircle />
        </a>
        <a href={settings.storeUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "xs", variant: "secondary" })}>
          View store<ExternalLink className="size-3.5" />
        </a>
      </div>
    </div>
  );
}
