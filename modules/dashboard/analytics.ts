import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { TenantContext } from "@/lib/api/context";
import type {
  AnalyticsFocus,
  AnalyticsFocusId,
  AnalyticsPeriodKpi,
  AnalyticsRange,
  AnalyticsSeriesPoint,
  AnalyticsSourceShare,
  DashboardAnalytics,
} from "@/types/api";

export type AnalyticsFocusRequest =
  | { id: Exclude<AnalyticsFocusId, "custom"> }
  | { id: "custom"; from: string; to: string };

export const ANALYTICS_TIMEZONE = "Asia/Kolkata";
export const ANALYTICS_PAGE_SIZE = 1000;
export const ANALYTICS_MAX_ROWS = 5000;

export type AnalyticsOrderRow = {
  created_at: string;
  total_amount: number | string | null;
  source: string | null;
  payment_status: string | null;
  status: string | null;
};

export type AnalyticsShipmentOrder = {
  total_amount?: number | string | null;
};

export type AnalyticsShipmentRow = {
  created_at: string;
  booked_at?: string | null;
  payment_mode: string | null;
  cod_amount: number | string | null;
  status: string | null;
  provider?: string | null;
  orders?: AnalyticsShipmentOrder | AnalyticsShipmentOrder[] | null;
};

type IstParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  dateKey: string;
  monthKey: string;
};

const SOURCE_LABELS: Record<string, string> = {
  SHOPIFY: "Shopify",
  MANUAL: "Manual",
  API: "API",
  WOOCOMMERCE: "WooCommerce",
  WHATSAPP: "WhatsApp Order",
};

export function asAmount(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isActiveOrder(row: Pick<AnalyticsOrderRow, "status">) {
  return (row.status ?? "").toUpperCase() !== "CANCELLED";
}

export function isCodOrder(row: Pick<AnalyticsOrderRow, "payment_status">) {
  return (row.payment_status ?? "").toUpperCase() === "COD";
}

export function isActiveShipment(row: Pick<AnalyticsShipmentRow, "status">) {
  return (row.status ?? "").toUpperCase() !== "CANCELLED";
}

export function isCodShipment(row: Pick<AnalyticsShipmentRow, "payment_mode">) {
  return (row.payment_mode ?? "").toUpperCase() === "COD";
}

export function isIndiaPostShipment(row: Pick<AnalyticsShipmentRow, "provider">) {
  const provider = (row.provider ?? "INDIA_POST").toUpperCase();
  return provider === "INDIA_POST" || provider === "";
}

export function isIndiaPostBooked(
  row: Pick<AnalyticsShipmentRow, "provider" | "booked_at" | "status">
) {
  return Boolean(row.booked_at) && isIndiaPostShipment(row) && isActiveShipment(row);
}

export function shipmentOrderAmount(row: Pick<AnalyticsShipmentRow, "orders">) {
  const linked = Array.isArray(row.orders) ? row.orders[0] : row.orders;
  return asAmount(linked?.total_amount);
}

export function istParts(value: string | Date, timeZone = ANALYTICS_TIMEZONE): IstParts {
  const date = value instanceof Date ? value : new Date(value);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year,
    month,
    day,
    hour,
    dateKey: `${bag.year}-${bag.month}-${bag.day}`,
    monthKey: `${bag.year}-${bag.month}`,
  };
}

export function startOfIstYearIso(now: Date, timeZone = ANALYTICS_TIMEZONE) {
  const parts = istParts(now, timeZone);
  return new Date(`${parts.year}-01-01T00:00:00+05:30`).toISOString();
}

export function emptyPeriod(): AnalyticsPeriodKpi {
  return {
    shipments: 0,
    revenue: 0,
    orders: 0,
    codOrders: 0,
    codAmount: 0,
    prepaidOrders: 0,
    prepaidAmount: 0,
    indiaPostBooked: 0,
    indiaPostBookedAmount: 0,
    indiaPostCodBooked: 0,
    indiaPostCodAmount: 0,
    indiaPostPrepaidBooked: 0,
    indiaPostPrepaidAmount: 0,
  };
}

function emptySeriesPoint(key: string, label: string): AnalyticsSeriesPoint {
  return {
    key,
    label,
    revenue: 0,
    shipments: 0,
    orders: 0,
    cod: 0,
    prepaid: 0,
    indiaPostBooked: 0,
    indiaPostCodAmount: 0,
    indiaPostPrepaidAmount: 0,
  };
}

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source;
}

function monthLabel(month: number) {
  return new Date(Date.UTC(2026, month - 1, 1)).toLocaleString("en-IN", { month: "short" });
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const FOCUS_PRESETS = new Set<AnalyticsFocusId>(["today", "yesterday", "month", "year"]);

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function addCalendarDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function inclusiveCalendarDays(from: string, to: string) {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const start = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const end = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((end - start) / 86_400_000) + 1;
}

function isCalendarDate(value: string) {
  if (!DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function istDayStartIso(dateKey: string) {
  return new Date(`${dateKey}T00:00:00+05:30`).toISOString();
}

export function istDayEndIso(dateKey: string) {
  return new Date(`${dateKey}T23:59:59.999+05:30`).toISOString();
}

function formatCalendarDay(dateKey: string, withYear: boolean) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function customRangeLabel(from: string, to: string) {
  if (from === to) return formatCalendarDay(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (sameYear) return `${formatCalendarDay(from, false)} – ${formatCalendarDay(to, false)}`;
  return `${formatCalendarDay(from, true)} – ${formatCalendarDay(to, true)}`;
}

export function parseAnalyticsFocus(params: URLSearchParams, now = new Date()): AnalyticsFocusRequest {
  const raw = params.get("range") ?? "today";
  if (FOCUS_PRESETS.has(raw as AnalyticsFocusId)) return { id: raw as Exclude<AnalyticsFocusId, "custom"> };
  if (raw !== "custom") throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Unknown analytics range.");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Custom range needs from and to as YYYY-MM-DD.");
  }
  if (from > to) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Custom range start is after the end.");
  const todayKey = istParts(now).dateKey;
  if (from > todayKey || to > todayKey) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Custom range cannot include future dates.");
  }
  if (inclusiveCalendarDays(from, to) > 365) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Custom range cannot be longer than 365 days.");
  }
  return { id: "custom", from, to };
}

export function analyticsFetchSince(now: Date, focus: AnalyticsFocusRequest = { id: "today" }) {
  const yearStart = startOfIstYearIso(now);
  const todayKey = istParts(now).dateKey;
  const rangeStart =
    focus.id === "yesterday"
      ? istDayStartIso(addCalendarDays(todayKey, -1))
      : focus.id === "custom"
        ? istDayStartIso(focus.from)
        : yearStart;
  return rangeStart < yearStart ? rangeStart : yearStart;
}

function hourSeries(): AnalyticsSeriesPoint[] {
  return Array.from({ length: 24 }, (_, hour) =>
    emptySeriesPoint(pad(hour), `${pad(hour)}:00`)
  );
}

function eachDateKey(from: string, to: string) {
  const keys: string[] = [];
  const total = inclusiveCalendarDays(from, to);
  for (let offset = 0; offset < total; offset += 1) keys.push(addCalendarDays(from, offset));
  return keys;
}

function monthKeysBetween(from: string, to: string) {
  const keys: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${pad(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

type BucketWindow = {
  period: AnalyticsPeriodKpi;
  series: AnalyticsSeriesPoint[];
  sources: Map<string, AnalyticsSourceShare>;
  indexFor: (parts: IstParts) => number;
};

function buildCustomWindow(from: string, to: string): BucketWindow {
  const span = inclusiveCalendarDays(from, to);
  if (span <= 1) {
    return {
      period: emptyPeriod(),
      series: hourSeries(),
      sources: new Map(),
      indexFor: (parts) => (parts.dateKey === from ? parts.hour : -1),
    };
  }
  if (span <= 62) {
    const keys = eachDateKey(from, to);
    const lookup = new Map(keys.map((key, index) => [key, index]));
    return {
      period: emptyPeriod(),
      series: keys.map((key) => emptySeriesPoint(key, formatCalendarDay(key, false))),
      sources: new Map(),
      indexFor: (parts) => lookup.get(parts.dateKey) ?? -1,
    };
  }
  const keys = monthKeysBetween(from, to);
  const lookup = new Map(keys.map((key, index) => [key, index]));
  return {
    period: emptyPeriod(),
    series: keys.map((key) => {
      const [year, month] = key.split("-").map(Number);
      const sameYear = from.slice(0, 4) === to.slice(0, 4);
      return emptySeriesPoint(key, sameYear ? monthLabel(month) : `${monthLabel(month)} ${year}`);
    }),
    sources: new Map(),
    indexFor: (parts) => lookup.get(parts.monthKey) ?? -1,
  };
}

function focusMeta(focus: AnalyticsFocusRequest, now: IstParts): Pick<AnalyticsFocus, "label" | "from" | "to"> {
  if (focus.id === "custom") {
    return {
      label: customRangeLabel(focus.from, focus.to),
      from: istDayStartIso(focus.from),
      to: istDayEndIso(focus.to),
    };
  }
  if (focus.id === "yesterday") {
    const key = addCalendarDays(now.dateKey, -1);
    return { label: "Yesterday", from: istDayStartIso(key), to: istDayEndIso(key) };
  }
  if (focus.id === "month") {
    const start = `${now.year}-${pad(now.month)}-01`;
    return { label: "This month", from: istDayStartIso(start), to: istDayEndIso(now.dateKey) };
  }
  if (focus.id === "year") {
    return { label: "This year", from: istDayStartIso(`${now.year}-01-01`), to: istDayEndIso(now.dateKey) };
  }
  return { label: "Today", from: istDayStartIso(now.dateKey), to: istDayEndIso(now.dateKey) };
}

function buildSeries(now: IstParts): Record<AnalyticsRange, AnalyticsSeriesPoint[]> {
  const today = Array.from({ length: 24 }, (_, hour) =>
    emptySeriesPoint(String(hour).padStart(2, "0"), `${String(hour).padStart(2, "0")}:00`)
  );
  const month = Array.from({ length: now.day }, (_, index) => {
    const day = index + 1;
    return emptySeriesPoint(
      `${now.year}-${String(now.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      String(day)
    );
  });
  const year = Array.from({ length: now.month }, (_, index) => {
    const monthNumber = index + 1;
    return emptySeriesPoint(`${now.year}-${String(monthNumber).padStart(2, "0")}`, monthLabel(monthNumber));
  });
  return { today, month, year };
}

function bumpSource(map: Map<string, AnalyticsSourceShare>, source: string, amount: number) {
  const current = map.get(source) ?? {
    source,
    label: sourceLabel(source),
    orders: 0,
    revenue: 0,
    share: 0,
  };
  current.orders += 1;
  current.revenue += amount;
  map.set(source, current);
}

function finalizeSources(map: Map<string, AnalyticsSourceShare>): AnalyticsSourceShare[] {
  const rows = [...map.values()];
  const total = rows.reduce((sum, row) => sum + row.orders, 0);
  return rows
    .map((row) => ({
      ...row,
      share: total > 0 ? (row.orders / total) * 100 : 0,
    }))
    .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
}

export function aggregateAnalytics(
  orders: AnalyticsOrderRow[],
  shipments: AnalyticsShipmentRow[],
  nowInput: Date = new Date(),
  truncated = false,
  focus: AnalyticsFocusRequest = { id: "today" }
): DashboardAnalytics {
  const now = istParts(nowInput);
  const series = buildSeries(now);
  const yesterdayKey = addCalendarDays(now.dateKey, -1);
  const windows = {
    today: {
      period: emptyPeriod(),
      series: series.today,
      sources: new Map<string, AnalyticsSourceShare>(),
      indexFor: (parts: IstParts) => (parts.dateKey === now.dateKey ? parts.hour : -1),
    },
    month: {
      period: emptyPeriod(),
      series: series.month,
      sources: new Map<string, AnalyticsSourceShare>(),
      indexFor: (parts: IstParts) =>
        parts.year === now.year && parts.month === now.month ? parts.day - 1 : -1,
    },
    year: {
      period: emptyPeriod(),
      series: series.year,
      sources: new Map<string, AnalyticsSourceShare>(),
      indexFor: (parts: IstParts) => (parts.year === now.year ? parts.month - 1 : -1),
    },
    yesterday: {
      period: emptyPeriod(),
      series: hourSeries(),
      sources: new Map<string, AnalyticsSourceShare>(),
      indexFor: (parts: IstParts) => (parts.dateKey === yesterdayKey ? parts.hour : -1),
    },
  } satisfies Record<Exclude<AnalyticsFocusId, "custom">, BucketWindow>;
  const custom = focus.id === "custom" ? buildCustomWindow(focus.from, focus.to) : null;
  const active: BucketWindow[] = [windows.today, windows.month, windows.year, windows.yesterday];
  if (custom) active.push(custom);

  for (const order of orders) {
    if (!isActiveOrder(order)) continue;
    const parts = istParts(order.created_at);
    const amount = asAmount(order.total_amount);
    const source = (order.source || "MANUAL").toUpperCase();
    const cod = isCodOrder(order);

    for (const window of active) {
      const index = window.indexFor(parts);
      if (index < 0) continue;
      window.period.orders += 1;
      window.period.revenue += amount;
      if (cod) {
        window.period.codOrders += 1;
        window.period.codAmount += amount;
      } else {
        window.period.prepaidOrders += 1;
        window.period.prepaidAmount += amount;
      }
      bumpSource(window.sources, source, amount);
      const point = window.series[index];
      if (!point) continue;
      point.orders += 1;
      point.revenue += amount;
      if (cod) point.cod += 1;
      else point.prepaid += 1;
    }
  }

  for (const shipment of shipments) {
    if (!isActiveShipment(shipment)) continue;
    const parts = istParts(shipment.created_at);
    for (const window of active) {
      const index = window.indexFor(parts);
      if (index < 0) continue;
      window.period.shipments += 1;
      const point = window.series[index];
      if (point) point.shipments += 1;
    }

    if (!isIndiaPostBooked(shipment) || !shipment.booked_at) continue;
    const bookedParts = istParts(shipment.booked_at);
    const cod = isCodShipment(shipment);
    const amount = cod ? asAmount(shipment.cod_amount) : shipmentOrderAmount(shipment);
    for (const window of active) {
      const index = window.indexFor(bookedParts);
      if (index < 0) continue;
      window.period.indiaPostBooked += 1;
      window.period.indiaPostBookedAmount += amount;
      if (cod) {
        window.period.indiaPostCodBooked += 1;
        window.period.indiaPostCodAmount += amount;
      } else {
        window.period.indiaPostPrepaidBooked += 1;
        window.period.indiaPostPrepaidAmount += amount;
      }
      const point = window.series[index];
      if (!point) continue;
      point.indiaPostBooked += 1;
      if (cod) point.indiaPostCodAmount += amount;
      else point.indiaPostPrepaidAmount += amount;
    }
  }

  const yearSources = finalizeSources(windows.year.sources);
  const focusWindow: BucketWindow =
    focus.id === "custom" ? (custom ?? windows.today) : windows[focus.id];
  const meta = focusMeta(focus, now);

  return {
    timezone: ANALYTICS_TIMEZONE,
    generatedAt: nowInput.toISOString(),
    truncated,
    today: windows.today.period,
    month: windows.month.period,
    year: windows.year.period,
    topSource: yearSources[0] ?? null,
    sources: {
      today: finalizeSources(windows.today.sources),
      month: finalizeSources(windows.month.sources),
      year: yearSources,
    },
    series,
    focus: {
      id: focus.id,
      label: meta.label,
      from: meta.from,
      to: meta.to,
      period: focusWindow.period,
      sources: finalizeSources(focusWindow.sources),
      series: focusWindow.series,
    },
  };
}

async function fetchPaged<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
) {
  const rows: T[] = [];
  let from = 0;
  while (from < ANALYTICS_MAX_ROWS) {
    const to = Math.min(from + ANALYTICS_PAGE_SIZE - 1, ANALYTICS_MAX_ROWS - 1);
    const { data, error } = await query(from, to);
    if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < ANALYTICS_PAGE_SIZE || rows.length >= ANALYTICS_MAX_ROWS) break;
    from += ANALYTICS_PAGE_SIZE;
  }
  return { rows, truncated: rows.length >= ANALYTICS_MAX_ROWS };
}

export async function getAnalytics(
  supabase: SupabaseClient,
  ctx: TenantContext,
  now = new Date(),
  focus: AnalyticsFocusRequest = { id: "today" }
) {
  const since = analyticsFetchSince(now, focus);
  const [orders, shipments] = await Promise.all([
    fetchPaged<AnalyticsOrderRow>((from, to) =>
      supabase
        .from("orders")
        .select("created_at, total_amount, source, payment_status, status")
        .eq("organization_id", ctx.organizationId)
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .range(from, to)
    ),
    fetchPaged<AnalyticsShipmentRow>((from, to) =>
      supabase
        .from("shipments")
        .select("created_at, booked_at, payment_mode, cod_amount, status, provider, orders(total_amount)")
        .eq("organization_id", ctx.organizationId)
        .or(`created_at.gte.${since},booked_at.gte.${since}`)
        .order("created_at", { ascending: true })
        .range(from, to)
    ),
  ]);

  return aggregateAnalytics(orders.rows, shipments.rows, now, orders.truncated || shipments.truncated, focus);
}
