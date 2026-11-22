"use client";

import { useEffect, useState } from "react";
import {
  CircleDollarSign,
  Package,
  Radio,
  ShoppingBag,
  Store,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  CodMixChart,
  RevenueChart,
  ShipmentsHistogram,
  SourceMixChart,
} from "@/components/dashboard/analytics-charts";
import {
  AnalyticsDateFilter,
  formatAnalyticsCustomLabel,
  type AnalyticsDateFilterValue,
} from "@/components/dashboard/analytics-date-filter";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks/use-analytics";
import { cn } from "@/lib/utils";
import type { AnalyticsFocus, AnalyticsPeriodKpi, AnalyticsSeriesPoint } from "@/types/api";

type PayFilter = "all" | "COD" | "PREPAID";

const PAY_FILTERS: { id: PayFilter; label: string }[] = [
  { id: "all", label: "All payments" },
  { id: "COD", label: "COD" },
  { id: "PREPAID", label: "Prepaid" },
];

function liveLabel(updatedAt: number, now: number) {
  if (!updatedAt) return "Waiting for first snapshot";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 5) return "Live · updated just now";
  if (seconds < 60) return `Live · updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `Live · updated ${minutes}m ago`;
}

function istDateKey(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function focusMatches(focus: AnalyticsFocus | undefined, filter: AnalyticsDateFilterValue) {
  if (!focus || focus.id !== filter.kind) return false;
  if (filter.kind !== "custom") return true;
  return istDateKey(focus.from) === filter.from && istDateKey(focus.to) === filter.to;
}

function MetricCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint: string;
  loading: boolean;
}) {
  return (
    <Card className="relative overflow-hidden">
      <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand" />
      <CardHeader className="gap-3 p-5 sm:p-6">
        <CardDescription className="font-medium text-foreground">{label}</CardDescription>
        {loading ? (
          <Skeleton className="h-8 w-36" />
        ) : (
          <CardTitle className="truncate text-2xl tabular-nums sm:text-[1.7rem]">{value}</CardTitle>
        )}
        <p className="text-xs text-muted">{hint}</p>
      </CardHeader>
    </Card>
  );
}

function InsightCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "brand",
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "brand" | "warning";
  loading: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex items-start gap-4 p-5 sm:p-6">
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-2xl",
            tone === "warning"
              ? "bg-warning/15 text-amber-700 dark:text-amber-400"
              : "bg-brand/10 text-brand"
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <CardDescription className="font-medium">{label}</CardDescription>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-28" />
          ) : (
            <CardTitle className="mt-1 truncate text-2xl tabular-nums">{value}</CardTitle>
          )}
          {hint ? <p className="mt-2 text-sm leading-5 text-muted">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function indiaPostForFilter(period: AnalyticsPeriodKpi | undefined, payFilter: PayFilter) {
  if (!period) {
    return { booked: 0, amount: 0, codBooked: 0, codAmount: 0, prepaidBooked: 0, prepaidAmount: 0 };
  }
  if (payFilter === "COD") {
    return {
      booked: period.indiaPostCodBooked,
      amount: period.indiaPostCodAmount,
      codBooked: period.indiaPostCodBooked,
      codAmount: period.indiaPostCodAmount,
      prepaidBooked: 0,
      prepaidAmount: 0,
    };
  }
  if (payFilter === "PREPAID") {
    return {
      booked: period.indiaPostPrepaidBooked,
      amount: period.indiaPostPrepaidAmount,
      codBooked: 0,
      codAmount: 0,
      prepaidBooked: period.indiaPostPrepaidBooked,
      prepaidAmount: period.indiaPostPrepaidAmount,
    };
  }
  return {
    booked: period.indiaPostBooked,
    amount: period.indiaPostBookedAmount,
    codBooked: period.indiaPostCodBooked,
    codAmount: period.indiaPostCodAmount,
    prepaidBooked: period.indiaPostPrepaidBooked,
    prepaidAmount: period.indiaPostPrepaidAmount,
  };
}

function seriesForPayFilter(series: AnalyticsSeriesPoint[], payFilter: PayFilter) {
  if (payFilter === "all") return series;
  return series.map((point) =>
    payFilter === "COD"
      ? { ...point, prepaid: 0, indiaPostPrepaidAmount: 0 }
      : { ...point, cod: 0, indiaPostCodAmount: 0 }
  );
}

const PRESET_LABELS: Record<Exclude<AnalyticsDateFilterValue["kind"], "custom">, string> = {
  today: "Today",
  yesterday: "Yesterday",
  month: "This month",
  year: "This year",
};

export default function AnalyticsPage() {
  const [dateFilter, setDateFilter] = useState<AnalyticsDateFilterValue>({ kind: "today" });
  const analytics = useAnalytics(
    dateFilter.kind === "custom"
      ? { range: "custom", from: dateFilter.from, to: dateFilter.to }
      : { range: dateFilter.kind }
  );
  const [payFilter, setPayFilter] = useState<PayFilter>("all");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const data = analytics.data;
  const rangeReady = focusMatches(data?.focus, dateFilter);
  const period = rangeReady ? data?.focus.period : undefined;
  const series = seriesForPayFilter(rangeReady ? (data?.focus.series ?? []) : [], payFilter);
  const sources = rangeReady ? (data?.focus.sources ?? []) : [];
  const prepaidOrders =
    payFilter === "COD" ? 0 : (period?.prepaidOrders ?? Math.max(0, (period?.orders ?? 0) - (period?.codOrders ?? 0)));
  const codOrders = payFilter === "PREPAID" ? 0 : (period?.codOrders ?? 0);
  const codAmount = payFilter === "PREPAID" ? 0 : (period?.codAmount ?? 0);
  const prepaidAmount = payFilter === "COD" ? 0 : (period?.prepaidAmount ?? 0);
  const indiaPost = indiaPostForFilter(period, payFilter);
  const hasActivity = Boolean(
    data &&
      (data.year.orders > 0 ||
        data.year.shipments > 0 ||
        data.year.indiaPostBooked > 0 ||
        data.focus.period.orders > 0 ||
        data.focus.period.shipments > 0 ||
        data.focus.period.indiaPostBooked > 0)
  );
  const selectedRangeLabel =
    dateFilter.kind === "custom"
      ? formatAnalyticsCustomLabel(dateFilter.from, dateFilter.to)
      : PRESET_LABELS[dateFilter.kind];
  const paymentAmount = (source: AnalyticsPeriodKpi | undefined) =>
    payFilter === "COD" ? source?.codAmount : payFilter === "PREPAID" ? source?.prepaidAmount : source?.revenue;
  const currentRevenue = paymentAmount(period);
  const totalRevenue = paymentAmount(data?.year);
  const orders =
    payFilter === "COD" ? period?.codOrders : payFilter === "PREPAID" ? period?.prepaidOrders : period?.orders;
  const showCodInsight = payFilter !== "PREPAID";
  const showPrepaidInsight = payFilter !== "COD";

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader
        title="Analytics"
        description="Live revenue, India Post booked amounts, sources, and COD vs prepaid for this workspace."
        className="gap-5"
        actions={
          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <span
              className={cn(
                "inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-medium text-muted sm:justify-start"
              )}
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              {analytics.isError ? "Live feed paused" : liveLabel(analytics.dataUpdatedAt, now)}
            </span>
            <AnalyticsDateFilter value={dateFilter} onChange={setDateFilter} />
            <Select value={payFilter} onValueChange={(value) => setPayFilter(value as PayFilter)}>
              <SelectTrigger aria-label="Payment" className="w-full bg-card sm:w-[170px]">
                <SelectValue placeholder="Payment" />
              </SelectTrigger>
              <SelectContent>
                {PAY_FILTERS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {analytics.isError ? (
        <EmptyState
          icon={Radio}
          title="Analytics unavailable"
          description={analytics.error instanceof Error ? analytics.error.message : "Try again shortly."}
        />
      ) : (
        <>
          <section aria-labelledby="performance-heading" className="space-y-3">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
                  Performance
                </p>
                <h2 id="performance-heading" className="mt-1 text-lg font-semibold text-ink">
                  {selectedRangeLabel}
                </h2>
              </div>
              <p className="hidden text-sm text-muted sm:block">All times in Asia/Kolkata</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Current revenue"
                value={formatCurrency(currentRevenue)}
                hint={`${selectedRangeLabel} · non-cancelled`}
                loading={!rangeReady}
              />
              <MetricCard
                label="Total revenue"
                value={formatCurrency(totalRevenue)}
                hint="This year · non-cancelled"
                loading={!data}
              />
              <MetricCard
                label="Orders"
                value={formatNumber(orders)}
                hint={payFilter === "all" ? "All payments" : payFilter === "COD" ? "Cash on delivery" : "Prepaid"}
                loading={!rangeReady}
              />
              <MetricCard
                label="Shipments"
                value={formatNumber(period?.shipments)}
                hint="Created in this range"
                loading={!rangeReady}
              />
            </div>
          </section>

          <section aria-labelledby="india-post-heading" className="space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">India Post</p>
              <h2 id="india-post-heading" className="mt-1 text-lg font-semibold text-ink">
                Booked · {selectedRangeLabel}
              </h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {!rangeReady
                ? Array.from({ length: 3 }, (_, index) => (
                    <Card key={index}>
                      <CardContent className="p-6">
                        <Skeleton className="h-20 w-full" />
                      </CardContent>
                    </Card>
                  ))
                : (
                  <>
                    <InsightCard
                      icon={Package}
                      label="India Post booked"
                      value={formatNumber(indiaPost.booked)}
                      hint={`${formatCurrency(indiaPost.amount)} booked order value`}
                      loading={!rangeReady}
                    />
                    {showCodInsight ? (
                      <InsightCard
                        icon={CircleDollarSign}
                        label="COD booked"
                        value={formatNumber(indiaPost.codBooked)}
                        hint={`${formatCurrency(indiaPost.codAmount)} cash-on-delivery collect`}
                        tone="warning"
                        loading={!rangeReady}
                      />
                    ) : null}
                    {showPrepaidInsight ? (
                      <InsightCard
                        icon={Wallet}
                        label="Prepaid booked"
                        value={formatNumber(indiaPost.prepaidBooked)}
                        hint={`${formatCurrency(indiaPost.prepaidAmount)} prepaid order value`}
                        loading={!rangeReady}
                      />
                    ) : null}
                  </>
                )}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {!rangeReady
              ? Array.from({ length: 3 }, (_, index) => (
                  <Card key={index}>
                    <CardContent className="p-6">
                      <Skeleton className="h-20 w-full" />
                    </CardContent>
                  </Card>
                ))
              : (
                <>
                  {showCodInsight ? (
                    <InsightCard
                      icon={CircleDollarSign}
                      label={`COD orders · ${selectedRangeLabel}`}
                      value={formatNumber(codOrders)}
                      hint={`${formatCurrency(codAmount)} cash-on-delivery order value`}
                      tone="warning"
                      loading={!rangeReady}
                    />
                  ) : null}
                  {showPrepaidInsight ? (
                    <InsightCard
                      icon={Wallet}
                      label={`Prepaid orders · ${selectedRangeLabel}`}
                      value={formatNumber(prepaidOrders)}
                      hint={`${formatCurrency(prepaidAmount)} prepaid order value`}
                      loading={!rangeReady}
                    />
                  ) : null}
                  <InsightCard
                    icon={Store}
                    label="Top order source · This year"
                    value={data?.topSource?.label ?? "—"}
                    hint={
                      data?.topSource
                        ? `${formatNumber(Math.round(data.topSource.share))}% of orders · ${formatNumber(data.topSource.orders)} total`
                        : "No source data available yet"
                    }
                    loading={!rangeReady}
                  />
                </>
              )}
          </section>

          {!rangeReady ? (
            <section className="grid gap-4 xl:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Card key={index}>
                  <CardHeader>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-72 w-full" />
                  </CardContent>
                </Card>
              ))}
            </section>
          ) : !hasActivity ? (
            <EmptyState
              icon={ShoppingBag}
              title="No analytics yet"
              description="Import Shopify orders or add a manual order to see revenue, sources, and shipment histograms."
            />
          ) : (
            <section aria-labelledby="charts-heading" className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
                  Trends
                </p>
                <h2 id="charts-heading" className="mt-1 text-lg font-semibold text-ink">
                  {selectedRangeLabel} breakdown
                </h2>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <RevenueChart data={series} />
                <ShipmentsHistogram data={series} />
                <SourceMixChart data={sources} />
                <CodMixChart
                  series={series}
                  codOrders={codOrders}
                  prepaidOrders={prepaidOrders}
                />
              </div>
            </section>
          )}
        </>
      )}

      {data?.truncated ? (
        <p className="text-sm text-muted">
          Showing the first 5,000 rows from this year. Older records beyond that cap are not included.
        </p>
      ) : null}
    </div>
  );
}
