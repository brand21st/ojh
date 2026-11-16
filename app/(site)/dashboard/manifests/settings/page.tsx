"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { toast } from "sonner";
import { EmailList } from "@/components/dashboard/manifest-email-recipients";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { hasPermission } from "@/lib/permissions/rbac";
import type { MemberRole } from "@/types/domain";

type Settings = {
  autoSendEnabled: boolean;
  recipients: string[];
  officeOverrides: Record<string, string[]>;
  replyTo: string | null;
  ccRecipients: string[];
  offices: { id: string; name: string }[];
  deliveryEnabled: boolean;
  maxRecipients: number;
  trigger: string;
  attachment: string;
};

export default function ManifestEmailSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = hasPermission((me.data?.role ?? "VIEWER") as MemberRole, "automation.manage");
  const query = useQuery({
    queryKey: ["manifest-email-settings"],
    queryFn: () => api<Settings>("/api/v1/manifests/email-settings"),
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  const settings = draft ?? query.data ?? null;

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
    <div className="space-y-6">
      <Link href="/dashboard/manifests" className="text-sm text-muted hover:text-foreground">
        Manifests
      </Link>
      <PageHeader
        title="Manifest email"
        description="Send the India Post Excel file to your booking office when a manifest is closed. Automatic sending stays off until you turn it on."
      />
      {!query.data && query.isLoading ? <Skeleton className="h-80 w-full" /> : null}
      {query.isError ? <p className="text-sm text-red-700">{(query.error as Error).message}</p> : null}
      {settings ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="size-4 text-brand" />
              Manifest email automation
            </CardTitle>
            <CardDescription>
              The email contains customer shipment details. PostBus sends it from the platform mail server and does not book the articles.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {settings.deliveryEnabled ? null : (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Email delivery is turned off on this server. You can save recipients now. Messages will not be sent until delivery is enabled.
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Automatically email manifest</p>
                <p className="text-sm text-muted">Sends once, after the manifest is closed. Adding a shipment to a draft does not send mail.</p>
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
            <div className="grid gap-4">
              <div>
                <p className="text-sm font-medium">Booking office recipients</p>
                <p className="text-sm text-muted">
                  Leave an office off this list to use the default recipients. An office with its own list never uses the default, even when that list is empty.
                </p>
              </div>
              {settings.offices.length ? (
                settings.offices.map((office) => {
                  const custom = Object.prototype.hasOwnProperty.call(settings.officeOverrides, office.id);
                  return (
                    <div key={office.id} className="grid gap-3 rounded-xl border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{office.name || office.id}</p>
                          <p className="text-xs text-muted">{office.id}</p>
                        </div>
                        <Switch
                          checked={custom}
                          disabled={!canManage || save.isPending}
                          aria-label={`Custom recipients for ${office.name || office.id}`}
                          onCheckedChange={(checked) => {
                            const officeOverrides = { ...settings.officeOverrides };
                            if (checked) officeOverrides[office.id] = officeOverrides[office.id] ?? [];
                            else delete officeOverrides[office.id];
                            setDraft({ ...settings, officeOverrides });
                          }}
                        />
                      </div>
                      {custom ? (
                        <EmailList
                          label={`Recipients for ${office.name || office.id}`}
                          emails={settings.officeOverrides[office.id] ?? []}
                          disabled={!canManage || save.isPending}
                          max={settings.maxRecipients}
                          onChange={(emails) =>
                            setDraft({
                              ...settings,
                              officeOverrides: { ...settings.officeOverrides, [office.id]: emails },
                            })
                          }
                        />
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-muted">Office-specific lists appear after a manifest has a booking office.</p>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="manifest-reply-to">Reply-To (optional)</Label>
                <Input
                  id="manifest-reply-to"
                  type="email"
                  value={settings.replyTo ?? ""}
                  disabled={!canManage || save.isPending}
                  placeholder="store@example.com"
                  onChange={(event) => setDraft({ ...settings, replyTo: event.target.value })}
                />
                <p className="text-xs text-muted">Replies go to this address. The From address stays PostBus.</p>
              </div>
              <div className="grid gap-1.5">
                <p className="text-sm font-medium">Send trigger</p>
                <p className="text-sm">{settings.trigger}</p>
                <p className="text-sm font-medium">Email attachment</p>
                <p className="text-sm">{settings.attachment}</p>
              </div>
            </div>
            <EmailList
              label="CC (optional)"
              emails={settings.ccRecipients}
              disabled={!canManage || save.isPending}
              max={3}
              onChange={(ccRecipients) => setDraft({ ...settings, ccRecipients })}
            />
            {!canManage ? <p className="text-sm text-muted">Only an owner, admin, or manager can change these settings.</p> : null}
            <div>
              <Button type="button" disabled={!canManage || save.isPending} onClick={() => save.mutate(settings)}>
                {save.isPending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
