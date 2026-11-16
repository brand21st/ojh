"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FixOrderDetailsForm, type SavePhase } from "@/components/orders/fix-order-details-form";
import { precheckOrderIds, tallyPrecheck } from "@/components/orders/booking-precheck";
import { ApiError, api } from "@/lib/hooks/use-api";
import { contactCorrectionFields, needsContactCorrection } from "@/modules/orders/contact-correction";
import type { AutomationSettings, PrebookingCheckResult, PrebookingOrderResult } from "@/types/api";

export function addressCheckLabel(status?: string | null, checking = false) {
  if (checking) return "Checking";
  switch (String(status ?? "").toUpperCase()) {
    case "READY":
      return "Checked";
    case "INVALID":
      return "Address error";
    case "NEEDS_REVIEW":
      return "Review required";
    case "VALIDATION_UNAVAILABLE":
      return "Check unavailable";
    default:
      return status ? "Not checked" : "";
  }
}

function replaceOrder(current: PrebookingCheckResult | null, next: PrebookingOrderResult[]) {
  const orders = current
    ? current.orders.map((order) => next.find((item) => item.orderId === order.orderId) ?? order)
    : next;
  return tallyPrecheck(orders);
}

export function PrebookingReviewDialog({
  open,
  onOpenChange,
  orderIds,
  onCheckingChange,
  allowAi: allowAiProp,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderIds: string[];
  onCheckingChange?: (orderIds: string[]) => void;
  allowAi?: boolean;
  seed?: PrebookingCheckResult | null;
}) {
  const queryClient = useQueryClient();
  const automation = useQuery({
    queryKey: ["automation"],
    queryFn: () => api<AutomationSettings>("/api/v1/automation"),
    enabled: open && allowAiProp === undefined,
  });
  const allowAi =
    allowAiProp ??
    automation.data?.autoAiAddressCheck ??
    automation.data?.auto_ai_address_check ??
    false;
  const [result, setResult] = useState<PrebookingCheckResult | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [phase, setPhase] = useState<SavePhase>("idle");
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      const seeded = seed?.orders.filter((order) => needsContactCorrection(order.issues)) ?? [];
      setPhase("idle");
      setFormError("");
      setConflict(false);
      if (seeded.length) {
        const visible = tallyPrecheck(seeded);
        setResult(visible);
        setActiveId(visible.orders[0]?.orderId ?? null);
      } else {
        setResult(null);
        setActiveId(null);
      }
    }
  }
  const ordersRef = useRef<PrebookingOrderResult[]>([]);
  const closeTimer = useRef<number | null>(null);
  useEffect(() => {
    ordersRef.current = result?.orders ?? [];
  }, [result]);
  useEffect(() => {
    if (open) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, [open]);

  async function runCheck(ids: string[]) {
    if (!ids.length) return null;
    onCheckingChange?.(ids);
    try {
      const next = await precheckOrderIds(ids, () => undefined, { allowAi, forceAi: false });
      const merged = replaceOrder(ids.length === orderIds.length ? null : result, next.orders);
      const visible = tallyPrecheck(merged.orders.filter((order) => needsContactCorrection(order.issues)));
      setResult(visible);
      return visible;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Address check failed.");
      return null;
    } finally {
      onCheckingChange?.([]);
    }
  }

  const seeded = Boolean(seed?.orders.some((order) => needsContactCorrection(order.issues)));
  const checking = open && !result && !seeded;

  useEffect(() => {
    if (!open || seeded) return;
    let cancelled = false;
    onCheckingChange?.(orderIds);
    void precheckOrderIds(orderIds, () => undefined, { allowAi, forceAi: false })
      .then((next) => {
        if (cancelled) return;
        const visible = tallyPrecheck(next.orders.filter((order) => needsContactCorrection(order.issues)));
        setResult(visible);
        setActiveId(visible.orders[0]?.orderId ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "Address check failed.");
      })
      .finally(() => {
        if (!cancelled) onCheckingChange?.([]);
      });
    return () => {
      cancelled = true;
    };
    // The selection captured when the dialog opens is the set to check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pending = (result?.orders ?? []).filter((order) => needsContactCorrection(order.issues));
  const active = pending.find((order) => order.orderId === activeId) ?? pending[0] ?? null;
  const fields = contactCorrectionFields(active?.issues ?? []);

  function selectOrder(order: PrebookingOrderResult) {
    setActiveId(order.orderId);
  }

  async function save(order: PrebookingOrderResult, phone: string, pincode: string) {
    if (phase !== "idle") return;
    setFormError("");
    setConflict(false);
    setPhase("saving");
    try {
      await api(`/api/v1/orders/${order.orderId}/address`, {
        method: "PATCH",
        body: JSON.stringify({
          correction: "phone_pin",
          ...(fields.phone ? { phone } : {}),
          ...(fields.pin ? { pincode } : {}),
          expectedFingerprint: order.fingerprint || undefined,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      const checked = await precheckOrderIds([order.orderId], () => undefined, { allowAi, forceAi: false });
      const updated = checked.orders[0];
      const still = updated ? needsContactCorrection(updated.issues) : true;
      const unavailable = updated ? contactCorrectionFields(updated.issues).pinUnavailable : false;
      if (still || unavailable) {
        setResult((current) => (updated ? replaceOrder(current, [updated]) : current));
        setPhase("idle");
        if (unavailable && !still) {
          setFormError("Saved. India Post PIN check is temporarily unavailable, so this order is not marked ready.");
        }
        return;
      }
      setPhase("success");
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => {
        const orders = ordersRef.current.filter((item) => item.orderId !== order.orderId);
        setResult(tallyPrecheck(orders));
        setPhase("idle");
        if (!orders.length) onOpenChange(false);
        else setActiveId(orders[0].orderId);
      }, 1000);
    } catch (error) {
      setPhase("idle");
      setConflict(error instanceof ApiError && error.status === 409);
      setFormError(error instanceof Error ? error.message : "Could not save the address.");
    }
  }

  function reload() {
    if (!active) return;
    setFormError("");
    void runCheck([active.orderId]).then((visible) => {
      const match = visible?.orders.find((order) => order.orderId === active.orderId);
      if (match) setActiveId(match.orderId);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-[28rem] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fix Order Details</DialogTitle>
          <DialogDescription>Please correct the highlighted details to continue.</DialogDescription>
        </DialogHeader>
        {checking && !active ? <p className="text-sm text-muted-foreground">Checking…</p> : null}
        {pending.length > 1 ? (
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {pending.map((order) => (
              <button
                key={order.orderId}
                type="button"
                className={`w-full rounded-lg border px-2 py-2 text-left text-sm ${order.orderId === active?.orderId ? "border-brand bg-surface-soft" : "border-border"}`}
                onClick={() => selectOrder(order)}
              >
                #{order.orderNumber || order.orderId.slice(0, 8)} · {order.customerName || "Customer"}
              </button>
            ))}
          </div>
        ) : null}
        {active ? (
          <FixOrderDetailsForm
            key={`${active.orderId}:${active.fingerprint}`}
            orderNumber={active.orderNumber || active.orderId.slice(0, 8)}
            customerName={active.customerName || "Customer"}
            showPhone={fields.phone}
            showPin={fields.pin}
            stateChoice={fields.stateChoice}
            pinUnavailable={fields.pinUnavailable}
            orderHref={`/dashboard/orders/${active.orderId}`}
            initialPhone={active.address.phone || ""}
            initialPin={active.address.pincode || ""}
            formError={formError}
            phase={phase}
            onSave={(phone, pincode) => void save(active, phone, pincode)}
          />
        ) : checking ? null : (
          <p className="text-sm text-muted-foreground">No mobile number or PIN code needs a correction.</p>
        )}
        {conflict && active ? (
          <button type="button" className="text-sm font-medium text-brand" onClick={reload}>
            Reload
          </button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
