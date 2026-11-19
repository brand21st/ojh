"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BadgePercent, Gift, IndianRupee, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { useDebounced } from "./store-address-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { describeCoupon, generateCouponCode, normalizeCouponCode, type CouponDiscountType, type CouponScope } from "@/modules/storefront/coupons/engine";
import { couponInputSchema } from "@/modules/storefront/coupons/schema";
import type { CouponRecord } from "@/modules/storefront/coupons/service";
import type { Paginated, ProductRecord } from "@/types/api";

export type CouponDraft = {
  code: string;
  title: string;
  description: string;
  discountType: CouponDiscountType;
  value: number | null;
  maxDiscount: number | null;
  appliesTo: CouponScope;
  productIds: string[];
  categoryIds: string[];
  buyQuantity: number | null;
  getQuantity: number | null;
  minOrderAmount: number | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  firstOrderOnly: boolean;
  prepaidOnly: boolean;
  autoApply: boolean;
  startsAt: string;
  endsAt: string;
  status: "ACTIVE" | "PAUSED";
};

const TYPES: Array<{ value: CouponDiscountType; label: string; hint: string; icon: ReactNode }> = [
  { value: "PERCENT", label: "Percentage", hint: "e.g. 10% off", icon: <BadgePercent className="size-4" aria-hidden /> },
  { value: "FIXED", label: "Fixed amount", hint: "e.g. ₹100 off", icon: <IndianRupee className="size-4" aria-hidden /> },
  { value: "BUY_X_GET_Y", label: "Buy X get Y", hint: "e.g. buy 2 get 1 free", icon: <Gift className="size-4" aria-hidden /> },
];

/** `datetime-local` wants local wall time without a zone. */
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromRecord(coupon: CouponRecord | null, initial?: Partial<CouponDraft>): CouponDraft {
  return {
    code: coupon?.code ?? "",
    title: coupon?.title ?? "",
    description: coupon?.description ?? "",
    discountType: coupon?.discountType ?? "PERCENT",
    value: coupon?.value ?? null,
    maxDiscount: coupon?.maxDiscount ?? null,
    appliesTo: coupon?.appliesTo ?? "ALL",
    productIds: coupon?.productIds ?? [],
    categoryIds: coupon?.categoryIds ?? [],
    buyQuantity: coupon?.buyQuantity ?? null,
    getQuantity: coupon?.getQuantity ?? null,
    minOrderAmount: coupon?.minOrderAmount ?? null,
    usageLimit: coupon?.usageLimit ?? null,
    perCustomerLimit: coupon?.perCustomerLimit ?? null,
    firstOrderOnly: coupon?.firstOrderOnly ?? false,
    prepaidOnly: coupon?.prepaidOnly ?? false,
    autoApply: coupon?.autoApply ?? false,
    startsAt: toLocalInput(coupon?.startsAt ?? null),
    endsAt: toLocalInput(coupon?.endsAt ?? null),
    status: coupon?.status === "PAUSED" ? "PAUSED" : "ACTIVE",
    ...initial,
  };
}

function numberOrNull(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function CouponEditor({
  coupon,
  initial,
  onClose,
  onSaved,
}: {
  coupon: CouponRecord | null;
  initial?: Partial<CouponDraft>;
  onClose: () => void;
  onSaved: (coupon: CouponRecord) => void;
}) {
  const [draft, setDraft] = useState<CouponDraft>(() => fromRecord(coupon, initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof CouponDraft>(key: K, value: CouponDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<CouponRecord>(coupon ? `/api/v1/inventory/coupons/${coupon.id}` : "/api/v1/inventory/coupons", {
        method: coupon ? "PATCH" : "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: onSaved,
    onError: (error: Error) => toast.error(error.message),
  });

  function submit() {
    const parsed = couponInputSchema.safeParse({
      ...draft,
      value: draft.value ?? 0,
      startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
      endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= key === "value" && !draft.value ? "Enter a discount value." : issue.message;
      }
      setErrors(next);
      toast.error(Object.values(next)[0]);
      return;
    }
    save.mutate(parsed.data);
  }

  const preview = useMemo(
    () =>
      draft.value
        ? describeCoupon({
            discountType: draft.discountType,
            value: draft.value,
            maxDiscount: draft.discountType === "PERCENT" ? draft.maxDiscount : null,
            buyQuantity: draft.buyQuantity,
            getQuantity: draft.getQuantity,
            minOrderAmount: draft.minOrderAmount,
            appliesTo: draft.appliesTo,
          })
        : "Set a discount to see the summary",
    [draft]
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{coupon ? `Edit ${coupon.code}` : "New coupon"}</DialogTitle>
          <DialogDescription>Customers enter the code at checkout, or open your magic link to have it applied for them.</DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="coupon-code" label="Code" error={errors.code} hint="Letters, numbers, - and _. Not case-sensitive for customers.">
                <div className="flex gap-2">
                  <Input
                    id="coupon-code"
                    className="font-mono uppercase"
                    maxLength={32}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="SAVE10"
                    value={draft.code}
                    aria-invalid={Boolean(errors.code) || undefined}
                    onChange={(event) => set("code", normalizeCouponCode(event.target.value).replace(/[^A-Z0-9_-]/g, ""))}
                  />
                  <Button type="button" size="icon" variant="secondary" aria-label="Generate a random code" title="Generate code" onClick={() => set("code", generateCouponCode())}>
                    <RefreshCw />
                  </Button>
                </div>
              </Field>
              <Field id="coupon-title" label="Internal name" hint="Only you see this, e.g. Diwali Instagram campaign.">
                <Input id="coupon-title" maxLength={80} value={draft.title} onChange={(event) => set("title", event.target.value)} />
              </Field>
            </div>

            <div>
              <p className="text-xs font-medium">Discount type</p>
              <div role="radiogroup" aria-label="Discount type" className="mt-1.5 grid gap-2 sm:grid-cols-3">
                {TYPES.map((type) => {
                  const active = draft.discountType === type.value;
                  return (
                    <button
                      key={type.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        set("discountType", type.value);
                        if (type.value === "BUY_X_GET_Y") {
                          setDraft((current) => ({ ...current, discountType: type.value, value: current.value && current.value <= 100 ? current.value : 100, buyQuantity: current.buyQuantity ?? 2, getQuantity: current.getQuantity ?? 1, maxDiscount: null }));
                        } else if (type.value === "FIXED") {
                          setDraft((current) => ({ ...current, discountType: type.value, maxDiscount: null }));
                        }
                      }}
                      className={cn(
                        "flex items-start gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                        active ? "border-brand bg-brand/5" : "border-border hover:bg-surface-soft"
                      )}
                    >
                      <span className={cn("mt-0.5", active ? "text-brand" : "text-muted")}>{type.icon}</span>
                      <span>
                        <span className="block text-xs font-semibold">{type.label}</span>
                        <span className="block text-[11px] text-muted">{type.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {draft.discountType === "BUY_X_GET_Y" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="coupon-buy" label="Customer buys" error={errors.buyQuantity}>
                  <Input id="coupon-buy" type="number" inputMode="numeric" min={1} max={20} value={draft.buyQuantity ?? ""} onChange={(event) => set("buyQuantity", numberOrNull(event.target.value))} />
                </Field>
                <Field id="coupon-get" label="Customer gets">
                  <Input id="coupon-get" type="number" inputMode="numeric" min={1} max={20} value={draft.getQuantity ?? ""} onChange={(event) => set("getQuantity", numberOrNull(event.target.value))} />
                </Field>
                <Field id="coupon-value" label="Off the free items (%)" error={errors.value} hint="100 = free. Cheapest items get the discount.">
                  <Input id="coupon-value" type="number" inputMode="decimal" min={1} max={100} value={draft.value ?? ""} onChange={(event) => set("value", numberOrNull(event.target.value))} />
                </Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="coupon-value" label={draft.discountType === "PERCENT" ? "Discount (%)" : "Discount (₹)"} error={errors.value}>
                  <Input id="coupon-value" type="number" inputMode="decimal" min={0.01} max={draft.discountType === "PERCENT" ? 99 : undefined} step="0.01" value={draft.value ?? ""} onChange={(event) => set("value", numberOrNull(event.target.value))} />
                </Field>
                {draft.discountType === "PERCENT" ? (
                  <Field id="coupon-cap" label="Maximum discount (₹)" error={errors.maxDiscount} hint="Optional. Caps big orders.">
                    <Input id="coupon-cap" type="number" inputMode="decimal" min={1} placeholder="No cap" value={draft.maxDiscount ?? ""} onChange={(event) => set("maxDiscount", numberOrNull(event.target.value))} />
                  </Field>
                ) : null}
              </div>
            )}

            <ScopePicker draft={draft} errors={errors} set={set} />

            <section aria-labelledby="coupon-rules-title" className="space-y-3">
              <h3 id="coupon-rules-title" className="text-xs font-semibold">Rules</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="coupon-min" label="Minimum order (₹)" hint={draft.appliesTo === "ALL" ? "Optional" : "Of eligible items"}>
                  <Input id="coupon-min" type="number" inputMode="decimal" min={0} placeholder="None" value={draft.minOrderAmount ?? ""} onChange={(event) => set("minOrderAmount", numberOrNull(event.target.value))} />
                </Field>
                <Field id="coupon-limit" label="Total uses" hint="Optional">
                  <Input id="coupon-limit" type="number" inputMode="numeric" min={1} placeholder="Unlimited" value={draft.usageLimit ?? ""} onChange={(event) => set("usageLimit", numberOrNull(event.target.value))} />
                </Field>
                <Field id="coupon-per-customer" label="Uses per customer" error={errors.perCustomerLimit} hint="By phone number">
                  <Input id="coupon-per-customer" type="number" inputMode="numeric" min={1} placeholder="Unlimited" value={draft.perCustomerLimit ?? ""} onChange={(event) => set("perCustomerLimit", numberOrNull(event.target.value))} />
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Toggle id="coupon-first" label="First order only" hint="New customers by phone" checked={draft.firstOrderOnly} onChange={(value) => set("firstOrderOnly", value)} />
                <Toggle id="coupon-prepaid" label="Prepaid only" hint="Not valid with COD" checked={draft.prepaidOnly} onChange={(value) => set("prepaidOnly", value)} />
                <Toggle id="coupon-auto" label="Auto-apply" hint="Banner on store, no code needed" checked={draft.autoApply} onChange={(value) => set("autoApply", value)} />
              </div>
            </section>

            <section aria-labelledby="coupon-schedule-title" className="space-y-3">
              <h3 id="coupon-schedule-title" className="text-xs font-semibold">Schedule</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="coupon-start" label="Starts" hint="Leave empty to start now">
                  <Input id="coupon-start" type="datetime-local" value={draft.startsAt} onChange={(event) => set("startsAt", event.target.value)} />
                </Field>
                <Field id="coupon-end" label="Ends" error={errors.endsAt} hint="Leave empty for no end date">
                  <Input id="coupon-end" type="datetime-local" value={draft.endsAt} min={draft.startsAt || undefined} onChange={(event) => set("endsAt", event.target.value)} />
                </Field>
              </div>
            </section>

            <Field id="coupon-description" label="Message for customers" hint="Optional. Shown in the store banner, e.g. “Diwali sale ends Sunday”.">
              <Input id="coupon-description" maxLength={160} value={draft.description} onChange={(event) => set("description", event.target.value)} />
            </Field>

            <div className="rounded-lg border border-dashed border-border bg-surface-soft p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Customers see</p>
              <p className="mt-1 text-sm font-semibold">
                <span className="mr-2 rounded border border-dashed border-border bg-card px-1.5 py-0.5 font-mono text-xs">{draft.code || "CODE"}</span>
                {preview}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {[draft.prepaidOnly && "Prepaid only", draft.firstOrderOnly && "First order only", draft.perCustomerLimit && `${draft.perCustomerLimit} per customer`, "Not valid on bundles"].filter(Boolean).join(" · ")}
              </p>
            </div>
          </fieldset>

          <DialogFooter className="items-center gap-2 sm:justify-between">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={draft.status === "ACTIVE"} onCheckedChange={(value) => set("status", value ? "ACTIVE" : "PAUSED")} aria-label="Coupon active" />
              {draft.status === "ACTIVE" ? "Active" : "Paused"}
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : null}
                {coupon ? "Save changes" : "Create coupon"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="mt-1">{children}</div>
      {error ? <p className="mt-1 text-[11px] text-red-600">{error}</p> : hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className={cn("flex items-start justify-between gap-2 rounded-lg border p-2.5", checked ? "border-brand/40 bg-brand/5" : "border-border")}>
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs">{label}</Label>
        <p className="text-[11px] text-muted">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

type Category = { id: string; name: string; active?: boolean };

function ScopePicker({
  draft,
  errors,
  set,
}: {
  draft: CouponDraft;
  errors: Record<string, string>;
  set: <K extends keyof CouponDraft>(key: K, value: CouponDraft[K]) => void;
}) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 250);
  const [names, setNames] = useState<Record<string, string>>({});
  const categories = useQuery({
    queryKey: ["product-categories"],
    enabled: draft.appliesTo === "CATEGORIES",
    queryFn: () => api<Category[]>("/api/v1/inventory/categories"),
  });
  const products = useQuery({
    queryKey: ["coupon-products", term],
    enabled: draft.appliesTo === "PRODUCTS",
    queryFn: ({ signal }) => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=50&active=true${term ? `&q=${encodeURIComponent(term)}` : ""}`, { signal }),
  });
  // Names for already-selected products that aren't in the current search page.
  const selectedLookup = useQuery({
    queryKey: ["coupon-products-selected", draft.productIds.join(",")],
    enabled: draft.appliesTo === "PRODUCTS" && draft.productIds.some((id) => !names[id]),
    queryFn: () => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=100&active=all`),
  });
  const known = useMemo(() => {
    const map = new Map<string, string>(Object.entries(names));
    for (const product of [...(products.data?.items ?? []), ...(selectedLookup.data?.items ?? [])]) map.set(product.id, product.name);
    return map;
  }, [names, products.data, selectedLookup.data]);

  return (
    <section aria-labelledby="coupon-scope-title" className="space-y-2">
      <h3 id="coupon-scope-title" className="text-xs font-semibold">Applies to</h3>
      <div role="radiogroup" aria-label="Applies to" className="flex flex-wrap gap-1.5">
        {(["ALL", "PRODUCTS", "CATEGORIES"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            role="radio"
            aria-checked={draft.appliesTo === scope}
            onClick={() => set("appliesTo", scope)}
            className={cn(
              "h-8 rounded-full border px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand",
              draft.appliesTo === scope ? "border-brand bg-brand/10 text-brand" : "border-border text-muted hover:text-ink"
            )}
          >
            {scope === "ALL" ? "All products" : scope === "PRODUCTS" ? "Specific products" : "Categories"}
          </button>
        ))}
      </div>
      {draft.appliesTo === "ALL" ? <p className="text-[11px] text-muted">Every product except bundles, which are already discounted.</p> : null}

      {draft.appliesTo === "PRODUCTS" ? (
        <div className="rounded-lg border border-border p-3">
          {draft.productIds.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Selected products">
              {draft.productIds.map((id) => (
                <li key={id} className="flex items-center gap-1 rounded-full bg-surface-soft py-0.5 pl-2.5 pr-1 text-xs">
                  <span className="max-w-40 truncate">{known.get(id) ?? "Product"}</span>
                  <button type="button" aria-label={`Remove ${known.get(id) ?? "product"}`} className="grid size-5 place-items-center rounded-full hover:bg-card" onClick={() => set("productIds", draft.productIds.filter((value) => value !== id))}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Input type="search" aria-label="Search products" placeholder="Search by name or SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="mt-2 max-h-44 space-y-0.5 overflow-y-auto">
            {products.isPending ? <p role="status" className="text-xs text-muted">Loading…</p> : null}
            {(products.data?.items ?? []).map((product) => {
              const checked = draft.productIds.includes(product.id);
              return (
                <label key={product.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-surface-soft">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={checked}
                    onChange={(event) => {
                      setNames((current) => ({ ...current, [product.id]: product.name }));
                      set("productIds", event.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter((id) => id !== product.id));
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  <span className="shrink-0 text-[11px] text-muted">{product.sku}</span>
                </label>
              );
            })}
          </div>
          {errors.productIds ? <p className="mt-1 text-[11px] text-red-600">{errors.productIds}</p> : null}
        </div>
      ) : null}

      {draft.appliesTo === "CATEGORIES" ? (
        <div className="rounded-lg border border-border p-3">
          {categories.isPending ? <p role="status" className="text-xs text-muted">Loading…</p> : null}
          {categories.data && !categories.data.length ? <p className="text-xs text-muted">No categories yet. Create them in the Categories tab.</p> : null}
          <div className="grid gap-0.5 sm:grid-cols-2">
            {(categories.data ?? []).map((category) => (
              <label key={category.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-surface-soft">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={draft.categoryIds.includes(category.id)}
                  onChange={(event) => set("categoryIds", event.target.checked ? [...draft.categoryIds, category.id] : draft.categoryIds.filter((id) => id !== category.id))}
                />
                <span className="truncate">{category.name}</span>
                {category.active === false ? <span className="text-[11px] text-muted">(hidden)</span> : null}
              </label>
            ))}
          </div>
          {errors.categoryIds ? <p className="mt-1 text-[11px] text-red-600">{errors.categoryIds}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
