"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Mail, MapPin, Megaphone, Phone, Store } from "lucide-react";
import { SideSheet } from "@/components/dashboard/side-sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";
import { adjustmentAction, linkAction, payoutAction, rateAction, statusAction } from "./admin-actions";
import { app, inr, pct, str, StatusPill, type PendingAction, type Row } from "./admin-shared";

type Detail = {
  profile: Row;
  summary: Row;
  links: Row[];
  policies: Row[];
  payouts: Row[];
  accounts: Row[];
  audit: Row[];
};

export function PartnerSheet({
  partnerId,
  defaultBp,
  onClose,
  onAction,
}: {
  partnerId: string | null;
  defaultBp: number | null;
  onClose: () => void;
  onAction: (action: PendingAction) => void;
}) {
  const detail = useQuery({
    queryKey: ["admin-affiliates", "partner", partnerId],
    queryFn: () => api<Detail>(`/api/admin/affiliates/partners/${partnerId}`),
    enabled: Boolean(partnerId),
    retry: false,
  });
  const d = detail.data;
  const profile = d?.profile;
  const a = profile ? app(profile) : {};
  const status = String(profile?.status ?? "");
  const partnerRate = d?.policies.find((p) => p.link_id == null);
  const effectiveBp = partnerRate ? Number(partnerRate.basis_points) : defaultBp;

  const footer = profile ? (
    <div className="flex flex-wrap gap-2">
      {status === "PENDING" ? (
        <>
          <Button onClick={() => onAction(statusAction(profile, "APPROVED"))}>Approve</Button>
          <Button variant="secondary" onClick={() => onAction(statusAction(profile, "REJECTED"))}>Reject</Button>
        </>
      ) : null}
      {status === "APPROVED" ? (
        <>
          <Button variant="secondary" onClick={() => onAction(rateAction(profile, effectiveBp))}>Set commission rate</Button>
          <Button variant="secondary" onClick={() => onAction(adjustmentAction(profile))}>Adjust balance</Button>
          <Button variant="ghost" className="text-red-700" onClick={() => onAction(statusAction(profile, "SUSPENDED"))}>Suspend</Button>
        </>
      ) : null}
      {status === "SUSPENDED" || status === "REJECTED" ? (
        <Button onClick={() => onAction(statusAction(profile, "APPROVED"))}>Reactivate</Button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <SideSheet
      open={Boolean(partnerId)}
      onClose={onClose}
      title={str(a.fullName, "Partner")}
      description={profile ? `Partner since ${formatDate(String(profile.created_at))}` : undefined}
      footer={footer}
    >
      {detail.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
          <Skeleton className="h-40" />
        </div>
      ) : detail.error ? (
        <p role="alert" className="text-sm text-red-700">{detail.error.message}</p>
      ) : d && profile ? (
        <div className="space-y-6 text-sm">
          <section className="flex flex-wrap items-center gap-2">
            <StatusPill status={status} />
            <span className="text-muted">Commission {effectiveBp != null ? pct(effectiveBp) : "—"}{partnerRate ? " (custom)" : " (program default)"}</span>
            {partnerRate?.fixed_paise != null ? <span className="text-muted">· fixed {inr(partnerRate.fixed_paise)}</span> : null}
          </section>
          {profile.rejection_reason ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950/40 dark:text-red-300">Rejected: {String(profile.rejection_reason)}</p>
          ) : null}

          <section className="grid gap-2 sm:grid-cols-2">
            <Info icon={<Mail />} label="Email" value={str(profile.email)} />
            <Info icon={<Phone />} label="Mobile" value={str(a.mobile)} />
            <Info icon={<Store />} label="Business" value={str(a.business)} />
            <Info icon={<Megaphone />} label="Promotes via" value={str(a.channel)} />
            <Info icon={<Globe />} label="Website / social" value={[a.website, a.social].filter(Boolean).join(" · ") || "—"} />
            <Info icon={<MapPin />} label="Location" value={[a.city, a.state].filter(Boolean).join(", ") || "—"} />
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-ink">Last 90 days</h3>
            <div className="grid grid-cols-3 gap-2">
              <Mini label="Clicks" value={str(d.summary.clicks, "0")} />
              <Mini label="Signups" value={str(d.summary.signups, "0")} />
              <Mini label="Paid" value={str(d.summary.conversions, "0")} />
              <Mini label="Earned" value={inr(d.summary.earned)} />
              <Mini label="On hold" value={inr(d.summary.pending)} />
              <Mini label="Balance" value={inr(d.summary.balance)} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-ink">Referral links</h3>
            {d.links.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {d.links.map((link) => (
                  <li key={String(link.id)} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{str(link.campaign, "Default link")}</p>
                      <p className="text-xs text-muted tabular-nums">
                        {str(link.clicks, "0")} clicks · {str(link.signups, "0")} signups · {str(link.conversions, "0")} paid
                      </p>
                    </div>
                    {link.enabled ? null : <StatusPill status="Disabled" />}
                    <Button size="xs" variant="secondary" onClick={() => onAction(linkAction(link, !link.enabled))}>
                      {link.enabled ? "Disable" : "Enable"}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No links yet. One is created automatically on approval.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-ink">Payout requests</h3>
            {d.payouts.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {d.payouts.map((p) => (
                  <li key={String(p.id)} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <span className="font-medium tabular-nums text-ink">{inr(p.amount_paise)}</span>
                    <StatusPill status={p.status} />
                    <span className="text-xs text-muted">{formatDate(String(p.created_at))}</span>
                    {p.status === "REQUESTED" || p.status === "REVIEW" ? (
                      <Button size="xs" className="ml-auto" onClick={() => onAction(payoutAction(p, "APPROVED"))}>Approve</Button>
                    ) : p.status === "APPROVED" && p.send_via !== "RAZORPAYX" ? (
                      <Button size="xs" className="ml-auto" onClick={() => onAction(payoutAction(p, "PAID"))}>Mark paid</Button>
                    ) : p.settlement_reference ? (
                      <span className="ml-auto text-xs text-muted">Ref {String(p.settlement_reference)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No payout requests.</p>
            )}
            {d.accounts.length ? <p className="mt-2 text-xs text-muted">Payout account: {String(d.accounts[0].masked_details)}</p> : null}
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-ink">Activity</h3>
            {d.audit.length ? (
              <ol className="space-y-2 border-l border-border pl-4">
                {d.audit.map((entry) => (
                  <li key={String(entry.id)}>
                    <p className="font-medium text-ink">{describeAudit(entry)}</p>
                    <p className="text-xs text-muted">{formatDate(String(entry.created_at), true)}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted">No activity recorded.</p>
            )}
          </section>
        </div>
      ) : null}
    </SideSheet>
  );
}

export function describeAudit(entry: Row) {
  const details = (entry.details || {}) as Row;
  const reason = details.reason ? ` — ${String(details.reason)}` : "";
  switch (String(entry.action)) {
    case "application.submitted": return "Application submitted";
    case "risk.identity_overlap": return "Flagged: mobile number matches another partner";
    case "profile.updated": return "Profile updated by partner";
    case "payout.destination_viewed": return "Payout destination viewed";
    case "status": return `Status set to ${String(details.status ?? "").toLowerCase()}${reason}`;
    case "policy": return `Commission set to ${pct(details.basisPoints)}${details.fixedPaise ? ` / fixed ${inr(details.fixedPaise)}` : ""}${reason}`;
    case "adjustment": return `Balance adjusted by ${inr(details.amountPaise)}${reason}`;
    case "link": return `Link ${details.enabled ? "enabled" : "disabled"}${reason}`;
    case "correction": return `Referral reassigned${reason}`;
    case "settings": return `Program settings changed${reason}`;
    default: return `${String(entry.action).replaceAll(/[._]/g, " ")}${reason}`;
  }
}

function Info({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-surface-soft px-3 py-2.5 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted">
      {icon}
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        <p className="break-words text-ink">{value}</p>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
