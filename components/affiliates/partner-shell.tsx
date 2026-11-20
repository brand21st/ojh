"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeIndianRupee,
  CircleHelp,
  Handshake,
  LayoutDashboard,
  Link2,
  LogOut,
  Megaphone,
  Menu,
  Store,
  UserRound,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { resetAnalyticsUser } from "@/lib/analytics/posthog";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const NAV = [
  { group: "Earn", items: [
    ["/partner/dashboard", "Overview", LayoutDashboard],
    ["/partner/links", "Referral links", Link2],
    ["/partner/campaigns", "Campaigns", Megaphone],
    ["/partner/referrals", "Referred sellers", Users],
  ] },
  { group: "Money", items: [
    ["/partner/commissions", "Earnings", BadgeIndianRupee],
    ["/partner/payouts", "Payouts", Wallet],
  ] },
  { group: "Account", items: [
    ["/partner/profile", "Profile", UserRound],
    ["/partner/support", "Help", CircleHelp],
  ] },
] as const;

const STATUS_TONE: Record<string, string> = {
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  SUSPENDED: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
};

export function PartnerShell({
  children,
  status,
  statusText,
  email,
  name,
}: {
  children: ReactNode;
  status?: string;
  statusText?: string;
  email?: string;
  name?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const signOut = () => {
    resetAnalyticsUser();
    void createClient().auth.signOut().then(() => {
      window.location.href = "/partner/login";
    });
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between gap-2 px-5">
        <Link href="/partner/dashboard" className="flex items-center gap-2 font-semibold text-ink" onClick={() => setOpen(false)}>
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-white"><Handshake className="size-4" aria-hidden /></span>
          PostBus <span className="font-normal text-muted">Partners</span>
        </Link>
        <button type="button" className="flex size-11 items-center justify-center rounded-xl hover:bg-surface-soft lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2" aria-label="Partner">
        {NAV.map(({ group, items }) => (
          <div key={group}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{group}</p>
            <ul className="space-y-0.5">
              {items.map(([href, label, Icon]) => {
                const active = pathname === href;
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                        active ? "bg-rose-50 font-semibold text-brand-dark dark:bg-rose-950/40 dark:text-rose-300" : "text-muted hover:bg-surface-soft hover:text-ink"
                      )}
                    >
                      {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-full bg-brand" /> : null}
                      <Icon className="size-4 shrink-0" aria-hidden />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="space-y-1 border-t border-border p-3">
        <div className="px-3 py-2">
          {name ? <p className="truncate text-sm font-medium text-ink">{name}</p> : null}
          <p className="truncate text-xs text-muted">{email}</p>
        </div>
        <Link href="/dashboard" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-muted hover:bg-surface-soft hover:text-ink">
          <Store className="size-4" aria-hidden /> Merchant workspace
        </Link>
        <button type="button" onClick={signOut} className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-sm text-muted hover:bg-surface-soft hover:text-ink">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <aside className="hidden border-r border-border bg-card lg:sticky lg:top-0 lg:block lg:h-screen">{sidebar}</aside>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Partner menu">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close menu" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[min(85vw,18rem)] bg-card shadow-2xl">{sidebar}</aside>
        </div>
      ) : null}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-8">
          <button type="button" className="-ml-2 flex size-11 items-center justify-center rounded-xl hover:bg-surface-soft lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
            <Menu className="size-5" />
          </button>
          <p className="text-sm font-medium text-muted lg:hidden">Partners</p>
          <div className="ml-auto flex items-center gap-2">
            {statusText ? (
              <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", STATUS_TONE[status ?? ""] ?? "bg-surface-soft text-ink")}>{statusText}</span>
            ) : null}
          </div>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-6xl p-4 pb-16 md:p-8">{children}</main>
      </div>
    </div>
  );
}
