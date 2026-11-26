"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, PackageCheck, ScanLine, Undo2, Volume2, VolumeX, XCircle } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/hooks/use-api";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PackScanResult, TeamActivityItem } from "@/types/team";

type Today = { day: string; mine: number; team: number; recent: TeamActivityItem[] };

type Shown = PackScanResult & { scannedAt: number };

const SOUND_KEY = "postbus.packing.sound";

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

export function PackingStation() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  // Dashboard pages mount after hydration, so reading the saved choice up front is safe.
  const [sound, setSound] = useState(
    () => typeof window === "undefined" || window.localStorage.getItem(SOUND_KEY) !== "off"
  );

  useEffect(() => {
    inputRef.current?.focus();
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
      inputRef.current?.focus();
    },
  });

  const undo = useMutation({
    mutationFn: (orderId: string) =>
      api<{ ok: boolean }>("/api/v1/packing/undo", { method: "POST", body: JSON.stringify({ orderId }) }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Pack undone.");
        setShown(null);
      }
      queryClient.invalidateQueries({ queryKey: ["packing-today"] });
      inputRef.current?.focus();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!value || scan.isPending) return;
    scan.mutate(value);
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Packing station"
        description="Scan the label barcode (or type the order number) as each parcel is packed."
        actions={
          <Button type="button" variant="ghost" className="gap-2" onClick={toggleSound} aria-pressed={sound}>
            {sound ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
            Sound {sound ? "on" : "off"}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-5">
              <form onSubmit={submit} className="flex gap-2">
                <div className="relative flex-1">
                  <ScanLine className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
                  <Input
                    ref={inputRef}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Scan barcode, e.g. EK123456789IN"
                    aria-label="Barcode or order number"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    inputMode="text"
                    className="h-14 pl-11 font-mono text-lg tracking-wide"
                  />
                </div>
                <Button type="submit" className="h-14 px-6 text-base" disabled={!code.trim() || scan.isPending}>
                  {scan.isPending ? "Checking…" : "Mark packed"}
                </Button>
              </form>
              <p className="mt-2 text-xs text-muted">
                USB and Bluetooth scanners work out of the box: keep this box selected and scan. Each order is counted once.
              </p>
            </CardContent>
          </Card>

          <ScanResult shown={shown} onUndo={(orderId) => undo.mutate(orderId)} undoing={undo.isPending} />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm text-muted">Packed by you today</p>
              <p className="mt-1 text-4xl font-semibold tabular-nums">{today.data?.mine ?? "–"}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm text-muted">Whole team today</p>
              <p className="mt-1 text-4xl font-semibold tabular-nums">{today.data?.team ?? "–"}</p>
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Your recent scans</CardTitle>
              <CardDescription>You can undo your own scan within 15 minutes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {(today.data?.recent ?? []).length === 0 ? (
                <p className="text-sm text-muted">No parcels packed yet today.</p>
              ) : (
                (today.data?.recent ?? []).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.orderId ? (
                          <Link href={`/dashboard/orders/${item.orderId}`} className="hover:underline">
                            {item.orderNumber ?? "Order"}
                          </Link>
                        ) : (
                          item.orderNumber ?? "Order"
                        )}
                      </p>
                      {item.barcode ? <p className="truncate font-mono text-xs text-muted">{item.barcode}</p> : null}
                    </div>
                    <span className="shrink-0 text-xs text-muted">{formatRelative(item.occurredAt)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ScanResult({
  shown,
  onUndo,
  undoing,
}: {
  shown: Shown | null;
  onUndo: (orderId: string) => void;
  undoing: boolean;
}) {
  if (!shown) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
        <PackageCheck className="size-10 text-muted/60" aria-hidden />
        <p className="mt-3 text-sm text-muted">Ready. Scan the first parcel.</p>
      </div>
    );
  }

  const tone =
    shown.status === "PACKED"
      ? { box: "border-success/40 bg-success/5", icon: CheckCircle2, iconClass: "text-success", title: "Packed" }
      : shown.status === "ALREADY_PACKED"
        ? { box: "border-amber-300 bg-amber-50 dark:bg-warning/10", icon: AlertTriangle, iconClass: "text-amber-600", title: "Already packed" }
        : shown.status === "CANCELLED"
          ? { box: "border-error/40 bg-error/5", icon: XCircle, iconClass: "text-error", title: "Order cancelled: don't ship" }
          : { box: "border-error/40 bg-error/5", icon: XCircle, iconClass: "text-error", title: "Not found" };
  const Icon = tone.icon;

  return (
    <div key={shown.scannedAt} role="status" aria-live="assertive" className={cn("rounded-2xl border-2 p-6", tone.box)}>
      <div className="flex items-start gap-4">
        <Icon className={cn("size-12 shrink-0", tone.iconClass)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold">{tone.title}</p>
          {shown.orderNumber ? (
            <p className="mt-1 text-lg">
              Order <span className="font-semibold">{shown.orderNumber}</span>
              {shown.barcode ? <span className="ml-2 font-mono text-base text-muted">{shown.barcode}</span> : null}
            </p>
          ) : (
            <p className="mt-1 font-mono text-base text-muted">{shown.code}</p>
          )}
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
          <Button type="button" variant="secondary" className="shrink-0 gap-1.5" disabled={undoing} onClick={() => onUndo(shown.orderId!)}>
            <Undo2 className="size-4" aria-hidden /> Undo
          </Button>
        ) : null}
      </div>
    </div>
  );
}
