"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { loadCheckoutScript } from "@/components/billing/ai-credits-checkout-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackPurchase } from "@/lib/analytics/posthog";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { formatMicros } from "@/modules/wallet/money";
import { quoteRecharge, validateRechargeAmount, type RechargeLimits } from "@/modules/wallet/recharge-quote";

type StartResponse = {
  keyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { email?: string; name?: string };
};

type VerifyResponse = { status: "CREDITED" | "PENDING"; balanceMicros?: string | null };

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function RechargeDialog({
  open,
  onOpenChange,
  limits,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: RechargeLimits;
}) {
  const client = useQueryClient();
  const presets = limits.presetsPaise;
  const [selected, setSelected] = useState<number | "custom">(presets[2] ?? presets[0] ?? "custom");
  const [custom, setCustom] = useState("");

  const amountPaise = selected === "custom" ? Math.round(Number(custom || "0") * 100) : selected;
  const check = validateRechargeAmount(
    selected === "custom" && !/^\d+$/.test(custom.trim()) ? Number.NaN : amountPaise,
    limits
  );
  const quote = check.ok ? quoteRecharge(check.amountPaise, limits.gstRateBps, limits.placeOfSupply) : null;

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["wallet"] });
  };

  const start = useMutation({
    mutationFn: (paise: number) =>
      api<StartResponse>("/api/v1/wallet/recharge", { method: "POST", body: JSON.stringify({ amountPaise: paise }) }),
    onSuccess: async (data) => {
      try {
        await loadCheckoutScript();
        if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable.");
        const checkout = new window.Razorpay({
          key: data.keyId,
          amount: data.amountPaise,
          currency: data.currency,
          order_id: data.razorpayOrderId,
          name: data.name,
          description: data.description,
          prefill: data.prefill ?? {},
          handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
            try {
              const result = await api<VerifyResponse>("/api/v1/wallet/recharge/verify", {
                method: "POST",
                body: JSON.stringify({
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                }),
              });
              trackPurchase("wallet-recharge", data.amountPaise, {});
              if (result.status === "PENDING") {
                toast.success("Payment received. Your wallet updates in a minute.");
                setTimeout(() => void refresh(), 20_000);
              } else {
                toast.success("Wallet recharged.");
              }
              onOpenChange(false);
              await refresh();
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? `${error.message} If money left your account, the wallet updates automatically.`
                  : "Could not confirm the payment."
              );
              await refresh();
            }
          },
        });
        checkout.on("payment.failed", (response) => {
          toast.error(response.error?.description || "Payment failed. No money was added.");
          void refresh();
        });
        checkout.open();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not open Razorpay Checkout.");
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const gstPercent = (limits.gstRateBps / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Recharge wallet</DialogTitle>
          <DialogDescription>Pays for WhatsApp messages and AI features. Prices include {gstPercent}% GST.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Recharge amount">
            {presets.map((paise) => (
              <button
                key={paise}
                type="button"
                role="radio"
                aria-checked={selected === paise}
                onClick={() => setSelected(paise)}
                className={cn(
                  "h-11 rounded-xl border text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  selected === paise ? "border-brand bg-rose-50 text-brand-dark dark:bg-brand/15" : "border-border bg-card text-ink hover:bg-surface-soft"
                )}
              >
                {rupees(paise)}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={selected === "custom"}
              onClick={() => setSelected("custom")}
              className={cn(
                "h-11 rounded-xl border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                selected === "custom" ? "border-brand bg-rose-50 text-brand-dark dark:bg-brand/15" : "border-border bg-card text-ink hover:bg-surface-soft"
              )}
            >
              Other
            </button>
          </div>

          {selected === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="wallet-custom-amount">Amount in rupees</Label>
              <Input
                id="wallet-custom-amount"
                inputMode="numeric"
                autoFocus
                placeholder={`${limits.minPaise / 100} to ${limits.maxPaise / 100}`}
                value={custom}
                onChange={(event) => setCustom(event.target.value.replace(/[^\d]/g, "").slice(0, 7))}
              />
              {custom && !check.ok ? <p className="text-xs text-rose-600">{check.message}</p> : null}
            </div>
          ) : null}

          {quote ? (
            <dl className="space-y-1.5 rounded-xl border border-border bg-surface p-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">You pay</dt>
                <dd className="font-semibold tabular-nums text-ink">{rupees(quote.amountPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">GST ({gstPercent}%) included</dt>
                <dd className="tabular-nums text-muted">{rupees(quote.taxPaise)}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5">
                <dt className="font-medium text-ink">Added to wallet</dt>
                <dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{formatMicros(quote.creditMicros)}</dd>
              </div>
            </dl>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!check.ok || start.isPending} onClick={() => check.ok && start.mutate(check.amountPaise)}>
            {start.isPending ? "Starting…" : check.ok ? `Pay ${rupees(check.amountPaise)}` : "Pay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
