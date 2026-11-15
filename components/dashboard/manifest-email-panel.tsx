"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
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
import { api, ApiError } from "@/lib/hooks/use-api";
import { formatDate } from "@/lib/format";

type Delivery = {
  id: string;
  recipients: string[];
  status: string;
  retryable: boolean;
  lastError: string | null;
  filename: string;
  subject: string;
  createdAt: string;
  triggerType: "AUTO" | "MANUAL";
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Failed",
  RETRYING: "Retrying",
  CANCELLED: "Cancelled",
  UNKNOWN: "Needs review",
};

export function ManifestEmailPanel({
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
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [confirmResend, setConfirmResend] = useState(false);
  const history = useQuery({
    queryKey: ["manifest-email", manifestId],
    queryFn: () => api<Delivery[]>(`/api/v1/manifests/${manifestId}/email-deliveries`),
  });
  const priorCopy = (history.data ?? []).some((row) => row.status === "SENT" || row.status === "UNKNOWN");

  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/manifests/${manifestId}/email`, {
        method: "POST",
        body: JSON.stringify({ recipients, confirmResend: confirmResend || !priorCopy }),
      }),
    onSuccess: () => {
      toast.success("Manifest email queued.");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["manifest-email", manifestId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const retry = useMutation({
    mutationFn: (deliveryId: string) => api(`/api/v1/manifests/${manifestId}/email-deliveries/${deliveryId}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Retry queued.");
      queryClient.invalidateQueries({ queryKey: ["manifest-email", manifestId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function openDialog() {
    setConfirmResend(false);
    setDraft("");
    try {
      const settings = await api<{ recipients: string[]; officeOverrides: Record<string, string[]> }>(
        "/api/v1/manifests/email-settings"
      );
      const officeKey = officeId?.trim() || "";
      const custom = officeKey && Object.prototype.hasOwnProperty.call(settings.officeOverrides, officeKey);
      setRecipients(custom ? settings.officeOverrides[officeKey] ?? [] : settings.recipients);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not load recipients.");
      setRecipients([]);
    }
    setOpen(true);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4 text-brand" />
            Email history
          </CardTitle>
          <CardDescription>
            Sent means the mail server accepted the message. It does not mean India Post has booked or received the shipments.
          </CardDescription>
        </div>
        {canSend ? (
          <Button type="button" variant="secondary" onClick={() => void openDialog()}>
            Send manifest via email
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {history.isLoading ? <p className="text-sm text-muted">Loading email history…</p> : null}
        {history.isError ? <p className="text-sm text-red-700">{(history.error as Error).message}</p> : null}
        {history.data && !history.data.length ? <p className="text-sm text-muted">No emails have been sent for this manifest.</p> : null}
        {history.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Recipients</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="py-3 pr-3">{formatDate(row.createdAt, true)}</td>
                    <td className="py-3 pr-3">
                      {row.recipients.length} recipient{row.recipients.length === 1 ? "" : "s"}
                      <span className="mt-1 block text-xs text-muted">{row.recipients.join(", ")}</span>
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
                      ) : canSend && (row.status === "SENT" || row.status === "UNKNOWN") ? (
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
            <DialogTitle>Send India Post manifest</DialogTitle>
            <DialogDescription>
              This email contains customer shipment details. It submits the Excel file to the addresses below. It does not book the shipments with India Post.
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
                {recipients.map((email) => (
                  <li key={email} className="flex items-center justify-between gap-2">
                    <span className="truncate">{email}</span>
                    <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setRecipients(recipients.filter((item) => item !== email))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input
                  type="email"
                  value={draft}
                  placeholder="Add an email address"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const email = draft.trim().toLowerCase();
                    if (!looksLikeEmail(email) || recipients.includes(email)) return;
                    setRecipients([...recipients, email]);
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
                <span>A previous email was already accepted, or the result was unclear. Sending again delivers another copy.</span>
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
              {send.isPending ? "Sending…" : "Send email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
