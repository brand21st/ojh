"use client";

import { useState } from "react";
import { Loader2, Tag, X } from "lucide-react";

/** The part of the store quote response the coupon UI needs. */
export type QuoteCoupon = {
  code: string;
  label: string;
  automatic: boolean;
  applied: boolean;
  discount: number;
  subtotal: number;
  message: string | null;
};

const inr = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Checkout coupon entry. The parent owns the quote: `onApply(code)` should re-quote with
 * `couponCode` (and `trackCouponApply: true`) and resolve once the quote is back.
 */
export function CouponField({
  coupon,
  error,
  pending,
  accentColor,
  onApply,
  onRemove,
}: {
  coupon: QuoteCoupon | null;
  error: string | null;
  pending: boolean;
  accentColor?: string;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  if (coupon?.applied) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <Tag className="size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            <span className="font-mono">{coupon.code}</span> applied{coupon.automatic ? " automatically" : ""}
          </p>
          <p className="truncate text-xs">{coupon.label} · you save {inr(coupon.discount)}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove coupon ${coupon.code}`}
          className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  const hint = coupon && !coupon.applied ? coupon.message : null;

  return (
    <div className="space-y-1.5">
      {hint ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Tag className="size-3.5 shrink-0" aria-hidden />
          <span><span className="font-mono font-semibold">{coupon?.code}</span>: {hint}</span>
        </p>
      ) : null}
      {!open && !error ? (
        <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline" style={{ color: accentColor }}>
          <Tag className="size-4" aria-hidden />Have a coupon code?
        </button>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const code = value.trim().toUpperCase().replace(/\s+/g, "");
            if (code) onApply(code);
          }}
        >
          <label htmlFor="store-coupon" className="sr-only">Coupon code</label>
          <input
            id="store-coupon"
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            placeholder="Enter code"
            value={value}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? "store-coupon-error" : undefined}
            onChange={(event) => setValue(event.target.value)}
            className="h-11 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 font-mono text-base uppercase text-zinc-900 placeholder:font-sans placeholder:normal-case placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none aria-[invalid=true]:border-red-500"
          />
          <button
            type="submit"
            disabled={pending || !value.trim()}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: accentColor ?? "#18181b" }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}Apply
          </button>
        </form>
      )}
      {error ? (
        <p id="store-coupon-error" role="alert" className="text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}

/** Order summary rows: subtotal, discount and total, shown only when a coupon is applied. */
export function CouponSummaryRows({ coupon, total }: { coupon: QuoteCoupon | null; total: number }) {
  if (!coupon?.applied) return null;
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex justify-between text-zinc-600">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{inr(coupon.subtotal)}</dd>
      </div>
      <div className="flex justify-between text-emerald-700">
        <dt>Discount (<span className="font-mono">{coupon.code}</span>)</dt>
        <dd className="tabular-nums">−{inr(coupon.discount)}</dd>
      </div>
      <div className="flex justify-between font-semibold text-zinc-900">
        <dt>Total</dt>
        <dd className="tabular-nums">{inr(total)}</dd>
      </div>
    </dl>
  );
}

/** Thin banner for the store's auto-apply coupon or a magic-link coupon. */
export function CouponBanner({
  code,
  label,
  description,
  accentColor,
  onDismiss,
}: {
  code: string;
  label: string;
  description?: string | null;
  accentColor: string;
  onDismiss?: () => void;
}) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-4 py-2 text-center text-xs font-medium text-white sm:text-sm" style={{ backgroundColor: accentColor }}>
      <Tag className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        <span className="font-semibold">{label}</span>
        {" "}with code <span className="rounded bg-white/20 px-1.5 py-0.5 font-mono">{code}</span>
        {description ? <span className="hidden sm:inline"> · {description}</span> : null}
        <span className="hidden sm:inline"> · applied at checkout</span>
      </p>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss offer" className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-white/15">
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
