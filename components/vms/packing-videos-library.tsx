"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Download, FileArchive, Play, Search, Video } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, toSearchParams } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";
import { VMS_ZIP_MAX_VIDEOS, type PackingVideo, type PackingVideoList, type VmsSummary } from "@/types/vms";

const PAGE_SIZE = 25;

function formatBytes(bytes: number | null) {
  if (!bytes) return "–";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | null) {
  if (!ms) return "–";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function rupees(micros: number) {
  return `₹${(micros / 1_000_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function BillingBadge({ video }: { video: PackingVideo }) {
  if (video.billingStatus === "FREE") return <Badge variant="success">Free</Badge>;
  if (video.billingStatus === "CHARGED") return <Badge variant="default">{rupees(video.chargeMicros)}</Badge>;
  if (video.billingStatus === "UNPAID") return <Badge variant="warning">Unpaid</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

/** Downloads go through a plain link so the browser streams the file to disk. */
function startDownload(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function PackingVideosLibrary() {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<PackingVideo | null>(null);

  const summary = useQuery({
    queryKey: ["vms-summary"],
    queryFn: () => api<VmsSummary>("/api/v1/vms/summary"),
    retry: false,
  });

  const autoOpened = useRef<string | null>(null);
  const videos = useQuery({
    queryKey: ["vms-videos", q, from, to, page],
    queryFn: async () => {
      const result = await api<PackingVideoList>(`/api/v1/vms?${toSearchParams({ q, from, to, page, pageSize: PAGE_SIZE })}`);
      // A search with a single match opens it straight away: scan a return parcel, watch its video.
      if (q && result.items.length === 1 && autoOpened.current !== q) {
        autoOpened.current = q;
        setPlaying(result.items[0]);
      }
      return result;
    },
    enabled: summary.isSuccess,
    placeholderData: keepPreviousData,
  });

  function search(event: FormEvent) {
    event.preventDefault();
    autoOpened.current = null;
    setQ(draft.trim());
    setPage(1);
    setSelected(new Set());
  }

  const items = videos.data?.items ?? [];
  const total = videos.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPage = items.length > 0 && items.every((item) => selected.has(item.id));

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        if (next.size >= VMS_ZIP_MAX_VIDEOS) {
          toast.warning(`Up to ${VMS_ZIP_MAX_VIDEOS} videos per zip.`);
          return current;
        }
        next.add(id);
      } else next.delete(id);
      return next;
    });
  }

  function togglePage(on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (on && next.size < VMS_ZIP_MAX_VIDEOS) next.add(item.id);
        if (!on) next.delete(item.id);
      }
      return next;
    });
  }

  if (summary.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Packing videos" description="Watermarked packing proof for every parcel." />
        <Card>
          <CardContent className="p-6 text-sm text-muted">{summary.error.message}</CardContent>
        </Card>
      </div>
    );
  }

  const s = summary.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Packing videos"
        description={
          s
            ? `Search by barcode, tracking or order number. Videos are kept for ${s.retentionDays} days; download any you need for a longer claim.`
            : "Search by barcode, tracking or order number."
        }
        actions={
          <Link
            href="/dashboard/packing"
            className={buttonVariants({ variant: "ghost", className: "gap-2" })}
          >
            <ArrowLeft className="size-4" aria-hidden /> Packing station
          </Link>
        }
      />

      {s ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm text-muted">Videos this month</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{s.videosThisMonth}</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm text-muted">Price</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{rupees(s.priceMicros)}</p>
            <p className="text-xs text-muted">
              per video{s.freeRemaining > 0 ? ` · ${s.freeRemaining} free left` : ""}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm text-muted">Wallet balance</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {s.walletAvailableMicros === null ? "–" : rupees(s.walletAvailableMicros)}
            </p>
            <p className="text-xs text-muted">
              {s.walletAvailableMicros === null ? "Wallet not set up" : `about ${Math.floor(s.walletAvailableMicros / Math.max(s.priceMicros, 1))} videos`}
            </p>
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-4 p-5">
          <form onSubmit={search} className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Scan or type a barcode, tracking or order number"
                aria-label="Search videos"
                autoComplete="off"
                spellCheck={false}
                className="pl-10 font-mono"
                autoFocus
              />
            </div>
            <label className="text-xs text-muted">
              From
              <Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="mt-1 h-11 w-40" />
            </label>
            <label className="text-xs text-muted">
              To
              <Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="mt-1 h-11 w-40" />
            </label>
            <Button type="submit">Search</Button>
            {q || from || to ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft("");
                  setQ("");
                  setFrom("");
                  setTo("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">
              {videos.isLoading ? "Loading…" : `${total.toLocaleString("en-IN")} video${total === 1 ? "" : "s"}`}
              {selected.size > 0 ? ` · ${selected.size} selected` : ""}
            </p>
            <div className="flex gap-2">
              {selected.size > 0 ? (
                <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              ) : null}
              <Button
                type="button"
                className="gap-2"
                disabled={selected.size === 0}
                onClick={() => {
                  startDownload(`/api/v1/vms/zip?ids=${[...selected].join(",")}`);
                  toast.success("Preparing the zip. It downloads as it is built.");
                }}
              >
                <FileArchive className="size-4" aria-hidden /> Download zip
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <Checkbox checked={allOnPage} onCheckedChange={(value) => togglePage(value === true)} aria-label="Select page" />
                  </th>
                  <th className="px-3 py-2">Barcode</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Recorded</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2">Length</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2 text-right">Video</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-muted">
                      <Video className="mx-auto mb-2 size-8 opacity-50" aria-hidden />
                      {q ? `No video for "${q}".` : "No packing videos yet. Turn on Packing video at the packing station."}
                    </td>
                  </tr>
                ) : (
                  items.map((video) => (
                    <tr key={video.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(video.id)}
                          onCheckedChange={(value) => toggle(video.id, value === true)}
                          aria-label={`Select ${video.barcode}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {video.barcode}
                        {video.trackingNumber && video.trackingNumber !== video.barcode ? (
                          <span className="block text-xs text-muted">{video.trackingNumber}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {video.orderId ? (
                          <Link href={`/dashboard/orders/${video.orderId}`} className="hover:underline">
                            {video.orderNumber ?? "Order"}
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDate(video.startedAt, true)}</td>
                      <td className="px-3 py-2">{video.recordedByName ?? "–"}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDuration(video.durationMs)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatBytes(video.sizeBytes)}</td>
                      <td className="px-3 py-2">
                        <BillingBadge video={video} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={() => setPlaying(video)}>
                            <Play className="size-3.5" aria-hidden /> Play
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="gap-1"
                            onClick={() => startDownload(`/api/v1/vms/${video.id}/download`)}
                          >
                            <Download className="size-3.5" aria-hidden /> {video.mimeType === "video/webm" ? "WebM" : "MP4"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 text-sm">
              <Button type="button" size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-muted">
                Page {page} of {pages}
              </span>
              <Button type="button" size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={playing !== null} onOpenChange={(open) => !open && setPlaying(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-mono">{playing?.barcode}</DialogTitle>
            <DialogDescription>
              {playing?.orderNumber ? `Order ${playing.orderNumber} · ` : ""}
              {playing ? formatDate(playing.startedAt, true) : ""}
              {playing?.recordedByName ? ` · ${playing.recordedByName}` : ""}
            </DialogDescription>
          </DialogHeader>
          {playing ? (
            playing.billingStatus === "UNPAID" ? (
              <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-warning/10 dark:text-amber-200">
                This video is saved but unpaid. Recharge your wallet and it is charged {rupees(s?.priceMicros ?? 1_000_000)} when you play or download it.
              </p>
            ) : null
          ) : null}
          {playing ? (
            <video
              key={playing.id}
              src={`/api/v1/vms/${playing.id}/download?inline=1`}
              controls
              autoPlay
              playsInline
              className="aspect-video w-full rounded-lg bg-black"
            />
          ) : null}
          {playing ? (
            <div className="flex justify-end">
              <Button type="button" className="gap-2" onClick={() => startDownload(`/api/v1/vms/${playing.id}/download`)}>
                <Download className="size-4" aria-hidden /> Download
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
