"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmFields, NativeSelect, money } from "@/components/admin/wallet/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";
import { AI_FEATURES, AI_FEATURE_LABELS } from "@/modules/wallet/ai-features";
import { WHATSAPP_CATEGORIES } from "@/modules/wallet/pricing";

type Rule = {
  id: string;
  service: "whatsapp" | "ai";
  organization_id: string | null;
  whatsapp_category: string;
  country_code: string;
  provider: string;
  ai_feature: string;
  ai_model: string;
  per_unit_micros: string;
  per_1k_input_tokens_micros: string;
  per_1k_output_tokens_micros: string;
  markup_bps: number;
  discount_bps: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  organizations: { name: string } | { name: string }[] | null;
};

type Allowance = {
  id: string;
  organization_id: string | null;
  whatsapp_category: string;
  monthly_messages: number;
  effective_from: string;
  effective_to: string | null;
  organizations: { name: string } | { name: string }[] | null;
};

const orgName = (value: Rule["organizations"]) => (Array.isArray(value) ? value[0]?.name : value?.name) ?? null;

function scope(rule: Rule) {
  if (rule.service === "whatsapp") {
    return `${rule.whatsapp_category === "*" ? "All categories" : rule.whatsapp_category}${rule.country_code !== "*" ? ` · ${rule.country_code}` : ""}${rule.provider !== "*" ? ` · ${rule.provider}` : ""}`;
  }
  const feature = rule.ai_feature === "*" ? "Any AI feature" : AI_FEATURE_LABELS[rule.ai_feature as keyof typeof AI_FEATURE_LABELS] ?? rule.ai_feature;
  return `${feature}${rule.ai_model !== "*" ? ` · ${rule.ai_model}` : ""}`;
}

function price(rule: Rule) {
  const parts = [`${money(rule.per_unit_micros, 4)} ${rule.service === "whatsapp" ? "per message" : "per use"}`];
  if (rule.per_1k_input_tokens_micros !== "0") parts.push(`${money(rule.per_1k_input_tokens_micros, 4)}/1k in`);
  if (rule.per_1k_output_tokens_micros !== "0") parts.push(`${money(rule.per_1k_output_tokens_micros, 4)}/1k out`);
  if (rule.markup_bps) parts.push(`+${rule.markup_bps / 100}%`);
  if (rule.discount_bps) parts.push(`−${rule.discount_bps / 100}%`);
  return parts.join(" · ");
}

const emptyForm = {
  service: "whatsapp" as "whatsapp" | "ai",
  organizationId: "",
  whatsappCategory: "UTILITY",
  countryCode: "IN",
  aiFeature: "*",
  aiModel: "",
  perUnitRupees: "",
  per1kInputTokensRupees: "",
  per1kOutputTokensRupees: "",
  markupPercent: "",
  discountPercent: "",
  note: "",
};

export function PricingTab() {
  const client = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [pin, setPin] = useState("");
  const [allowance, setAllowance] = useState({ organizationId: "", category: "UTILITY", monthly: "" });
  const [allowancePin, setAllowancePin] = useState("");

  const pricing = useQuery({
    queryKey: ["admin", "wallet", "pricing"],
    queryFn: () => api<{ rules: Rule[]; allowances: Allowance[] }>("/api/admin/wallet/pricing"),
  });

  const saveRule = useMutation({
    mutationFn: () =>
      api("/api/admin/wallet/pricing", {
        method: "POST",
        body: JSON.stringify({
          pin,
          service: form.service,
          organizationId: form.organizationId.trim() || null,
          whatsappCategory: form.service === "whatsapp" ? form.whatsappCategory : undefined,
          countryCode: form.service === "whatsapp" ? form.countryCode || "*" : undefined,
          aiFeature: form.service === "ai" ? form.aiFeature : undefined,
          aiModel: form.service === "ai" ? form.aiModel.trim() || "*" : undefined,
          perUnitRupees: form.perUnitRupees || "0",
          per1kInputTokensRupees: form.service === "ai" ? form.per1kInputTokensRupees || "0" : undefined,
          per1kOutputTokensRupees: form.service === "ai" ? form.per1kOutputTokensRupees || "0" : undefined,
          markupPercent: form.markupPercent ? Number(form.markupPercent) : 0,
          discountPercent: form.discountPercent ? Number(form.discountPercent) : 0,
          note: form.note || undefined,
        }),
      }),
    onSuccess: async () => {
      toast.success("New rate saved. Earlier charges keep their old rate.");
      setForm(emptyForm);
      setPin("");
      await client.invalidateQueries({ queryKey: ["admin", "wallet"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveAllowance = useMutation({
    mutationFn: () =>
      api("/api/admin/wallet/allowances", {
        method: "POST",
        body: JSON.stringify({
          pin: allowancePin,
          organizationId: allowance.organizationId.trim() || null,
          whatsappCategory: allowance.category,
          monthlyMessages: Number(allowance.monthly || 0),
        }),
      }),
    onSuccess: async () => {
      toast.success("Free allowance saved.");
      setAllowance({ organizationId: "", category: "UTILITY", monthly: "" });
      setAllowancePin("");
      await client.invalidateQueries({ queryKey: ["admin", "wallet", "pricing"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rules = useMemo(
    () => (pricing.data?.rules ?? []).filter((rule) => showHistory || rule.effective_to === null || new Date(rule.effective_to) > new Date()),
    [pricing.data?.rules, showHistory]
  );
  const missingUtility = !(pricing.data?.rules ?? []).some(
    (r) => r.service === "whatsapp" && r.whatsapp_category === "UTILITY" && r.effective_to === null
  );

  return (
    <div className="space-y-6">
      {missingUtility && pricing.isSuccess ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          No WhatsApp Utility rate yet. Order notices go out free until you add one, and WhatsApp billing cannot be turned on.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a rate</CardTitle>
          <CardDescription>
            Rates are versioned: saving replaces the current rate for the same item from now on. Leave Tenant ID empty for everyone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="pr-service">Service</Label>
              <NativeSelect id="pr-service" className="w-full" value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value as "whatsapp" | "ai" })}>
                <option value="whatsapp">WhatsApp</option>
                <option value="ai">AI</option>
              </NativeSelect>
            </div>
            {form.service === "whatsapp" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-cat">Category</Label>
                  <NativeSelect id="pr-cat" className="w-full" value={form.whatsappCategory} onChange={(e) => setForm({ ...form, whatsappCategory: e.target.value })}>
                    {WHATSAPP_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0) + c.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-country">Country (ISO, * for all)</Label>
                  <Input id="pr-country" maxLength={2} value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-feature">Feature</Label>
                  <NativeSelect id="pr-feature" className="w-full" value={form.aiFeature} onChange={(e) => setForm({ ...form, aiFeature: e.target.value })}>
                    <option value="*">Any AI feature</option>
                    {AI_FEATURES.map((f) => (
                      <option key={f} value={f}>
                        {AI_FEATURE_LABELS[f]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-model">Model (blank for any)</Label>
                  <Input id="pr-model" placeholder="openai/gpt-4o-mini" value={form.aiModel} onChange={(e) => setForm({ ...form, aiModel: e.target.value })} />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pr-org">Tenant ID (optional)</Label>
              <Input id="pr-org" placeholder="Everyone" value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-unit">{form.service === "whatsapp" ? "Cost per message (₹)" : "Fixed cost per use (₹)"}</Label>
              <Input id="pr-unit" inputMode="decimal" placeholder="0.115" value={form.perUnitRupees} onChange={(e) => setForm({ ...form, perUnitRupees: e.target.value })} />
            </div>
            {form.service === "ai" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-in">Per 1k input tokens (₹)</Label>
                  <Input id="pr-in" inputMode="decimal" value={form.per1kInputTokensRupees} onChange={(e) => setForm({ ...form, per1kInputTokensRupees: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pr-out">Per 1k output tokens (₹)</Label>
                  <Input id="pr-out" inputMode="decimal" value={form.per1kOutputTokensRupees} onChange={(e) => setForm({ ...form, per1kOutputTokensRupees: e.target.value })} />
                </div>
              </>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="pr-markup">PostBus markup (%)</Label>
              <Input id="pr-markup" inputMode="decimal" value={form.markupPercent} onChange={(e) => setForm({ ...form, markupPercent: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-discount">Discount (%)</Label>
              <Input id="pr-discount" inputMode="decimal" value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pr-note">Note</Label>
              <Input id="pr-note" placeholder="Meta rate card Nov 2026" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
          </div>
          <ConfirmFields id="pr" withReason={false} pin={pin} onPin={setPin} />
          <Button disabled={!form.perUnitRupees || pin.length !== 6 || saveRule.isPending} onClick={() => saveRule.mutate()}>
            {saveRule.isPending ? "Saving…" : "Save rate"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{showHistory ? "All rates, including past versions" : "Rates in force"}</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide history" : "Show history"}
          </Button>
        </CardHeader>
        <CardContent>
          {pricing.isLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                    <th className="py-2 pr-3">Applies to</th>
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3">Price</th>
                    <th className="py-2 pr-3">In force</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id} className="border-t border-border align-top">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <Badge variant={rule.service === "ai" ? "brand" : "success"}>{rule.service === "ai" ? "AI" : "WhatsApp"}</Badge>
                          <span>{scope(rule)}</span>
                        </div>
                        {rule.note ? <p className="text-xs text-muted">{rule.note}</p> : null}
                      </td>
                      <td className="py-2 pr-3 text-muted">{orgName(rule.organizations) ?? "Everyone"}</td>
                      <td className="py-2 pr-3 tabular-nums">{price(rule)}</td>
                      <td className="py-2 pr-3 text-xs text-muted">
                        {formatDate(rule.effective_from)} → {rule.effective_to ? formatDate(rule.effective_to) : "now"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Free WhatsApp messages per month</CardTitle>
          <CardDescription>Used before any charge. A tenant allowance replaces the global one for that category. Set 0 to remove.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1 text-sm">
            {(pricing.data?.allowances ?? [])
              .filter((a) => a.effective_to === null)
              .map((a) => (
                <li key={a.id}>
                  {orgName(a.organizations) ?? "Everyone"} · {a.whatsapp_category} · {a.monthly_messages} free / month
                </li>
              ))}
          </ul>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="al-cat">Category</Label>
              <NativeSelect id="al-cat" value={allowance.category} onChange={(e) => setAllowance({ ...allowance, category: e.target.value })}>
                {WHATSAPP_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="al-qty">Messages / month</Label>
              <Input id="al-qty" className="w-32" inputMode="numeric" value={allowance.monthly} onChange={(e) => setAllowance({ ...allowance, monthly: e.target.value.replace(/\D/g, "") })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="al-org">Tenant ID (optional)</Label>
              <Input id="al-org" className="w-72" placeholder="Everyone" value={allowance.organizationId} onChange={(e) => setAllowance({ ...allowance, organizationId: e.target.value })} />
            </div>
          </div>
          <ConfirmFields id="al" withReason={false} pin={allowancePin} onPin={setAllowancePin} />
          <Button variant="secondary" disabled={allowance.monthly === "" || allowancePin.length !== 6 || saveAllowance.isPending} onClick={() => saveAllowance.mutate()}>
            Save allowance
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
