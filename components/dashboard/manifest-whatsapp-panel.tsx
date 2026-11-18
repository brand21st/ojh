"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";
import { isIndiaWhatsappInput, toIndiaWhatsappE164 } from "@/lib/phone/india-whatsapp";

type Delivery = {
  id: string;
  recipient: string;
  recipientName: string | null;
  status: string;
  retryable: boolean;
  lastError: string | null;
  filename: string;
  createdAt: string;
  triggerType: "AUTO" | "MANUAL";
  batchIndex: number;
  batchCount: number;
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  QUEUED: "Queued",
  SENDING: "Sending",
  ACCEPTED: "Accepted",
  SENT: "Sent",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  RETRYING: "Retrying",
  CANCELLED: "Cancelled",
  UNKNOWN: "Needs review",
};

export function ManifestWhatsAppPanel({
  manifestId,
  manifestNumber,
  merchantName,
  shipmentCount,
  filenameHint,
  canSend,
  officeId,
}: {
  manifestId: string;
  manifestNumber: string;
  merchantName: string;
  shipmentCount: number;
  filenameHint: string;
  canSend: boolean;
  officeId: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState<{ e164: string; name: string | null }[]>([]);
  const [draft, setDraft] = useState("");
  const [confirmResend, setConfirmResend] = useState(false);
  const history = useQuery({
    queryKey: ["manifest-whatsapp", manifestId],
    queryFn: () => api<Delivery[]>(`/api/v1/manifests/${manifestId}/whatsapp-deliveries`),
  });
  const priorCopy = (history.data ?? []).some((row) =>
    ["ACCEPTED", "SENT", "DELIVERED", "UNKNOWN"].includes(row.status)
  );

  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/manifests/${manifestId}/whatsapp`, {
        method: "POST",
        body: JSON.stringify({ recipients, confirmResend: confirmResend || !priorCopy }),
      }),
    onSuccess: () => {
      toast.success("Manifest WhatsApp queued.");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["manifest-whatsapp", manifestId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retry = useMutation({
    mutationFn: (deliveryId: string) =>
      api(`/api/v1/manifests/${manifestId}/whatsapp-deliveries/${deliveryId}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Retry queued.");
      queryClient.invalidateQueries({ queryKey: ["manifest-whatsapp", manifestId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function openDialog() {
    setConfirmResend(false);
    setDraft("");
    try {
      const settings = await api<{
        recipients: { e164: string; name: string | null }[];
        officeOverrides: Record<string, { e164: string; name: string | null }[]>;
      }>("/api/v1/manifests/whatsapp-settings");
      const officeKey = officeId?.trim() || "";
      const custom = officeKey && Object.prototype.hasOwnProperty.call(settings.officeOverrides, officeKey);
      setRecipients(custom ? settings.officeOverrides[officeKey] ?? [] : settings.recipients);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not load WhatsApp recipients.");
      setRecipients([]);
    }
    setOpen(true);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="size-4 text-brand" />
            WhatsApp history
            <Badge variant="brand">Powered by Vachat</Badge>
          </CardTitle>
          <CardDescription>
            Delivered is recorded only after WhatsApp confirms receipt. Accepted means Vachat took the message.
          </CardDescription>
        </div>
        {canSend ? (
          <Button type="button" variant="secondary" onClick={() => void openDialog()}>
            Send manifest via WhatsApp
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {history.isLoading ? <p className="text-sm text-muted">Loading WhatsApp history…</p> : null}
        {history.isError ? <p className="text-sm text-red-700">{(history.error as Error).message}</p> : null}
        {history.data && !history.data.length ? (
          <p className="text-sm text-muted">No WhatsApp messages have been sent for this manifest.</p>
        ) : null}
        {history.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Recipient</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="py-3 pr-3">{formatDate(row.createdAt, true)}</td>
                    <td className="py-3 pr-3">
                      {row.recipientName || row.recipient}
                      <span className="mt-1 block text-xs text-muted">{row.recipient}</span>
                    </td>
                    <td className="py-3 pr-3">
                      {STATUS_LABEL[row.status] ?? row.status}
                      {row.lastError ? <span className="mt-1 block text-xs text-muted">{row.lastError}</span> : null}
                    </td>
                    <td className="py-3">
                      {canSend && (row.status === "FAILED" || row.status === "RETRYING") && row.retryable ? (
                        <Button type="button" variant="secondary" className="h-8" disabled={retry.isPending} onClick={() => retry.mutate(row.id)}>
                          Retry
                        </Button>
                      ) : canSend && ["ACCEPTED", "SENT", "DELIVERED", "UNKNOWN"].includes(row.status) ? (
                        <Button type="button" variant="secondary" className="h-8" onClick={() => void openDialog()}>
                          Send again
                        </Button>
                      ) : (
                        <span className="text-xs text-muted">{row.triggerType === "AUTO" ? "Automatic" : "Manual"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send India Post manifest on WhatsApp</DialogTitle>
            <DialogDescription>
              This sends the India Post Excel file through Vachat. It does not book the shipments with India Post.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p>
              <span className="text-muted">Manifest: </span>
              {manifestNumber}
            </p>
            <p>
              <span className="text-muted">Merchant: </span>
              {merchantName}
            </p>
            <p>
              <span className="text-muted">Shipments: </span>
              {shipmentCount}
            </p>
            <p>
              <span className="text-muted">Attachment: </span>
              {filenameHint}
            </p>
            <div className="grid gap-2">
              <p className="text-muted">Recipients</p>
              <ul className="grid gap-1">
                {recipients.map((item) => (
                  <li key={item.e164} className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.name ? `${item.name} · ${item.e164}` : item.e164}</span>
                    <button
                      type="button"
                      className="text-xs text-muted hover:text-foreground"
                      onClick={() => setRecipients(recipients.filter((row) => row.e164 !== item.e164))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input
                  inputMode="tel"
                  value={draft}
                  placeholder="Add a 10-digit Indian mobile"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (!isIndiaWhatsappInput(draft)) return;
                    const e164 = toIndiaWhatsappE164(draft);
                    if (recipients.some((item) => item.e164 === e164)) return;
                    setRecipients([...recipients, { e164, name: null }]);
                    setDraft("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            {priorCopy ? (
              <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950">
                <input type="checkbox" className="mt-1" checked={confirmResend} onChange={(event) => setConfirmResend(event.target.checked)} />
                <span>A previous WhatsApp message was already accepted, or the result was unclear. Sending again delivers another copy.</span>
              </label>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={send.isPending || history.isLoading || !recipients.length || (priorCopy && !confirmResend)}
              onClick={() => send.mutate()}
            >
              {send.isPending ? "Sending…" : "Send WhatsApp"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
