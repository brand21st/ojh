"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/hooks/use-api";
import { formatBasisPoints, formatPaiseInr } from "@/modules/affiliates/policy";

export type Row = Record<string, unknown>;

export const inr = (value: unknown) => formatPaiseInr(value ?? 0);
export const pct = (bp: unknown) => formatBasisPoints(Number(bp ?? 0));
export const str = (value: unknown, fallback = "—") => (value == null || value === "" ? fallback : String(value));
export const shortId = (value: unknown) => String(value ?? "").slice(0, 8);
export const app = (row: Row) => (row.application || {}) as Record<string, unknown>;

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "brand" | "default"> = {
  APPROVED: "success",
  PAID: "success",
  PAYABLE: "success",
  PENDING: "warning",
  REQUESTED: "warning",
  REVIEW: "warning",
  REJECTED: "error",
  REVERSED: "error",
  SUSPENDED: "default",
  RETURNED: "default",
  PROCESSING: "brand",
  FAILED: "error",
  SENT: "success",
  SENDING: "brand",
  SKIPPED: "default",
};

export function StatusPill({ status }: { status: unknown }) {
  const s = String(status ?? "").toUpperCase();
  const label = s ? s.charAt(0) + s.slice(1).toLowerCase() : "—";
  return <Badge variant={STATUS_TONE[s] ?? "outline"}>{label}</Badge>;
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <span>{label}</span>
        {icon}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export type ActionField = {
  name: string;
  label: string;
  type?: "text" | "select" | "textarea";
  inputMode?: "decimal" | "numeric" | "text";
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
  defaultValue?: string;
  placeholder?: string;
};

/** One audited admin mutation: optional fields, a reason and the admin action PIN. */
export type PendingAction = {
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  /** Path under /api/admin/affiliates, e.g. `actions/<partnerId>` or `payouts/<id>`. */
  path: string;
  fields?: ActionField[];
  /** Return the request data, or a string error message to show instead of submitting. */
  build: (values: Record<string, string>) => Row | string;
  reasonLabel?: string;
  reasonDefault?: string;
  successMessage?: string;
  /** Optional second audited call sent with the same PIN and reason after the first succeeds. */
  followUp?: (values: Record<string, string>) => { path: string; data: Row } | null;
  onDone?: (result: unknown) => void;
};

export function ActionDialog({ action, onClose }: { action: PendingAction | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      {action ? <ActionDialogBody key={action.title + action.path} action={action} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ActionDialogBody({ action, onClose }: { action: PendingAction; onClose: () => void }) {
  const client = useQueryClient();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: async ({ pin, data, values }: { pin: string; data: Row; values: Record<string, string> }) => {
      const post = (path: string, body: Row) =>
        api<unknown>(`/api/admin/affiliates/${path}`, { method: "POST", body: JSON.stringify({ pin, data: { ...body, reason: values.__reason } }) });
      const result = await post(action.path, data);
      const next = action.followUp?.(values);
      if (next) await post(next.path, next.data);
      return result;
    },
    retry: false,
    onSuccess: (result) => {
      toast.success(action.successMessage ?? "Saved.");
      void client.invalidateQueries({ queryKey: ["admin-affiliates"] });
      action.onDone?.(result);
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Something went wrong."),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{action.title}</DialogTitle>
        {action.description ? <DialogDescription>{action.description}</DialogDescription> : null}
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          const values = Object.fromEntries(
            [...new FormData(event.currentTarget).entries()].map(([k, v]) => [k, String(v).trim()])
          );
          const data = action.build(values);
          if (typeof data === "string") return setError(data);
          mutation.mutate({ pin: values.__pin, data, values });
        }}
      >
        {action.fields?.map((field) => (
          <label key={field.name} className="block space-y-1.5 text-sm">
            <span className="font-medium text-ink">{field.label}</span>
            {field.type === "select" ? (
              <select
                name={field.name}
                defaultValue={field.defaultValue}
                className="flex h-11 w-full rounded-[var(--radius-input)] border border-border bg-card px-3 text-sm"
              >
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <Textarea name={field.name} defaultValue={field.defaultValue} required={field.required !== false} placeholder={field.placeholder} />
            ) : (
              <Input
                name={field.name}
                defaultValue={field.defaultValue}
                inputMode={field.inputMode}
                required={field.required !== false}
                placeholder={field.placeholder}
              />
            )}
            {field.help ? <span className="block text-xs text-muted">{field.help}</span> : null}
          </label>
        ))}
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">{action.reasonLabel ?? "Reason"}</span>
          <Textarea name="__reason" required minLength={3} maxLength={500} defaultValue={action.reasonDefault} placeholder="Kept in the audit log" />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-ink">Admin action PIN</span>
          <Input name="__pin" type="password" autoComplete="off" required />
        </label>
        {error ? (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending}
            className={action.danger ? "bg-red-600 hover:bg-red-700" : undefined}
          >
            {mutation.isPending ? "Saving…" : action.confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
