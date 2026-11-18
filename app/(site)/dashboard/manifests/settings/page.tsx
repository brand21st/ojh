"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { EmailList } from "@/components/dashboard/manifest-email-recipients";
import { WhatsAppRecipientList } from "@/components/dashboard/manifest-whatsapp-recipients";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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

type WhatsAppSettings = {
  autoSendEnabled: boolean;
  recipients: { e164: string; name: string | null }[];
  officeOverrides: Record<string, { e164: string; name: string | null }[]>;
  offices: { id: string; name: string }[];
  deliveryEnabled: boolean;
  sessionDocumentsEnabled: boolean;
  templateConfigured: boolean;
  maxRecipients: number;
  maxFilesPerBatch: number;
  lastStatus: string | null;
  lastSentAt: string | null;
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

  const whatsappQuery = useQuery({
    queryKey: ["manifest-whatsapp-settings"],
    queryFn: () => api<WhatsAppSettings>("/api/v1/manifests/whatsapp-settings"),
  });
  const [whatsappDraft, setWhatsappDraft] = useState<WhatsAppSettings | null>(null);
  const whatsapp = whatsappDraft ?? whatsappQuery.data ?? null;

  const saveWhatsApp = useMutation({
    mutationFn: (body: WhatsAppSettings) =>
      api<WhatsAppSettings>("/api/v1/manifests/whatsapp-settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoSendEnabled: body.autoSendEnabled,
          recipients: body.recipients,
          officeOverrides: body.officeOverrides,
        }),
      }),
    onSuccess: (saved) => {
      setWhatsappDraft(null);
      queryClient.setQueryData(["manifest-whatsapp-settings"], saved);
      toast.success("Manifest WhatsApp settings saved.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const testWhatsApp = useMutation({
    mutationFn: () => api("/api/v1/manifests/whatsapp-settings/test", { method: "POST" }),
    onSuccess: () => toast.success("Vachat connection is working."),
    onError: (error: Error) => toast.error(error.message),
  });

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
                  Leave an office off this list to use the default recipients as To:. An office with its own list is the To: line. Default addresses that are not on that list are still CC'd. An empty office list means no email for that office.
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
                            if (checked) officeOverrides[office.id] = officeOverrides[office.id] ?? [...settings.recipients];
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

      {!whatsappQuery.data && whatsappQuery.isLoading ? <Skeleton className="h-80 w-full" /> : null}
      {whatsappQuery.isError ? <p className="text-sm text-red-700">{(whatsappQuery.error as Error).message}</p> : null}
      {whatsapp ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <MessageCircle className="size-4 text-brand" />
              Automated WhatsApp delivery
              <Badge variant="brand">Powered by Vachat</Badge>
            </CardTitle>
            <CardDescription>
              Send the same India Post Excel file on WhatsApp after a manifest is closed. Email automation is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {whatsapp.deliveryEnabled ? null : (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                WhatsApp delivery is turned off on this server. You can save recipients now. Messages will not be sent until delivery is enabled.
              </p>
            )}
            {whatsapp.templateConfigured || whatsapp.sessionDocumentsEnabled ? null : (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Direct Excel documents are not sent until an approved Vachat utility template is configured, or an authorized session-document test flag is on.
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Automatically send manifest on WhatsApp</p>
                <p className="text-sm text-muted">
                  Status: {whatsapp.autoSendEnabled ? "On" : "Off"}. Sends once after the manifest is closed.
                </p>
              </div>
              <Switch
                checked={whatsapp.autoSendEnabled}
                disabled={!canManage || saveWhatsApp.isPending}
                aria-label="Automatically send manifest on WhatsApp"
                onCheckedChange={(checked) => setWhatsappDraft({ ...whatsapp, autoSendEnabled: checked })}
              />
            </div>
            <WhatsAppRecipientList
              label="WhatsApp recipients"
              recipients={whatsapp.recipients}
              disabled={!canManage || saveWhatsApp.isPending}
              max={whatsapp.maxRecipients}
              onChange={(recipients) => setWhatsappDraft({ ...whatsapp, recipients })}
            />
            <div className="grid gap-4">
              <div>
                <p className="text-sm font-medium">Booking office recipients</p>
                <p className="text-sm text-muted">
                  Leave an office off this list to use the default numbers. An office with its own list replaces the default. An empty office list means no WhatsApp for that office.
                </p>
              </div>
              {whatsapp.offices.length ? (
                whatsapp.offices.map((office) => {
                  const custom = Object.prototype.hasOwnProperty.call(whatsapp.officeOverrides, office.id);
                  return (
                    <div key={office.id} className="grid gap-3 rounded-xl border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{office.name || office.id}</p>
                          <p className="text-xs text-muted">{office.id}</p>
                        </div>
                        <Switch
                          checked={custom}
                          disabled={!canManage || saveWhatsApp.isPending}
                          aria-label={`Custom WhatsApp recipients for ${office.name || office.id}`}
                          onCheckedChange={(checked) => {
                            const officeOverrides = { ...whatsapp.officeOverrides };
                            if (checked) officeOverrides[office.id] = officeOverrides[office.id] ?? [...whatsapp.recipients];
                            else delete officeOverrides[office.id];
                            setWhatsappDraft({ ...whatsapp, officeOverrides });
                          }}
                        />
                      </div>
                      {custom ? (
                        <WhatsAppRecipientList
                          label={`WhatsApp numbers for ${office.name || office.id}`}
                          recipients={whatsapp.officeOverrides[office.id] ?? []}
                          disabled={!canManage || saveWhatsApp.isPending}
                          max={whatsapp.maxRecipients}
                          onChange={(recipients) =>
                            setWhatsappDraft({
                              ...whatsapp,
                              officeOverrides: { ...whatsapp.officeOverrides, [office.id]: recipients },
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
            <div className="grid gap-1.5 text-sm">
              <p className="font-medium">Delivery configuration</p>
              <p>Trigger: {whatsapp.trigger}</p>
              <p>Attachment: {whatsapp.attachment}</p>
              <p>Maximum files per logical batch: {whatsapp.maxFilesPerBatch}</p>
              <p>Last delivery status: {whatsapp.lastStatus ?? "None"}</p>
              <p>Last sent: {whatsapp.lastSentAt ? new Date(whatsapp.lastSentAt).toLocaleString() : "Never"}</p>
            </div>
            {!canManage ? <p className="text-sm text-muted">Only an owner, admin, or manager can change these settings.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!canManage || saveWhatsApp.isPending} onClick={() => saveWhatsApp.mutate(whatsapp)}>
                {saveWhatsApp.isPending ? "Saving…" : "Save settings"}
              </Button>
              <Button type="button" variant="secondary" disabled={!canManage || testWhatsApp.isPending} onClick={() => testWhatsApp.mutate()}>
                {testWhatsApp.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Link href="/dashboard/manifests" className={buttonVariants({ variant: "secondary" })}>
                View delivery history
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
