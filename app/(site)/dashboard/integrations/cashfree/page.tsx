"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CheckCircle2, Copy, HelpCircle, Loader2, Radio, ShieldCheck, Unplug } from "lucide-react";
import { CashfreeLogo } from "@/components/brand/cashfree-logo";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { GATEWAY_QUERY_KEY, PaymentGatewayDefault, type GatewayOverview } from "@/components/integrations/payment-gateway-default";
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
type CashfreeView = {
  provider: "CASHFREE";
  status: Status;
  enabled: boolean;
  mode: Mode;
  environment: "Sandbox" | "Production";
  clientIdHint: string | null;
  hasClientSecret: boolean;
  webhookUrl: string | null;
  webhookEvents: string[];
  lastVerifiedAt: string | null;
  lastWebhookAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  available: boolean;
  gateway?: GatewayOverview;
};

const QUERY_KEY = ["integrations", "cashfree"];
const ENV_LABEL: Record<Mode, string> = { TEST: "Sandbox", LIVE: "Production" };

/** Status shown to the merchant: Not Connected / Test Mode / Live Mode / Connection Error. */
function headline(view: CashfreeView) {
  if (view.status === "NOT_CONNECTED") return { label: "Not connected", tone: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100" };
  if (view.status === "VERIFICATION_FAILED") return { label: "Connection error", tone: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" };
  return view.mode === "LIVE"
    ? { label: "Live mode", tone: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" }
    : { label: "Test mode", tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" };
}

export default function CashfreeIntegrationPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => api<CashfreeView>("/api/v1/integrations/cashfree") });
  const view = query.data;
  const connected = Boolean(view?.clientIdHint);

  const [editing, setEditing] = useState(false);
  const [modeChoice, setMode] = useState<Mode | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const mode: Mode = modeChoice ?? view?.mode ?? "TEST";
  const showForm = !connected || editing;

  function resetForm() {
    setClientId("");
    setClientSecret("");
    setMode(null);
    setEditing(false);
  }

  function update(next: CashfreeView) {
    queryClient.setQueryData(QUERY_KEY, (previous: CashfreeView | undefined) => ({ ...next, gateway: previous?.gateway }));
    void queryClient.invalidateQueries({ queryKey: ["integrations"], exact: true });
    void queryClient.invalidateQueries({ queryKey: GATEWAY_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }

  const save = useMutation({
    mutationFn: () =>
      api<CashfreeView>("/api/v1/integrations/cashfree", {
        method: "PUT",
        body: JSON.stringify({ mode, clientId: clientId.trim() || null, clientSecret: clientSecret.trim() || null }),
      }),
    onSuccess: (next) => {
      update(next);
      resetForm();
      toast.success(`Cashfree ${next.environment} connected and verified.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const verify = useMutation({
    mutationFn: () => api<CashfreeView & { verified: boolean }>("/api/v1/integrations/cashfree/verify", { method: "POST" }),
    onSuccess: (next) => {
      update(next);
      if (next.verified) toast.success("Cashfree accepted your credentials.");
      else toast.error(next.lastError ?? "Cashfree rejected the saved credentials.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<CashfreeView>("/api/v1/integrations/cashfree", { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: (next) => {
      update(next);
      toast.success(next.enabled ? "Cashfree payments are on." : "Cashfree payments are off. Past payments stay visible.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api<CashfreeView>("/api/v1/integrations/cashfree", { method: "DELETE" }),
    onSuccess: (next) => {
      update(next);
      resetForm();
      setConfirmDisconnect(false);
      toast.success("Cashfree disconnected. Your payment history is kept.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const secretEnv = /_test_/i.test(clientSecret) ? "TEST" : /_prod_/i.test(clientSecret) ? "LIVE" : null;
  const envMismatch = Boolean(secretEnv && secretEnv !== mode);
  const modeChanged = connected && mode !== view?.mode;
  const canSave =
    !save.isPending &&
    !envMismatch &&
    (connected ? clientSecret.trim() !== "" || clientId.trim() !== "" || modeChanged : clientId.trim() !== "" && clientSecret.trim() !== "");

  async function copyWebhook() {
    if (!view?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(view.webhookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Could not copy. Select the URL and copy it manually.");
    }
  }

  const isDefault = view?.gateway?.activeProvider === "CASHFREE";

  return (
    <div className="space-y-6">
      <Link href="/dashboard/integrations" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Integrations
      </Link>
      <PageHeader
        title="Cashfree Payments"
        description="Connect your Cashfree account to accept online payments directly through your PostBus Mini Store."
      />

      {query.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted">
            {query.error instanceof Error ? query.error.message : "Could not load the Cashfree integration."}
          </CardContent>
        </Card>
      ) : view && !view.available ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted">Cashfree payments are not available on this workspace yet.</CardContent>
        </Card>
      ) : view ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>
                      <CashfreeLogo />
                    </CardTitle>
                    <CardDescription className="mt-1">Payments settle to your own Cashfree account. PostBus never holds your money.</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", headline(view).tone)}>{headline(view).label}</span>
                    {connected ? <StatusBadge value={view.status} /> : null}
                    {isDefault ? <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">Default gateway</span> : null}
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
                      <dt className="text-xs text-muted">Environment</dt>
                      <dd className="font-medium">{view.environment}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Client ID (App ID)</dt>
                      <dd className="truncate font-mono text-sm">{view.clientIdHint}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Client Secret</dt>
                      <dd className="font-mono text-sm">{view.hasClientSecret ? "•••••••• saved" : "Missing"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Credential check</dt>
                      <dd className="font-medium">{view.status === "CONNECTED" ? "Verified with Cashfree" : view.status === "VERIFICATION_FAILED" ? "Failed" : "—"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Last successful check</dt>
                      <dd>{view.status === "CONNECTED" ? formatDate(view.lastVerifiedAt, true) : "—"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted">Last webhook received</dt>
                      <dd>{view.lastWebhookAt ? formatDate(view.lastWebhookAt, true) : "None yet"}</dd>
                    </div>
                  </dl>
                ) : null}

                {connected && !editing ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
                      {verify.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
                      Verify connection
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
                      Update credentials / switch environment
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
                      <legend className="mb-1 text-sm font-medium">Environment</legend>
                      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Cashfree environment">
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
                              name="cashfree-mode"
                              value={value}
                              checked={mode === value}
                              onChange={() => setMode(value)}
                              className="size-4 accent-[var(--color-brand,#2563eb)]"
                            />
                            <span>
                              <span className="block font-medium">{ENV_LABEL[value]}</span>
                              <span className="block text-xs text-muted">{value === "TEST" ? "Test keys, no real money" : "Live keys, real payments"}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <div className="grid gap-1.5">
                      <Label htmlFor="cf-client-id">Cashfree Client ID / App ID</Label>
                      <Input
                        id="cf-client-id"
                        value={clientId}
                        onChange={(event) => setClientId(event.target.value)}
                        placeholder={connected ? `${view.clientIdHint} (leave blank to keep)` : "Client ID"}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="cf-client-secret">Cashfree Client Secret</Label>
                      <Input
                        id="cf-client-secret"
                        type="password"
                        value={clientSecret}
                        onChange={(event) => setClientSecret(event.target.value)}
                        placeholder={connected ? "Saved · enter a new secret to replace" : "Client Secret"}
                        autoComplete="new-password"
                        spellCheck={false}
                        aria-invalid={envMismatch}
                      />
                      {envMismatch ? (
                        <p className="text-xs text-red-600">
                          This looks like a {secretEnv === "LIVE" ? "Production" : "Sandbox"} secret. Switch the environment to {secretEnv === "LIVE" ? "Production" : "Sandbox"} or use matching keys.
                        </p>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted">
                      PostBus checks the credentials with Cashfree before saving them, then stores them encrypted. They are never shown again or sent to your customers.
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
                <CardTitle>Online payments with Cashfree</CardTitle>
                <CardDescription>
                  When on, customers can pay with UPI, cards, net banking or wallets — whichever methods are active on your Cashfree account.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-4">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{view.enabled ? "Payments enabled" : "Payments disabled"}</p>
                  <p className="text-xs text-muted">
                    {view.status === "CONNECTED"
                      ? "Turning this off stops new Cashfree checkouts. Payments already started still complete, and history is kept."
                      : "Connect and verify Cashfree to turn this on."}
                  </p>
                </div>
                <Switch
                  checked={view.enabled}
                  disabled={toggle.isPending || (view.status !== "CONNECTED" && !view.enabled)}
                  onCheckedChange={(checked) => toggle.mutate(checked)}
                  aria-label="Accept Cashfree payments on my store"
                />
              </CardContent>
            </Card>

            <PaymentGatewayDefault />

            {connected ? (
              <Card>
                <CardHeader>
                  <CardTitle>Disconnect</CardTitle>
                  <CardDescription>Removes your Cashfree credentials from PostBus. Payment history and paid orders stay.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2">
                  {confirmDisconnect ? (
                    <>
                      <p className="w-full text-sm">
                        {isDefault
                          ? "Cashfree is your default gateway, so online payments will turn off for your store. Open payments are checked with Cashfree first."
                          : "Open payments are checked with Cashfree first."}
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

          <div className="min-w-0 space-y-4">
            <Card className="h-fit min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HelpCircle className="size-4" aria-hidden />
                  Get your API credentials
                </CardTitle>
                <CardDescription>About 2 minutes in your Cashfree Merchant Dashboard.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <ol className="list-decimal space-y-2 pl-4 text-muted">
                  <li>
                    Sign in at <strong className="text-foreground">merchant.cashfree.com</strong> and open <strong className="text-foreground">Payment Gateway</strong>.
                  </li>
                  <li>
                    Pick <strong className="text-foreground">{ENV_LABEL[mode]}</strong> with the environment switch at the top of the dashboard.
                  </li>
                  <li>
                    Go to <strong className="text-foreground">Developers → API Keys</strong> and generate (or view) your keys.
                  </li>
                  <li>
                    Copy the <strong className="text-foreground">Client ID (App ID)</strong> and <strong className="text-foreground">Client Secret</strong> into this page and click Connect.
                  </li>
                </ol>
                <button type="button" className="text-xs font-medium text-brand underline-offset-2 hover:underline" onClick={() => setShowHelp((value) => !value)}>
                  {showHelp ? "Hide troubleshooting" : "Troubleshooting"}
                </button>
                {showHelp ? (
                  <ul className="list-disc space-y-1.5 pl-4 text-xs text-muted">
                    <li>
                      <strong className="text-foreground">Invalid credentials</strong>: copy both values again; the secret is shown only once in Cashfree, so regenerate it if lost.
                    </li>
                    <li>
                      <strong className="text-foreground">Wrong environment</strong>: Sandbox and Production keys are different. Choose the environment the keys came from.
                    </li>
                    <li>
                      <strong className="text-foreground">Account not activated</strong>: Production keys work only after Cashfree approves your KYC and activates Payment Gateway. Use Sandbox until then.
                    </li>
                    <li>
                      <strong className="text-foreground">Domain whitelisting</strong>: for Production, Cashfree may ask you to whitelist your store&apos;s domain under Developers → Whitelisting before checkout opens.
                    </li>
                  </ul>
                ) : null}
              </CardContent>
            </Card>

            <Card className="h-fit min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Radio className="size-4" aria-hidden />
                  Payment notifications
                </CardTitle>
                <CardDescription>Confirms payments even if the customer closes the page.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted">
                  PostBus sends this URL to Cashfree with every order, so <strong className="text-foreground">no webhook setup is required</strong>. Optionally add it in
                  Cashfree under <strong className="text-foreground">Developers → Webhooks</strong> as well.
                </p>
                {view.webhookUrl ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="cf-webhook-url">Your notification URL</Label>
                    <div className="flex min-w-0 gap-2">
                      <Input id="cf-webhook-url" readOnly value={view.webhookUrl} className="min-w-0 font-mono text-xs" onFocus={(event) => event.target.select()} />
                      <Button type="button" variant="secondary" size="icon" onClick={copyWebhook} aria-label="Copy notification URL">
                        <Copy className="size-4" aria-hidden />
                      </Button>
                    </div>
                    <p className="text-xs text-muted">Unique to this workspace. Signed with your Client Secret.</p>
                  </div>
                ) : (
                  <p className="text-muted">Your notification URL appears after you connect.</p>
                )}
                <ul className="space-y-0.5">
                  {view.webhookEvents.map((event) => (
                    <li key={event} className="flex items-center gap-1.5 font-mono text-xs">
                      <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
                      {event}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted">
                  Status: {view.lastWebhookAt ? `working · last received ${formatDate(view.lastWebhookAt, true)}` : "not confirmed yet — it shows here after your first payment."}
                </p>
                <Link href="/dashboard/orders" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  View orders
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
