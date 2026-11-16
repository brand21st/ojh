"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { toast } from "sonner";
import { EmailList } from "@/components/dashboard/manifest-email-recipients";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { hasPermission } from "@/lib/permissions/rbac";
import { withBookingOfficeRecipients } from "@/modules/manifest-email/recipients";
import type { MemberRole } from "@/types/domain";

const CARD = "flex h-full flex-col";
const CARD_HEADER = "gap-1.5 p-5 pb-4 sm:p-6 sm:pb-4";
const CARD_CONTENT = "flex-1 px-5 pb-5 sm:px-6 sm:pb-6";
const CARD_FOOTER =
  "mt-auto flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-border bg-surface-soft/40 px-5 py-2.5 sm:px-6";

type Settings = {
  autoSendEnabled: boolean;
  recipients: string[];
  officeOverrides: Record<string, string[]>;
  replyTo: string | null;
  ccRecipients: string[];
  deliveryEnabled: boolean;
  maxRecipients: number;
};

export function IndiaPostManifestEmailSetup({
  officeId,
  officeName,
}: {
  officeId: string;
  officeName: string;
}) {
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = hasPermission((me.data?.role ?? "VIEWER") as MemberRole, "automation.manage");
  const query = useQuery({
    queryKey: ["manifest-email-settings"],
    queryFn: () => api<Settings>("/api/v1/manifests/email-settings"),
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  const settings = draft ?? query.data ?? null;
  const savedOfficeKey = officeId.trim();
  const keepEmptyOffice = Boolean(
    savedOfficeKey &&
      query.data &&
      Object.prototype.hasOwnProperty.call(query.data.officeOverrides, savedOfficeKey)
  );

  const save = useMutation({
    mutationFn: (body: Settings) =>
      api<Settings>("/api/v1/manifests/email-settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoSendEnabled: body.autoSendEnabled,
          recipients: body.recipients,
          officeOverrides: body.officeOverrides,
          replyTo: body.replyTo,
          ccRecipients: body.ccRecipients,
        }),
      }),
    onSuccess: (saved) => {
      setDraft(null);
      queryClient.setQueryData(["manifest-email-settings"], saved);
      toast.success("Manifest email settings saved.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card className={CARD}>
      <CardHeader className={CARD_HEADER}>
        <CardTitle as="h2" className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold tabular-nums text-brand"
          >
            7
          </span>
          <Mail className="size-4 text-brand" aria-hidden="true" />
          Manifest email
        </CardTitle>
        <CardDescription>
          Send the India Post Excel file to your booking office when a manifest is closed. Automatic sending stays off until you turn it on.
        </CardDescription>
      </CardHeader>
      <CardContent className={`${CARD_CONTENT} space-y-3`}>
        {!query.data && query.isLoading ? <Skeleton className="h-40 w-full" /> : null}
        {query.isError ? <p className="text-sm text-red-700">{(query.error as Error).message}</p> : null}
        {settings ? (
          <>
            {settings.deliveryEnabled ? null : (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Email delivery is turned off on this server. You can save recipients now. Messages will not be sent until delivery is enabled.
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Automatically email manifest</p>
                <p className="text-sm text-muted">
                  Sends once, after the manifest is closed. Adding a shipment to a draft does not send mail.
                </p>
              </div>
              <Switch
                checked={settings.autoSendEnabled}
                disabled={!canManage || save.isPending}
                aria-label="Automatically email manifest"
                onCheckedChange={(checked) => setDraft({ ...settings, autoSendEnabled: checked })}
              />
            </div>
            <EmailList
              label="India Post email recipients"
              emails={settings.recipients}
              disabled={!canManage || save.isPending}
              max={settings.maxRecipients}
              onChange={(recipients) => setDraft({ ...settings, recipients })}
            />
            {savedOfficeKey ? (
              <div className="space-y-2 rounded-xl border border-border p-3">
                <div>
                  <p className="text-sm font-medium">This booking office</p>
                  <p className="text-xs text-muted">
                    {officeName || "Drop-off office"} · {savedOfficeKey}. Add this office&apos;s mailbox here. Leave it blank to keep using the default recipients.
                  </p>
                </div>
                <EmailList
                  label="Booking office recipients"
                  emails={settings.officeOverrides[savedOfficeKey] ?? []}
                  disabled={!canManage || save.isPending}
                  max={settings.maxRecipients}
                  onChange={(emails) =>
                    setDraft({
                      ...settings,
                      officeOverrides: withBookingOfficeRecipients(
                        settings.officeOverrides,
                        savedOfficeKey,
                        emails,
                        keepEmptyOffice
                      ),
                    })
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-muted">
                Save a drop-off office first. Until then, closed manifests use the default recipients above.
              </p>
            )}
            {!canManage ? (
              <p className="text-sm text-muted">Only an owner, admin, or manager can change these settings.</p>
            ) : null}
          </>
        ) : null}
      </CardContent>
      <CardFooter className={CARD_FOOTER}>
        <Button
          type="button"
          size="sm"
          disabled={!canManage || !settings || save.isPending}
          onClick={() => settings && save.mutate(settings)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Link href="/dashboard/manifests/settings" className="text-sm text-brand underline-offset-2 hover:underline">
          Reply-To, CC, and other offices
        </Link>
      </CardFooter>
    </Card>
  );
}
