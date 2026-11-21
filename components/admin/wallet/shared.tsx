"use client";

import type { ReactNode, SelectHTMLAttributes } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatMicros, toMicros } from "@/modules/wallet/money";

export const money = (micros: string | number | bigint | null | undefined, digits = 2) =>
  formatMicros(typeof micros === "bigint" ? micros : toMicros(String(micros ?? "0")), { maxFractionDigits: digits });

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "warn" | "bad" }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p className={cn("text-lg font-semibold tabular-nums text-ink", tone === "warn" && "text-amber-600", tone === "bad" && "text-rose-600")}>
          {value}
        </p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-10 rounded-[var(--radius-input)] border border-border bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        className
      )}
      {...props}
    />
  );
}

/** Reason + 6-digit PIN, required for every action that changes money or pricing. */
export function ConfirmFields({
  id,
  reason,
  onReason,
  pin,
  onPin,
  reasonLabel = "Reason (kept in the audit log)",
  withReason = true,
}: {
  id: string;
  reason?: string;
  onReason?: (value: string) => void;
  pin: string;
  onPin: (value: string) => void;
  reasonLabel?: string;
  withReason?: boolean;
}) {
  return (
    <div className="space-y-3">
      {withReason ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`}>{reasonLabel}</Label>
          <Textarea
            id={`${id}-reason`}
            rows={2}
            maxLength={400}
            value={reason ?? ""}
            onChange={(event) => onReason?.(event.target.value)}
            placeholder="At least 10 characters"
          />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-pin`}>Confirmation PIN</Label>
        <Input
          id={`${id}-pin`}
          inputMode="numeric"
          autoComplete="off"
          type="password"
          className="w-40"
          value={pin}
          onChange={(event) => onPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
        />
      </div>
    </div>
  );
}

export function confirmReady(pin: string, reason?: string) {
  return pin.length === 6 && (reason === undefined || reason.trim().length >= 10);
}
