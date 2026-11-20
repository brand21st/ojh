"use client";

import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  Handshake,
  Inbox,
  Link2,
  Search,
  Settings2,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";
import { percentToBasisPoints, rupeesToPaise } from "@/modules/affiliates/policy";
import { destinationAction, payoutAction, statusAction, type PayoutDecision } from "./admin-actions";
import { describeAudit, PartnerSheet } from "./admin-partner-sheet";
import { ActionDialog, app, inr, pct, shortId, Stat, StatusPill, str, type PendingAction, type Row } from "./admin-shared";

const PAGE = 25;
type Section = "applications" | "partners" | "payouts" | "commissions" | "referrals" | "audit" | "health";

function useSection(section: string, params: Record<string, string | number>, enabled = true) {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "").map(([k, v]) => [k, String(v)]));
  return useQuery({
    queryKey: ["admin-affiliates", section, params],
    queryFn: () => api<Row[]>(`/api/admin/affiliates/${section}?${search}`),
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  });
}

export function AffiliateAdminDashboard({ payoutsEnabled, accrualEnabled }: { payoutsEnabled: boolean; accrualEnabled: boolean }) {
  const [tab, setTab] = useState<Section>("applications");
  const [action, setAction] = useState<PendingAction | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  const overview = useQuery({ queryKey: ["admin-affiliates", "overview"], queryFn: () => api<Row>("/api/admin/affiliates/overview"), retry: false });
  const settings = useSection("settings", {});
  const policies = useSection("policies", {});
  const program = settings.data?.[0];
  const defaultPolicy = policies.data?.find((p) => p.affiliate_id == null && p.link_id == null);
  const defaultBp = defaultPolicy ? Number(defaultPolicy.basis_points) : null;
  const o = overview.data;

  if (overview.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Partner program" description="Affiliates who refer merchants to PostBus." />
        <EmptyState icon={AlertTriangle} title="Partner data isn't available" description={overview.error.message} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner program"
        description="Approve affiliates, track referred merchants and settle commission payouts."
        icon={<span className="flex size-10 items-center justify-center rounded-xl bg-rose-100 text-brand-dark"><Handshake className="size-5" /></span>}
        actions={
          <Button variant="secondary" size="sm" disabled={!program} onClick={() => program && setAction(settingsAction(program, defaultBp))}>
            <Settings2 /> Program settings
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2 text-xs">
        <Flag on={program ? Boolean(program.registration_open) : null} label="Registration" />
        <Flag on={accrualEnabled} label="Commission accrual" />
        <Flag on={payoutsEnabled} label="Payouts" />
        <span className="rounded-full border border-border px-2.5 py-1 text-muted">
          Default rate {defaultBp != null ? pct(defaultBp) : "—"} · {str(program?.attribution_days, "–")}-day attribution · {str(program?.hold_days, "–")}-day hold · min payout {program ? inr(program.minimum_payout_paise) : "—"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {o ? (
          <>
            <Stat label="Active partners" value={str(o.active, "0")} hint={`${str(o.partners, "0")} total · ${str(o.links, "0")} live links`} icon={<Users className="size-4" />} />
            <Stat label="Pending applications" value={str(o.applications, "0")} hint="Waiting for review" icon={<UserPlus className="size-4" />} />
            <Stat label="Referred merchants" value={str(o.signups, "0")} hint={`${str(o.paidMerchants, "0")} became paying`} icon={<Link2 className="size-4" />} />
            <Stat label="Owed to partners" value={inr(o.liabilities)} hint={`${inr(o.earned)} earned · ${inr(o.paid)} paid out`} icon={<Wallet className="size-4" />} />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)
        )}
      </div>

      {o && Number(o.review) > 0 ? (
        <button
          type="button"
          onClick={() => setTab("health")}
          className="flex w-full items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">{String(o.review)} captured payment(s) need review before commission can be calculated.</span>
          <span className="font-medium underline">Open health</span>
        </button>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Section)}>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="applications">
              Applications{o && Number(o.applications) > 0 ? <Count n={o.applications} /> : null}
            </TabsTrigger>
            <TabsTrigger value="partners">Partners</TabsTrigger>
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="commissions">Commissions</TabsTrigger>
            <TabsTrigger value="referrals">Referrals</TabsTrigger>
            <TabsTrigger value="audit">Activity</TabsTrigger>
            <TabsTrigger value="health">Health{o && Number(o.review) > 0 ? <Count n={o.review} /> : null}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="applications" className="mt-4">
          <Applications onAction={setAction} onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="partners" className="mt-4">
          <Partners onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="payouts" className="mt-4">
          <Payouts payoutsEnabled={payoutsEnabled} onAction={setAction} onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="commissions" className="mt-4">
          <Commissions onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="referrals" className="mt-4">
          <Referrals onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <Activity onOpen={setPartnerId} />
        </TabsContent>
        <TabsContent value="health" className="mt-4">
          <Health />
        </TabsContent>
      </Tabs>

      <PartnerSheet partnerId={partnerId} defaultBp={defaultBp} onClose={() => setPartnerId(null)} onAction={setAction} />
      <ActionDialog action={action} onClose={() => setAction(null)} />
    </div>
  );
}

function settingsAction(program: Row, defaultBp: number | null): PendingAction {
  return {
    title: "Program settings",
    description: "Changes apply to new referrals and new commissions. Existing earnings keep the terms they were created under.",
    confirmLabel: "Save settings",
    path: "actions",
    successMessage: "Program settings saved.",
    fields: [
      { name: "registrationOpen", label: "New partner applications", type: "select", defaultValue: String(Boolean(program.registration_open)), options: [{ value: "true", label: "Open" }, { value: "false", label: "Closed" }] },
      { name: "attributionDays", label: "Attribution window (days)", inputMode: "numeric", defaultValue: str(program.attribution_days, "30"), help: "How long after a click a signup still counts, 1–90." },
      { name: "holdDays", label: "Commission hold (days)", inputMode: "numeric", defaultValue: str(program.hold_days, "30"), help: "Earnings stay on hold this long to cover refunds, 1–365." },
      { name: "minimumPayout", label: "Minimum payout (₹)", inputMode: "decimal", defaultValue: String(Number(program.minimum_payout_paise ?? 100000) / 100) },
      { name: "defaultRate", label: "Default commission (%)", inputMode: "decimal", defaultValue: defaultBp != null ? String(defaultBp / 100) : "20", help: "For partners without a custom rate. Saved separately in the audit log." },
    ],
    build: (v) => {
      const attributionDays = Number(v.attributionDays);
      const holdDays = Number(v.holdDays);
      const minimumPayoutPaise = rupeesToPaise(v.minimumPayout);
      const basisPoints = percentToBasisPoints(v.defaultRate);
      if (!Number.isInteger(attributionDays) || attributionDays < 1 || attributionDays > 90) return "Attribution window must be 1–90 days.";
      if (!Number.isInteger(holdDays) || holdDays < 1 || holdDays > 365) return "Commission hold must be 1–365 days.";
      if (!minimumPayoutPaise) return "Enter a minimum payout above ₹0.";
      if (basisPoints == null) return "Default commission must be 0–100%.";
      return {
        action: "settings",
        registrationOpen: v.registrationOpen === "true",
        attributionDays,
        holdDays,
        minimumPayoutPaise,
      };
    },
    followUp: (v) => {
      const basisPoints = percentToBasisPoints(v.defaultRate);
      return basisPoints == null || basisPoints === defaultBp
        ? null
        : { path: "actions", data: { action: "policy", affiliateId: null, linkId: null, basisPoints, fixedPaise: null } };
    },
  };
}

/* ---------- Applications ---------- */

function Applications({ onAction, onOpen }: { onAction: (a: PendingAction) => void; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const query = useSection("applications", { page, q });
  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      <SearchBox value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="Search name, mobile, business, city" />
      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-52 rounded-2xl" /><Skeleton className="h-52 rounded-2xl" /></div>
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Inbox} title={q ? "No matching applications" : "No applications waiting"} description="New partner applications show up here for approval." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => {
            const a = app(row);
            return (
              <article key={String(row.id)} className="flex flex-col rounded-2xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button type="button" className="text-left text-base font-semibold text-ink hover:underline" onClick={() => onOpen(String(row.id))}>
                      {str(a.fullName, "Applicant")}
                    </button>
                    <p className="text-sm text-muted">{[a.business, [a.city, a.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted">{formatDate(String(row.created_at))}</span>
                </div>
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted">Promotes via</dt><dd className="text-ink">{str(a.channel)}</dd>
                  <dt className="text-muted">Mobile</dt><dd className="tabular-nums text-ink">{str(a.mobile)}</dd>
                  <dt className="text-muted">Website</dt><dd className="truncate text-ink">{a.website ? <a className="underline" href={String(a.website)} target="_blank" rel="noreferrer noopener">{String(a.website)}</a> : "—"}</dd>
                  <dt className="text-muted">Social</dt><dd className="break-words text-ink">{str(a.social)}</dd>
                </dl>
                <div className="mt-auto flex gap-2 pt-5">
                  <Button size="sm" onClick={() => onAction(statusAction(row, "APPROVED"))}><Check /> Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => onAction(statusAction(row, "REJECTED"))}>Reject</Button>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onOpen(String(row.id))}>Details</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <Pager page={page} count={rows.length} onPage={setPage} />
    </div>
  );
}

/* ---------- Partners ---------- */

const PARTNER_STATUSES = ["", "APPROVED", "PENDING", "SUSPENDED", "REJECTED"];

function Partners({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const query = useSection("partners", { page, q, status });
  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="Search name, mobile, business, city" />
        <Chips value={status} options={PARTNER_STATUSES} onChange={(v) => { setStatus(v); setPage(0); }} />
        <ExportButton rows={rows} name="partners" map={(r) => ({ name: app(r).fullName, mobile: app(r).mobile, business: app(r).business, channel: app(r).channel, city: app(r).city, state: app(r).state, status: r.status, joined: r.created_at })} />
      </div>
      <Table
        loading={query.isLoading}
        error={query.error}
        rows={rows}
        empty="No partners match these filters."
        onRow={(r) => onOpen(String(r.id))}
        columns={[
          { h: "Partner", c: (r) => <><p className="font-medium text-ink">{str(app(r).fullName)}</p><p className="text-xs text-muted">{str(app(r).business, "")}</p></> },
          { h: "Mobile", c: (r) => <span className="tabular-nums">{str(app(r).mobile)}</span> },
          { h: "Promotes via", c: (r) => str(app(r).channel) },
          { h: "Location", c: (r) => [app(r).city, app(r).state].filter(Boolean).join(", ") || "—" },
          { h: "Status", c: (r) => <StatusPill status={r.status} /> },
          { h: "Joined", c: (r) => formatDate(String(r.created_at)) },
        ]}
      />
      <Pager page={page} count={rows.length} onPage={setPage} />
    </div>
  );
}

/* ---------- Payouts ---------- */

const PAYOUT_STATUSES = ["", "REQUESTED", "REVIEW", "APPROVED", "PAID", "REJECTED", "RETURNED"];
const NEXT_STEPS: Record<string, PayoutDecision[]> = {
  REQUESTED: ["APPROVED", "REVIEW", "REJECTED"],
  REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["PAID", "REVIEW", "REJECTED"],
  PAID: ["RETURNED"],
};
const DECISION_LABEL: Record<PayoutDecision, string> = { APPROVED: "Approve", PAID: "Mark paid", REVIEW: "Review", REJECTED: "Reject", RETURNED: "Returned" };

function Payouts({ payoutsEnabled, onAction, onOpen }: { payoutsEnabled: boolean; onAction: (a: PendingAction) => void; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("REQUESTED");
  const [revealed, setRevealed] = useState<Row | null>(null);
  const query = useSection("payouts", { page, status });
  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      {!payoutsEnabled ? (
        <p className="rounded-2xl border border-border bg-surface-soft px-4 py-3 text-sm text-muted">
          Payouts are switched off (<code>POSTBUS_AFFILIATE_PAYOUTS_ENABLED</code>). Partners can&apos;t request payouts and the actions below will be refused.
        </p>
      ) : null}
      <Chips value={status} options={PAYOUT_STATUSES} onChange={(v) => { setStatus(v); setPage(0); }} />
      <Table
        loading={query.isLoading}
        error={query.error}
        rows={rows}
        empty={status ? `No ${status.toLowerCase()} payouts.` : "No payout requests yet."}
        columns={[
          { h: "Partner", c: (r) => <button type="button" className="font-medium text-ink hover:underline" onClick={() => onOpen(String(r.affiliate_id))}>{str(r.partner_name)}</button> },
          { h: "Amount", c: (r) => <span className="font-semibold tabular-nums">{inr(r.amount_paise)}</span> },
          { h: "Status", c: (r) => <StatusPill status={r.status} /> },
          { h: "Requested", c: (r) => formatDate(String(r.created_at)) },
          { h: "Reference", c: (r) => str(r.settlement_reference) },
          {
            h: "",
            c: (r) => (
              <div className="flex flex-wrap justify-end gap-1.5">
                {["REQUESTED", "REVIEW", "APPROVED"].includes(String(r.status)) ? (
                  <Button size="xs" variant="ghost" onClick={() => onAction(destinationAction(String(r.account_id), setRevealed))}>UPI</Button>
                ) : null}
                {(NEXT_STEPS[String(r.status)] ?? []).map((d, i) => (
                  <Button key={d} size="xs" variant={i === 0 ? "primary" : "secondary"} onClick={() => onAction(payoutAction(r, d))}>{DECISION_LABEL[d]}</Button>
                ))}
              </div>
            ),
          },
        ]}
      />
      <Pager page={page} count={rows.length} onPage={setPage} />
      <Dialog open={Boolean(revealed)} onOpenChange={(open) => (!open ? setRevealed(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payout destination</DialogTitle>
            <DialogDescription>This view was recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Account name</dt><dd className="font-medium text-ink">{str(revealed?.name)}</dd>
            <dt className="text-muted">UPI ID</dt><dd className="select-all font-mono text-ink">{str(revealed?.upi)}</dd>
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- Commissions / Referrals / Activity ---------- */

function Commissions({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const query = useSection("commissions", { page });
  const rows = query.data ?? [];
  const [now] = useState(() => Date.now());
  return (
    <div className="space-y-4">
      <Table
        loading={query.isLoading}
        error={query.error}
        rows={rows}
        empty="No commissions yet. They're created when a referred merchant pays for a subscription."
        columns={[
          { h: "Partner", c: (r) => <PartnerLink r={r} onOpen={onOpen} /> },
          { h: "Payment", c: (r) => <span className="font-mono text-xs">{shortId(r.payment_id)}</span> },
          { h: "Net payment", c: (r) => <span className="tabular-nums">{inr(r.net_paise)}</span> },
          { h: "Rate", c: (r) => { const s = (r.policy_snapshot || {}) as Row; const fixed = s.fixed_paise ?? s.fixedPaise; const bp = s.basis_points ?? s.basisPoints; return fixed != null ? `fixed ${inr(fixed)}` : bp != null ? pct(bp) : "—"; } },
          { h: "Commission", c: (r) => <span className="font-semibold tabular-nums">{inr(r.amount_paise)}</span> },
          { h: "Releases", c: (r) => <span className={Date.parse(String(r.available_at)) > now ? "text-amber-700 dark:text-amber-300" : "text-muted"}>{formatDate(String(r.available_at))}</span> },
          { h: "Earned", c: (r) => formatDate(String(r.created_at)) },
        ]}
      />
      <Pager page={page} count={rows.length} onPage={setPage} />
    </div>
  );
}

function Referrals({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const query = useSection("referrals", { page });
  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      <Table
        loading={query.isLoading}
        error={query.error}
        rows={rows}
        empty="No referred merchants yet."
        columns={[
          { h: "Partner", c: (r) => <PartnerLink r={r} onOpen={onOpen} /> },
          { h: "Merchant workspace", c: (r) => <span className="font-mono text-xs">{shortId(r.organization_id)}</span> },
          { h: "Link", c: (r) => <span className="font-mono text-xs">{shortId(r.link_id)}</span> },
          { h: "Attribution", c: (r) => str(r.policy_version) },
          { h: "Signed up", c: (r) => formatDate(String(r.created_at), true) },
        ]}
      />
      <Pager page={page} count={rows.length} onPage={setPage} />
    </div>
  );
}

function Activity({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const query = useSection("audit", { page });
  const rows = query.data ?? [];
  return (
    <div className="space-y-4">
      <Table
        loading={query.isLoading}
        error={query.error}
        rows={rows}
        empty="Nothing recorded yet."
        columns={[
          { h: "When", c: (r) => <span className="whitespace-nowrap">{formatDate(String(r.created_at), true)}</span> },
          { h: "Partner", c: (r) => (r.affiliate_id ? <PartnerLink r={r} onOpen={onOpen} /> : <span className="text-muted">Program</span>) },
          { h: "What happened", c: (r) => describeAudit(r) },
          { h: "By", c: (r) => (r.actor_id ? <span className="font-mono text-xs">{shortId(r.actor_id)}</span> : <span className="text-muted">System</span>) },
        ]}
      />
      <Pager page={page} count={rows.length} onPage={setPage} />
    </div>
  );
}

/* ---------- Health ---------- */

function Health() {
  const queue = useSection("reconciliation", { page: 0 });
  const report = useQuery({ queryKey: ["admin-affiliates", "report"], queryFn: () => api<unknown>("/api/admin/affiliates/report"), retry: false });
  const reportRows = Array.isArray(report.data) ? (report.data as Row[]) : report.data && typeof report.data === "object" ? [report.data as Row] : [];
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold text-ink">Payment processing queue</h2>
        <p className="text-sm text-muted">Each captured subscription payment from a referred merchant passes through here before commission is calculated. Items in review usually need verified tax evidence.</p>
        <Table
          loading={queue.isLoading}
          error={queue.error}
          rows={queue.data ?? []}
          empty="Queue is empty."
          columns={[
            { h: "Payment", c: (r) => <span className="font-mono text-xs">{shortId(r.payment_id)}</span> },
            { h: "Status", c: (r) => <StatusPill status={r.status} /> },
            { h: "Attempts", c: (r) => str(r.attempts, "0") },
            { h: "Next attempt", c: (r) => formatDate(String(r.next_attempt_at), true) },
            { h: "Updated", c: (r) => formatDate(String(r.updated_at), true) },
          ]}
        />
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold text-ink">Reconciliation report</h2>
        {report.isLoading ? <Skeleton className="h-24 rounded-2xl" /> : report.error ? <ErrorNote error={report.error} /> : <KeyValueRows rows={reportRows} />}
      </section>
    </div>
  );
}

function KeyValueRows({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No discrepancies found.</p>;
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <dl key={i} className="grid gap-x-6 gap-y-1 rounded-2xl border border-border bg-card p-4 text-sm sm:grid-cols-2">
          {Object.entries(row).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted">{k.replaceAll("_", " ")}</dt>
              <dd className="truncate text-right font-medium text-ink">{typeof v === "object" ? (Array.isArray(v) ? `${v.length} item(s)` : JSON.stringify(v)) : str(v)}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

/* ---------- small building blocks ---------- */

type Col = { h: string; c: (r: Row) => ReactNode };

function Table({ rows, columns, loading, error, empty, onRow }: { rows: Row[]; columns: Col[]; loading: boolean; error: Error | null; empty: string; onRow?: (r: Row) => void }) {
  if (loading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  if (!rows.length) return <p className="rounded-2xl border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            {columns.map((col, i) => <th key={i} className="whitespace-nowrap px-4 py-3 font-medium">{col.h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr
              key={String(row.id ?? row.payment_id ?? i)}
              className={onRow ? "cursor-pointer hover:bg-surface-soft" : undefined}
              onClick={onRow ? () => onRow(row) : undefined}
              tabIndex={onRow ? 0 : undefined}
              onKeyDown={onRow ? (e) => { if (e.key === "Enter") onRow(row); } : undefined}
            >
              {columns.map((col, j) => <td key={j} className="px-4 py-3 align-middle">{col.c(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PartnerLink({ r, onOpen }: { r: Row; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="font-medium text-ink hover:underline" onClick={() => onOpen(String(r.affiliate_id))}>
      {str(r.partner_name)}
    </button>
  );
}

function Pager({ page, count, onPage }: { page: number; count: number; onPage: (p: number) => void }) {
  if (page === 0 && count < PAGE) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="px-2 text-muted">Page {page + 1}</span>
      <Button size="sm" variant="secondary" disabled={count < PAGE} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-full sm:w-80">
      <span className="sr-only">Search</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-10 pl-9" />
    </label>
  );
}

function Chips({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Filter by status">
      {options.map((opt) => (
        <button
          key={opt || "all"}
          type="button"
          role="radio"
          aria-checked={value === opt}
          onClick={() => onChange(opt)}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${value === opt ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-ink" : "border-border bg-card text-muted hover:text-ink"}`}
        >
          {opt ? opt.charAt(0) + opt.slice(1).toLowerCase() : "All"}
        </button>
      ))}
    </div>
  );
}

function ExportButton({ rows, name, map }: { rows: Row[]; name: string; map: (r: Row) => Row }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="sm:ml-auto"
      disabled={!rows.length}
      onClick={() => {
        const data = rows.map(map);
        const keys = Object.keys(data[0] ?? {});
        const safe = (v: unknown) => `"${String(v ?? "").replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
        const csv = [keys.join(","), ...data.map((r) => keys.map((k) => safe(r[k])).join(","))].join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `affiliate-${name}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <Download /> Export
    </Button>
  );
}

function Flag({ on, label }: { on: boolean | null; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${on ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300" : "border-border text-muted"}`}>
      <span className={`size-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-zinc-400"}`} />
      {label} {on == null ? "…" : on ? "on" : "off"}
    </span>
  );
}

function Count({ n }: { n: unknown }) {
  return <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{String(n)}</span>;
}

function ErrorNote({ error }: { error: Error }) {
  return (
    <p role="alert" className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
      <AlertTriangle className="size-4 shrink-0" /> {error.message}
    </p>
  );
}
