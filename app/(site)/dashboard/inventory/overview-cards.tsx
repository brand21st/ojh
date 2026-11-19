"use client";

import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Boxes, Minus, Package, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { api, toSearchParams } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import type { InventoryOverview, InventoryOverviewPeriod } from "@/types/api";

export type OverviewRange = InventoryOverview["range"];
export const OVERVIEW_RANGES: Array<{ value: OverviewRange; label: string; compare: string }> = [
  { value: "today", label: "Today", compare: "same time yesterday" },
  { value: "7d", label: "7 days", compare: "previous 7 days" },
  { value: "30d", label: "30 days", compare: "previous 30 days" },
  { value: "90d", label: "90 days", compare: "previous 90 days" },
];

const DAY = 24 * 60 * 60 * 1000;
const card = "min-w-0 rounded-2xl border border-border bg-card";
const wholeRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const rupees = (value: number) => wholeRupees.format(Math.round(value));
const compactRupees = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 }).format(value);

/* ---------- calculations ---------- */

export function percentChange(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : Infinity;
  return ((current - previous) / previous) * 100;
}

const aov = (p: InventoryOverviewPeriod) => (p.orders ? p.orderValue / p.orders : 0);

/** Days the current stock lasts at the average daily sales rate; null when nothing sold. */
export function daysOfCover(onHand: number, unitsSold: number, days: number) {
  if (onHand <= 0) return 0;
  if (unitsSold <= 0 || days <= 0) return null;
  return onHand / (unitsSold / days);
}

function coverLabel(days: number | null) {
  if (days === null) return "No recent sales";
  if (days === 0) return "Sold out";
  if (days < 1) return "Under a day left";
  if (days > 365) return "Over a year left";
  return `About ${Math.round(days)} ${Math.round(days) === 1 ? "day" : "days"} left`;
}

function bucketLabel(bucket: string, kind: InventoryOverview["bucket"], long = false) {
  const [date, time = "00:00"] = bucket.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const hour = Number(time.slice(0, 2));
  if (kind === "hour") {
    const h = hour % 12 || 12;
    return `${h} ${hour < 12 ? "am" : "pm"}`;
  }
  const value = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", weekday: long ? "short" : undefined, timeZone: "UTC" }).format(value);
}

function rangeLabel(from: string, to: string, range: OverviewRange) {
  const fmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  if (range === "today") return `Today, ${fmt.format(new Date(to))}`;
  return `${fmt.format(new Date(from))} to ${fmt.format(new Date(to))}`;
}

/* ---------- pieces ---------- */

function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return null;
  if (value === Infinity) return <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">New</span>;
  const flat = Math.abs(value) < 0.5;
  const good = invert ? value < 0 : value > 0;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        flat ? "bg-surface-soft text-muted" : good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
      )}
    >
      <Icon className="size-3" aria-hidden />
      {flat ? "0%" : `${Math.abs(value) >= 100 ? Math.round(Math.abs(value)) : Math.abs(value).toFixed(1)}%`}
      <span className="sr-only">{flat ? "no change" : value > 0 ? "increase" : "decrease"}</span>
    </span>
  );
}

function Kpi({ label, value, change, previous, help }: { label: string; value: string; change: number | null; previous?: string; help?: string }) {
  return (
    <div className={cn(card, "p-4")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-muted">{label}</p>
        <Delta value={change} />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      <p className="mt-1 truncate text-xs text-muted">{previous ?? help ?? " "}</p>
    </div>
  );
}

function TrendCard({ data }: { data: InventoryOverview }) {
  const rows = data.series.map((b) => ({ ...b, label: bucketLabel(b.bucket, data.bucket), long: bucketLabel(b.bucket, data.bucket, true) }));
  const empty = !rows.some((r) => r.orders > 0);
  const peak = rows.reduce((best, r) => (r.orderValue > best.orderValue ? r : best), rows[0] ?? { orderValue: 0, long: "" });
  return (
    <section className={cn(card, "p-4 sm:p-5 lg:col-span-2")} aria-labelledby="trend-head">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 id="trend-head" className="font-semibold text-ink">Sales trend</h3>
          <p className="text-xs text-muted">Order value {data.bucket === "hour" ? "by hour" : "by day"}, India time. Cancelled, returned and refunded orders are left out.</p>
        </div>
        {!empty && peak ? <p className="text-xs text-muted">Best {data.bucket === "hour" ? "hour" : "day"}: <span className="font-semibold text-ink">{peak.long}</span>, {rupees(peak.orderValue)}</p> : null}
      </div>
      {empty ? (
        <div className="grid h-56 place-items-center text-center">
          <div>
            <TrendingUp className="mx-auto size-6 text-muted" aria-hidden />
            <p className="mt-2 text-sm font-medium text-ink">No sales in this period</p>
            <p className="text-xs text-muted">The chart fills in as orders come in.</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 h-56 sm:h-64" role="img" aria-label={`Sales trend chart, ${rows.length} points`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="inv-trend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand, #e11d48)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--brand, #e11d48)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} minTickGap={18} tick={{ fill: "var(--muted)" }} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} width={52} tick={{ fill: "var(--muted)" }} tickFormatter={(v: number) => compactRupees(v)} />
              <Tooltip
                cursor={{ stroke: "var(--border)" }}
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12, color: "var(--ink)" }}
                labelFormatter={(_, payload) => String(payload?.[0]?.payload?.long ?? "")}
                formatter={(value, _name, item) => [`${rupees(Number(value))} from ${formatNumber(item.payload.orders)} ${item.payload.orders === 1 ? "order" : "orders"}`, "Sales"]}
              />
              <Area type="monotone" dataKey="orderValue" stroke="var(--brand, #e11d48)" strokeWidth={2} fill="url(#inv-trend)" activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function MoneyCard({ current, wide }: { current: InventoryOverviewPeriod; wide: boolean }) {
  const total = current.orderValue;
  const parts = [
    { key: "collected", label: "Collected", help: "Paid online or marked paid", value: current.collected, bar: "bg-emerald-500" },
    { key: "cod", label: "COD to collect", help: "Cash due on delivery", value: current.codDue, bar: "bg-sky-500" },
    { key: "prepaid", label: "Awaiting payment", help: "Prepaid orders not yet paid", value: current.prepaidDue, bar: "bg-amber-400" },
  ];
  const excluded = current.returned + current.cancelled + current.refunded;
  const returnRate = current.orders + current.returned ? (current.returned / (current.orders + current.returned)) * 100 : 0;
  return (
    <section className={cn(card, "flex flex-col p-4 sm:p-5", wide && "lg:col-span-3")} aria-labelledby="money-head">
      <h3 id="money-head" className="font-semibold text-ink">Where the money is</h3>
      <p className="text-xs text-muted">{rupees(total)} in sales this period</p>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-surface-soft" role="img" aria-label={parts.map((p) => `${p.label} ${rupees(p.value)}`).join(", ")}>
        {total > 0 ? parts.map((p) => <span key={p.key} className={p.bar} style={{ width: `${(p.value / total) * 100}%` }} />) : null}
      </div>
      <ul className={cn("mt-4 grid gap-3", wide && "sm:grid-cols-3")}>
        {parts.map((p) => (
          <li key={p.key} className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-start gap-2">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", p.bar)} aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{p.label}</span>
                <span className="block text-xs text-muted">{p.help}</span>
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm font-semibold tabular-nums text-ink">{rupees(p.value)}</span>
              <span className="block text-xs tabular-nums text-muted">{total > 0 ? `${Math.round((p.value / total) * 100)}%` : "0%"}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-4">
        <div className="rounded-xl bg-surface-soft p-3 text-xs text-muted">
          {excluded ? (
            <>
              <p className="font-medium text-ink">Not counted as sales</p>
              <p className="mt-1 tabular-nums">
                {[
                  current.returned ? `${formatNumber(current.returned)} returned (RTO)` : null,
                  current.cancelled ? `${formatNumber(current.cancelled)} cancelled or failed` : null,
                  current.refunded ? `${formatNumber(current.refunded)} refunded` : null,
                ].filter(Boolean).join(", ")}
              </p>
              {current.returned ? <p className="mt-1">Return rate {returnRate.toFixed(1)}%</p> : null}
            </>
          ) : (
            <p>No returned, cancelled or refunded orders in this period.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function StockCard({ data }: { data: InventoryOverview }) {
  const c = data.catalog;
  const healthy = Math.max(0, c.activeProducts - c.lowStock - c.outOfStock);
  const base = Math.max(1, c.activeProducts);
  const inactive = Math.max(0, c.totalProducts - c.activeProducts);
  const segments = [
    { label: "Healthy", value: healthy, bar: "bg-emerald-500", href: "/dashboard/inventory?tab=products&active=true&stock=inStock" },
    { label: "Low stock", value: c.lowStock, bar: "bg-amber-400", href: "/dashboard/inventory?tab=products&active=true&stock=lowStock" },
    { label: "Out of stock", value: c.outOfStock, bar: "bg-red-500", href: "/dashboard/inventory?tab=products&active=true&stock=outOfStock" },
  ];
  return (
    <section className={cn(card, "p-4 sm:p-5")} aria-labelledby="stock-head">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="stock-head" className="font-semibold text-ink">Stock health</h3>
        <p className="text-xs text-muted">Active products only{inactive ? `. ${formatNumber(inactive)} inactive not counted` : ""}</p>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted">Stock value</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-ink sm:text-xl">{rupees(c.stockValue)}</dd>
          <dd className="text-[11px] text-muted">at selling price</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Units on hand</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-ink sm:text-xl">{formatNumber(c.stockUnits)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Active products</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-ink sm:text-xl">{formatNumber(c.activeProducts)}</dd>
          <dd className="text-[11px] text-muted">of {formatNumber(c.totalProducts)}</dd>
        </div>
      </dl>
      <div className="mt-5 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-soft" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        {segments.map((s) => (s.value ? <span key={s.label} className={s.bar} style={{ width: `${(s.value / base) * 100}%` }} /> : null))}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {segments.map((s) => (
          <li key={s.label}>
            <Link href={s.href} className="block rounded-lg p-2 -m-2 hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-brand">
              <span className="flex items-center gap-1.5 text-xs text-muted"><span className={cn("size-2 rounded-full", s.bar)} aria-hidden />{s.label}</span>
              <span className="mt-0.5 block text-sm font-semibold tabular-nums text-ink">
                {formatNumber(s.value)} <span className="font-normal text-muted">({Math.round((s.value / base) * 100)}%)</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TopProducts({ data, windowDays }: { data: InventoryOverview; windowDays: number }) {
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units));
  return (
    <section className={cn(card, "p-4 sm:p-5")} aria-labelledby="top-head">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="top-head" className="font-semibold text-ink">Top sellers</h3>
        <p className="text-xs text-muted">By units sold</p>
      </div>
      {!data.topProducts.length ? (
        <p className="py-10 text-center text-sm text-muted">No product sales in this period yet.</p>
      ) : (
        <div className="mt-3">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th scope="col" className="hidden w-7 py-2 font-medium sm:table-cell">#</th>
                <th scope="col" className="py-2 font-medium">Product</th>
                <th scope="col" className="w-12 py-2 text-right font-medium sm:w-14">Units</th>
                <th scope="col" className="w-20 py-2 text-right font-medium sm:w-24">Sales</th>
                <th scope="col" className="w-24 py-2 pl-2 text-right font-medium sm:w-32 sm:pl-3">Stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.topProducts.map((p, i) => {
                const cover = daysOfCover(p.onHand, p.units, windowDays);
                const urgent = cover !== null && cover < 7;
                return (
                  <tr key={p.productId}>
                    <td className="hidden py-2.5 text-xs tabular-nums text-muted sm:table-cell">{i + 1}</td>
                    <td className="py-2.5 pr-3">
                      <Link href={`/dashboard/inventory?tab=products&q=${encodeURIComponent(p.sku || p.name)}`} className="block truncate font-medium text-ink hover:underline" title={p.name}>{p.name}</Link>
                      <span className="block truncate text-[11px] text-muted">{p.sku}</span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-soft" aria-hidden><span className="block h-full rounded-full bg-brand/60" style={{ width: `${(p.units / maxUnits) * 100}%` }} /></span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{formatNumber(p.units)}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums">{rupees(p.revenue)}</td>
                    <td className="py-2.5 pl-2 text-right sm:pl-3">
                      <span className="block tabular-nums">{formatNumber(p.onHand)}</span>
                      <span className={cn("block text-[11px]", urgent ? "font-medium text-red-600" : "text-muted")}>{coverLabel(cover)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RestockList({ data }: { data: InventoryOverview }) {
  return (
    <section className={cn(card, "p-4 sm:p-5")} aria-labelledby="restock-head">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="restock-head" className="font-semibold text-ink">Needs restock</h3>
        {data.catalog.lowStock + data.catalog.outOfStock > data.attention.length ? (
          <Link href="/dashboard/inventory?tab=products&active=true&stock=lowStock" className="text-xs font-medium text-brand hover:underline">
            View all {formatNumber(data.catalog.lowStock + data.catalog.outOfStock)}
          </Link>
        ) : null}
      </div>
      {!data.attention.length ? (
        <div className="py-10 text-center">
          <Boxes className="mx-auto size-6 text-emerald-600" aria-hidden />
          <p className="mt-2 text-sm font-medium text-ink">Every active product is above its low-stock level</p>
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {data.attention.map((p) => {
            const cover = p.units30d === null ? undefined : daysOfCover(p.onHand, p.units30d, 30);
            const out = p.onHand <= 0;
            return (
              <li key={p.productId} className="flex items-center gap-3 py-2.5">
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold tabular-nums", out ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800")} aria-label={`${p.onHand} on hand`}>
                  {Math.max(0, p.onHand)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                  <p className="truncate text-xs text-muted">
                    {out ? "Out of stock" : `Low, alert at ${formatNumber(p.threshold)}`}
                    {p.units30d !== null ? `. ${formatNumber(p.units30d)} sold in 30 days` : ""}
                    {cover !== undefined && !out ? `. ${coverLabel(cover)}` : ""}
                  </p>
                </div>
                <Link
                  href={`/dashboard/inventory?tab=products&q=${encodeURIComponent(p.sku || p.name)}`}
                  className="inline-flex h-8 shrink-0 items-center rounded-[var(--radius-btn)] border border-border bg-card px-3 text-xs font-semibold hover:bg-surface-soft"
                >
                  Restock
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading overview">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[108px] rounded-2xl" />)}</div>
      <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-80 rounded-2xl lg:col-span-2" /><Skeleton className="h-80 rounded-2xl" /></div>
      <Skeleton className="h-48 rounded-2xl" />
    </div>
  );
}

/* ---------- page ---------- */

export function InventoryOverview({ range, onRangeChange }: { range: OverviewRange; onRangeChange: (range: OverviewRange) => void }) {
  const query = useQuery({
    queryKey: ["inventory-overview", range],
    queryFn: () => api<InventoryOverview>(`/api/v1/inventory/overview?${toSearchParams({ range })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60 * 1000,
  });
  const data = query.data;
  const compare = OVERVIEW_RANGES.find((r) => r.value === range)?.compare ?? "previous period";

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">Overview</h2>
        <p className="text-xs text-muted">
          {data ? rangeLabel(data.from, data.to, data.range) : "Sales, payments and stock for this workspace"}
          {data?.complete ? `, compared with the ${compare}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {query.isFetching && data ? <RefreshCw className="size-4 animate-spin text-muted motion-reduce:animate-none" aria-label="Updating" /> : null}
        <div className="flex rounded-xl border border-border bg-surface-soft p-1" role="radiogroup" aria-label="Date range">
          {OVERVIEW_RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={range === r.value}
              className={cn("h-8 rounded-lg px-3 text-sm font-medium transition-colors", range === r.value ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink")}
              onClick={() => onRangeChange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (query.isError && !data) {
    return (
      <div className="space-y-4">
        {header}
        <div className={cn(card, "p-8 text-center")}>
          <p className="font-semibold text-ink">The overview didn&apos;t load.</p>
          <p className="mt-1 text-sm text-muted">Check your connection and try again.</p>
          <Button className="mt-4" type="button" onClick={() => void query.refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!data) return <div className="space-y-4">{header}<LoadingState /></div>;

  if (!data.catalog.totalProducts) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
          <Package className="mx-auto size-8 text-muted" aria-hidden />
          <p className="mt-3 font-semibold text-ink">Add your first product</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Stock levels, sales and restock alerts show up here once your catalog has products.</p>
          <Link href="/dashboard/inventory?tab=products" className="mt-5 inline-flex h-10 items-center rounded-[var(--radius-btn)] bg-brand px-5 text-sm font-semibold text-white">Add products</Link>
        </div>
      </div>
    );
  }

  const cur = data.current;
  const prev = data.previous;
  const windowDays = Math.max(1 / 24, (new Date(data.to).getTime() - new Date(data.from).getTime()) / DAY);
  const was = (value: string) => (prev ? `Previously ${value}` : undefined);

  return (
    <div className={cn("space-y-4 transition-opacity", query.isFetching && query.isPlaceholderData && "opacity-60")}>
      {header}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Sales" value={rupees(cur.orderValue)} change={percentChange(cur.orderValue, prev?.orderValue)} previous={prev ? was(rupees(prev.orderValue)) : undefined} help="Order value, excluding returns" />
        <Kpi label="Orders" value={formatNumber(cur.orders)} change={percentChange(cur.orders, prev?.orders)} previous={prev ? was(formatNumber(prev.orders)) : undefined} />
        <Kpi label="Average order value" value={cur.orders ? rupees(aov(cur)) : "No orders"} change={prev && cur.orders && prev.orders ? percentChange(aov(cur), aov(prev)) : null} previous={prev?.orders ? was(rupees(aov(prev))) : undefined} />
        <Kpi label="Units sold" value={formatNumber(cur.units)} change={percentChange(cur.units, prev?.units)} previous={prev ? was(formatNumber(prev.units)) : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {data.complete ? <TrendCard data={data} /> : null}
        <MoneyCard current={cur} wide={!data.complete} />
      </div>
      <StockCard data={data} />
      <div className="grid gap-4 xl:grid-cols-2">
        <TopProducts data={data} windowDays={windowDays} />
        <RestockList data={data} />
      </div>
    </div>
  );
}
