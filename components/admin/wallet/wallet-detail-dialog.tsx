"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmFields, NativeSelect, confirmReady, money } from "@/components/admin/wallet/shared";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";

type Detail = {
  organization: { id: string; name: string; legacyAiCredits: number };
  wallet: {
    status: "ACTIVE" | "FROZEN";
    balance_micros: string;
    reserved_micros: string;
    credit_limit_micros: string;
    low_balance_thresholds_micros: string[];
    lifetime_recharged_micros: string;
    lifetime_whatsapp_micros: string;
    lifetime_ai_micros: string;
    lifetime_promo_micros: string;
    lifetime_refunded_micros: string;
    last_recharged_at: string | null;
    ai_credits_migrated_at: string | null;
  };
  ledger: Array<{ id: string; label: string; amount_micros: string; balance_after_micros: string; description: string | null; created_at: string }>;
  adjustments: Array<{ id: string; kind: string; amount_micros: string; reason: string; admin_email: string | null; created_at: string }>;
  statusEvents: Array<{ id: string; from_status: string; to_status: string; reason: string; created_at: string }>;
  recharges: Array<{ id: string; amount_paise: number; tax_paise: number; refunded_paise: number; status: string; method: string | null; created_at: string; paid_at: string | null }>;
  aiUsage: Array<{ key: string; count: number; chargedMicros: string; refused: number }>;
  whatsappUsage: Array<{ key: string; count: number; chargedMicros: string; refused: number }>;
};

const KIND_LABEL: Record<string, string> = {
  PROMO: "Promotional credit",
  REFUND: "Refund to wallet",
  MANUAL_CREDIT: "Manual credit",
  MANUAL_DEBIT: "Manual debit",
};

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function WalletDetailDialog({ organizationId, onClose }: { organizationId: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const [kind, setKind] = useState("PROMO");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [limit, setLimit] = useState("");
  const [refundOrder, setRefundOrder] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [from, setFrom] = useState(() => `${istToday().slice(0, 8)}01`);
  const [to, setTo] = useState(istToday);

  const detail = useQuery({
    queryKey: ["admin", "wallet", "detail", organizationId],
    queryFn: () => api<Detail>(`/api/admin/wallet/wallets/${organizationId}`),
    enabled: Boolean(organizationId),
  });

  const reset = () => {
    setAmount("");
    setReason("");
    setPin("");
    setLimit("");
    setRefundOrder("");
    setRefundAmount("");
    setIdempotencyKey(crypto.randomUUID());
  };

  const act = useMutation({
    mutationFn: (input: { action: string; body: Record<string, unknown> }) =>
      api<{ status: string; note?: string }>(`/api/admin/wallet/wallets/${organizationId}/${input.action}`, {
        method: "POST",
        body: JSON.stringify(input.body),
      }),
    onSuccess: async (result) => {
      toast.success(result.note ?? `Done: ${result.status.toLowerCase().replaceAll("_", " ")}.`);
      reset();
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const data = detail.data;
  const frozen = data?.wallet.status === "FROZEN";
  const paidRecharges = (data?.recharges ?? []).filter((r) => r.status === "PAID" || r.status === "PARTIALLY_REFUNDED");

  return (
    <Dialog open={Boolean(organizationId)} onOpenChange={(open) => (!open ? (reset(), onClose()) : undefined)}>
      <DialogContent className="max-h-[90svh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {data?.organization.name ?? "Wallet"}
            {data ? <Badge variant={frozen ? "error" : "success"}>{frozen ? "Frozen" : "Active"}</Badge> : null}
          </DialogTitle>
          <DialogDescription className="break-all">{organizationId}</DialogDescription>
        </DialogHeader>

        {detail.isLoading || !data ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ["Balance", money(data.wallet.balance_micros)],
                ["On hold", money(data.wallet.reserved_micros)],
                ["Credit limit", money(data.wallet.credit_limit_micros)],
                ["Recharged", money(data.wallet.lifetime_recharged_micros)],
                ["WhatsApp spend", money(data.wallet.lifetime_whatsapp_micros)],
                ["AI spend", money(data.wallet.lifetime_ai_micros)],
                ["Promo credit", money(data.wallet.lifetime_promo_micros)],
                ["Refunded", money(data.wallet.lifetime_refunded_micros)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border p-2.5">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="font-semibold tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">
              Last recharge {data.wallet.last_recharged_at ? formatDate(data.wallet.last_recharged_at, true) : "never"} · AI credits{" "}
              {data.wallet.ai_credits_migrated_at
                ? `moved ${formatDate(data.wallet.ai_credits_migrated_at)}`
                : `not moved yet (${data.organization.legacyAiCredits} legacy credits)`}
            </p>

            <Tabs defaultValue="adjust">
              <TabsList className="flex-wrap">
                <TabsTrigger value="adjust">Adjust</TabsTrigger>
                <TabsTrigger value="controls">Controls</TabsTrigger>
                <TabsTrigger value="refund">Refund recharge</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
              </TabsList>

              <TabsContent value="adjust" className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="adj-kind">Type</Label>
                    <NativeSelect id="adj-kind" className="w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
                      {Object.entries(KIND_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adj-amount">Amount (₹)</Label>
                    <Input id="adj-amount" inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </div>
                </div>
                <ConfirmFields id="adj" reason={reason} onReason={setReason} pin={pin} onPin={setPin} />
                <Button
                  disabled={!amount || !confirmReady(pin, reason) || act.isPending}
                  onClick={() => act.mutate({ action: "adjust", body: { kind, amountRupees: amount, reason, pin, idempotencyKey } })}
                >
                  {act.isPending ? "Saving…" : `Apply ${KIND_LABEL[kind].toLowerCase()}`}
                </Button>
              </TabsContent>

              <TabsContent value="controls" className="space-y-5">
                <ConfirmFields id="ctl" reason={reason} onReason={setReason} pin={pin} onPin={setPin} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={frozen ? "primary" : "secondary"}
                    disabled={!confirmReady(pin, reason) || act.isPending}
                    onClick={() => act.mutate({ action: "status", body: { status: frozen ? "ACTIVE" : "FROZEN", reason, pin } })}
                  >
                    {frozen ? "Unfreeze wallet" : "Freeze wallet"}
                  </Button>
                  {!data.wallet.ai_credits_migrated_at ? (
                    <Button
                      variant="secondary"
                      disabled={pin.length !== 6 || act.isPending}
                      onClick={() => act.mutate({ action: "migrate-ai-credits", body: { pin } })}
                    >
                      Move AI credits to wallet
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ctl-limit">Credit limit (₹, 0 = prepaid only)</Label>
                    <Input id="ctl-limit" className="w-40" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0" />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={!limit || !confirmReady(pin, reason) || act.isPending}
                    onClick={() => act.mutate({ action: "credit-limit", body: { limitRupees: limit, reason, pin } })}
                  >
                    Set credit limit
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="refund" className="space-y-3">
                {paidRecharges.length === 0 ? (
                  <p className="text-sm text-muted">No paid recharges to refund.</p>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="rf-order">Recharge</Label>
                        <NativeSelect id="rf-order" className="w-full" value={refundOrder} onChange={(e) => setRefundOrder(e.target.value)}>
                          <option value="">Choose a recharge</option>
                          {paidRecharges.map((r) => (
                            <option key={r.id} value={r.id}>
                              ₹{(r.amount_paise / 100).toFixed(2)} · {formatDate(r.paid_at ?? r.created_at)}
                              {r.refunded_paise ? ` · ₹${(r.refunded_paise / 100).toFixed(2)} refunded` : ""}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="rf-amount">Refund amount (₹, incl. GST)</Label>
                        <Input id="rf-amount" inputMode="decimal" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
                      </div>
                    </div>
                    <p className="text-xs text-muted">
                      Money goes back to the merchant&apos;s card or bank through Razorpay. The matching wallet credit is removed when Razorpay confirms the refund.
                    </p>
                    <ConfirmFields id="rf" reason={reason} onReason={setReason} pin={pin} onPin={setPin} />
                    <Button
                      variant="secondary"
                      disabled={!refundOrder || !refundAmount || !confirmReady(pin, reason) || act.isPending}
                      onClick={() =>
                        act.mutate({ action: "refund-recharge", body: { rechargeOrderId: refundOrder, amountRupees: refundAmount, reason, pin } })
                      }
                    >
                      Refund through Razorpay
                    </Button>
                  </>
                )}
              </TabsContent>

              <TabsContent value="history" className="space-y-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="st-from">From</Label>
                    <Input id="st-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="st-to">To</Label>
                    <Input id="st-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                  </div>
                  <a
                    className={cn(buttonVariants({ variant: "secondary" }))}
                    href={`/api/admin/wallet/wallets/${organizationId}/statement?from=${from}&to=${to}`}
                    download
                  >
                    Export statement
                  </a>
                </div>
                <section>
                  <h3 className="mb-1.5 text-sm font-semibold text-ink">Adjustments</h3>
                  {data.adjustments.length === 0 ? (
                    <p className="text-sm text-muted">None.</p>
                  ) : (
                    <ul className="divide-y divide-border text-sm">
                      {data.adjustments.map((a) => (
                        <li key={a.id} className="flex justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="font-medium text-ink">{KIND_LABEL[a.kind] ?? a.kind}</p>
                            <p className="text-xs text-muted">
                              {formatDate(a.created_at, true)} · {a.admin_email ?? "admin"} · {a.reason}
                            </p>
                          </div>
                          <p className={cn("shrink-0 font-semibold tabular-nums", a.kind === "MANUAL_DEBIT" ? "text-ink" : "text-emerald-700")}>
                            {a.kind === "MANUAL_DEBIT" ? "−" : "+"}
                            {money(a.amount_micros)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3 className="mb-1.5 text-sm font-semibold text-ink">Last 50 ledger entries</h3>
                  <ul className="divide-y divide-border text-sm">
                    {data.ledger.map((e) => (
                      <li key={e.id} className="flex justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{e.label}</p>
                          <p className="truncate text-xs text-muted">
                            {formatDate(e.created_at, true)}
                            {e.description ? ` · ${e.description}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-semibold tabular-nums">{money(e.amount_micros, 4)}</p>
                          <p className="text-xs tabular-nums text-muted">{money(e.balance_after_micros)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
                {data.statusEvents.length ? (
                  <section>
                    <h3 className="mb-1.5 text-sm font-semibold text-ink">Status and limit changes</h3>
                    <ul className="space-y-1 text-xs text-muted">
                      {data.statusEvents.map((s) => (
                        <li key={s.id}>
                          {formatDate(s.created_at, true)} · {s.from_status} → {s.to_status} · {s.reason}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </TabsContent>

              <TabsContent value="usage" className="grid gap-4 sm:grid-cols-2">
                {[
                  ["AI features", data.aiUsage],
                  ["WhatsApp notices", data.whatsappUsage],
                ].map(([title, rows]) => (
                  <section key={title as string}>
                    <h3 className="mb-1.5 text-sm font-semibold text-ink">{title as string} (last 500)</h3>
                    {(rows as Detail["aiUsage"]).length === 0 ? (
                      <p className="text-sm text-muted">No usage yet.</p>
                    ) : (
                      <ul className="divide-y divide-border text-sm">
                        {(rows as Detail["aiUsage"]).map((row) => (
                          <li key={row.key} className="flex justify-between gap-3 py-1.5">
                            <span className="truncate">{row.key.replaceAll("_", " ")}</span>
                            <span className="shrink-0 tabular-nums text-muted">
                              {row.count} · {money(row.chargedMicros)}
                              {row.refused ? ` · ${row.refused} refused` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
