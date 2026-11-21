"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, X } from "lucide-react";
import type { MeResponse } from "@/types/api";

const DISMISS_KEY = "postbus.wallet-banner-dismissed";

/**
 * Shown on every dashboard page (except the Wallet page itself) while the
 * wallet is low or on hold. Dismissing hides it for this browser session only.
 */
export function WalletBalanceBanner({ me }: { me?: MeResponse | null }) {
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? false : window.sessionStorage.getItem(DISMISS_KEY) === "1"
  );
  const wallet = me?.wallet;
  if (!wallet?.enabled || (!wallet.lowBalance && !wallet.frozen)) return null;
  if (pathname.startsWith("/dashboard/wallet") || dismissed) return null;

  const frozen = Boolean(wallet.frozen);
  return (
    <div
      role="status"
      className={
        frozen
          ? "mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
          : "mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      }
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {frozen
          ? "Your wallet is on hold, so WhatsApp notifications and paid AI features are paused."
          : "Your wallet balance is low. WhatsApp notifications and AI checks pause when it runs out."}{" "}
        <Link href="/dashboard/wallet" className="font-semibold underline underline-offset-2">
          {frozen ? "View wallet" : "Recharge"}
        </Link>
      </p>
      <button
        type="button"
        aria-label="Dismiss for now"
        className="shrink-0 rounded-md p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        onClick={() => {
          window.sessionStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
