"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileText, Lock, Plus, Wallet } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { AlertLevels } from "@/components/wallet/alert-levels";
import { RechargeDialog } from "@/components/wallet/recharge-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { formatMicros, toMicros, ZERO } from "@/modules/wallet/money";
import type { RechargeLimits } from "@/modules/wallet/recharge-quote";

type Overview = {
  walletStatus: "ACTIVE" | "FROZEN";
  balanceMicros: string;
  reservedMicros: string;
  availableMicros: string;
  lifetimeRechargedMicros: string;
  lifetimeWhatsappMicros: string;
  lifetimeAiMicros: string;
  monthWhatsappMicros: string;
  monthAiMicros: string;
  monthSpendMicros: string;
  monthRechargedMicros: string;
  lastRechargedAt: string | null;
  lowBalance: boolean;
  thresholdsMicros: string[];
  recharge: RechargeLimits;
  canRecharge: boolean;
};

type Transactions = {
  entries: Array<{
    id: string;
    date: string;
    label: string;
    type: string;
    service: string | null;
    description: string | null;
    amountMicros: string;
    balanceAfterMicros: string;
  }>;
  page: number;
  pageSize: number;
  total: number;
};

type Recharges = {
  recharges: Array<{
    id: string;
    amountPaise: number;
    taxPaise: number;
    creditMicros: string;
    refundedPaise: number;
    status: string;
    method: string | null;
    failureReason: string | null;
    createdAt: string;
    paidAt: string | null;
    invoiceNumber: string | null;
  }>;
  page: number;
  pageSize: number;
  total: number;
};

type Usage = { days: Array<{ day: string; whatsappMicros: string; aiMicros: string; rechargedMicros: string }> };

const WHATSAPP_COLOR = "var(--success)";
const AI_COLOR = "var(--brand)";
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--ink)", fontSize: 12 };

const FILTERS = [
  ["all", "All"],
  ["recharge", "Recharges"],
  ["whatsapp", "WhatsApp"],
  ["ai", "AI"],
  ["credits", "Credits & adjustments"],
] as const;

const money = (micros: string | null | undefined, digits = 2) => formatMicros(toMicros(micros ?? "0"), { maxFractionDigits: digits });
const rupeesFromPaise = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Chart values in rupees; precision beyond a paisa does not matter on a bar. */
const chartRupees = (micros: string) => Number(toMicros(micros) / BigInt(10_000)) / 100;

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" | "bad" }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p className={cn("text-xl font-semibold tabular-nums text-ink", tone === "warn" && "text-amber-600", tone === "bad" && "text-rose-600")}>
          {value}
        </p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 pt-3 text-xs text-muted">
      <span>
        Page {page} of {pages}
      </span>
      <Button size="icon" variant="secondary" className="size-8" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="size-4" />
      </Button>
      <Button size="icon" variant="secondary" className="size-8" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

function rechargeBadge(status: string) {
  if (status === "PAID") return <Badge variant="success">Paid</Badge>;
  if (status === "FAILED") return <Badge variant="error">Failed</Badge>;
  if (status === "REFUNDED") return <Badge>Refunded</Badge>;
  if (status === "PARTIALLY_REFUNDED") return <Badge variant="warning">Part refunded</Badge>;
  return <Badge variant="outline">Waiting for payment</Badge>;
}

export function WalletDashboard() {
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [txPage, setTxPage] = useState(1);
  const [rcPage, setRcPage] = useState(1);
  const [from, setFrom] = useState(() => `${istToday().slice(0, 8)}01`);
  const [to, setTo] = useState(istToday);

  const overview = useQuery({ queryKey: ["wallet", "overview"], queryFn: () => api<Overview>("/api/v1/wallet") });
  const usage = useQuery({ queryKey: ["wallet", "usage"], queryFn: () => api<Usage>("/api/v1/wallet/usage?days=30") });
  const transactions = useQuery({
    queryKey: ["wallet", "transactions", filter, txPage],
    queryFn: () => api<Transactions>(`/api/v1/wallet/transactions?type=${filter}&page=${txPage}&pageSize=15`),
    placeholderData: keepPreviousData,
  });
  const recharges = useQuery({
    queryKey: ["wallet", "recharges", rcPage],
    queryFn: () => api<Recharges>(`/api/v1/wallet/recharges?page=${rcPage}&pageSize=10`),
    placeholderData: keepPreviousData,
  });

  const data = overview.data;
  const frozen = data?.walletStatus === "FROZEN";
  const reserved = toMicros(data?.reservedMicros ?? "0");

  const rechargeButton = data?.canRecharge ? (
    <Button onClick={() => setRechargeOpen(true)} disabled={frozen}>
      <Plus className="size-4" />
      Recharge wallet
    </Button>
  ) : null;

  if (overview.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Wallet" description="Prepaid balance for WhatsApp messages and AI features." />
        <EmptyState icon={Wallet} title="Wallet is not available" description={overview.error instanceof Error ? overview.error.message : "Try again in a moment."} />
      </div>
    );
  }

  const chartData = (usage.data?.days ?? []).map((row) => ({
    day: row.day.slice(5),
    WhatsApp: chartRupees(row.whatsappMicros),
    AI: chartRupees(row.aiMicros),
  }));
  const anyUsage = chartData.some((row) => row.WhatsApp > 0 || row.AI > 0);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Wallet"
        description="Prepaid balance for WhatsApp messages and AI features."
        actions={rechargeButton}
      />

      {frozen ? (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <p>Your wallet is on hold, so WhatsApp messages and AI features that cost money are paused. Contact PostBus support to restore it. Shipping, labels and tracking keep working.</p>
        </div>
      ) : data?.lowBalance ? (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>Your balance is low. When it runs out, WhatsApp notifications and AI checks pause until you recharge. Everything else keeps working.</p>
          </div>
          {data.canRecharge ? (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setRechargeOpen(true)}>
              Recharge now
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {overview.isLoading || !data ? (
          Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-[92px] rounded-2xl" />)
        ) : (
          <>
            <Card className="sm:col-span-2 lg:col-span-1">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium text-muted">Available balance</p>
                <p className={cn("text-2xl font-semibold tabular-nums", toMicros(data.availableMicros) < ZERO ? "text-rose-600" : "text-ink")}>
                  {money(data.availableMicros)}
                </p>
                <p className="text-xs text-muted">
                  {reserved > ZERO ? `${money(data.reservedMicros)} on hold for messages in progress` : data.lastRechargedAt ? `Last recharge ${formatDate(data.lastRechargedAt)}` : "No recharges yet"}
                </p>
              </CardContent>
            </Card>
            <Kpi label="WhatsApp this month" value={money(data.monthWhatsappMicros)} hint={`${money(data.lifetimeWhatsappMicros)} all time`} />
            <Kpi label="AI this month" value={money(data.monthAiMicros)} hint={`${money(data.lifetimeAiMicros)} all time`} />
            <Kpi label="Spent this month" value={money(data.monthSpendMicros)} hint={`${money(data.monthRechargedMicros)} recharged this month`} />
            <Kpi label="Total recharged" value={money(data.lifetimeRechargedMicros)} hint="Wallet credit after GST" />
          </>
        )}
      </div>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Last 30 days</CardTitle>
          <CardDescription>What WhatsApp messages and AI features cost each day.</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 p-3 pt-0 sm:p-6 sm:pt-0">
          {usage.isLoading ? (
            <Skeleton className="h-56 rounded-xl" />
          ) : anyUsage ? (
            <div className="h-56 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `₹${v}`} width={52} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(value) => `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`} cursor={{ fill: "var(--surface-soft)" }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="WhatsApp" stackId="spend" fill={WHATSAPP_COLOR} maxBarSize={22} />
                  <Bar dataKey="AI" stackId="spend" fill={AI_COLOR} radius={[6, 6, 0, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted">No WhatsApp or AI charges in the last 30 days.</p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="transactions">
        <TabsList>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="recharges">Recharges</TabsTrigger>
          <TabsTrigger value="statement">Statement</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="transactions">
          <Card>
            <CardContent className="p-4">
              <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
                {FILTERS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => {
                      setFilter(value);
                      setTxPage(1);
                    }}
                    className={cn(
                      "h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                      filter === value ? "border-ink bg-ink text-background" : "border-border bg-card text-muted hover:text-ink"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {transactions.isLoading ? (
                <Skeleton className="h-48 rounded-xl" />
              ) : !transactions.data?.entries.length ? (
                <p className="py-10 text-center text-sm text-muted">No transactions yet.</p>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {transactions.data.entries.map((entry) => {
                      const amount = toMicros(entry.amountMicros);
                      return (
                        <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-ink">{entry.label}</p>
                            <p className="truncate text-xs text-muted">
                              {formatDate(entry.date, true)}
                              {entry.description && entry.description !== entry.label ? ` · ${entry.description}` : ""}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={cn("text-sm font-semibold tabular-nums", amount > ZERO ? "text-emerald-700 dark:text-emerald-400" : "text-ink")}>
                              {amount > ZERO ? "+" : "−"}
                              {formatMicros(amount > ZERO ? amount : -amount, { maxFractionDigits: 4 })}
                            </p>
                            <p className="text-xs tabular-nums text-muted">Balance {money(entry.balanceAfterMicros)}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <Pager page={transactions.data.page} pageSize={transactions.data.pageSize} total={transactions.data.total} onPage={setTxPage} />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recharges">
          <Card>
            <CardContent className="p-4">
              {recharges.isLoading ? (
                <Skeleton className="h-40 rounded-xl" />
              ) : !recharges.data?.recharges.length ? (
                <p className="py-10 text-center text-sm text-muted">No recharges yet.</p>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {recharges.data.recharges.map((row) => (
                      <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium tabular-nums text-ink">{rupeesFromPaise(row.amountPaise)}</p>
                            {rechargeBadge(row.status)}
                          </div>
                          <p className="truncate text-xs text-muted">
                            {formatDate(row.paidAt ?? row.createdAt, true)}
                            {row.method ? ` · ${row.method.toUpperCase()}` : ""}
                            {row.status === "FAILED" && row.failureReason ? ` · ${row.failureReason}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted">
                          {row.status === "PAID" || row.status === "REFUNDED" || row.status === "PARTIALLY_REFUNDED" ? (
                            <p className="text-sm font-semibold tabular-nums text-ink">+{money(row.creditMicros)}</p>
                          ) : (
                            <p className="text-sm tabular-nums text-muted">Not added</p>
                          )}
                          <p className="tabular-nums">GST {rupeesFromPaise(row.taxPaise)}</p>
                          {row.refundedPaise > 0 ? <p className="tabular-nums">Refunded {rupeesFromPaise(row.refundedPaise)}</p> : null}
                          {row.invoiceNumber ? (
                            <a
                              href={`/api/v1/wallet/recharges/${row.id}/invoice`}
                              download
                              className="mt-0.5 inline-flex items-center gap-1 font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                              aria-label={`Download tax invoice ${row.invoiceNumber}`}
                            >
                              <FileText className="size-3.5" />
                              Invoice
                            </a>
                          ) : row.status === "PAID" ? (
                            <p title="Issued as soon as PostBus and your billing details are complete.">Invoice pending</p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Pager page={recharges.data.page} pageSize={recharges.data.pageSize} total={recharges.data.total} onPage={setRcPage} />
                  <p className="pt-3 text-xs text-muted">
                    Each paid recharge gets a GST tax invoice. To show your GSTIN and address on new invoices, add them under{" "}
                    <a href="/dashboard/billing" className="font-medium text-ink underline-offset-2 hover:underline">
                      Billing
                    </a>
                    .
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="statement">
          <Card>
            <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-end">
              <div className="grid flex-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wallet-from">From</Label>
                  <Input id="wallet-from" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wallet-to">To</Label>
                  <Input id="wallet-to" type="date" value={to} min={from} max={istToday()} onChange={(event) => setTo(event.target.value)} />
                </div>
              </div>
              <a
                href={`/api/v1/wallet/statement?from=${from}&to=${to}`}
                download
                aria-disabled={!from || !to}
                className={cn(buttonVariants({ variant: "secondary" }), (!from || !to) && "pointer-events-none opacity-50")}
              >
                <Download className="size-4" />
                Download CSV
              </a>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="alerts">
          {data ? <AlertLevels key={data.thresholdsMicros.join(",")} thresholdsMicros={data.thresholdsMicros} canEdit={data.canRecharge} /> : null}
        </TabsContent>
      </Tabs>

      {data ? <RechargeDialog open={rechargeOpen} onOpenChange={setRechargeOpen} limits={data.recharge} /> : null}
    </div>
  );
}
