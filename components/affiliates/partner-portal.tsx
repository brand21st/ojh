"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  Hourglass,
  Link2,
  QrCode,
  Send,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/hooks/use-api";
import { INDIAN_STATE_LIST, INDIAN_STATES, INDIAN_UNION_TERRITORIES } from "@/lib/indian-states";
import { formatBasisPoints, formatPaiseInr, publicReferralPath } from "@/modules/affiliates/policy";
import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site-config";
import { PartnerShell } from "@/components/affiliates/partner-shell";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";

type Row = Record<string, unknown>;
type Profile = { id: string; status: string; rejection_reason?: string; application: Record<string, string>; created_at?: string };
type Settings = { minimum_payout_paise: number; hold_days: number; attribution_days: number; registration_open: boolean; default_basis_points: number | null };
type Summary = {
  balance: { available: string; recoverable: string; paid: string };
  clicks: number;
  visitors: number;
  signups: number;
  conversions: number;
  earned: string;
  pending: string;
  reversed?: string;
  reserved: string;
  daily: { day: string; clicks: number }[];
  activity?: { day: string; signups: number; conversions: number; earnings: string }[];
};
type Me = { profile: Profile | null; email?: string; payoutsEnabled: boolean; settings: Settings | null };
type LinkRow = { id: string; code: string; campaign?: string; enabled?: boolean; landingPath?: string; landing_path?: string; utmSource?: string; utm_source?: string; utmMedium?: string; utm_medium?: string; utmCampaign?: string; utm_campaign?: string; clicks?: number; signups?: number; conversions?: number; created_at?: string };
export type PayoutOverview = {
  automatic: boolean;
  balance: { available: string; recoverable: string; paid: string };
  minimumPaise: string;
  nextPayoutDate: string | null;
  payoutDay: number;
  account: { masked: string; addedAt: string } | null;
  openPayout: { id: string; amount_paise: number; status: string; hold_reason: string | null; created_at: string } | null;
};

const money = (value: unknown) => formatPaiseInr(value ?? 0);
const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
function fmtDate(value: unknown, short = false) {
  if (!value) return "—";
  const d = new Date(String(value).length === 10 ? `${value}T00:00:00+05:30` : String(value));
  return Number.isNaN(d.getTime()) ? "—" : (short ? shortDate : dateFmt).format(d);
}

function statusLabel(status?: string) {
  if (status === "APPROVED") return "Active partner";
  if (status === "PENDING") return "Pending approval";
  if (status === "REJECTED") return "Not approved";
  if (status === "SUSPENDED") return "Paused";
  return status || "Unknown";
}

function Field({ name, label, type = "text", defaultValue = "", required = true, hint, placeholder, inputMode }: { name: string; label: string; type?: string; defaultValue?: string; required?: boolean; hint?: string; placeholder?: string; inputMode?: "text" | "email" | "tel" | "url" }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-ink">
        {label}
        {!required ? <span className="font-normal text-muted"> (optional)</span> : null}
      </span>
      <Input name={name} type={type} defaultValue={defaultValue} required={required} placeholder={placeholder} inputMode={inputMode} />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export { Field };

function StateField({ defaultValue = "" }: { defaultValue?: string }) {
  const listed = (INDIAN_STATES as readonly string[]).includes(defaultValue);
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-ink">State</span>
      <span className="relative">
        <select
          name="state"
          required
          defaultValue={defaultValue || ""}
          className={cn(
            "flex h-11 w-full appearance-none rounded-[var(--radius-input)] border border-border bg-card px-3.5 pr-10 text-sm text-foreground shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:border-brand"
          )}
        >
          <option value="" disabled>
            Select state
          </option>
          {!listed && defaultValue ? <option value={defaultValue}>{defaultValue}</option> : null}
          <optgroup label="States">
            {INDIAN_STATE_LIST.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </optgroup>
          <optgroup label="Union territories">
            {INDIAN_UNION_TERRITORIES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </optgroup>
        </select>
        <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      </span>
    </label>
  );
}

function rangeParams(days: number) {
  // Rounded to the minute so the query key stays stable across re-renders.
  const now = Math.floor(Date.now() / 60000) * 60000;
  return { from: new Date(now - days * 86400000).toISOString(), to: new Date(now).toISOString() };
}

function usePartnerMe() {
  return useQuery({ queryKey: ["partner", "me"], queryFn: () => api<Me>("/api/partner/me"), retry: false });
}

function usePayoutOverview(enabled = true) {
  return useQuery({ queryKey: ["partner", "payout-overview"], queryFn: () => api<PayoutOverview>("/api/partner/payouts/overview"), retry: false, enabled });
}

function Gate({ children }: { children: (me: Me) => ReactNode }) {
  const me = usePartnerMe();
  if (me.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-44 rounded-3xl" />
        <div className="grid gap-3 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      </div>
    );
  }
  if (me.error) {
    return (
      <main id="main-content" className="mx-auto max-w-md p-8">
        <Card className="space-y-3 p-6">
          <h1 className="text-lg font-semibold text-ink">Sign in to the partner dashboard</h1>
          <p role="alert" className="text-sm text-muted">{me.error.message}</p>
          <Link href="/partner/login" className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-btn)] bg-brand px-5 text-sm font-semibold text-white">
            Sign in <ArrowRight className="size-4" />
          </Link>
        </Card>
      </main>
    );
  }
  const data = me.data;
  if (!data) return null;
  return (
    <PartnerShell status={data.profile?.status} statusText={statusLabel(data.profile?.status)} email={data.email} name={data.profile?.application.fullName}>
      {!data.profile ? <ApplicationCard email={data.email} /> : children(data)}
    </PartnerShell>
  );
}

/* ---------------- application / profile form ---------------- */

function ApplicationCard({ email, profile }: { email?: string; profile?: Profile }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: Row) => api(profile ? "/api/partner/profile" : "/api/partner/application", { method: profile ? "PATCH" : "POST", body: JSON.stringify(data) }),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["partner"] }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    mutation.mutate({ ...data, terms: data.terms === "on", notify: data.notify === "on", country: "IN" });
  }
  const fields: [string, string, boolean, string?][] = [
    ["fullName", "Full name", true],
    ["mobile", "Mobile number", true, "+91 98765 43210"],
    ["business", "Business or agency", false],
    ["website", "Website", false, "https://"],
    ["social", "Social profile", false, "Instagram, YouTube, LinkedIn…"],
    ["channel", "How will you promote PostBus?", true, "e.g. YouTube tutorials, seller WhatsApp groups"],
    ["state", "State", true],
    ["city", "City", true],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{profile ? "Partner details" : "Apply to become a PostBus partner"}</CardTitle>
        <CardDescription>{profile ? "Keep these up to date — we use them to contact you." : "Earn recurring commission when sellers you refer subscribe. You're approved instantly and get your referral link right away."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          {email ? <p className="text-sm text-muted sm:col-span-2">Signed in as <span className="font-medium text-ink">{email}</span></p> : null}
          {fields.map(([name, label, required, placeholder]) =>
            name === "state" ? (
              <StateField key={name} defaultValue={profile?.application[name]} />
            ) : (
              <Field key={name} name={name} label={label} defaultValue={profile?.application[name]} required={required} placeholder={placeholder} inputMode={name === "mobile" ? "tel" : name === "website" ? "url" : "text"} />
            )
          )}
          <p className="text-xs text-muted sm:col-span-2">Partners are paid in INR to an Indian UPI ID.</p>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-border p-3 text-sm sm:col-span-2">
            <input name="notify" type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" defaultChecked={String(profile?.application.notify ?? "true") !== "false"} />
            <span>
              <span className="font-medium text-ink">Email me about my account</span>
              <span className="block text-muted">Application decisions and your first cleared commission. Payout emails are always sent.</span>
            </span>
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
            <input name="terms" type="checkbox" className="size-4 accent-[var(--brand)]" required defaultChecked={Boolean(profile)} />
            <span>I accept the <Link className="font-medium text-brand underline-offset-4 hover:underline" href="/partner/terms">partner terms</Link>.</span>
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : profile ? "Save details" : "Join and get my link"}</Button>
            {mutation.error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{mutation.error.message}</p> : null}
            {mutation.isSuccess ? <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300"><Check className="size-4" /> Saved</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ---------------- shared bits ---------------- */

function RangeTabs({ days, setDays }: { days: number; setDays: (value: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-xl border border-border bg-surface-soft p-1">
      {[7, 30, 90, 365].map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={days === value}
          onClick={() => setDays(value)}
          className={cn(
            "h-9 min-w-12 cursor-pointer rounded-lg px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
            days === value ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"
          )}
        >
          {value === 365 ? "1y" : `${value}d`}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const PAYOUT_STATUS: Record<string, { label: string; tone: "success" | "warning" | "error" | "brand" | "default"; icon: typeof Check }> = {
  REQUESTED: { label: "Requested", tone: "warning", icon: Clock3 },
  REVIEW: { label: "Being reviewed", tone: "warning", icon: Hourglass },
  APPROVED: { label: "Scheduled", tone: "brand", icon: CalendarClock },
  PROCESSING: { label: "On its way", tone: "brand", icon: Send },
  PAID: { label: "Paid", tone: "success", icon: CheckCircle2 },
  FAILED: { label: "Failed — returned to balance", tone: "error", icon: XCircle },
  REJECTED: { label: "Not approved", tone: "error", icon: XCircle },
  RETURNED: { label: "Returned by bank", tone: "error", icon: CircleAlert },
};

const HOLD_COPY: Record<string, string> = {
  NOT_ELIGIBLE: "Our team is reviewing your account.",
};

function PayoutStatus({ status }: { status: string }) {
  const s = PAYOUT_STATUS[status] ?? { label: status, tone: "default" as const, icon: Clock3 };
  const Icon = s.icon;
  return (
    <Badge variant={s.tone} className="gap-1">
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className={className}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        })
      }
      aria-label={`${label}: ${value}`}
    >
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}

/* ---------------- overview ---------------- */

export function PartnerOverview() {
  return <Gate>{(me) => <OverviewBody me={me} />}</Gate>;
}

function StatusCard({ profile }: { profile: Profile }) {
  if (profile.status === "APPROVED") return null;
  const copy = {
    PENDING: { icon: Hourglass, tone: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100", title: "Your application is being reviewed", body: "We usually decide within 2 working days and will email you. Your referral link appears here once you're approved." },
    REJECTED: { icon: XCircle, tone: "border-red-200 bg-red-50 text-red-950 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100", title: "Your application wasn't approved", body: profile.rejection_reason ? `Reason: ${profile.rejection_reason}` : "Contact us if you'd like us to take another look." },
    SUSPENDED: { icon: CircleAlert, tone: "border-zinc-200 bg-zinc-50 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100", title: "Your partner account is paused", body: "New referrals aren't being credited right now. Earnings you've already made are safe." },
  }[profile.status as "PENDING" | "REJECTED" | "SUSPENDED"];
  if (!copy) return null;
  const Icon = copy.icon;
  return (
    <div role="status" className={cn("flex gap-3 rounded-2xl border p-4", copy.tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">{copy.title}</p>
        <p className="mt-0.5 text-sm opacity-90">{copy.body}</p>
      </div>
    </div>
  );
}

function OverviewBody({ me }: { me: Me }) {
  const [days, setDays] = useState(30);
  const { from, to } = useMemo(() => rangeParams(days), [days]);
  const approved = me.profile?.status === "APPROVED";
  const summary = useQuery({ queryKey: ["partner", "summary", days], queryFn: () => api<Summary>(`/api/partner/summary?from=${from}&to=${to}`), retry: false });
  const payout = usePayoutOverview(approved);
  const s = summary.data;
  const first = (me.profile?.application.fullName || "Partner").split(" ")[0];
  const conversion = s?.signups ? `${((s.conversions / s.signups) * 100).toFixed(0)}%` : "—";

  return (
    <div className="space-y-6">
      <PageHeader title={`Hi ${first}`} description="Your referrals, earnings and next payout at a glance." actions={<RangeTabs days={days} setDays={setDays} />} />
      {me.profile ? <StatusCard profile={me.profile} /> : null}

      {approved ? <EarningsHero summary={s} overview={payout.data} loading={summary.isLoading || payout.isLoading} /> : null}

      {summary.error ? <p role="alert" className="text-sm text-red-700">{summary.error.message}</p> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {s ? (
          <>
            <Kpi label="Link clicks" value={s.clicks.toLocaleString("en-IN")} hint={`${s.visitors.toLocaleString("en-IN")} unique visitors`} />
            <Kpi label="Sellers signed up" value={s.signups.toLocaleString("en-IN")} />
            <Kpi label="Became paying" value={s.conversions.toLocaleString("en-IN")} hint={`${conversion} of signups`} />
            <Kpi label="Earned" value={<span className="text-emerald-700 dark:text-emerald-400">{money(s.earned)}</span>} hint={`in the last ${days === 365 ? "year" : `${days} days`}`} />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[98px] rounded-2xl" />)
        )}
      </div>

      {s ? <PerformanceChart summary={s} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        {approved ? <TopLinks /> : null}
        <ProgramTerms me={me} />
      </div>
    </div>
  );
}

function EarningsHero({ summary, overview, loading }: { summary?: Summary; overview?: PayoutOverview; loading: boolean }) {
  if (loading && !summary) return <Skeleton className="h-48 rounded-3xl" />;
  const available = BigInt(overview?.balance.available ?? summary?.balance.available ?? "0");
  const minimum = BigInt(overview?.minimumPaise ?? "100000");
  const progress = minimum > BigInt(0) ? Math.min(100, Number((available * BigInt(100)) / minimum)) : 100;
  const reachable = available >= minimum;
  const open = overview?.openPayout;
  return (
    <section aria-label="Earnings" className="grid overflow-hidden rounded-3xl border border-border bg-card lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="relative p-6 sm:p-7">
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-24 size-64 rounded-full bg-[var(--brand)] opacity-[0.07] blur-3xl" />
        <p className="text-sm font-medium text-muted">Available to pay out</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-ink sm:text-5xl">{money(available.toString())}</p>
        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:max-w-sm">
          <div>
            <dt className="flex items-center gap-1.5 text-muted"><Hourglass className="size-3.5" aria-hidden /> On hold</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-ink">{money(summary?.pending)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-muted"><CheckCircle2 className="size-3.5" aria-hidden /> Paid to date</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-ink">{money(overview?.balance.paid ?? summary?.balance.paid)}</dd>
          </div>
        </dl>
        {BigInt(overview?.balance.recoverable ?? "0") > BigInt(0) ? (
          <p className="mt-4 text-xs text-amber-800 dark:text-amber-300">{money(overview?.balance.recoverable)} will be recovered from future earnings after a refund.</p>
        ) : null}
      </div>
      <div className="border-t border-border bg-surface-soft/60 p-6 sm:p-7 lg:border-l lg:border-t-0">
        {open ? (
          <>
            <p className="text-sm font-medium text-muted">Current payout</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{money(open.amount_paise)}</p>
            <div className="mt-2"><PayoutStatus status={open.status} /></div>
            {open.hold_reason ? <p className="mt-2 text-sm text-muted">{HOLD_COPY[open.hold_reason] ?? "Our team is checking it."}</p> : null}
          </>
        ) : overview?.automatic && overview.nextPayoutDate ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-medium text-muted"><CalendarClock className="size-4" aria-hidden /> Next automatic payout</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{fmtDate(overview.nextPayoutDate)}</p>
            <p className="mt-1 text-sm text-muted">
              {reachable ? <>≈ <span className="font-semibold tabular-nums text-ink">{money(available.toString())}</span></> : `Payouts start at ${money(minimum.toString())}`}
              {overview.account ? ` to UPI ${overview.account.masked.replace(/^UPI\s*/, "")}` : ""}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-muted">Payouts</p>
            <p className="mt-1 text-lg font-semibold text-ink">{reachable ? "You can request a payout" : `Payouts start at ${money(minimum.toString())}`}</p>
          </>
        )}
        {!open && !reachable ? (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Progress to minimum payout">
              <div className="h-full rounded-full bg-emerald-500 motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted">{money((minimum - available).toString())} to go</p>
          </div>
        ) : null}
        {overview && !overview.account ? (
          <Link href="/partner/payouts" className="mt-4 inline-flex h-11 items-center gap-2 rounded-[var(--radius-btn)] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark">
            <Wallet className="size-4" /> Add your UPI ID
          </Link>
        ) : (
          <Link href="/partner/payouts" className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
            Payout details <ArrowRight className="size-4" />
          </Link>
        )}
      </div>
    </section>
  );
}

const SERIES = {
  clicks: { label: "Clicks", color: "var(--brand)" },
  signups: { label: "Signups", color: "#6366f1" },
  earnings: { label: "Earnings (₹)", color: "var(--success)" },
} as const;

function PerformanceChart({ summary }: { summary: Summary }) {
  const [series, setSeries] = useState<keyof typeof SERIES>("clicks");
  const data = useMemo(() => {
    if (series === "clicks") return (summary.daily || []).map((r) => ({ day: r.day, value: Number(r.clicks) }));
    return (summary.activity || []).map((r) => ({ day: r.day, value: series === "signups" ? Number(r.signups) : Number(r.earnings) / 100 }));
  }, [series, summary]);
  const color = SERIES[series].color;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Performance</CardTitle>
        <div role="radiogroup" aria-label="Chart series" className="inline-flex rounded-xl border border-border bg-surface-soft p-1">
          {(Object.keys(SERIES) as (keyof typeof SERIES)[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={series === key}
              onClick={() => setSeries(key)}
              className={cn("h-8 cursor-pointer rounded-lg px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", series === key ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {SERIES[key].label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-56">
          {data.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ left: -16, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="partner-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="day" tickFormatter={(v) => fmtDate(v, true)} tick={{ fontSize: 12, fill: "var(--muted)" }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis allowDecimals={series === "earnings"} tick={{ fontSize: 12, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                <Tooltip
                  labelFormatter={(v) => fmtDate(v)}
                  formatter={(v) => [series === "earnings" ? `₹${Number(v).toLocaleString("en-IN")}` : Number(v).toLocaleString("en-IN"), SERIES[series].label]}
                  contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", background: "var(--card, #fff)" }}
                />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill="url(#partner-fill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="flex h-full items-center justify-center text-sm text-muted">No activity in this range yet. Share your link to get started.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function shareUrl(row: LinkRow) {
  if (typeof window === "undefined") return "";
  const landing = row.landingPath || row.landing_path || "/";
  return `${window.location.origin}${publicReferralPath(row.code, landing, { utmSource: row.utmSource || row.utm_source, utmMedium: row.utmMedium || row.utm_medium, utmCampaign: row.utmCampaign || row.utm_campaign })}`;
}

function useLinks() {
  return useQuery({ queryKey: ["partner", "links"], queryFn: () => api<{ rows: LinkRow[] }>("/api/partner/links"), retry: false });
}

function TopLinks() {
  const list = useLinks();
  const rows = [...(list.data?.rows ?? [])].filter((r) => r.enabled !== false).sort((a, b) => Number(b.conversions ?? 0) - Number(a.conversions ?? 0) || Number(b.clicks ?? 0) - Number(a.clicks ?? 0)).slice(0, 4);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Your links</CardTitle>
        <Link href="/partner/links" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">All links <ArrowRight className="size-4" /></Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {list.isLoading ? <Skeleton className="h-24" /> : rows.length ? (
          rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{row.campaign || "Main referral link"}</p>
                <p className="text-xs tabular-nums text-muted">{row.clicks ?? 0} clicks · {row.signups ?? 0} signups · {row.conversions ?? 0} paying</p>
              </div>
              <CopyButton value={shareUrl(row)} label="Copy link" />
            </div>
          ))
        ) : (
          <p className="text-sm text-muted">Your referral link appears here after approval.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ProgramTerms({ me }: { me: Me }) {
  const rate = me.settings?.default_basis_points == null ? null : formatBasisPoints(me.settings.default_basis_points);
  const items = [
    rate ? `${rate} recurring commission on every subscription payment from sellers you refer.` : "Recurring commission on every subscription payment from sellers you refer.",
    `Sellers count as yours for ${me.settings?.attribution_days ?? 30} days after they click your link.`,
    `Each commission is held ${me.settings?.hold_days ?? 30} days to cover refunds, then becomes available.`,
    `Payouts start at ${money(me.settings?.minimum_payout_paise ?? 100000)} and are sent to your UPI ID.`,
  ];
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-emerald-600" aria-hidden /> How you earn</CardTitle></CardHeader>
      <CardContent>
        <ul className="space-y-2.5 text-sm text-muted">
          {items.map((item) => (
            <li key={item} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> <span>{item}</span></li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------- links & campaigns ---------------- */

function LinksBody({ createCampaign }: { createCampaign: boolean }) {
  const client = useQueryClient();
  const list = useLinks();
  const mutation = useMutation({
    mutationFn: (data: Row) => api(createCampaign ? "/api/partner/campaigns" : "/api/partner/links", { method: "POST", body: JSON.stringify(data) }),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["partner", "links"] }),
  });
  const me = usePartnerMe();
  const approved = me.data?.profile?.status === "APPROVED";
  const rows = list.data?.rows || [];
  return (
    <div className="space-y-6">
      <PageHeader title={createCampaign ? "Campaigns" : "Referral links"} description={createCampaign ? "Separate links per channel, so you can see what works." : "Share these with sellers. Every signup through them is credited to you."} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{createCampaign ? "New campaign link" : "New link"}</CardTitle>
          <CardDescription>{approved ? "Give it a name you'll recognise, like “YouTube Dec”." : "Links are available once your application is approved."}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(Object.fromEntries(new FormData(event.currentTarget)));
              event.currentTarget.reset();
            }}
          >
            <Field name="campaign" label="Name" required={createCampaign} placeholder="YouTube Dec" />
            {createCampaign ? (
              <>
                <Field name="channel" label="Channel" required={false} placeholder="youtube" />
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium text-ink">Landing page</span>
                  <select name="landingPath" className="h-11 rounded-[var(--radius-input)] border border-border bg-card px-3 text-sm" defaultValue="/">
                    <option value="/">Home page</option>
                    <option value="/pricing">Pricing</option>
                    <option value="/partner">Partner page</option>
                  </select>
                </label>
                <Field name="utmSource" label="UTM source" required={false} />
                <Field name="utmMedium" label="UTM medium" required={false} />
                <Field name="utmCampaign" label="UTM campaign" required={false} />
              </>
            ) : null}
            <div className="flex items-end">
              <Button disabled={!approved || mutation.isPending}>{mutation.isPending ? "Creating…" : "Create link"}</Button>
            </div>
          </form>
          {mutation.error ? <p role="alert" className="mt-3 text-sm text-red-700">{mutation.error.message}</p> : null}
        </CardContent>
      </Card>
      {list.isLoading ? <Skeleton className="h-40 rounded-2xl" /> : null}
      {list.error ? <p role="alert" className="text-sm text-red-700">{list.error.message}</p> : null}
      {!list.isLoading && !rows.length ? <EmptyState icon={Link2} title="No links yet" description={approved ? "Create your first link above." : "Your main link is created automatically when you're approved."} /> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((row) => {
          const url = shareUrl(row);
          const qr = `/api/partner/qr?code=${encodeURIComponent(row.code)}`;
          return (
            <Card key={row.id} className={cn(row.enabled === false && "opacity-60")}>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{row.campaign || "Main referral link"}</p>
                    <p className="text-xs tabular-nums text-muted">{row.clicks ?? 0} clicks · {row.signups ?? 0} signups · {row.conversions ?? 0} paying</p>
                  </div>
                  {row.enabled === false ? <Badge>Inactive</Badge> : <Badge variant="success">Active</Badge>}
                </div>
                <div className="flex items-center gap-2 rounded-xl bg-surface-soft px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-ink">{url}</code>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={url} label="Copy link" />
                  <a className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-btn)] border border-border px-3.5 text-xs font-semibold hover:bg-surface-soft" href={`https://wa.me/?text=${encodeURIComponent(`Ship India Post parcels faster with PostBus: ${url}`)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
                  <a className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-btn)] border border-border px-3.5 text-xs font-semibold hover:bg-surface-soft" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">LinkedIn</a>
                  <a className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-btn)] border border-border px-3.5 text-xs font-semibold hover:bg-surface-soft" href={qr} target="_blank" rel="noopener noreferrer"><QrCode className="size-4" aria-hidden /> QR</a>
                  <a className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-btn)] border border-border px-3.5 text-xs font-semibold hover:bg-surface-soft" href={qr} download={`postbus-partner-${row.code}.png`}><Download className="size-4" aria-hidden /> QR</a>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function PartnerLinks() {
  return <Gate>{() => <LinksBody createCampaign={false} />}</Gate>;
}

export function PartnerCampaigns() {
  return <Gate>{() => <LinksBody createCampaign />}</Gate>;
}

/* ---------------- referrals & earnings ---------------- */

type Column = { h: string; c: (r: Row) => ReactNode; className?: string };

const REFERRAL_STATUS_TONE: Record<string, "success" | "warning" | "error" | "default"> = { ACTIVE: "success", TRIALING: "warning", TRIAL: "warning", CANCELLED: "default", PAST_DUE: "error", EXPIRED: "default" };
const COMMISSION_TONE: Record<string, "success" | "warning" | "error" | "brand"> = { PENDING: "warning", PAYABLE: "success", PAID: "brand", REVERSED: "error" };
const COMMISSION_LABEL: Record<string, string> = { PENDING: "On hold", PAYABLE: "Available", PAID: "Paid out", REVERSED: "Reversed (refund)" };

function RecordsPage({ path }: { path: "referrals" | "commissions" }) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState(90);
  const { from, to } = useMemo(() => rangeParams(days), [days]);
  const list = useQuery({
    queryKey: ["partner", path, page, query, status, days],
    queryFn: () => api<Row[]>(`/api/partner/${path}?page=${page}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&from=${from}&to=${to}`),
    retry: false,
  });
  const rows = Array.isArray(list.data) ? list.data : [];
  const earnings = path === "commissions";
  const statuses = earnings ? ["", "PENDING", "PAYABLE", "PAID", "REVERSED"] : ["", "ACTIVE", "TRIALING", "CANCELLED"];
  const columns: Column[] = earnings
    ? [
        { h: "Payment", c: (r) => <span className="font-mono text-xs">{String(r.payment_reference ?? "—")}</span> },
        { h: "Commission", c: (r) => <span className="font-semibold tabular-nums text-ink">{money(r.amount_paise)}</span>, className: "text-right" },
        { h: "Status", c: (r) => <Badge variant={COMMISSION_TONE[String(r.status)] ?? "default"}>{COMMISSION_LABEL[String(r.status)] ?? String(r.status)}</Badge> },
        { h: "Available from", c: (r) => fmtDate(r.available_at) },
        { h: "Earned", c: (r) => fmtDate(r.created_at) },
      ]
    : [
        { h: "Seller", c: (r) => <span className="font-medium text-ink">{String(r.merchant ?? "—")}</span> },
        { h: "Signed up", c: (r) => fmtDate(r.signup_at) },
        { h: "Plan", c: (r) => (r.subscription_status ? <Badge variant={REFERRAL_STATUS_TONE[String(r.subscription_status)] ?? "default"}>{String(r.subscription_status).toLowerCase().replace("_", " ")}</Badge> : <span className="text-muted">No plan yet</span>) },
        { h: "Paying", c: (r) => (r.paid_conversion ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Yes" /> : <span className="text-muted">—</span>) },
        { h: "You earned", c: (r) => <span className="tabular-nums">{money(r.earned_paise)}</span>, className: "text-right" },
      ];
  return (
    <Gate>
      {(me) => (
        <div className="space-y-6">
          <PageHeader
            title={earnings ? "Earnings" : "Referred sellers"}
            description={earnings ? `Commissions are held ${me.settings?.hold_days ?? 30} days to cover refunds, then become available for payout.` : "Sellers are shown by a short label to protect their privacy."}
            actions={<RangeTabs days={days} setDays={(d) => { setDays(d); setPage(0); }} />}
          />
          {earnings ? <EarningsStats days={days} from={from} to={to} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <label className="w-full sm:w-72">
              <span className="sr-only">Search</span>
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder={earnings ? "Search payment reference" : "Search seller label"} className="h-10" />
            </label>
            <div role="radiogroup" aria-label="Status" className="flex flex-wrap gap-1.5">
              {statuses.map((s) => (
                <button key={s || "all"} type="button" role="radio" aria-checked={status === s} onClick={() => { setStatus(s); setPage(0); }}
                  className={cn("h-9 cursor-pointer rounded-full border px-3 text-xs font-medium transition-colors duration-150", status === s ? "border-ink bg-ink text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-border bg-card text-muted hover:text-ink")}>
                  {s ? (earnings ? COMMISSION_LABEL[s] : s.charAt(0) + s.slice(1).toLowerCase()) : "All"}
                </button>
              ))}
            </div>
          </div>
          <Card className="overflow-hidden">
            {list.isLoading ? <Skeleton className="m-4 h-40" /> : list.error ? <p role="alert" className="p-6 text-sm text-red-700">{list.error.message}</p> : !rows.length ? (
              <p className="p-10 text-center text-sm text-muted">{earnings ? "No commissions in this range yet." : "No referred sellers in this range yet."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                      {columns.map((col) => <th key={col.h} className={cn("whitespace-nowrap px-4 py-3 font-medium", col.className)}>{col.h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row, index) => (
                      <tr key={String(row.payment_reference ?? row.merchant ?? index)}>
                        {columns.map((col) => <td key={col.h} className={cn("px-4 py-3", col.className)}>{col.c(row)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {page > 0 || rows.length >= 25 ? (
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="px-2 text-sm text-muted">Page {page + 1}</span>
              <Button size="sm" variant="secondary" disabled={rows.length < 25} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          ) : null}
        </div>
      )}
    </Gate>
  );
}

function EarningsStats({ days, from, to }: { days: number; from: string; to: string }) {
  const summary = useQuery({ queryKey: ["partner", "summary", days], queryFn: () => api<Summary>(`/api/partner/summary?from=${from}&to=${to}`), retry: false });
  const s = summary.data;
  if (!s) return summary.isLoading ? <Skeleton className="h-24 rounded-2xl" /> : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Earned in range" value={<span className="text-emerald-700 dark:text-emerald-400">{money(s.earned)}</span>} />
      <Kpi label="On hold" value={money(s.pending)} hint="Clears after the hold period" />
      <Kpi label="Available" value={money(s.balance.available)} />
      <Kpi label="Paid to date" value={money(s.balance.paid)} hint={BigInt(s.reversed || "0") > BigInt(0) ? `${money(s.reversed)} reversed by refunds` : undefined} />
    </div>
  );
}

export function PartnerReferrals() {
  return <RecordsPage path="referrals" />;
}

export function PartnerCommissions() {
  return <RecordsPage path="commissions" />;
}

/* ---------------- payouts ---------------- */

export function PartnerPayouts() {
  return <Gate>{(me) => <PayoutsBody me={me} />}</Gate>;
}

export function PayoutsBody({ me }: { me: Me }) {
  const approved = me.profile?.status === "APPROVED";
  const overview = usePayoutOverview(approved);
  const list = useQuery({ queryKey: ["partner", "payouts"], queryFn: () => api<Row[]>("/api/partner/payouts"), retry: false });
  const rows = list.data || [];
  const o = overview.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        description={o?.automatic ? `Paid automatically to your UPI ID on the ${ordinal(o.payoutDay)} of every month.` : "Your earnings are paid to your UPI ID."}
      />
      {!approved ? <p className="rounded-2xl border border-border bg-surface-soft p-4 text-sm text-muted">Payouts open once your application is approved.</p> : null}
      {approved ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Kpi label="Available" value={o ? money(o.balance.available) : "—"} />
              <Kpi label="Minimum payout" value={o ? money(o.minimumPaise) : "—"} />
              <Kpi label="Paid to date" value={o ? money(o.balance.paid) : "—"} />
            </div>
            <RequestPayout overview={o} payoutsEnabled={me.payoutsEnabled} />
          </div>
          <UpiAccountCard overview={o} />
        </div>
      ) : null}

      <section aria-labelledby="payout-history" className="space-y-3">
        <h2 id="payout-history" className="text-base font-semibold text-ink">History</h2>
        {list.isLoading ? <Skeleton className="h-32 rounded-2xl" /> : rows.length ? (
          <ol className="space-y-2">
            {rows.map((row) => (
              <li key={String(row.id)} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3">
                <div className="min-w-[7rem]">
                  <p className="text-lg font-semibold tabular-nums text-ink">{money(row.amount_paise)}</p>
                  <p className="text-xs text-muted">{fmtDate(row.created_at)}{row.origin === "AUTO" ? " · automatic" : ""}</p>
                </div>
                <PayoutStatus status={String(row.status)} />
                <div className="min-w-0 flex-1 text-sm text-muted">
                  {row.status === "REVIEW" && row.hold_reason ? HOLD_COPY[String(row.hold_reason)] : null}
                  {row.status === "FAILED" || row.status === "RETURNED" ? <>{String(row.failure_reason ?? "")} The amount is back in your balance.</> : null}
                  {row.status === "PAID" && row.settled_at ? `Credited ${fmtDate(row.settled_at)}` : null}
                </div>
                {row.status === "PAID" && (row.utr || row.settlement_reference) ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">UTR</span>
                    <code className="text-xs font-semibold text-ink">{String(row.utr ?? row.settlement_reference)}</code>
                    <CopyButton value={String(row.utr ?? row.settlement_reference)} label="Copy" />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState icon={Wallet} title="No payouts yet" description="Your first payout appears here once your available balance reaches the minimum." />
        )}
      </section>
    </div>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function RequestPayout({ overview, payoutsEnabled }: { overview?: PayoutOverview; payoutsEnabled: boolean }) {
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ["partner", "accounts"], queryFn: () => api<Row[]>("/api/partner/accounts"), retry: false });
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/partner/payouts", {
        method: "POST",
        body: JSON.stringify({ accountId: String(accounts.data?.[0]?.id), amountPaise: Number(overview?.balance.available), key: crypto.randomUUID() }),
      }),
    retry: false,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["partner"] }),
  });
  if (!overview) return <Skeleton className="h-28 rounded-2xl" />;
  const available = BigInt(overview.balance.available);
  const reachable = available >= BigInt(overview.minimumPaise);
  const blocked = !payoutsEnabled ? "Payouts are paused right now." : overview.openPayout ? "You already have a payout in progress." : !overview.account ? "Add a UPI ID first." : !reachable ? `You need at least ${money(overview.minimumPaise)} available.` : null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{overview.automatic ? "Don't want to wait?" : "Request a payout"}</p>
          <p className="text-sm text-muted">
            {overview.automatic
              ? `Next automatic payout: ${fmtDate(overview.nextPayoutDate)}. You can also request your full available balance now.`
              : "Request your full available balance. We'll send it to your UPI ID."}
          </p>
          {blocked ? <p className="mt-1 text-xs text-muted">{blocked}</p> : null}
          {mutation.error ? <p role="alert" className="mt-1 text-sm text-red-700">{mutation.error.message}</p> : null}
          {mutation.isSuccess ? <p role="status" className="mt-1 text-sm text-emerald-700">Payout requested.</p> : null}
        </div>
        <Button disabled={Boolean(blocked) || mutation.isPending || !accounts.data?.length} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Requesting…" : `Request ${money(overview.balance.available)}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function UpiAccountCard({ overview }: { overview?: PayoutOverview }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const mutation = useMutation({
    mutationFn: (data: Row) => api("/api/partner/accounts", { method: "POST", body: JSON.stringify(data) }),
    retry: false,
    onSuccess: () => { setEditing(false); void client.invalidateQueries({ queryKey: ["partner"] }); },
  });
  const account = overview?.account;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Wallet className="size-4" aria-hidden /> Payout account</CardTitle>
        <CardDescription>Money is sent by UPI through RazorpayX.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {account && !editing ? (
          <>
            <div className="rounded-xl bg-surface-soft px-4 py-3">
              <p className="text-xs text-muted">UPI ID</p>
              <p className="font-semibold text-ink">{account.masked}</p>
              <p className="mt-1 text-xs text-muted">Added {fmtDate(account.addedAt)}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Change UPI ID</Button>
          </>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const f = Object.fromEntries(new FormData(event.currentTarget));
              mutation.mutate({ name: String(f.name).trim(), upi: String(f.upi).trim() });
            }}
          >
            <Field name="name" label="Account holder name" placeholder="As shown in your UPI app" />
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-ink">UPI ID</span>
              <Input name="upi" required pattern="[\w.\-]{2,100}@[\w.\-]{2,50}" placeholder="yourname@okhdfcbank" autoComplete="off" inputMode="email" />
              <span className="text-xs text-muted">Double-check it — payouts to a wrong UPI ID can&apos;t always be recovered.</span>
            </label>
            <div className="flex gap-2">
              <Button disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save UPI ID"}</Button>
              {account ? <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
            </div>
            {mutation.error ? <p role="alert" className="text-sm text-red-700">{mutation.error.message}</p> : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- profile & help ---------------- */

export function PartnerProfile() {
  return (
    <Gate>
      {(me) => (
        <div className="space-y-6">
          <PageHeader title="Profile" description="Your partner details and email preferences." />
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Status" value={<span className="text-lg">{statusLabel(me.profile?.status)}</span>} />
            <Kpi label="Partner since" value={<span className="text-lg">{fmtDate(me.profile?.created_at)}</span>} />
            <Kpi label="Commission" value={<span className="text-lg">{me.settings?.default_basis_points == null ? "Program rate" : formatBasisPoints(me.settings.default_basis_points)}</span>} hint="Set by PostBus" />
          </div>
          <ApplicationCard email={me.email} profile={me.profile || undefined} />
          <p className="text-sm text-muted">Your partner login is your PostBus account. <Link className="font-medium text-brand hover:underline" href="/forgot-password">Reset password</Link></p>
        </div>
      )}
    </Gate>
  );
}

const FAQ: [string, (me: Me) => string][] = [
  ["What do I earn?", (me) => `${me.settings?.default_basis_points == null ? "A share" : formatBasisPoints(me.settings.default_basis_points)} of every subscription payment (excluding GST) from sellers who sign up through your link — for as long as they stay subscribed.`],
  ["When does a seller count as mine?", (me) => `When they sign up within ${me.settings?.attribution_days ?? 30} days of clicking your link. The first partner link they clicked wins.`],
  ["When can I withdraw?", (me) => `Each commission is held ${me.settings?.hold_days ?? 30} days to cover refunds. After that it's available, and paid once your balance reaches ${money(me.settings?.minimum_payout_paise ?? 100000)}.`],
  ["How are payouts sent?", () => "By UPI through RazorpayX, usually on a fixed day each month. You'll get an email when a payout is sent and when it's credited, with the UTR."],
  ["What if a payout fails?", () => "The money goes straight back to your available balance and we email you. Check your UPI ID — it's retried on the next payout run."],
  ["What doesn't earn commission?", () => "India Post booking charges, storefront sales and AI credit top-ups. Refunded payments are reversed from your earnings."],
];

export function PartnerSupport() {
  return (
    <Gate>
      {(me) => (
        <div className="space-y-6">
          <PageHeader title="Help" description="How the PostBus partner program works." />
          <div className="divide-y divide-border rounded-2xl border border-border bg-card">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium text-ink">
                  {q}
                  <ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
                </summary>
                <p className="mt-1 text-sm leading-relaxed text-muted">{a(me)}</p>
              </details>
            ))}
          </div>
          <p className="text-sm text-muted">
            Still stuck? Email <a className="font-medium text-brand hover:underline" href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</a> · <Link className="font-medium text-brand hover:underline" href="/partner/terms">Partner terms</Link>
          </p>
        </div>
      )}
    </Gate>
  );
}

export function PartnerPendingBanner() {
  return <Badge variant="warning">Pending approval</Badge>;
}
