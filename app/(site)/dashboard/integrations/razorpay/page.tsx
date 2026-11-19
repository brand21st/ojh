"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, Copy, Loader2, ShieldCheck, Unplug } from "lucide-react";
import { RazorpayLogo } from "@/components/brand/razorpay-logo";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { GATEWAY_QUERY_KEY, PaymentGatewayDefault } from "@/components/integrations/payment-gateway-default";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";

type Mode = "TEST" | "LIVE";
type Status = "NOT_CONNECTED" | "CONNECTED" | "VERIFICATION_FAILED" | "CONFIGURATION_REQUIRED";
type IntegrationView = {
  provider: "RAZORPAY";
  status: Status;
  enabled: boolean;
  mode: Mode;
  keyIdHint: string | null;
  hasKeySecret: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
  webhookEvents: string[];
  lastVerifiedAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  available: boolean;
};

const STATUS_COPY: Record<Status, string> = {
  NOT_CONNECTED: "Not connected",
  CONNECTED: "Connected",
  VERIFICATION_FAILED: "Verification failed",
  CONFIGURATION_REQUIRED: "Configuration required",
};

const QUERY_KEY = ["integrations", "razorpay"];

export default function RazorpayIntegrationPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => api<IntegrationView>("/api/v1/integrations/razorpay") });
  const view = query.data;
  const connected = Boolean(view?.keyIdHint);

  const [editing, setEditing] = useState(false);
  const [modeChoice, setMode] = useState<Mode | null>(null);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const mode: Mode = modeChoice ?? view?.mode ?? "TEST";

  const showForm = !connected || editing;

  function resetForm() {
    setKeyId("");
    setKeySecret("");
    setWebhookSecret("");
    setMode(null);
    setEditing(false);
  }

  function update(next: IntegrationView) {
    queryClient.setQueryData(QUERY_KEY, next);
    void queryClient.invalidateQueries({ queryKey: ["integrations"], exact: true });
    void queryClient.invalidateQueries({ queryKey: GATEWAY_QUERY_KEY });
  }

  const save = useMutation({
    mutationFn: () =>
      api<IntegrationView>("/api/v1/integrations/razorpay", {
        method: "PUT",
        body: JSON.stringify({
          mode,
          keyId: keyId.trim() || null,
          keySecret: keySecret.trim() || null,
          webhookSecret: webhookSecret.trim() || null,
        }),
      }),
    onSuccess: (next) => {
      update(next);
      resetForm();
      toast.success(next.status === "CONNECTED" ? "Razorpay connected and verified." : "Keys verified. Add the webhook secret to finish.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const verify = useMutation({
    mutationFn: () => api<IntegrationView & { verified: boolean }>("/api/v1/integrations/razorpay/verify", { method: "POST" }),
    onSuccess: (next) => {
      update(next);
      if (next.verified) toast.success("Razorpay accepted your keys.");
      else toast.error(next.lastError ?? "Razorpay rejected the saved keys.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<IntegrationView>("/api/v1/integrations/razorpay", { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: (next) => {
      update(next);
      toast.success(next.enabled ? "Online payments are on for your store." : "Online payments are off. Past payments stay visible.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api<IntegrationView>("/api/v1/integrations/razorpay", { method: "DELETE" }),
    onSuccess: (next) => {
      update(next);
      resetForm();
      setConfirmDisconnect(false);
      toast.success("Razorpay disconnected. Your payment history is kept.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const keyMode = /^rzp_live_/.test(keyId.trim()) ? "LIVE" : /^rzp_test_/.test(keyId.trim()) ? "TEST" : null;
  const modeMismatch = Boolean(keyMode && keyMode !== mode);
  const needsKeys = !connected || keyId.trim() !== "" || mode !== view?.mode;
  const canSave =
    !save.isPending &&
    !modeMismatch &&
    (needsKeys ? keyId.trim() !== "" && keySecret.trim() !== "" : keySecret.trim() !== "" || webhookSecret.trim() !== "");

  async function copyWebhook() {
    if (!view?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(view.webhookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Could not copy. Select the URL and copy it manually.");
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/integrations" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Integrations
      </Link>
      <PageHeader
        title="Razorpay — Online Payments"
        description="Connect your Razorpay account to accept secure online payments directly from your PostBus Mini Store."
      />

      {query.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted">
            {query.error instanceof Error ? query.error.message : "Could not load the Razorpay integration."}
          </CardContent>
        </Card>
      ) : view && !view.available ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted">Online payments are not available on this workspace yet.</CardContent>
        </Card>
      ) : view ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>
                      <RazorpayLogo />
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Payments go straight to your Razorpay account. PostBus never holds your money.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {connected ? (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-semibold",
                          view.mode === "LIVE" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"
                        )}
                      >
                        {view.mode === "LIVE" ? "Live mode" : "Test mode"}
                      </span>
                    ) : null}
                    <StatusBadge value={view.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {view.lastError ? (
                  <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200">
                    {view.lastError}
                  </p>
                ) : null}

                {connected ? (
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Status</dt>
                      <dd className="font-medium">{STATUS_COPY[view.status]}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Key ID</dt>
                      <dd className="truncate font-mono text-sm">{view.keyIdHint}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Key Secret</dt>
                      <dd className="font-mono text-sm">{view.hasKeySecret ? "•••••••• saved" : "Missing"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Webhook secret</dt>
                      <dd className="font-mono text-sm">{view.hasWebhookSecret ? "•••••••• saved" : "Not set"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Last verified</dt>
                      <dd>{formatDate(view.lastVerifiedAt, true)}</dd>
                    </div>
                  </dl>
                ) : null}

                {connected && !editing ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
                      {verify.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
                      Verify credentials
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
                      Manage integration
                    </Button>
                  </div>
                ) : null}

                {showForm ? (
                  <form
                    className="grid max-w-xl grid-cols-[minmax(0,1fr)] gap-4 border-t border-border pt-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (canSave) save.mutate();
                    }}
                  >
                    <fieldset className="grid gap-2">
                      <legend className="mb-1 text-sm font-medium">Payment mode</legend>
                      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment mode">
                        {(["TEST", "LIVE"] as const).map((value) => (
                          <label
                            key={value}
                            className={cn(
                              "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                              mode === value ? "border-brand ring-1 ring-brand" : "border-border"
                            )}
                          >
                            <input
                              type="radio"
                              name="razorpay-mode"
                              value={value}
                              checked={mode === value}
                              onChange={() => setMode(value)}
                              className="size-4 accent-[var(--color-brand,#2563eb)]"
                            />
                            <span>
                              <span className="block font-medium">{value === "TEST" ? "Test" : "Live"}</span>
                              <span className="block text-xs text-muted">{value === "TEST" ? "rzp_test_ keys, no real money" : "rzp_live_ keys, real payments"}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <div className="grid gap-1.5">
                      <Label htmlFor="rzp-key-id">Razorpay Key ID</Label>
                      <Input
                        id="rzp-key-id"
                        value={keyId}
                        onChange={(event) => setKeyId(event.target.value)}
                        placeholder={connected ? `${view.keyIdHint} (leave blank to keep)` : mode === "LIVE" ? "rzp_live_…" : "rzp_test_…"}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={modeMismatch}
                      />
                      {modeMismatch ? (
                        <p className="text-xs text-red-600">
                          This is a {keyMode === "LIVE" ? "Live" : "Test"} key. Switch the mode to {keyMode === "LIVE" ? "Live" : "Test"} or use matching keys.
                        </p>
                      ) : null}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rzp-key-secret">Razorpay Key Secret</Label>
                      <Input
                        id="rzp-key-secret"
                        type="password"
                        value={keySecret}
                        onChange={(event) => setKeySecret(event.target.value)}
                        placeholder={connected ? "Saved · enter a new secret to replace" : "Key Secret"}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rzp-webhook-secret">Razorpay Webhook Secret</Label>
                      <Input
                        id="rzp-webhook-secret"
                        type="password"
                        value={webhookSecret}
                        onChange={(event) => setWebhookSecret(event.target.value)}
                        placeholder={view.hasWebhookSecret ? "Saved · enter a new secret to replace" : "The secret you set on the Razorpay webhook"}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      <p className="text-xs text-muted">Create the webhook in Razorpay first (see the steps on this page), then paste its secret here.</p>
                    </div>
                    <p className="text-xs text-muted">
                      Keys are checked with Razorpay before they are saved, then stored encrypted. They are never shown again or sent to your store&apos;s customers.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={!canSave}>
                        {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {connected ? "Verify & save configuration" : "Connect account"}
                      </Button>
                      {connected ? (
                        <Button type="button" variant="ghost" onClick={resetForm} disabled={save.isPending}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </form>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Online checkout</CardTitle>
                <CardDescription>
                  When on, customers can pay with UPI, cards, net banking or wallets — whichever methods are active on your Razorpay account.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-4">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{view.enabled ? "Accepting online payments" : "Online payments are off"}</p>
                  <p className="text-xs text-muted">
                    {view.status === "CONNECTED"
                      ? "Turning this off keeps every past payment and paid order as it is."
                      : view.status === "CONFIGURATION_REQUIRED"
                        ? "Add your webhook secret to turn this on."
                        : "Connect and verify Razorpay to turn this on."}
                  </p>
                </div>
                <Switch
                  checked={view.enabled}
                  disabled={toggle.isPending || (view.status !== "CONNECTED" && !view.enabled)}
                  onCheckedChange={(checked) => toggle.mutate(checked)}
                  aria-label="Accept online payments on my store"
                />
              </CardContent>
            </Card>

            <PaymentGatewayDefault />

            {connected ? (
              <Card>
                <CardHeader>
                  <CardTitle>Disconnect</CardTitle>
                  <CardDescription>Removes your keys from PostBus. Payment history and paid orders stay.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2">
                  {confirmDisconnect ? (
                    <>
                      <p className="w-full text-sm">
                        Customers will no longer see online payment. Open payments are checked with Razorpay first.
                      </p>
                      <Button type="button" variant="primary" size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                        {disconnect.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Unplug className="size-4" aria-hidden />}
                        Disconnect account
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)} disabled={disconnect.isPending}>
                        Keep connected
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDisconnect(true)}>
                      <Unplug className="size-4" aria-hidden />
                      Disconnect account
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </div>

          <Card className="h-fit min-w-0">
            <CardHeader>
              <CardTitle>Webhook setup</CardTitle>
              <CardDescription>Lets Razorpay confirm payments even if the customer closes the page.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {view.webhookUrl ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="rzp-webhook-url">Your webhook URL</Label>
                  <div className="flex min-w-0 gap-2">
                    <Input id="rzp-webhook-url" readOnly value={view.webhookUrl} className="min-w-0 font-mono text-xs" onFocus={(event) => event.target.select()} />
                    <Button type="button" variant="secondary" size="icon" onClick={copyWebhook} aria-label="Copy webhook URL">
                      <Copy className="size-4" aria-hidden />
                    </Button>
                  </div>
                  <p className="text-xs text-muted">Unique to this workspace. Keep it private.</p>
                </div>
              ) : (
                <p className="text-muted">Your webhook URL appears after you connect your keys.</p>
              )}
              <ol className="list-decimal space-y-2 pl-4 text-muted">
                <li>
                  In the Razorpay Dashboard, switch to <strong className="text-foreground">{mode === "LIVE" ? "Live" : "Test"} mode</strong> and open{" "}
                  <strong className="text-foreground">Account &amp; Settings → Webhooks</strong>.
                </li>
                <li>Add a new webhook and paste the URL above.</li>
                <li>Choose a secret and keep it — you will paste it here.</li>
                <li>
                  Tick these events:
                  <ul className="mt-1 space-y-0.5">
                    {view.webhookEvents.map((event) => (
                      <li key={event} className="flex items-center gap-1.5 font-mono text-xs text-foreground">
                        <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
                        {event}
                      </li>
                    ))}
                  </ul>
                </li>
                <li>Save, then paste the secret into Razorpay Webhook Secret and save here.</li>
              </ol>
              <p className="text-xs text-muted">
                Keys live in Razorpay under <strong>Account &amp; Settings → API Keys</strong>. Test and Live mode each have their own keys and webhook.
              </p>
              <Link href="/dashboard/orders" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                View orders
              </Link>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
