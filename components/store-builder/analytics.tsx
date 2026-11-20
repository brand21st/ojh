"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { formatStorePrice } from "@/modules/storefront/pricing";

export type StoreAnalytics = {
  range: "7d" | "30d" | "90d";
  funnel: { PRODUCT_VIEW: number; ADD_TO_CART: number; CHECKOUT_STARTED: number; PURCHASE: number };
  revenue: number;
  conversionRate: number;
  topProducts: Array<{ id: string; name: string; views: number }>;
  series: Array<{ day: string; views: number; orders: number }>;
};

export function useStoreAnalytics(range: StoreAnalytics["range"]) {
  return useQuery({ queryKey: ["store-builder", "analytics", range], queryFn: () => api<StoreAnalytics>(`/api/v1/inventory/storefront/analytics?range=${range}`) });
}

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

const STEPS = [
  { key: "PRODUCT_VIEW", label: "Product views" },
  { key: "ADD_TO_CART", label: "Added to cart" },
  { key: "CHECKOUT_STARTED", label: "Started checkout" },
  { key: "PURCHASE", label: "Orders" },
] as const;

export function StoreAnalyticsDashboard() {
  const [range, setRange] = useState<StoreAnalytics["range"]>("30d");
  const query = useStoreAnalytics(range);
  const data = query.data;
  const top = data?.funnel.PRODUCT_VIEW || 1;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Store performance</h2>
        <div role="group" aria-label="Date range" className="flex rounded-lg border border-border bg-surface-soft p-0.5">
          {(["7d", "30d", "90d"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)} className={cn("h-7 rounded-md px-3 text-xs font-medium", range === value ? "bg-card shadow-sm" : "text-muted hover:text-ink")}>
              {value === "7d" ? "7 days" : value === "30d" ? "30 days" : "90 days"}
            </button>
          ))}
        </div>
      </div>
      {query.isError ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm">Could not load analytics. <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>Retry</Button></div>
      ) : !data ? (
        <div role="status" aria-label="Loading analytics" className="grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Product views" value={data.funnel.PRODUCT_VIEW.toLocaleString("en-IN")} />
            <Kpi label="Orders" value={data.funnel.PURCHASE.toLocaleString("en-IN")} />
            <Kpi label="Store revenue" value={formatStorePrice(data.revenue)} hint="From store checkouts" />
            <Kpi label="Conversion" value={`${data.conversionRate}%`} hint="Orders ÷ product views" />
          </div>
          <section aria-labelledby="funnel-title" className="rounded-xl border border-border bg-card p-4">
            <h3 id="funnel-title" className="text-sm font-semibold">Shopper funnel</h3>
            <ol className="mt-3 space-y-2">
              {STEPS.map((step) => {
                const value = data.funnel[step.key];
                const pct = Math.round((value / top) * 100);
                return (
                  <li key={step.key} className="grid grid-cols-[120px_minmax(0,1fr)_60px] items-center gap-2 text-xs sm:grid-cols-[160px_minmax(0,1fr)_70px]">
                    <span className="truncate">{step.label}</span>
                    <span className="h-2.5 overflow-hidden rounded-full bg-surface-soft"><span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(pct, value ? 2 : 0)}%` }} /></span>
                    <span className="text-right tabular-nums text-muted">{value.toLocaleString("en-IN")}</span>
                  </li>
                );
              })}
            </ol>
          </section>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-labelledby="trend-title" className="min-w-0 rounded-xl border border-border bg-card p-4">
              <h3 id="trend-title" className="text-sm font-semibold">Views and orders</h3>
              <div className="mt-3 h-56 w-full" role="img" aria-label="Daily product views and orders">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.series} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(day: string) => day.slice(5)} minTickGap={24} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="views" name="Views" stroke="#64748b" fill="#64748b" fillOpacity={0.12} />
                    <Area type="monotone" dataKey="orders" name="Orders" stroke="#e11d48" fill="#e11d48" fillOpacity={0.18} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section aria-labelledby="top-title" className="min-w-0 rounded-xl border border-border bg-card p-4">
              <h3 id="top-title" className="text-sm font-semibold">Most viewed products</h3>
              {data.topProducts.length ? (
                <ol className="mt-3 space-y-2 text-xs">
                  {data.topProducts.map((product, index) => (
                    <li key={product.id} className="flex items-center gap-2"><span className="w-4 text-muted">{index + 1}</span><span className="min-w-0 flex-1 truncate">{product.name}</span><span className="tabular-nums text-muted">{product.views}</span></li>
                  ))}
                </ol>
              ) : <p className="mt-3 text-xs text-muted">No product views in this period yet.</p>}
            </section>
          </div>
          <p className="text-xs text-muted">Cover impressions and clicks are in Marketing → Covers. Pixels for Meta, GA4 and Clarity are in Marketing → Tracking.</p>
        </>
      )}
    </div>
  );
}
