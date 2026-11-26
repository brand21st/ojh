"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Circle, Download, Loader2, RotateCcw, Square, Video, VideoOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { listCameras, MAX_RECORDING_MS, PackingCamera, recordsMp4, uploadRecording } from "@/lib/vms/recorder";
import type { PackingVideoBilling, VmsStartResult, VmsSummary } from "@/types/vms";

const CAMERA_KEY = "postbus.packing.camera";
const DEVICE_KEY = "postbus.packing.cameraDevice";

export type PackingVideoHandle = {
  /** Returns true when the scan was used to start or stop a video. */
  onScan: (code: string) => boolean;
};

type Active = {
  videoId: string;
  code: string;
  matches: string[];
  orderNumber: string | null;
  startedAt: number;
};

type Upload = {
  videoId: string;
  code: string;
  blob: Blob;
  durationMs: number;
  state: "uploading" | "failed" | "saved";
  progress: number;
  billing?: PackingVideoBilling;
  error?: string;
};

export function normalizeCode(code: string) {
  return code.replace(/\s+/g, "").toUpperCase();
}

function rupees(micros: number) {
  return `₹${(micros / 1_000_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function saveLocally(upload: Upload) {
  const url = URL.createObjectURL(upload.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${upload.code}.${upload.blob.type.includes("webm") ? "webm" : "mp4"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PackingVideoPanel({
  ref,
  onSaved,
  onBeep,
  refocus,
}: {
  ref?: Ref<PackingVideoHandle>;
  /** Called with the scanned code when a recording is stopped, to mark the parcel packed. */
  onSaved: (code: string) => void;
  onBeep: (ok: boolean) => void;
  refocus: () => void;
}) {
  const queryClient = useQueryClient();
  const previewRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<PackingCamera | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef<Active | null>(null);
  const [enabled, setEnabled] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(CAMERA_KEY) === "on");
  // Result of the last camera open, keyed by which camera it was for; anything else reads as "opening".
  const [cameraResult, setCameraResult] = useState<{ key: string; state: "on" | "error"; error?: string } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => (typeof window === "undefined" ? "" : window.localStorage.getItem(DEVICE_KEY) ?? ""));
  const [active, setActive] = useState<Active | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);

  const summary = useQuery({
    queryKey: ["vms-summary"],
    queryFn: () => api<VmsSummary>("/api/v1/vms/summary"),
    retry: false,
    refetchInterval: 60_000,
  });
  const available = summary.isSuccess;

  const setActiveBoth = (next: Active | null) => {
    activeRef.current = next;
    setActive(next);
  };

  const cameraKey = available && enabled ? deviceId || "default" : null;
  const cameraState: "off" | "opening" | "on" | "error" = !cameraKey
    ? "off"
    : cameraResult?.key === cameraKey
      ? cameraResult.state
      : "opening";
  const cameraError = cameraResult?.key === cameraKey ? (cameraResult.error ?? null) : null;

  // Camera lifecycle follows the switch and the chosen camera.
  useEffect(() => {
    if (!cameraKey) {
      cameraRef.current?.close();
      return;
    }
    let cancelled = false;
    const camera = cameraRef.current ?? new PackingCamera();
    cameraRef.current = camera;
    camera
      .open(cameraKey === "default" ? null : cameraKey)
      .then(async () => {
        if (cancelled) return;
        setCameraResult({ key: cameraKey, state: "on" });
        const container = previewRef.current;
        if (container && camera.canvas.parentElement !== container) {
          camera.canvas.className = "block h-auto w-full";
          container.replaceChildren(camera.canvas);
        }
        setDevices(await listCameras());
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setCameraResult({
          key: cameraKey,
          state: "error",
          error:
            error.name === "NotAllowedError"
              ? "Camera permission was blocked. Allow the camera for this site in the browser's address bar."
              : error.name === "NotFoundError" || error.name === "OverconstrainedError"
                ? "No camera found. Plug in a USB webcam and try again."
                : error.message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cameraKey]);

  useEffect(() => () => cameraRef.current?.close(), []);

  // Elapsed clock and the 20-minute safety stop.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const ms = Date.now() - active.startedAt;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) void stop(true);
    }, 500);
    return () => clearInterval(timer);
    // stop is stable enough for this timer; it reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Leaving the page mid-recording would lose the video.
  useEffect(() => {
    const pending = active || uploads.some((upload) => upload.state !== "saved");
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, uploads]);

  const patchUpload = (videoId: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((item) => (item.videoId === videoId ? { ...item, ...patch } : item)));

  const runUpload = useCallback(
    async (item: Upload) => {
      patchUpload(item.videoId, { state: "uploading", error: undefined });
      try {
        const result = await uploadRecording(item.videoId, item.blob, item.durationMs, (progress) =>
          patchUpload(item.videoId, { progress })
        );
        patchUpload(item.videoId, { state: "saved", progress: 1, billing: result.billingStatus });
        if (result.billingStatus === "UNPAID") {
          toast.warning(`Video for ${item.code} saved, but your wallet is short. Recharge to download it.`);
        }
        queryClient.invalidateQueries({ queryKey: ["vms-summary"] });
        queryClient.invalidateQueries({ queryKey: ["vms-videos"] });
        // Saved items drop off after a while; failed ones stay until retried or saved locally.
        setTimeout(() => setUploads((list) => list.filter((entry) => entry.videoId !== item.videoId)), 60_000);
      } catch (error) {
        patchUpload(item.videoId, {
          state: "failed",
          error: error instanceof Error ? error.message : "Upload failed.",
        });
        toast.error(`Video for ${item.code} did not upload. It is kept in this tab: retry or save a copy.`);
      }
    },
    [queryClient]
  );

  async function start(code: string) {
    const camera = cameraRef.current;
    if (!camera?.isOpen) {
      onBeep(false);
      toast.error("The camera is not ready yet.");
      return;
    }
    busyRef.current = true;
    try {
      const result = await api<VmsStartResult>("/api/v1/vms/start", { method: "POST", body: JSON.stringify({ code }) });
      if (result.status === "RECORDING") {
        camera.start({
          barcode: result.code,
          orderNumber: result.orderNumber,
          trackingNumber: result.trackingNumber,
          operator: summary.data?.operatorName ?? null,
          workspace: summary.data?.workspaceName ?? null,
        });
        setElapsed(0);
        setActiveBoth({
          videoId: result.videoId,
          code: result.code,
          matches: [result.code, result.trackingNumber, result.orderNumber]
            .filter((value): value is string => Boolean(value))
            .map((value) => normalizeCode(value).replace(/^#/, "")),
          orderNumber: result.orderNumber,
          startedAt: Date.now(),
        });
        onBeep(true);
      } else if (result.status === "NO_BALANCE") {
        onBeep(false);
        toast.error(
          `Wallet balance too low to record. Each video costs ${rupees(Number(result.priceMicros))}; you have ${rupees(Number(result.availableMicros))}.`
        );
      } else if (result.status === "CANCELLED") {
        onBeep(false);
        toast.error(`Order ${result.orderNumber ?? result.code} is cancelled. Don't ship it.`);
      } else {
        onBeep(false);
        toast.error("That barcode is too short or too long to record.");
      }
    } catch (error) {
      onBeep(false);
      toast.error(error instanceof Error ? error.message : "Could not start recording.");
    } finally {
      busyRef.current = false;
      refocus();
    }
  }

  async function stop(save: boolean) {
    const camera = cameraRef.current;
    const current = activeRef.current;
    if (!camera || !current) return;
    setActiveBoth(null);
    if (!save) {
      camera.discard();
      void api(`/api/v1/vms/${current.videoId}/cancel`, { method: "POST" }).catch(() => undefined);
      toast.message("Recording cancelled. Nothing was saved or charged.");
      refocus();
      return;
    }
    busyRef.current = true;
    try {
      const { blob, durationMs } = await camera.stop();
      onSaved(current.code);
      const item: Upload = { videoId: current.videoId, code: current.code, blob, durationMs, state: "uploading", progress: 0 };
      setUploads((list) => [item, ...list].slice(0, 20));
      void runUpload(item);
    } catch (error) {
      onBeep(false);
      toast.error(error instanceof Error ? error.message : "Could not stop the recording.");
    } finally {
      busyRef.current = false;
      refocus();
    }
  }

  useImperativeHandle(ref, () => ({
    onScan(code: string) {
      if (!available || !enabled) return false;
      if (busyRef.current) return true;
      const current = activeRef.current;
      const scanned = normalizeCode(code);
      if (current) {
        if (current.matches.includes(scanned.replace(/^#/, ""))) {
          void stop(true);
        } else {
          onBeep(false);
          toast.warning(`Recording ${current.code}. Scan the same barcode to stop, or press Stop & save.`);
        }
        return true;
      }
      void start(code);
      return true;
    },
  }));

  if (!available) return null;

  function toggle(next: boolean) {
    if (!next && activeRef.current) {
      toast.warning("Stop or cancel the recording first.");
      return;
    }
    setCameraResult(null);
    setEnabled(next);
    window.localStorage.setItem(CAMERA_KEY, next ? "on" : "off");
    refocus();
  }

  const s = summary.data!;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {enabled ? <Video className="size-5 text-brand" aria-hidden /> : <VideoOff className="size-5 text-muted" aria-hidden />}
            <div>
              <p className="font-semibold">Packing video</p>
              <p className="text-xs text-muted">
                Scan to start, pack on camera, scan the same barcode to stop.{" "}
                {s.freeRemaining > 0
                  ? `${s.freeRemaining} free video${s.freeRemaining === 1 ? "" : "s"} left, then ${rupees(s.priceMicros)} each.`
                  : `${rupees(s.priceMicros)} per video from your wallet.`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard/packing/videos" className="text-sm font-medium text-brand hover:underline">
              All videos
            </Link>
            <Switch checked={enabled} onCheckedChange={toggle} aria-label="Record packing videos" />
          </div>
        </div>

        {enabled ? (
          <>
            <div className={cn("relative overflow-hidden rounded-xl border-2 bg-black", active ? "border-red-500" : "border-border")}>
              <div ref={previewRef} className="aspect-video w-full" />
              {cameraState !== "on" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
                  {cameraState === "opening" ? <Loader2 className="size-6 animate-spin" aria-hidden /> : null}
                  {cameraState === "opening" ? "Opening camera…" : null}
                  {cameraState === "error" ? (
                    <>
                      <AlertTriangle className="size-6 text-amber-400" aria-hidden />
                      {cameraError}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {!recordsMp4() ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                This browser records WebM, not MP4. Use Chrome or Edge to get MP4 files.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {active ? (
                <>
                  <Badge variant="error" className="gap-1.5 text-sm">
                    <Circle className="size-2.5 animate-pulse fill-current" aria-hidden />
                    REC {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
                  </Badge>
                  <span className="font-mono text-sm">{active.code}</span>
                  {active.orderNumber ? <span className="text-sm text-muted">Order {active.orderNumber}</span> : null}
                  <div className="ml-auto flex gap-2">
                    <Button type="button" variant="secondary" className="gap-1.5" onClick={() => void stop(false)}>
                      <X className="size-4" aria-hidden /> Cancel
                    </Button>
                    <Button type="button" className="gap-1.5" onClick={() => void stop(true)}>
                      <Square className="size-4 fill-current" aria-hidden /> Stop & save
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-sm text-muted">{cameraState === "on" ? "Ready. Scan a barcode to start recording." : ""}</span>
                  {devices.length > 1 ? (
                    <select
                      className="ml-auto h-9 rounded-lg border border-border bg-card px-2 text-sm"
                      value={deviceId}
                      aria-label="Camera"
                      onChange={(event) => {
                        setCameraResult(null);
                        setDeviceId(event.target.value);
                        window.localStorage.setItem(DEVICE_KEY, event.target.value);
                        refocus();
                      }}
                    >
                      <option value="">Default camera</option>
                      {devices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Camera ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null}

        {uploads.length > 0 ? (
          <ul className="space-y-1.5">
            {uploads.map((item) => (
              <li key={item.videoId} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                {item.state === "uploading" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted" aria-hidden />
                ) : item.state === "saved" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                ) : (
                  <AlertTriangle className="size-4 shrink-0 text-error" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate font-mono">{item.code}</span>
                <span className="shrink-0 text-xs text-muted">
                  {item.state === "uploading"
                    ? `Uploading ${Math.round(item.progress * 100)}%`
                    : item.state === "saved"
                      ? item.billing === "FREE"
                        ? "Saved · free"
                        : item.billing === "UNPAID"
                          ? "Saved · unpaid"
                          : "Saved"
                      : (item.error ?? "Upload failed")}
                </span>
                {item.state === "failed" ? (
                  <>
                    <Button type="button" size="sm" variant="secondary" className="gap-1" onClick={() => void runUpload(item)}>
                      <RotateCcw className="size-3.5" aria-hidden /> Retry
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={() => saveLocally(item)}>
                      <Download className="size-3.5" aria-hidden /> Save copy
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
