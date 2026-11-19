"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";

type OnlinePayment = {
  provider: "RAZORPAY" | "CASHFREE";
  status: "CREATED" | "FAILED" | "CANCELLED" | "PROCESSING" | "AUTHORIZED" | "PAID" | "REFUNDED";
  mode: "TEST" | "LIVE";
  kind: "FULL" | "COD_ADVANCE";
  amount: number;
  orderTotal: number;
  currency: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  method: string | null;
  failureReason: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  extraPaymentIds: string[];
  paidAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  lastReconciledAt: string | null;
};

const STATUS_LABEL: Record<OnlinePayment["status"], { badge: string; label: string }> = {
  CREATED: { badge: "PENDING", label: "Pending" },
  FAILED: { badge: "FAILED", label: "Failed" },
  CANCELLED: { badge: "PENDING", label: "Cancelled by customer" },
  PROCESSING: { badge: "WAITING", label: "Processing" },
  AUTHORIZED: { badge: "WAITING", label: "Authorized" },
  PAID: { badge: "PAID", label: "Paid" },
  REFUNDED: { badge: "REFUNDED", label: "Refunded" },
};

const METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  credit_card: "Credit card",
  debit_card: "Debit card",
  net_banking: "Net banking",
  cardless_emi: "Cardless EMI",
  pay_later: "Pay later",
  netbanking: "Net banking",
  wallet: "Wallet",
  emi: "EMI",
  paylater: "Pay later",
};

function rupees(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);
}

const GATEWAY: Record<OnlinePayment["provider"], string> = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" };

/** Verified payment for a storefront order, from the merchant's own Razorpay or Cashfree account. */
export function OnlinePaymentCard({ orderId, customerName }: { orderId: string; customerName?: string | null }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["orders", orderId, "online-payment"],
    queryFn: () => api<{ payment: OnlinePayment | null }>(`/api/v1/orders/${orderId}/online-payment`),
    retry: false,
  });
  const reconcile = useMutation({
    mutationFn: () => api<{ payment: OnlinePayment | null }>(`/api/v1/orders/${orderId}/online-payment/reconcile`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["orders", orderId, "online-payment"], data);
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      const gateway = data.payment ? GATEWAY[data.payment.provider] : "the gateway";
      toast.success(data.payment?.status === "PAID" ? `Payment confirmed with ${gateway}.` : `Checked with ${gateway}. No change.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const payment = query.data?.payment;
  if (!payment) return null;
  const status = STATUS_LABEL[payment.status];
  const open = ["CREATED", "FAILED", "CANCELLED", "PROCESSING", "AUTHORIZED"].includes(payment.status);
  const gateway = GATEWAY[payment.provider] ?? payment.provider;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 p-4">
        <CardTitle>Online payment · {gateway}</CardTitle>
        <div className="flex items-center gap-2">
          {payment.mode === "TEST" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Test</span> : null}
          <StatusBadge value={status.badge} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 text-sm">
        {payment.needsReview ? (
          <p role="alert" className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {payment.reviewReason ?? "Needs review."}
              {payment.extraPaymentIds.length ? ` Extra payment: ${payment.extraPaymentIds.join(", ")}.` : ""}
            </span>
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Customer</dt>
          <dd className="min-w-0 truncate text-right">{customerName || "—"}</dd>
          <dt className="text-muted">Amount</dt>
          <dd className="text-right font-semibold tabular-nums">
            {rupees(payment.amount)}
            {payment.kind === "COD_ADVANCE" ? <span className="block text-xs font-normal text-muted">COD advance of {rupees(payment.orderTotal)}</span> : null}
          </dd>
          <dt className="text-muted">Status</dt>
          <dd className="text-right">{status.label}</dd>
          <dt className="text-muted">Method</dt>
          <dd className="text-right">{payment.method ? METHOD_LABEL[payment.method] ?? payment.method : "—"}</dd>
          <dt className="text-muted">Transaction ID</dt>
          <dd className="min-w-0 break-all text-right font-mono text-xs">{payment.providerPaymentId ?? "—"}</dd>
          <dt className="text-muted">{gateway} order</dt>
          <dd className="min-w-0 break-all text-right font-mono text-xs">{payment.providerOrderId}</dd>
          <dt className="text-muted">{payment.status === "REFUNDED" ? "Refunded" : "Paid on"}</dt>
          <dd className="text-right">{formatDate(payment.status === "REFUNDED" ? payment.refundedAt : payment.paidAt, true)}</dd>
          {payment.failureReason && (payment.status === "FAILED" || payment.status === "CANCELLED") ? (
            <>
              <dt className="text-muted">Last failure</dt>
              <dd className="min-w-0 text-right text-xs">{payment.failureReason}</dd>
            </>
          ) : null}
        </dl>
        {open ? (
          <Button type="button" variant="secondary" size="sm" className="w-full" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            {reconcile.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
            Check status with {gateway}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
