"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmFields, NativeSelect, confirmReady, money } from "@/components/admin/wallet/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";

type Settings = {
  rechargeMinRupees: number;
  rechargeMaxRupees: number;
  rechargePresetsRupees: number[];
  gstRatePercent: number;
  gstPlaceOfSupply: "INTRA" | "INTER";
  invoiceSac: string;
  signupPromoEnabled: boolean;
  signupPromoMicros: string;
  aiCreditRateMicros: string;
  lowBalanceThresholdsRupees: number[];
  whatsappBillingEnabled: boolean;
  whatsappResumeHours: number;
};

const list = (value: string) =>
  value
    .split(/[,\s]+/)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);

function toForm(s: Settings): Record<string, string | boolean> {
  return {
    rechargeMin: String(s.rechargeMinRupees),
    rechargeMax: String(s.rechargeMaxRupees),
    presets: s.rechargePresetsRupees.join(", "),
    gst: String(s.gstRatePercent),
    place: s.gstPlaceOfSupply,
    sac: s.invoiceSac,
    promoEnabled: s.signupPromoEnabled,
    promo: money(s.signupPromoMicros).replace("₹", "").replace(/,/g, ""),
    thresholds: s.lowBalanceThresholdsRupees.join(", "),
    whatsapp: s.whatsappBillingEnabled,
    resumeHours: String(s.whatsappResumeHours),
  };
}

export function SettingsTab() {
  const settings = useQuery({ queryKey: ["admin", "wallet", "settings"], queryFn: () => api<Settings>("/api/admin/wallet/settings") });
  if (settings.isLoading || !settings.data) return <Skeleton className="h-96 rounded-2xl" />;
  // Re-seed the form whenever the saved settings change.
  return <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />;
}

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient();
  const [form, setForm] = useState<Record<string, string | boolean>>(() => toForm(initial));
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api<Settings>("/api/admin/wallet/settings", {
        method: "PATCH",
        body: JSON.stringify({
          pin,
          reason,
          rechargeMinRupees: Number(form.rechargeMin),
          rechargeMaxRupees: Number(form.rechargeMax),
          rechargePresetsRupees: list(String(form.presets ?? "")),
          gstRatePercent: Number(form.gst),
          gstPlaceOfSupply: form.place,
          invoiceSac: String(form.sac ?? ""),
          signupPromoEnabled: Boolean(form.promoEnabled),
          signupPromoRupees: String(form.promo ?? "0"),
          lowBalanceThresholdsRupees: list(String(form.thresholds ?? "")),
          whatsappBillingEnabled: Boolean(form.whatsapp),
          whatsappResumeHours: Number(form.resumeHours),
        }),
      }),
    onSuccess: async () => {
      toast.success("Wallet settings saved.");
      setPin("");
      setReason("");
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const field = (key: string, label: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ws-${key}`}>{label}</Label>
      <Input id={`ws-${key}`} value={String(form[key] ?? "")} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recharges and GST</CardTitle>
          <CardDescription>Amounts are what merchants pay, including GST. New rates apply to new recharges only.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {field("rechargeMin", "Minimum recharge (₹)", { inputMode: "numeric" })}
          {field("rechargeMax", "Maximum recharge (₹)", { inputMode: "numeric" })}
          {field("presets", "Preset buttons (₹, comma separated)")}
          {field("gst", "GST rate (%)", { inputMode: "decimal" })}
          <div className="space-y-1.5">
            <Label htmlFor="ws-place">Default place of supply</Label>
            <NativeSelect id="ws-place" className="w-full" value={String(form.place ?? "INTRA")} onChange={(e) => setForm({ ...form, place: e.target.value })}>
              <option value="INTRA">Same state (CGST + SGST)</option>
              <option value="INTER">Other state (IGST)</option>
            </NativeSelect>
          </div>
          {field("sac", "SAC on invoices (blank for none)", { inputMode: "numeric" })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Billing switches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3">
            <Switch checked={Boolean(form.whatsapp)} onCheckedChange={(v) => setForm({ ...form, whatsapp: v })} />
            <span className="text-sm">
              <span className="font-medium text-ink">Charge WhatsApp notices to wallets</span>
              <span className="block text-muted">Only messages sent through the PostBus VaChat account. Needs a Utility rate in Pricing.</span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {field("resumeHours", "Resend held notices younger than (hours)", { inputMode: "numeric" })}
            {field("thresholds", "Low-balance alerts for new wallets (₹)")}
          </div>
          <label className="flex items-start gap-3">
            <Switch checked={Boolean(form.promoEnabled)} onCheckedChange={(v) => setForm({ ...form, promoEnabled: v })} />
            <span className="text-sm">
              <span className="font-medium text-ink">Welcome credit for new tenants</span>
              <span className="block text-muted">Turn on at cutover: new tenants then get this credit instead of free AI credits.</span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{field("promo", "Welcome credit (₹)", { inputMode: "decimal" })}</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <ConfirmFields id="ws" reason={reason} onReason={setReason} pin={pin} onPin={setPin} />
          <Button disabled={!confirmReady(pin, reason) || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
