"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Archive,
  BadgePercent,
  Copy,
  Link2,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Ticket,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { CouponEditor, type CouponDraft } from "./coupon-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import type { CouponRecord, CouponStats, CouponStatsRow } from "@/modules/storefront/coupons/service";

type Range = "7d" | "30d" | "90d" | "all";
type CouponList = { range: Range; from: string; coupons: CouponRecord[]; stats: CouponStats };
type Redemption = {
  id: string;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
  customer: string;
  subtotal: number;
  discount: number;
  total: number;
  paymentPreference: string | null;
  createdAt: string;
};

const RANGES: Array<{ value: Range; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

const STATE_STYLE: Record<CouponRecord["state"], { label: string; className: string }> = {
  ACTIVE: { label: "Active", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  SCHEDULED: { label: "Scheduled", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  EXPIRED: { label: "Expired", className: "bg-zinc-500/10 text-muted" },
  PAUSED: { label: "Paused", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  ARCHIVED: { label: "Archived", className: "bg-zinc-500/10 text-muted" },
};

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Starting points that cover the common Indian D2C promotions. */
const TEMPLATES: Array<{ title: string; hint: string; draft: Partial<CouponDraft> }> = [
  { title: "10% off first order", hint: "Welcome new customers", draft: { code: "WELCOME10", discountType: "PERCENT", value: 10, maxDiscount: 200, firstOrderOnly: true, perCustomerLimit: 1 } },
  { title: "₹100 off above ₹999", hint: "Lift average order value", draft: { code: "FLAT100", discountType: "FIXED", value: 100, minOrderAmount: 999 } },
  { title: "Buy 2 get 1 free", hint: "Move more units", draft: { code: "B2G1", discountType: "BUY_X_GET_Y", value: 100, buyQuantity: 2, getQuantity: 1 } },
  { title: "5% off prepaid", hint: "Cut COD returns", draft: { code: "PREPAID5", discountType: "PERCENT", value: 5, prepaidOnly: true } },
];

function magicLink(storeUrl: string | undefined, code: string) {
  return storeUrl ? `${storeUrl}?discount=${encodeURIComponent(code)}` : "";
}

function copy(text: string, message: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(message))
    .catch(() => toast.error("Could not copy."));
}

export function InventoryCoupons({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient();
  const [range, setRange] = useState<Range>("30d");
  const [editing, setEditing] = useState<{ coupon: CouponRecord | null; draft?: Partial<CouponDraft> } | null>(null);
  const [detail, setDetail] = useState<CouponRecord | null>(null);
  const [removing, setRemoving] = useState<CouponRecord | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({
    queryKey: ["inventory-coupons", range],
    queryFn: () => api<CouponList>(`/api/v1/inventory/coupons?range=${range}`),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const storefront = useQuery({
    queryKey: ["inventory-storefront"],
    queryFn: () => api<{ storeUrl: string; storeName: string }>("/api/v1/inventory/storefront"),
  });
  const storeUrl = storefront.data?.storeUrl;

  const status = useMutation({
    mutationFn: ({ id, next }: { id: string; next: "ACTIVE" | "PAUSED" | "ARCHIVED" }) =>
      api<CouponRecord>(`/api/v1/inventory/coupons/${id}/status`, { method: "POST", body: JSON.stringify({ status: next }) }),
    onSuccess: (coupon) => {
      void client.invalidateQueries({ queryKey: ["inventory-coupons"] });
      toast.success(coupon.status === "ACTIVE" ? `${coupon.code} is active.` : coupon.status === "PAUSED" ? `${coupon.code} paused.` : `${coupon.code} archived.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean; archived: boolean }>(`/api/v1/inventory/coupons/${id}`, { method: "DELETE" }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["inventory-coupons"] });
      setRemoving(null);
      toast.success(result.archived ? "Coupon archived. Its order history is kept." : "Coupon deleted.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const statsById = useMemo(() => new Map((list.data?.stats.coupons ?? []).map((row) => [row.couponId, row])), [list.data]);
  const coupons = (list.data?.coupons ?? []).filter((coupon) => showArchived || coupon.status !== "ARCHIVED");
  const archivedCount = (list.data?.coupons ?? []).filter((coupon) => coupon.status === "ARCHIVED").length;

  if (list.isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <Ticket className="mx-auto size-6 text-muted" aria-hidden />
        <p className="mt-2 font-semibold">Coupons couldn’t load.</p>
        <p className="mt-1 text-xs text-muted">{list.error instanceof Error ? list.error.message : "Please try again."}</p>
        <Button className="mt-3" size="sm" onClick={() => void list.refetch()}>Retry</Button>
      </div>
    );
  }

  if (!list.data) {
    return (
      <div role="status" aria-label="Loading coupons" className="space-y-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-20" />)}
        </div>
        <Skeleton className="h-56" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const { totals } = list.data.stats;
  const hasCoupons = (list.data.coupons ?? []).length > 0;

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Coupons</h2>
          <p className="text-xs text-muted">Discount codes, magic links and how they sell. Applied at your store checkout.</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Date range" className="flex rounded-lg border border-border bg-surface-soft p-0.5">
            {RANGES.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={range === item.value}
                onClick={() => setRange(item.value)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand",
                  range === item.value ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          {canWrite ? (
            <Button size="sm" onClick={() => setEditing({ coupon: null })}>
              <Plus />New coupon
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", list.isFetching && "opacity-70 transition-opacity")} aria-busy={list.isFetching}>
        <Kpi label="Coupon orders" value={totals.redemptions.toLocaleString("en-IN")} hint={`${totals.customers.toLocaleString("en-IN")} customers`} />
        <Kpi label="Revenue" value={inr.format(totals.revenue)} hint={totals.redemptions ? `${inr.format(totals.revenue / totals.redemptions)} avg order` : "No orders yet"} />
        <Kpi label="Discount given" value={inr.format(totals.discount)} hint={totals.revenue ? `${((totals.discount / (totals.revenue + totals.discount)) * 100).toFixed(1)}% of gross` : "—"} />
        <Kpi
          label="Link conversion"
          value={totals.linkOpens ? `${Math.min(100, (totals.redemptions / totals.linkOpens) * 100).toFixed(1)}%` : "—"}
          hint={`${totals.linkOpens.toLocaleString("en-IN")} link opens · ${totals.applies.toLocaleString("en-IN")} applied`}
        />
      </div>

      {hasCoupons ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <TrendChart daily={list.data.stats.daily} from={list.data.from} range={range} />
          <TopCoupons coupons={list.data.coupons} stats={list.data.stats.coupons} onOpen={setDetail} />
        </div>
      ) : null}

      {!hasCoupons ? (
        <section aria-labelledby="coupon-start" className="rounded-xl border border-dashed border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand/10 text-brand"><BadgePercent className="size-5" aria-hidden /></span>
            <div className="min-w-0">
              <h3 id="coupon-start" className="text-sm font-semibold">Create your first coupon</h3>
              <p className="mt-1 text-xs text-muted">
                Share a code or a magic link on WhatsApp and Instagram. Customers who open the link get the discount applied at checkout automatically.
              </p>
            </div>
          </div>
          {canWrite ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {TEMPLATES.map((template) => (
                <button
                  key={template.title}
                  type="button"
                  onClick={() => setEditing({ coupon: null, draft: template.draft })}
                  className="rounded-lg border border-border p-3 text-left transition-colors hover:border-brand hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <p className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles className="size-3.5 text-brand" aria-hidden />{template.title}</p>
                  <p className="mt-1 text-xs text-muted">{template.hint}</p>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="coupon-list-title" className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h3 id="coupon-list-title" className="text-sm font-semibold">All coupons</h3>
            {archivedCount ? (
              <button type="button" className="text-xs text-muted hover:text-ink hover:underline" onClick={() => setShowArchived((value) => !value)}>
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </button>
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {coupons.map((coupon) => {
              const stats = statsById.get(coupon.id);
              const link = magicLink(storeUrl, coupon.code);
              return (
                <li key={coupon.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap">
                  <button type="button" onClick={() => setDetail(coupon)} className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-brand">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="rounded border border-dashed border-border bg-surface-soft px-1.5 py-0.5 font-mono text-xs font-semibold tracking-wide">{coupon.code}</span>
                      <StateBadge coupon={coupon} />
                      {coupon.autoApply ? <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand">Auto-apply</span> : null}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted">
                      {coupon.title ? `${coupon.title} · ` : ""}{coupon.summary}
                      {coupon.prepaidOnly ? " · prepaid only" : ""}
                      {coupon.firstOrderOnly ? " · first order" : ""}
                    </span>
                  </button>
                  <dl className="grid shrink-0 grid-cols-3 gap-4 text-right text-xs">
                    <div>
                      <dt className="text-muted">Used</dt>
                      <dd className="font-semibold tabular-nums">
                        {(stats?.lifetimeRedemptions ?? 0).toLocaleString("en-IN")}
                        {coupon.usageLimit ? <span className="font-normal text-muted">/{coupon.usageLimit}</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Revenue</dt>
                      <dd className="font-semibold tabular-nums">{inr.format(stats?.revenue ?? 0)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Discount</dt>
                      <dd className="font-semibold tabular-nums">{inr.format(stats?.discount ?? 0)}</dd>
                    </div>
                  </dl>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon-xs" variant="ghost" aria-label={`Copy magic link for ${coupon.code}`} title="Copy magic link" disabled={!link} onClick={() => copy(link, "Magic link copied.")}>
                      <Link2 />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-xs" variant="ghost" aria-label={`More actions for ${coupon.code}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => copy(coupon.code, "Code copied.")}><Copy />Copy code</DropdownMenuItem>
                        <DropdownMenuItem disabled={!link} onSelect={() => copy(link, "Magic link copied.")}><Link2 />Copy magic link</DropdownMenuItem>
                        <DropdownMenuItem disabled={!link} asChild>
                          <a href={`https://wa.me/?text=${encodeURIComponent(`${coupon.summary} with code ${coupon.code}: ${link}`)}`} target="_blank" rel="noreferrer">
                            <MessageCircle />Share on WhatsApp
                          </a>
                        </DropdownMenuItem>
                        {canWrite ? (
                          <>
                            <DropdownMenuSeparator />
                            {coupon.status !== "ARCHIVED" ? <DropdownMenuItem onSelect={() => setEditing({ coupon })}><Pencil />Edit</DropdownMenuItem> : null}
                            {coupon.status === "ACTIVE" ? (
                              <DropdownMenuItem onSelect={() => status.mutate({ id: coupon.id, next: "PAUSED" })}><Pause />Pause</DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => status.mutate({ id: coupon.id, next: "ACTIVE" })}><Play />{coupon.status === "ARCHIVED" ? "Restore" : "Resume"}</DropdownMenuItem>
                            )}
                            {coupon.status !== "ARCHIVED" ? (
                              <DropdownMenuItem onSelect={() => setRemoving(coupon)} className="text-red-600 focus:text-red-600">
                                {stats?.lifetimeRedemptions ? <Archive /> : <Trash2 />}
                                {stats?.lifetimeRedemptions ? "Archive" : "Delete"}
                              </DropdownMenuItem>
                            ) : null}
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
            {!coupons.length ? <li className="px-4 py-6 text-center text-xs text-muted">No coupons to show.</li> : null}
          </ul>
        </section>
      )}

      {editing ? (
        <CouponEditor
          coupon={editing.coupon}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={(coupon) => {
            setEditing(null);
            void client.invalidateQueries({ queryKey: ["inventory-coupons"] });
            toast.success(`${coupon.code} saved.`);
          }}
        />
      ) : null}

      <CouponDetail
        coupon={detail}
        stats={detail ? statsById.get(detail.id) : undefined}
        rangeLabel={RANGES.find((item) => item.value === range)?.label ?? ""}
        link={detail ? magicLink(storeUrl, detail.code) : ""}
        onClose={() => setDetail(null)}
        onEdit={canWrite && detail && detail.status !== "ARCHIVED" ? () => { setEditing({ coupon: detail }); setDetail(null); } : undefined}
      />

      <Dialog open={Boolean(removing)} onOpenChange={(open) => !open && !remove.isPending && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statsById.get(removing?.id ?? "")?.lifetimeRedemptions ? "Archive" : "Delete"} {removing?.code}?</DialogTitle>
            <DialogDescription>
              {statsById.get(removing?.id ?? "")?.lifetimeRedemptions
                ? "This coupon has been used, so it’s archived instead of deleted. It stops working right away and its orders stay in your reports."
                : "The code stops working right away and shared magic links will show it as invalid. This can’t be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => setRemoving(null)}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>
              {remove.isPending ? <Loader2 className="animate-spin" /> : null}
              {statsById.get(removing?.id ?? "")?.lifetimeRedemptions ? "Archive coupon" : "Delete coupon"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StateBadge({ coupon }: { coupon: CouponRecord }) {
  const style = STATE_STYLE[coupon.state];
  return <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", style.className)}>{style.label}</span>;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
      <p className="truncate text-[11px] text-muted">{hint}</p>
    </div>
  );
}

function TrendChart({ daily, from, range }: { daily: CouponStats["daily"]; from: string; range: Range }) {
  // Fill empty days so the chart reads as a timeline, not a list of good days.
  const data = useMemo(() => {
    const byDay = new Map(daily.map((row) => [row.day, row]));
    const start = range === "all" && daily.length ? new Date(`${daily[0].day}T00:00:00Z`) : new Date(from);
    const days: Array<{ day: string; label: string; revenue: number; redemptions: number; discount: number }> = [];
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const end = new Date();
    while (cursor <= end && days.length < 400) {
      const key = cursor.toISOString().slice(0, 10);
      const row = byDay.get(key);
      days.push({ day: key, label: dateFmt.format(cursor), revenue: row?.revenue ?? 0, redemptions: row?.redemptions ?? 0, discount: row?.discount ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }, [daily, from, range]);
  const empty = !daily.length;

  return (
    <section aria-labelledby="coupon-trend" className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="coupon-trend" className="text-sm font-semibold">Coupon revenue</h3>
        <p className="flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1"><span aria-hidden className="size-2 rounded-sm bg-brand" />Revenue</span>
          <span className="flex items-center gap-1"><span aria-hidden className="h-0.5 w-3 bg-amber-500" />Orders</span>
        </p>
      </div>
      <div className="mt-3 h-52">
        {empty ? (
          <div className="grid h-full place-items-center rounded-lg bg-surface-soft text-xs text-muted">No coupon orders in this period.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} interval="preserveStartEnd" minTickGap={24} stroke="var(--muted, #71717a)" />
              <YAxis yAxisId="revenue" tickLine={false} axisLine={false} fontSize={11} width={44} tickFormatter={(value: number) => `₹${compact.format(value)}`} stroke="var(--muted, #71717a)" />
              <YAxis yAxisId="orders" orientation="right" tickLine={false} axisLine={false} fontSize={11} width={24} allowDecimals={false} stroke="var(--muted, #71717a)" />
              <Tooltip
                cursor={{ fill: "var(--surface-soft)" }}
                contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", background: "var(--card)", fontSize: 12 }}
                formatter={(value, name) => (name === "Revenue" || name === "Discount" ? inr.format(Number(value)) : Number(value).toLocaleString("en-IN"))}
              />
              <Bar yAxisId="revenue" dataKey="revenue" name="Revenue" fill="var(--brand)" radius={[3, 3, 0, 0]} maxBarSize={28} />
              <Line yAxisId="orders" dataKey="redemptions" name="Orders" stroke="#f59e0b" strokeWidth={2} dot={false} type="monotone" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

function TopCoupons({ coupons, stats, onOpen }: { coupons: CouponRecord[]; stats: CouponStatsRow[]; onOpen: (coupon: CouponRecord) => void }) {
  const ranked = stats
    .filter((row) => row.redemptions > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((row) => ({ row, coupon: coupons.find((coupon) => coupon.id === row.couponId) }))
    .filter((item): item is { row: CouponStatsRow; coupon: CouponRecord } => Boolean(item.coupon));
  const max = ranked[0]?.row.revenue ?? 0;
  return (
    <section aria-labelledby="coupon-top" className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h3 id="coupon-top" className="text-sm font-semibold">Top coupons</h3>
      {ranked.length ? (
        <ol className="mt-3 space-y-3">
          {ranked.map(({ row, coupon }) => (
            <li key={coupon.id}>
              <button type="button" className="w-full text-left focus-visible:outline-2 focus-visible:outline-brand" onClick={() => onOpen(coupon)}>
                <span className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-mono font-semibold">{coupon.code}</span>
                  <span className="shrink-0 tabular-nums">{inr.format(row.revenue)}</span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-soft">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${max ? Math.max(4, (row.revenue / max) * 100) : 0}%` }} />
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">{row.redemptions} order{row.redemptions === 1 ? "" : "s"} · {inr.format(row.discount)} off</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-muted">Coupons appear here once customers use them.</p>
      )}
    </section>
  );
}

function CouponDetail({
  coupon,
  stats,
  rangeLabel,
  link,
  onClose,
  onEdit,
}: {
  coupon: CouponRecord | null;
  stats: CouponStatsRow | undefined;
  rangeLabel: string;
  link: string;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const redemptions = useQuery({
    queryKey: ["inventory-coupon-redemptions", coupon?.id],
    enabled: Boolean(coupon),
    queryFn: () => api<Redemption[]>(`/api/v1/inventory/coupons/${coupon!.id}/redemptions`),
  });
  const funnel = [
    { label: "Link opens", value: stats?.linkOpens ?? 0 },
    { label: "Applied at checkout", value: stats?.applies ?? 0 },
    { label: "Orders", value: stats?.redemptions ?? 0 },
  ];
  const top = Math.max(1, ...funnel.map((step) => step.value));

  return (
    <Dialog open={Boolean(coupon)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {coupon ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{coupon.code}</span>
                <StateBadge coupon={coupon} />
              </DialogTitle>
              <DialogDescription>{coupon.title ? `${coupon.title} · ` : ""}{coupon.summary}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="secondary" onClick={() => copy(coupon.code, "Code copied.")}><Copy />Copy code</Button>
              <Button size="xs" variant="secondary" disabled={!link} onClick={() => copy(link, "Magic link copied.")}><Link2 />Copy magic link</Button>
              {onEdit ? <Button size="xs" variant="ghost" onClick={onEdit}><Pencil />Edit</Button> : null}
            </div>
            {link ? <p className="truncate rounded-md bg-surface-soft px-2 py-1.5 font-mono text-[11px] text-muted" title={link}>{link}</p> : null}

            <section aria-labelledby="coupon-funnel">
              <h4 id="coupon-funnel" className="text-xs font-semibold">Funnel · {rangeLabel}</h4>
              <ol className="mt-2 space-y-2">
                {funnel.map((step, index) => (
                  <li key={step.label} className="text-xs">
                    <span className="flex justify-between gap-2">
                      <span>{step.label}</span>
                      <span className="tabular-nums">
                        {step.value.toLocaleString("en-IN")}
                        {index > 0 && funnel[index - 1].value ? <span className="text-muted"> · {Math.min(100, (step.value / funnel[index - 1].value) * 100).toFixed(0)}%</span> : null}
                      </span>
                    </span>
                    <span className="mt-1 block h-2 overflow-hidden rounded-full bg-surface-soft">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${(step.value / top) * 100}%`, opacity: 1 - index * 0.2 }} />
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[11px] text-muted">Customers who type the code skip “Link opens”, so the steps may not shrink evenly.</p>
            </section>

            <dl className="grid grid-cols-3 gap-2 text-xs">
              <Fact label="Revenue" value={inr.format(stats?.revenue ?? 0)} />
              <Fact label="Discount" value={inr.format(stats?.discount ?? 0)} />
              <Fact label="Uses (all time)" value={`${stats?.lifetimeRedemptions ?? 0}${coupon.usageLimit ? ` / ${coupon.usageLimit}` : ""}`} />
            </dl>

            <section aria-labelledby="coupon-rules">
              <h4 id="coupon-rules" className="text-xs font-semibold">Rules</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
                <li>{coupon.appliesTo === "ALL" ? "All products (not bundles)" : coupon.appliesTo === "PRODUCTS" ? `${coupon.productIds.length} selected product${coupon.productIds.length === 1 ? "" : "s"}` : `${coupon.categoryIds.length} selected categor${coupon.categoryIds.length === 1 ? "y" : "ies"}`}</li>
                {coupon.minOrderAmount ? <li>Minimum order {inr.format(coupon.minOrderAmount)}</li> : null}
                {coupon.perCustomerLimit ? <li>{coupon.perCustomerLimit} use{coupon.perCustomerLimit === 1 ? "" : "s"} per customer (phone number)</li> : null}
                {coupon.firstOrderOnly ? <li>First order only</li> : null}
                {coupon.prepaidOnly ? <li>Prepaid orders only</li> : null}
                {coupon.autoApply ? <li>Auto-applies at checkout and shows a banner on your store</li> : null}
                <li>
                  {coupon.startsAt ? `From ${dateTimeFmt.format(new Date(coupon.startsAt))}` : "Starts immediately"}
                  {coupon.endsAt ? ` until ${dateTimeFmt.format(new Date(coupon.endsAt))}` : " · no end date"}
                </li>
              </ul>
            </section>

            <section aria-labelledby="coupon-orders">
              <h4 id="coupon-orders" className="text-xs font-semibold">Recent orders</h4>
              {redemptions.isPending ? (
                <p role="status" className="mt-2 text-xs text-muted">Loading…</p>
              ) : redemptions.isError ? (
                <p className="mt-2 text-xs text-red-600">Couldn’t load orders.</p>
              ) : redemptions.data?.length ? (
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                  {redemptions.data.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        {row.orderId ? (
                          <a href={`/dashboard/orders/${row.orderId}`} className="font-medium text-brand hover:underline">{row.orderNumber ?? "Order"}</a>
                        ) : (
                          <span className="text-muted">Order not created</span>
                        )}
                        <p className="text-[11px] text-muted">{row.customer} · {dateTimeFmt.format(new Date(row.createdAt))}{row.paymentPreference ? ` · ${row.paymentPreference === "COD" ? "COD" : "Prepaid"}` : ""}</p>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <p className="font-semibold">{inr.format(row.total)}</p>
                        <p className="text-[11px] text-emerald-700 dark:text-emerald-400">−{inr.format(row.discount)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted">No orders with this coupon yet.</p>
              )}
            </section>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-soft p-2">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
