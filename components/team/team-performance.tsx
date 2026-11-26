"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, PackageCheck, Settings2, Tag, Truck, Trophy } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { meCan } from "@/lib/permissions/me";
import { TEAM_LABELS, roleLabel, type MemberTeam } from "@/lib/permissions/rbac";
import { formatDate, formatNumber, formatRelative } from "@/lib/format";
import { addDays, istDay } from "@/modules/team/performance";
import { cn } from "@/lib/utils";
import {
  TEAM_ACTION_LABELS,
  type TeamAction,
  type TeamActivityItem,
  type TeamPerformance,
} from "@/types/team";

const RANGES = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
] as const;

const METRICS: Array<{ action: TeamAction; icon: typeof Truck; hint: string }> = [
  { action: "order.booked", icon: Truck, hint: "Orders booked with India Post" },
  { action: "order.packed", icon: PackageCheck, hint: "Parcels scanned at the packing station" },
  { action: "label.printed", icon: Tag, hint: "Shipments whose labels were printed" },
  { action: "manifest.created", icon: ClipboardList, hint: "Shipments added to manifests" },
];

const ACTIVITY_VERB: Record<TeamAction, string> = {
  "order.booked": "booked",
  "order.packed": "packed",
  "label.printed": "printed the label for",
  "manifest.created": "created a manifest with",
};

function shortDay(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function TeamPerformanceView() {
  const me = useMe();
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("7d");
  const [metric, setMetric] = useState<TeamAction>("order.booked");
  const [person, setPerson] = useState<string>("all");

  const { from, to } = useMemo(() => {
    const today = istDay(new Date());
    const days = RANGES.find((item) => item.key === range)?.days ?? 7;
    return { from: addDays(today, -(days - 1)), to: today };
  }, [range]);

  const performance = useQuery({
    queryKey: ["team-performance", from, to],
    queryFn: () => api<TeamPerformance>(`/api/v1/team/performance?from=${from}&to=${to}`),
    refetchInterval: 60_000,
  });
  const activity = useQuery({
    queryKey: ["team-activity", person],
    queryFn: () =>
      api<{ items: TeamActivityItem[] }>(
        `/api/v1/team/activity?limit=40${person !== "all" ? `&actorId=${encodeURIComponent(person)}` : ""}`
      ),
    refetchInterval: 30_000,
  });

  const data = performance.data;
  const people = (data?.members ?? []).filter((member) => member.actorId);

  // One series: the chosen metric per day, for everyone or one person.
  const series = useMemo(() => {
    if (!data) return [];
    return data.days.map((day) => {
      const rows = data.daily.filter(
        (row) => row.day === day && (person === "all" || row.actorId === person)
      );
      return { day, value: rows.reduce((sum, row) => sum + row[metric], 0) };
    });
  }, [data, metric, person]);
  const peak = Math.max(1, ...series.map((point) => point.value));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team performance"
        description="Who booked, packed and printed what, day by day (India time)."
        actions={
          meCan(me.data, "members.manage") ? (
            <Link href="/dashboard/settings?tab=members" className={cn(buttonVariants({ variant: "secondary" }), "gap-2")}>
              <Settings2 className="size-4" aria-hidden /> Manage team
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={range} onValueChange={(value) => setRange(value as typeof range)}>
          <TabsList>
            {RANGES.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select value={person} onValueChange={setPerson}>
          <SelectTrigger className="w-52" aria-label="Team member">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {people.map((member) => (
              <SelectItem key={member.actorId!} value={member.actorId!}>
                {member.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map(({ action, icon: Icon, hint }) => {
          const value =
            person === "all"
              ? data?.totals[action] ?? 0
              : data?.members.find((member) => member.actorId === person)?.totals[action] ?? 0;
          return (
            <button
              key={action}
              type="button"
              onClick={() => setMetric(action)}
              aria-pressed={metric === action}
              className={cn(
                "rounded-2xl border bg-card p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                metric === action ? "border-brand/50 ring-1 ring-brand/30" : "border-border hover:border-brand/30"
              )}
            >
              <div className="flex items-center gap-2 text-sm text-muted">
                <Icon className="size-4" aria-hidden />
                {TEAM_ACTION_LABELS[action]}
              </div>
              {performance.isLoading ? (
                <Skeleton className="mt-2 h-8 w-20" />
              ) : (
                <p className="mt-1 text-3xl font-semibold tabular-nums">{formatNumber(value)}</p>
              )}
              <p className="mt-1 text-xs text-muted">{hint}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{TEAM_ACTION_LABELS[metric]} per day</CardTitle>
          <CardDescription>
            {person === "all" ? "Whole team" : people.find((member) => member.actorId === person)?.name} ·{" "}
            {formatDate(`${from}T00:00:00`)} – {formatDate(`${to}T00:00:00`)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {performance.isLoading ? (
            <Skeleton className="h-44 w-full" />
          ) : (
            <DailyBars series={series} peak={peak} label={TEAM_ACTION_LABELS[metric]} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Leaderboard</CardTitle>
            <CardDescription>Ranked by orders booked, packed and printed in this period.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {performance.isError ? (
              <p className="p-6 text-sm text-error">{(performance.error as Error).message}</p>
            ) : (
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-y border-border bg-surface-soft/60 text-xs font-medium uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5 text-left">Member</th>
                    <th className="px-2 py-2.5 text-right">Booked</th>
                    <th className="px-2 py-2.5 text-right">Packed</th>
                    <th className="px-2 py-2.5 text-right">Labels</th>
                    <th className="px-2 py-2.5 text-right">Manifested</th>
                    <th className="px-2 py-2.5 text-right" title="Booked + packed, average per active day">
                      Per day
                    </th>
                    <th className="px-4 py-2.5 text-right">Best day</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(data?.members ?? []).map((member, index) => {
                    const work = member.totals["order.booked"] + member.totals["order.packed"];
                    const perDay = member.activeDays ? Math.round(work / member.activeDays) : 0;
                    return (
                      <tr
                        key={member.actorId ?? "automation"}
                        className={cn("cursor-pointer hover:bg-surface-soft/50", person === member.actorId && "bg-rose-50/60 dark:bg-brand/10")}
                        onClick={() => member.actorId && setPerson(person === member.actorId ? "all" : member.actorId)}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {index === 0 && work > 0 && member.actorId ? (
                              <Trophy className="size-4 shrink-0 text-amber-500" aria-label="Top performer" />
                            ) : (
                              <span className="w-4 text-center text-xs text-muted tabular-nums">{index + 1}</span>
                            )}
                            <div className="min-w-0">
                              <p className="truncate font-medium">{member.name}</p>
                              <p className="truncate text-xs text-muted">
                                {member.actorId
                                  ? [roleLabel(member.role), member.team ? TEAM_LABELS[member.team as MemberTeam] : null]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : "Automatic bookings"}
                              </p>
                            </div>
                          </div>
                        </td>
                        {(["order.booked", "order.packed", "label.printed", "manifest.created"] as TeamAction[]).map((action) => (
                          <td key={action} className="px-2 py-2.5 text-right tabular-nums">
                            {member.totals[action] ? formatNumber(member.totals[action]) : <span className="text-muted/60">0</span>}
                          </td>
                        ))}
                        <td className="px-2 py-2.5 text-right tabular-nums">{perDay || <span className="text-muted/60">–</span>}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted">
                          {member.bestDay ? `${member.bestDay.count} on ${shortDay(member.bestDay.day)}` : "–"}
                        </td>
                      </tr>
                    );
                  })}
                  {!performance.isLoading && !(data?.members ?? []).length ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                        No team activity yet. Bookings, packing scans and label prints show up here as they happen.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
            <CardDescription>The latest work across your team.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {activity.isLoading ? (
              [0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-10 w-full" />)
            ) : (activity.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted">Nothing yet.</p>
            ) : (
              (activity.data?.items ?? []).map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-soft/50">
                  <p className="min-w-0 text-sm">
                    <span className="font-medium">{item.actorName}</span> {ACTIVITY_VERB[item.action]}{" "}
                    {item.action === "manifest.created" ? (
                      `${item.quantity} shipments`
                    ) : item.orderId ? (
                      <Link className="font-medium text-brand hover:underline" href={`/dashboard/orders/${item.orderId}`}>
                        {item.orderNumber ?? "an order"}
                      </Link>
                    ) : (
                      "an order"
                    )}
                    {item.barcode ? <span className="ml-1 text-xs text-muted">{item.barcode}</span> : null}
                  </p>
                  <span className="shrink-0 text-xs text-muted">{formatRelative(item.occurredAt)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted">
        Each order counts once per step: reprinting a label or re-booking doesn&apos;t inflate anyone&apos;s numbers.{" "}
        <Badge variant="outline">Automation</Badge> is work done by bulk booking or schedules with no person attached.
      </p>
    </div>
  );
}

/** Single-series daily bars with a per-bar hover tooltip. */
function DailyBars({ series, peak, label }: { series: Array<{ day: string; value: number }>; peak: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const showEvery = series.length > 31 ? 7 : series.length > 14 ? 3 : 1;
  const total = series.reduce((sum, point) => sum + point.value, 0);
  if (!total) {
    return <p className="py-12 text-center text-sm text-muted">No {label.toLowerCase()} in this period.</p>;
  }
  return (
    <div className="relative">
      <div className="flex h-44 items-end gap-[2px] border-b border-border" role="img" aria-label={`${label} per day`}>
        {series.map((point, index) => (
          <div
            key={point.day}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className={cn("w-full rounded-t-[4px] bg-brand transition-opacity", hover !== null && hover !== index && "opacity-50")}
              style={{ height: `${Math.max(point.value ? 2 : 0, (point.value / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${((hover + 0.5) / series.length) * 100}%` }}
        >
          <p className="font-medium">{shortDay(series[hover].day)}</p>
          <p className="text-muted">
            {label}: <span className="font-semibold text-foreground tabular-nums">{series[hover].value}</span>
          </p>
        </div>
      ) : null}
      <div className="mt-1.5 flex gap-[2px] text-[11px] text-muted">
        {series.map((point, index) => (
          <span key={point.day} className="flex-1 truncate text-center">
            {index % showEvery === 0 ? shortDay(point.day) : ""}
          </span>
        ))}
      </div>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">Show as table</summary>
        <table className="mt-2 w-full max-w-sm">
          <tbody>
            {series.map((point) => (
              <tr key={point.day} className="border-b border-border/60">
                <td className="py-1">{shortDay(point.day)}</td>
                <td className="py-1 text-right tabular-nums text-foreground">{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
