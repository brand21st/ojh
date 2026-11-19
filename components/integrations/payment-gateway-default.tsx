"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";

type Provider = "RAZORPAY" | "CASHFREE";
type ProviderState = { connected: boolean; enabled: boolean; usable: boolean; mode: "TEST" | "LIVE" | null; status: string };
export type GatewayOverview = {
  available: boolean;
  defaultProvider: Provider | null;
  activeProvider: Provider | null;
  providers: Record<Provider, ProviderState>;
  notice: string | null;
};

const NAMES: Record<Provider, string> = { RAZORPAY: "Razorpay", CASHFREE: "Cashfree" };
export const GATEWAY_QUERY_KEY = ["integrations", "payment-gateway"];

function describe(state: ProviderState) {
  if (!state.connected) return "Not connected";
  if (state.status === "VERIFICATION_FAILED") return "Connection error";
  if (!state.usable) return state.enabled ? "Needs attention" : "Connected · payments off";
  return state.mode === "LIVE" ? "Live mode · enabled" : "Test mode · enabled";
}

/**
 * "Default online payment gateway" — which of the merchant's own connected gateways takes
 * storefront payments. Only verified + enabled gateways can be chosen. PostBus never switches on
 * its own: if the default stops working, online payment turns off until the merchant acts.
 */
export function PaymentGatewayDefault() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: GATEWAY_QUERY_KEY, queryFn: () => api<GatewayOverview>("/api/v1/integrations/payment-gateway") });
  const save = useMutation({
    mutationFn: (provider: Provider) =>
      api<GatewayOverview>("/api/v1/integrations/payment-gateway", { method: "PUT", body: JSON.stringify({ defaultProvider: provider }) }),
    onSuccess: (next) => {
      queryClient.setQueryData(GATEWAY_QUERY_KEY, next);
      void queryClient.invalidateQueries({ queryKey: ["integrations"], exact: true });
      toast.success(`${next.defaultProvider ? NAMES[next.defaultProvider] : "Gateway"} now takes your store's online payments.`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const overview = query.data;
  if (!overview?.available) return null;
  const current = overview.defaultProvider ?? overview.activeProvider;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default online payment gateway</CardTitle>
        <CardDescription>
          The account your store&apos;s online payments go to. Cash on delivery is set separately in your store settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Default online payment gateway">
          {(["RAZORPAY", "CASHFREE"] as const).map((provider) => {
            const state = overview.providers[provider];
            const selected = current === provider;
            return (
              <label
                key={provider}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                  selected ? "border-brand ring-1 ring-brand" : "border-border",
                  state.usable ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                )}
              >
                <input
                  type="radio"
                  name="default-gateway"
                  value={provider}
                  checked={selected}
                  disabled={!state.usable || save.isPending}
                  onChange={() => save.mutate(provider)}
                  className="size-4 accent-[var(--color-brand,#2563eb)]"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{NAMES[provider]}</span>
                  <span className="block text-xs text-muted">{describe(state)}</span>
                </span>
                {save.isPending && save.variables === provider ? <Loader2 className="ml-auto size-4 animate-spin" aria-hidden /> : null}
              </label>
            );
          })}
        </div>
        {overview.notice ? (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {overview.notice}
          </p>
        ) : overview.activeProvider ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-4" aria-hidden />
            New online payments use {NAMES[overview.activeProvider]}.
          </p>
        ) : null}
        <p className="text-xs text-muted">
          Changing this only affects new orders. Payments already started finish on the gateway they began on.
        </p>
      </CardContent>
    </Card>
  );
}
