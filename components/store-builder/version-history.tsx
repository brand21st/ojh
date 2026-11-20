"use client";

import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { findTheme } from "@/modules/storefront/layout/themes";
import type { StoreBuilderState } from "@/modules/storefront/builder";
import { useBuilderMutations, useLayoutVersions } from "./use-store-builder";

const LABELS = {
  published: "Published",
  "before-store-builder": "Before Store Builder (classic layout)",
  "reverted-to-classic": "Switched to classic layout",
} as const;

export function VersionList({ canWrite, onRestored, enabled = true }: { canWrite: boolean; onRestored?: (state: StoreBuilderState) => void; enabled?: boolean }) {
  const versions = useLayoutVersions(enabled);
  const { restore } = useBuilderMutations();
  if (versions.isPending) return <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>;
  if (versions.isError) return <Button size="xs" variant="ghost" onClick={() => void versions.refetch()}>Couldn’t load history. Retry</Button>;
  if (!versions.data.length) return <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">No published versions yet. Each time you publish, the version is saved here.</p>;
  return (
    <ol className="max-h-[60vh] space-y-1.5 overflow-y-auto">
      {versions.data.map((version, index) => (
        <li key={version.id} className="flex min-h-12 items-center gap-3 rounded-lg border border-border px-3 py-2">
          <span aria-hidden className="size-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: version.accentColor ?? "#E11D48" }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">
              {LABELS[version.label]}{version.label === "published" && version.themeId ? ` · ${findTheme(version.themeId).name}` : ""}
              {index === 0 && version.label !== "before-store-builder" ? <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">Live</span> : null}
            </p>
            <p className="text-[11px] text-muted">
              {new Date(version.publishedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
              {version.sectionCount ? ` · ${version.sectionCount} sections` : ""}
            </p>
          </div>
          {canWrite ? (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={restore.isPending}
              onClick={() =>
                restore.mutate(version.id, {
                  onSuccess: (state) => {
                    onRestored?.(state);
                    toast.success("Version copied to your draft. Review it, then publish.");
                  },
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {restore.isPending && restore.variables === version.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}Restore to draft
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function VersionHistoryDialog({ open, onOpenChange, canWrite, onRestored }: { open: boolean; onOpenChange: (open: boolean) => void; canWrite: boolean; onRestored?: (state: StoreBuilderState) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="size-4" />Published versions</DialogTitle>
          <DialogDescription>Restoring copies a version into your draft. Nothing changes for customers until you publish.</DialogDescription>
        </DialogHeader>
        <VersionList canWrite={canWrite} enabled={open} onRestored={(state) => { onRestored?.(state); onOpenChange(false); }} />
      </DialogContent>
    </Dialog>
  );
}
