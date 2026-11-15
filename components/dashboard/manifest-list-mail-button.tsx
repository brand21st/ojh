"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Mail, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/hooks/use-api";
import type { ManifestRecord } from "@/types/api";

const IN_FLIGHT = new Set(["PENDING", "QUEUED", "SENDING", "RETRYING"]);

export function ManifestListMailButton({
  row,
  canSend,
}: {
  row: ManifestRecord;
  canSend: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmResend, setConfirmResend] = useState(false);
  const closable = row.status === "CLOSED" || row.status === "HANDED_OVER";
  const alreadyAccepted = row.emailStatus === "SENT" || row.emailStatus === "UNKNOWN";
  const sending = IN_FLIGHT.has(row.emailStatus ?? "");
  const failed = row.emailStatus === "FAILED";

  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/manifests/${row.id}/email`, {
        method: "POST",
        body: JSON.stringify({ confirmResend: alreadyAccepted ? confirmResend : true }),
      }),
    onSuccess: () => {
      toast.success("Manifest email queued.");
      setOpen(false);
      setConfirmResend(false);
      queryClient.invalidateQueries({ queryKey: ["manifests"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retry = useMutation({
    mutationFn: () =>
      api(`/api/v1/manifests/${row.id}/email-deliveries/${row.emailDeliveryId}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Retry queued.");
      queryClient.invalidateQueries({ queryKey: ["manifests"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function openSend() {
    setConfirmResend(false);
    setOpen(true);
  }

  const showSend = canSend && closable && !sending && (!row.emailStatus || failed);
  const showRetry = canSend && closable && failed && row.emailRetryable && Boolean(row.emailDeliveryId);
  const showSendAgain = canSend && closable && alreadyAccepted;

  return (
    <div className="flex min-h-9 flex-col items-stretch gap-1" onClick={(event) => event.stopPropagation()}>
      {row.emailStatus === "SENT" ? (
        <span
          className="inline-flex min-h-8 items-center justify-center gap-1 rounded-full bg-success/15 px-2.5 text-xs font-semibold text-success"
          title="The mail server accepted this message."
        >
          <Check className="size-3.5" aria-hidden="true" />
          Sent
        </span>
      ) : null}

      {row.emailStatus === "UNKNOWN" ? (
        <span className="inline-flex min-h-8 items-center justify-center text-xs font-semibold text-amber-800">
          Needs review
        </span>
      ) : null}

      {sending ? (
        <span className="inline-flex min-h-8 items-center justify-center gap-1 text-xs font-medium text-muted" aria-busy="true">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Sending
        </span>
      ) : null}

      {failed ? (
        <span className="inline-flex min-h-8 items-center justify-center text-xs font-semibold text-red-700">Failed</span>
      ) : null}

      {showSendAgain ? (
        <Button type="button" variant="ghost" size="xs" className="h-8 min-h-8" onClick={openSend}>
          Send again
        </Button>
      ) : null}

      {showRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="h-8 min-h-8"
          disabled={retry.isPending}
          aria-busy={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      ) : null}

      {showSend && !showRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="h-8 min-h-8"
          disabled={send.isPending}
          aria-busy={send.isPending}
          onClick={openSend}
        >
          <Mail className="size-3.5" aria-hidden="true" />
          Send mail
        </Button>
      ) : null}

      {!closable ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="h-8 min-h-8"
          disabled
          title="Close the manifest before emailing it."
        >
          <Mail className="size-3.5" aria-hidden="true" />
          Send mail
        </Button>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send manifest email</DialogTitle>
            <DialogDescription>
              Sends the India Post Excel to the addresses saved in email settings. This does not book the shipments.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            Manifest {row.number ?? "draft"} · {row.shipmentCount} shipment{row.shipmentCount === 1 ? "" : "s"}
          </p>
          {alreadyAccepted ? (
            <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={confirmResend}
                onChange={(event) => setConfirmResend(event.target.checked)}
              />
              <span>A previous email was already accepted, or the result was unclear. Sending again delivers another copy.</span>
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={send.isPending || (alreadyAccepted && !confirmResend)}
              aria-busy={send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? "Sending…" : "Send mail"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
