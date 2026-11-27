"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Maximize2,
  Minimize2,
  PackageCheck,
  ScanLine,
  Square,
  Undo2,
  Volume2,
  VolumeX,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/hooks/use-api";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PackingVideoPanel, type PackingVideoHandle, type PackingVideoStatus } from "@/components/vms/packing-video-panel";
import type { PackScanResult, TeamActivityItem } from "@/types/team";

type Today = { day: string; mine: number; team: number; recent: TeamActivityItem[] };

type Shown = PackScanResult & { scannedAt: number };

const SOUND_KEY = "postbus.packing.sound";
const UNDO_WINDOW_MS = 15 * 60 * 1000;

/** Short tones: one high beep for packed, two low ones for anything that needs a look. */
function beep(ok: boolean) {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const tones = ok ? [[880, 0]] : [[220, 0], [220, 0.18]];
    for (const [frequency, at] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = ok ? "sine" : "square";
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.12);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // Sound is a nicety; never block a scan on it.
  }
}

/** True when keystrokes belong to some other field the user is typing in. */
function typingElsewhere(target: EventTarget | null, scanBox: HTMLInputElement | null) {
  if (!(target instanceof HTMLElement) || target === scanBox) return false;
  if (target.isContentEditable) return true;
  if (target.closest("[role=dialog], [role=listbox], [role=menu]")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function PackingStation() {
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<PackingVideoHandle>(null);
  const [code, setCode] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [armed, setArmed] = useState(false);
  const [videoStatus, setVideoStatus] = useState<PackingVideoStatus>("off");
  const [fullscreen, setFullscreen] = useState(false);
  // Dashboard pages mount after hydration, so reading the saved choice up front is safe.
  const [sound, setSound] = useState(
    () => typeof window === "undefined" || window.localStorage.getItem(SOUND_KEY) !== "off"
  );

  const focusScanBox = useCallback(() => {
    const box = inputRef.current;
    box?.focus();
    setArmed(document.activeElement === box);
  }, []);

  useEffect(() => {
    focusScanBox();
    // Focus can move without React's onFocus (a scanner, or focus already on the box).
    const sync = () => setArmed(document.activeElement === inputRef.current);
    window.addEventListener("focusin", sync);
    window.addEventListener("focusout", sync);
    return () => {
      window.removeEventListener("focusin", sync);
      window.removeEventListener("focusout", sync);
    };
  }, [focusScanBox]);

  // A scanner types like a keyboard. If focus wandered off the scan box (a button was
  // clicked, say), pull the next keystrokes back into it so no scan is lost.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      const box = inputRef.current;
      if (!box || document.activeElement === box || typingElsewhere(event.target, box)) return;
      box.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const today = useQuery({
    queryKey: ["packing-today"],
    queryFn: () => api<Today>("/api/v1/packing/today"),
    refetchInterval: 30_000,
  });

  const scan = useMutation({
    mutationFn: (value: string) =>
      api<PackScanResult>("/api/v1/packing/scan", { method: "POST", body: JSON.stringify({ code: value }) }),
    onSuccess: (result) => {
      setShown({ ...result, scannedAt: Date.now() });
      if (sound) beep(result.status === "PACKED");
      if (result.status === "PACKED") queryClient.invalidateQueries({ queryKey: ["packing-today"] });
    },
    onError: (error: Error) => {
      if (sound) beep(false);
      toast.error(error.message);
    },
    onSettled: () => {
      setCode("");
      focusScanBox();
    },
  });

  const undo = useMutation({
    mutationFn: (orderId: string) =>
      api<{ ok: boolean }>("/api/v1/packing/undo", { method: "POST", body: JSON.stringify({ orderId }) }),
    onSuccess: (result, orderId) => {
      if (result.ok) {
        toast.success("Pack undone. The order is back in the queue.");
        setShown((current) => (current?.orderId === orderId ? null : current));
      } else {
        toast.error("Too late to undo this one: the 15-minute window has passed.");
      }
      queryClient.invalidateQueries({ queryKey: ["packing-today"] });
      focusScanBox();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (scan.isPending) return;
    // Stop & save is the recording action even when the box is empty; a scan still stops it too.
    if (recording && !value) {
      videoRef.current?.stopAndSave();
      focusScanBox();
      return;
    }
    if (!value) return;
    // With packing video on, the first scan starts recording and the second stops it
    // (and then marks the parcel packed through onSaved).
    if (videoRef.current?.onScan(value)) {
      setCode("");
      focusScanBox();
      return;
    }
    scan.mutate(value);
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    focusScanBox();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      toast.error("This browser would not switch to full screen.");
    }
    focusScanBox();
  }

  const videoOn = videoStatus !== "off";
  const recording = videoStatus === "recording";
  const action = recording
    ? { label: "Stop & save", hint: "Scan the same barcode again to stop and save the video.", icon: Square }
    : videoStatus === "ready"
      ? { label: "Start recording", hint: "Scan a barcode to start recording this parcel.", icon: Circle }
      : videoStatus === "camera"
        ? { label: "Mark packed", hint: "Waiting for the camera. Scans start recording once it is ready.", icon: PackageCheck }
        : { label: "Mark packed", hint: "Scan the label barcode or type the order number.", icon: PackageCheck };
  const ActionIcon = action.icon;

  const result = (
    <ScanResult
      shown={shown}
      compact={videoOn}
      onUndo={(orderId) => undo.mutate(orderId)}
      undoing={undo.isPending}
    />
  );

  return (
    <div
      ref={rootRef}
      className={cn("space-y-5", fullscreen && "overflow-y-auto bg-background p-4 sm:p-6")}
      onClick={(event) => {
        // Clicking empty space re-arms the scanner; clicks on controls keep their focus.
        if (event.target === event.currentTarget) focusScanBox();
      }}
    >
      <PageHeader
        title="Packing station"
        description="Scan each parcel as it is packed. Every order is counted once."
        actions={
          <>
            <Button type="button" variant="ghost" className="gap-2" onClick={toggleSound} aria-pressed={sound}>
              {sound ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
              <span className="hidden sm:inline">Sound {sound ? "on" : "off"}</span>
              <span className="sr-only sm:hidden">Sound {sound ? "on" : "off"}</span>
            </Button>
            <Button type="button" variant="secondary" className="gap-2" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}>
              {fullscreen ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
              {fullscreen ? "Exit station mode" : "Station mode"}
            </Button>
          </>
        }
      />

      {/* Scan bar: the one control a packer uses all day. */}
      <Card
        className={cn(
          "border-2 transition-colors duration-200",
          recording ? "border-red-500/70" : armed ? "border-brand/50" : "border-amber-300 dark:border-amber-500/50"
        )}
      >
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={focusScanBox}
              className={cn(
                "inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-full px-3 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                armed
                  ? "bg-emerald-100 text-emerald-800 dark:bg-success/15 dark:text-emerald-300"
                  : "bg-amber-100 text-amber-900 dark:bg-warning/15 dark:text-amber-300"
              )}
            >
              <span className={cn("size-2 rounded-full", armed ? "animate-pulse bg-emerald-500" : "bg-amber-500")} aria-hidden />
              {armed ? "Scanner ready" : "Scanner paused · click here or just scan"}
            </button>
            <p className="text-xs text-muted sm:text-sm">{action.hint}</p>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <ScanLine className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                ref={inputRef}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Scan barcode, e.g. EK123456789IN"
                aria-label="Barcode or order number"
                aria-describedby="scan-help"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="go"
                className="h-16 pl-13 font-mono text-xl tracking-wider"
              />
            </div>
            <Button
              type="submit"
              className={cn("h-16 gap-2 px-7 text-base", recording && "bg-red-600 text-white hover:bg-red-700")}
              disabled={scan.isPending || (!recording && !code.trim())}
            >
              <ActionIcon className={cn("size-5", recording && "fill-current")} aria-hidden />
              {scan.isPending ? "Checking…" : action.label}
            </Button>
          </form>
          <p id="scan-help" className="text-xs text-muted">
            USB and Bluetooth scanners work straight away. The box re-arms itself after every scan.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-5">
          <PackingVideoPanel
            ref={videoRef}
            onSaved={(value) => scan.mutate(value)}
            onBeep={(ok) => {
              if (sound) beep(ok);
            }}
            refocus={focusScanBox}
            onStatus={setVideoStatus}
          />
          {videoOn ? null : result}
        </div>

        <aside className="min-w-0 space-y-5" aria-label="Today at this station">
          {videoOn ? result : null}
          <TodayStats mine={today.data?.mine} team={today.data?.team} />
          <RecentScans
            items={today.data?.recent}
            loading={today.isLoading}
            onUndo={(orderId) => undo.mutate(orderId)}
            undoing={undo.isPending ? undo.variables : null}
          />
        </aside>
      </div>
    </div>
  );
}

function TodayStats({ mine, team }: { mine?: number; team?: number }) {
  const share = mine !== undefined && team ? Math.round((mine / team) * 100) : null;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="grid grid-cols-2 divide-x divide-border">
          <div className="pr-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">You today</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums text-ink">{mine ?? "–"}</p>
          </div>
          <div className="pl-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Whole team</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums text-ink">{team ?? "–"}</p>
          </div>
        </div>
        {share !== null ? (
          <div className="mt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-soft" aria-hidden>
              <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${share}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted">You packed {share}% of today&apos;s parcels.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecentScans({
  items,
  loading,
  onUndo,
  undoing,
}: {
  items?: TeamActivityItem[];
  loading: boolean;
  onUndo: (orderId: string) => void;
  undoing: string | null | undefined;
}) {
  const list = items ?? [];
  // Re-render every 30 s so Undo buttons disappear when their window closes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Your recent scans</h2>
          <span className="text-xs text-muted">Undo within 15 min</span>
        </div>
        {loading ? (
          <div className="space-y-2 p-4" aria-hidden>
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-9 animate-pulse rounded-lg bg-surface-soft" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">No parcels packed yet today.</p>
        ) : (
          <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
            {list.map((item) => {
              const canUndo = Boolean(item.orderId) && now - new Date(item.occurredAt).getTime() < UNDO_WINDOW_MS;
              return (
                <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {item.orderId ? (
                        <Link href={`/dashboard/orders/${item.orderId}`} className="hover:underline">
                          {item.orderNumber ?? "Order"}
                        </Link>
                      ) : (
                        (item.orderNumber ?? "Order")
                      )}
                    </p>
                    <p className="truncate font-mono text-xs text-muted">
                      {item.barcode ? `${item.barcode} · ` : ""}
                      {formatRelative(item.occurredAt)}
                    </p>
                  </div>
                  {canUndo ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0 gap-1 text-muted hover:text-foreground"
                      disabled={undoing === item.orderId}
                      onClick={() => onUndo(item.orderId!)}
                      aria-label={`Undo pack for ${item.orderNumber ?? "this order"}`}
                    >
                      <Undo2 className="size-3.5" aria-hidden /> Undo
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ScanResult({
  shown,
  compact,
  onUndo,
  undoing,
}: {
  shown: Shown | null;
  compact: boolean;
  onUndo: (orderId: string) => void;
  undoing: boolean;
}) {
  if (!shown) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border text-center",
          compact ? "px-4 py-6" : "px-6 py-16"
        )}
      >
        <PackageCheck className={cn("text-muted/60", compact ? "size-7" : "size-12")} aria-hidden />
        <p className="mt-2 text-sm font-medium text-ink">Ready for the first parcel</p>
        <p className="mt-0.5 text-xs text-muted">The result of each scan shows here.</p>
      </div>
    );
  }

  const tone =
    shown.status === "PACKED"
      ? { box: "border-success/50 bg-success/5", icon: CheckCircle2, iconClass: "text-success", title: "Packed" }
      : shown.status === "ALREADY_PACKED"
        ? { box: "border-amber-300 bg-amber-50 dark:bg-warning/10", icon: AlertTriangle, iconClass: "text-amber-600", title: "Already packed" }
        : shown.status === "CANCELLED"
          ? { box: "border-error/50 bg-error/5", icon: XCircle, iconClass: "text-error", title: "Cancelled: don't ship" }
          : { box: "border-error/50 bg-error/5", icon: XCircle, iconClass: "text-error", title: "Not found" };
  const Icon = tone.icon;

  return (
    <div
      key={shown.scannedAt}
      role="status"
      aria-live="assertive"
      aria-atomic="true"
      className={cn("rounded-2xl border-2", compact ? "p-4" : "p-6", tone.box)}
    >
      <div className={cn("flex items-start", compact ? "gap-3" : "gap-4")}>
        <Icon className={cn("shrink-0", compact ? "size-9" : "size-12", tone.iconClass)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("font-semibold text-ink", compact ? "text-xl" : "text-2xl")}>{tone.title}</p>
          {shown.orderNumber ? (
            <p className={cn("mt-0.5", compact ? "text-base" : "text-lg")}>
              Order <span className="font-semibold">{shown.orderNumber}</span>
            </p>
          ) : null}
          <p className="truncate font-mono text-sm text-muted">{shown.barcode ?? shown.code}</p>
          {shown.status === "ALREADY_PACKED" ? (
            <p className="mt-1 text-sm text-muted">
              Packed by {shown.packedByName ?? "a team member"}
              {shown.packedAt ? `, ${formatRelative(shown.packedAt)}` : ""}. Check this isn&apos;t a duplicate parcel.
            </p>
          ) : null}
          {shown.status === "NOT_FOUND" ? (
            <p className="mt-1 text-sm text-muted">No order or shipment in this workspace matches that code.</p>
          ) : null}
        </div>
        {shown.status === "PACKED" && shown.orderId ? (
          <Button
            type="button"
            variant="secondary"
            size={compact ? "sm" : "default"}
            className="shrink-0 gap-1.5"
            disabled={undoing}
            onClick={() => onUndo(shown.orderId!)}
          >
            <Undo2 className="size-4" aria-hidden /> Undo
          </Button>
        ) : null}
      </div>
    </div>
  );
}
