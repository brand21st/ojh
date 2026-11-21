"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PricingTab } from "@/components/admin/wallet/pricing-tab";
import { SettingsTab } from "@/components/admin/wallet/settings-tab";
import { ConfirmFields, NativeSelect, Stat, confirmReady, money } from "@/components/admin/wallet/shared";
import { WalletDetailDialog } from "@/components/admin/wallet/wallet-detail-dialog";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";

type Totals = {
  wallets: number;
  frozen: number;
  lowBalance: number;
  totalBalanceMicros: string;
  totalReservedMicros: string;
  lifetimeRechargedMicros: string;
  monthRechargedMicros: string;
  monthWhatsappMicros: string;
  monthAiMicros: string;
  openReconciliationIssues: number;
  paidRechargesWithoutInvoice: number;
  pendingAiMigrations: number;
};

type Row = {
  organizationId: string;
  organizationName: string;
  walletStatus: "ACTIVE" | "FROZEN";
  balanceMicros: string;
  reservedMicros: string;
  lifetimeRechargedMicros: string;
  lifetimeWhatsappMicros: string;
  lifetimeAiMicros: string;
  lastRechargedAt: string | null;
  aiCreditsMigratedAt: string | null;
  lowBalance: boolean;
  mismatch: boolean;
};

type Issue = {
  id: string;
  organization_id: string;
  balance_micros: string;
  ledger_sum_micros: string;
  reserved_micros: string;
  held_sum_micros: string;
  detected_at: string;
  resolved_at: string | null;
  note: string | null;
  organizations: { name: string } | { name: string }[] | null;
};

function WalletsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("balance_asc");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["admin", "wallet", "list", search, status, sort, page],
    queryFn: () =>
      api<{ rows: Row[]; total: number; page: number; pageSize: number }>(
        `/api/admin/wallet/wallets?q=${encodeURIComponent(search)}&status=${status}&sort=${sort}&page=${page}&pageSize=25`
      ),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(q.trim());
            setPage(1);
          }}
        >
          <Input className="w-64" placeholder="Search tenant name or ID" value={q} onChange={(e) => setQ(e.target.value)} />
          <NativeSelect aria-label="Filter" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All wallets</option>
            <option value="LOW">Low balance</option>
            <option value="FROZEN">Frozen</option>
            <option value="ACTIVE">Active</option>
            <option value="NOT_MIGRATED">AI credits not moved</option>
          </NativeSelect>
          <NativeSelect aria-label="Sort" value={sort} onChange={(e) => (setSort(e.target.value), setPage(1))}>
            <option value="balance_asc">Lowest balance</option>
            <option value="balance_desc">Highest balance</option>
            <option value="recharged_desc">Most recharged</option>
            <option value="whatsapp_desc">Most WhatsApp spend</option>
            <option value="ai_desc">Most AI spend</option>
            <option value="last_recharge_desc">Latest recharge</option>
            <option value="name_asc">Name</option>
          </NativeSelect>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {list.isLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : !list.data?.rows.length ? (
          <p className="py-10 text-center text-sm text-muted">No wallets match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Tenant</th>
                  <th className="py-2 pr-3 text-right">Balance</th>
                  <th className="py-2 pr-3 text-right">Recharged</th>
                  <th className="py-2 pr-3 text-right">WhatsApp</th>
                  <th className="py-2 pr-3 text-right">AI</th>
                  <th className="py-2 pr-3">Last recharge</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((row) => (
                  <tr
                    key={row.organizationId}
                    tabIndex={0}
                    onClick={() => onOpen(row.organizationId)}
                    onKeyDown={(e) => (e.key === "Enter" ? onOpen(row.organizationId) : undefined)}
                    className="cursor-pointer border-t border-border hover:bg-surface-soft/60 focus-visible:bg-surface-soft focus-visible:outline-none"
                  >
                    <td className="py-2 pr-3">
                      <p className="font-medium text-ink">{row.organizationName}</p>
                      <p className="font-mono text-[11px] text-muted">{row.organizationId}</p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <span className={row.balanceMicros.startsWith("-") ? "text-rose-600" : "text-ink"}>{money(row.balanceMicros)}</span>
                      {row.reservedMicros !== "0" ? <p className="text-[11px] text-muted">{money(row.reservedMicros)} held</p> : null}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(row.lifetimeRechargedMicros)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(row.lifetimeWhatsappMicros)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(row.lifetimeAiMicros)}</td>
                    <td className="py-2 pr-3 text-muted">{row.lastRechargedAt ? formatDate(row.lastRechargedAt) : "—"}</td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={row.walletStatus === "FROZEN" ? "error" : "success"}>{row.walletStatus === "FROZEN" ? "Frozen" : "Active"}</Badge>
                        {row.lowBalance ? <Badge variant="warning">Low</Badge> : null}
                        {row.mismatch ? <Badge variant="error">Mismatch</Badge> : null}
                        {!row.aiCreditsMigratedAt ? <Badge variant="outline">Credits</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 text-xs text-muted">
          <span>
            {list.data?.total ?? 0} wallets · page {page} of {pages}
          </span>
          <Button size="icon-xs" variant="secondary" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="icon-xs" variant="secondary" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReconciliationTab({ totals }: { totals?: Totals }) {
  const client = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pin, setPin] = useState("");
  const [bulkPin, setBulkPin] = useState("");
  const issues = useQuery({ queryKey: ["admin", "wallet", "issues"], queryFn: () => api<{ issues: Issue[] }>("/api/admin/wallet/reconciliation") });
  const run = useMutation({
    mutationFn: () => api<{ mismatches: number }>("/api/admin/wallet/reconciliation/run", { method: "POST", body: "{}" }),
    onSuccess: async (r) => {
      toast.success(r.mismatches ? `${r.mismatches} wallets need a look.` : "Every wallet matches its ledger.");
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api(`/api/admin/wallet/reconciliation/${id}/resolve`, { method: "POST", body: JSON.stringify({ pin, note: notes[id] ?? "" }) }),
    onSuccess: async () => {
      toast.success("Marked as resolved.");
      setPin("");
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const migrate = useMutation({
    mutationFn: () => api<{ migrated: number; pending: number }>("/api/admin/wallet/migrate-ai-credits", { method: "POST", body: JSON.stringify({ pin: bulkPin, limit: 500 }) }),
    onSuccess: async (r) => {
      toast.success(`Moved ${r.migrated} tenants. ${r.pending} wait for an image job to finish.`);
      setBulkPin("");
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const open = (issues.data?.issues ?? []).filter((i) => !i.resolved_at);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Balance checks</CardTitle>
            <CardDescription>Each wallet&apos;s balance must equal the sum of its ledger, and its holds the sum of open holds. Nothing is fixed automatically.</CardDescription>
          </div>
          <Button size="sm" variant="secondary" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Checking…" : "Check now"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {open.length === 0 ? (
            <p className="text-sm text-muted">No open mismatches.</p>
          ) : (
            <>
              {open.map((issue) => {
                const name = Array.isArray(issue.organizations) ? issue.organizations[0]?.name : issue.organizations?.name;
                return (
                  <div key={issue.id} className="space-y-2 rounded-xl border border-red-200 p-3 text-sm dark:border-red-900/50">
                    <p className="font-medium text-ink">{name ?? issue.organization_id}</p>
                    <p className="tabular-nums text-muted">
                      Balance {money(issue.balance_micros, 6)} vs ledger {money(issue.ledger_sum_micros, 6)} · holds {money(issue.reserved_micros, 6)} vs open{" "}
                      {money(issue.held_sum_micros, 6)} · found {formatDate(issue.detected_at, true)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Input className="flex-1" placeholder="What you found and did (10+ characters)" value={notes[issue.id] ?? ""} onChange={(e) => setNotes({ ...notes, [issue.id]: e.target.value })} />
                      <Button size="sm" variant="secondary" disabled={!confirmReady(pin, notes[issue.id] ?? "") || resolve.isPending} onClick={() => resolve.mutate(issue.id)}>
                        Mark resolved
                      </Button>
                    </div>
                  </div>
                );
              })}
              <ConfirmFields id="rc" withReason={false} pin={pin} onPin={setPin} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Move AI credits to wallets</CardTitle>
          <CardDescription>
            {totals?.pendingAiMigrations ?? 0} tenants still pay for AI with credits. Moving converts their credits at the cutover rate and switches their AI billing to the wallet. Run after the AI billing release is live.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ConfirmFields id="mg" withReason={false} pin={bulkPin} onPin={setBulkPin} />
          <Button variant="secondary" disabled={bulkPin.length !== 6 || migrate.isPending || !totals?.pendingAiMigrations} onClick={() => migrate.mutate()}>
            {migrate.isPending ? "Moving…" : "Move up to 500 tenants"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function WalletAdmin() {
  const [selected, setSelected] = useState<string | null>(null);
  const totals = useQuery({ queryKey: ["admin", "wallet", "overview"], queryFn: () => api<Totals>("/api/admin/wallet/overview") });
  const t = totals.data;

  if (totals.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Wallet Management" />
        <EmptyState icon={Wallet} title="Wallets are not set up" description={totals.error instanceof Error ? totals.error.message : "Apply the wallet migrations first."} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Wallet Management" description="Tenant wallets, WhatsApp and AI pricing, adjustments and checks." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!t ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[84px] rounded-2xl" />)
        ) : (
          <>
            <Stat label="Held in all wallets" value={money(t.totalBalanceMicros)} hint={`${t.wallets} wallets · ${money(t.totalReservedMicros)} on hold`} />
            <Stat label="Recharged this month" value={money(t.monthRechargedMicros)} hint={`${money(t.lifetimeRechargedMicros)} all time`} />
            <Stat label="Usage this month" value={money(BigInt(t.monthWhatsappMicros) + BigInt(t.monthAiMicros))} hint={`WhatsApp ${money(t.monthWhatsappMicros)} · AI ${money(t.monthAiMicros)}`} />
            <Stat
              label="Needs attention"
              value={`${t.lowBalance} low · ${t.frozen} frozen`}
              hint={`${t.openReconciliationIssues} mismatches · ${t.paidRechargesWithoutInvoice} invoices waiting`}
              tone={t.openReconciliationIssues ? "bad" : t.lowBalance || t.frozen ? "warn" : undefined}
            />
          </>
        )}
      </div>

      <Tabs defaultValue="wallets">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="wallets">Tenant wallets</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="checks">Checks{t?.openReconciliationIssues ? ` (${t.openReconciliationIssues})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="wallets">
          <WalletsTab onOpen={setSelected} />
        </TabsContent>
        <TabsContent value="pricing">
          <PricingTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="checks">
          <ReconciliationTab totals={t} />
        </TabsContent>
      </Tabs>

      <WalletDetailDialog organizationId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
