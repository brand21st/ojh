"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Package, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import {
  DEFAULT_STORE_TRACKING,
  storeThemeSchema,
  storeTrackingSchema,
  type StoreTheme,
  type StoreTrackingConfig,
} from "@/modules/storefront/config";
import { bundleInputSchema, type BundleInput } from "@/modules/storefront/bundle-pricing";
import type { Paginated, ProductRecord } from "@/types/api";

const FONTS: Array<{ value: StoreTheme["font"]; label: string; family: string }> = [
  { value: "geist", label: "Geist", family: "var(--font-geist-sans, system-ui)" },
  { value: "inter", label: "Inter", family: "Inter, system-ui" },
  { value: "manrope", label: "Manrope", family: "Manrope, system-ui" },
];

/** Secondary color and font. Changes preview instantly and save on commit. */
export function ThemeSettings({
  theme,
  canWrite,
  onTheme,
  onSave,
}: {
  theme: StoreTheme;
  canWrite: boolean;
  onTheme: (value: StoreTheme) => void;
  onSave: (patch: { theme: StoreTheme }) => void;
}) {
  function commit(next: StoreTheme) {
    const parsed = storeThemeSchema.safeParse(next);
    if (!parsed.success) {
      toast.error("Use a hex color like #0F766E.");
      return;
    }
    onSave({ theme: parsed.data });
  }

  return (
    <fieldset disabled={!canWrite} className="grid gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <Label htmlFor="store-secondary">Secondary color</Label>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <input
            id="store-secondary"
            type="color"
            className="h-9 shrink-0 cursor-pointer rounded-md border border-border bg-card"
            value={theme.secondaryColor}
            onChange={(event) => onTheme({ ...theme, secondaryColor: event.target.value })}
            onBlur={(event) => commit({ ...theme, secondaryColor: event.target.value })}
          />
          <span className="truncate font-mono text-xs uppercase text-muted">{theme.secondaryColor}</span>
        </div>
      </div>
      <div className="min-w-0">
        <Label htmlFor="store-font">Font</Label>
        <select
          id="store-font"
          className="mt-1 w-full rounded-md border border-border bg-card px-2"
          value={theme.font}
          onChange={(event) => {
            const next = { ...theme, font: event.target.value as StoreTheme["font"] };
            onTheme(next);
            commit(next);
          }}
        >
          {FONTS.map((font) => (
            <option key={font.value} value={font.value} style={{ fontFamily: font.family }}>
              {font.label}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

const PROVIDERS = [
  ["meta", "Meta Pixel", "123456789"],
  ["ga4", "Google Analytics 4", "G-XXXXXXXX"],
  ["clarity", "Microsoft Clarity", "Project ID"],
] as const;

export function TrackingSettings({
  tracking,
  canTrack,
  onSave,
  saving,
}: {
  tracking: StoreTrackingConfig;
  canTrack: boolean;
  saving: boolean;
  onSave: (patch: { tracking: StoreTrackingConfig }) => void;
}) {
  const [draft, setDraft] = useState(tracking ?? DEFAULT_STORE_TRACKING);
  const dirty = JSON.stringify(draft) !== JSON.stringify(tracking ?? DEFAULT_STORE_TRACKING);
  const activeCount = [draft.meta, draft.ga4, draft.clarity, draft.gtm].filter((provider) => provider.enabled).length;

  function saveTracking() {
    const result = storeTrackingSchema.safeParse(draft);
    if (!result.success) {
      toast.error(result.error.issues[0].message);
      return;
    }
    if ([draft.meta, draft.ga4, draft.clarity].some((p) => p.enabled && (!p.id || (p.delivery === "gtm" && (!draft.gtm.enabled || !draft.gtm.id))))) {
      toast.error("Enter an ID and enable GTM for GTM-managed providers.");
      return;
    }
    onSave({ tracking: result.data });
  }

  return (
    <fieldset disabled={!canTrack} className="space-y-4">
      {!canTrack ? <p className="text-xs text-muted">Only owners and admins can change tracking.</p> : null}
      <p className="text-xs text-muted">{activeCount ? `${activeCount} active` : "No tracking enabled"}</p>
      {PROVIDERS.map(([key, label, placeholder]) => (
        <div key={key} className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`tracking-${key}`} className="text-xs font-medium">{label}</label>
            <Switch
              aria-label={`Enable ${label}`}
              checked={draft[key].enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, [key]: { ...draft[key], enabled } })}
            />
          </div>
          {draft[key].enabled ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                id={`tracking-${key}`}
                placeholder={placeholder}
                value={draft[key].id}
                onChange={(event) => setDraft({ ...draft, [key]: { ...draft[key], id: event.target.value } })}
              />
              <select
                aria-label={`${label} delivery`}
                className="w-full rounded-md border border-border bg-card px-2"
                value={draft[key].delivery}
                onChange={(event) => setDraft({ ...draft, [key]: { ...draft[key], delivery: event.target.value as "direct" | "gtm" } })}
              >
                <option value="direct">Direct integration</option>
                <option value="gtm">Managed in GTM</option>
              </select>
            </div>
          ) : null}
        </div>
      ))}
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="tracking-gtm" className="text-xs font-medium">Google Tag Manager</label>
          <Switch
            aria-label="Enable Google Tag Manager"
            checked={draft.gtm.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, gtm: { ...draft.gtm, enabled } })}
          />
        </div>
        {draft.gtm.enabled ? (
          <>
            <Input id="tracking-gtm" placeholder="GTM-XXXXXXX" value={draft.gtm.id} onChange={(event) => setDraft({ ...draft, gtm: { ...draft.gtm, id: event.target.value } })} />
            <p className="text-xs text-muted">GTM receives ecommerce events only. Tags that need page or customer fields are not supported.</p>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button size="xs" type="button" disabled={!dirty || saving} onClick={saveTracking}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}Save tracking
        </Button>
        {dirty ? (
          <Button size="xs" type="button" variant="ghost" onClick={() => setDraft(tracking ?? DEFAULT_STORE_TRACKING)}>
            Discard
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

type BundleRow = BundleInput & { id: string };
const EMPTY: BundleInput = { name: "", pricingMode: "FIXED", priceValue: 1, published: false, sortOrder: 0, items: [] };
const MAX_BUNDLE_ITEMS = 8;
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

export function MarketplaceBundles({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient();
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BundleInput | null>(null);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<BundleRow | null>(null);
  const bundles = useQuery({ queryKey: ["inventory-bundles"], retry: false, queryFn: () => api<BundleRow[]>("/api/v1/inventory/bundles") });
  const products = useQuery({
    queryKey: ["bundle-products", search],
    enabled: Boolean(draft),
    queryFn: ({ signal }) => api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=100&active=true&q=${encodeURIComponent(search)}`, { signal }),
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (value: BundleInput) =>
      api(`/api/v1/inventory/bundles${editId ? `/${editId}` : ""}`, { method: editId ? "PATCH" : "POST", body: JSON.stringify(value) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["inventory-bundles"] });
      setDraft(null);
      setEditId(null);
      toast.success("Bundle saved.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/inventory/bundles/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["inventory-bundles"] });
      setDeleting(null);
      toast.success("Bundle deleted.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function setItem(product: ProductRecord, checked: boolean) {
    if (!draft) return;
    setNames((current) => ({ ...current, [product.id]: product.name }));
    setDraft({
      ...draft,
      items: checked ? [...draft.items, { productId: product.id, quantity: 1 }] : draft.items.filter((item) => item.productId !== product.id),
    });
  }

  const listed = products.data?.items ?? [];
  const listedIds = new Set(listed.map((product) => product.id));
  // Keep picks visible while the merchant searches for other products.
  const offscreen = (draft?.items ?? []).filter((item) => !listedIds.has(item.productId));

  return (
    <div>
      {bundles.isError ? (
        <p className="mb-2 text-xs text-red-600">Bundles are unavailable right now. Try again later.</p>
      ) : bundles.isPending ? (
        <p role="status" className="mb-2 text-xs text-muted">Loading bundles…</p>
      ) : !bundles.data?.length && !draft ? (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-dashed border-border p-3">
          <Package className="size-5 shrink-0 text-muted" aria-hidden />
          <p className="text-xs text-muted">Sell products together at a fixed price or a percentage off. Published bundles appear on your store.</p>
        </div>
      ) : null}
      {bundles.data?.length ? (
        <ul className="mb-3 divide-y divide-border">
          {bundles.data.map((bundle) => (
            <li key={bundle.id} className="flex min-w-0 items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{bundle.name}</p>
                <p className="text-xs text-muted">
                  {bundle.pricingMode === "FIXED" ? inr.format(bundle.priceValue) : `${bundle.priceValue}% off`} · {bundle.items.length} item{bundle.items.length === 1 ? "" : "s"}
                </p>
              </div>
              <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", bundle.published ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-zinc-500/10 text-muted")}>
                {bundle.published ? "Published" : "Draft"}
              </span>
              <Button disabled={!canWrite} size="icon-xs" variant="ghost" title="Edit bundle" aria-label={`Edit ${bundle.name}`} onClick={() => { setEditId(bundle.id); setDraft(bundle); }}>
                <Pencil />
              </Button>
              <Button disabled={!canWrite} size="icon-xs" variant="ghost" title="Delete bundle" aria-label={`Delete ${bundle.name}`} onClick={() => setDeleting(bundle)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {!draft ? (
        <Button disabled={!canWrite || bundles.isError} size="xs" variant="secondary" onClick={() => { setEditId(null); setDraft(EMPTY); setSearch(""); }}>
          <Plus />New bundle
        </Button>
      ) : (
        <fieldset disabled={!canWrite || save.isPending} className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold">{editId ? "Edit bundle" : "New bundle"}</p>
          <div>
            <Label htmlFor="bundle-name">Bundle name</Label>
            <Input id="bundle-name" className="mt-1" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="bundle-pricing">Pricing</Label>
              <select id="bundle-pricing" className="mt-1 w-full rounded-md border border-border bg-card px-2" value={draft.pricingMode} onChange={(event) => setDraft({ ...draft, pricingMode: event.target.value as "FIXED" | "PERCENT" })}>
                <option value="FIXED">Fixed price</option>
                <option value="PERCENT">Percent off</option>
              </select>
            </div>
            <div>
              <Label htmlFor="bundle-price">{draft.pricingMode === "FIXED" ? "Price (INR)" : "Discount (%)"}</Label>
              <Input id="bundle-price" className="mt-1" type="number" inputMode="decimal" min="0.01" step="0.01" max={draft.pricingMode === "PERCENT" ? 100 : undefined} value={draft.priceValue} onChange={(event) => setDraft({ ...draft, priceValue: Number(event.target.value) })} />
            </div>
          </div>
          <div className="grid grid-cols-2 items-end gap-2">
            <div>
              <Label htmlFor="bundle-order">Display order</Label>
              <Input id="bundle-order" className="mt-1" type="number" min="0" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} />
            </div>
            <label className="flex h-9 items-center gap-2 text-xs">
              <Switch checked={draft.published} onCheckedChange={(published) => setDraft({ ...draft, published })} />Published
            </label>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="bundle-search">Products</Label>
              <span className="text-xs text-muted">{draft.items.length} of {MAX_BUNDLE_ITEMS}</span>
            </div>
            <Input id="bundle-search" type="search" className="mt-1" placeholder="Search by name or SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {offscreen.map((item) => (
              <BundleItemRow
                key={item.productId}
                name={names[item.productId] ?? "Selected product"}
                checked
                quantity={item.quantity}
                onCheck={() => setDraft({ ...draft, items: draft.items.filter((row) => row.productId !== item.productId) })}
                onQuantity={(quantity) => setDraft({ ...draft, items: draft.items.map((row) => (row.productId === item.productId ? { ...row, quantity } : row)) })}
              />
            ))}
            {products.isPending ? <p role="status" className="text-xs text-muted">Loading products…</p> : null}
            {listed.map((product) => {
              const selected = draft.items.find((item) => item.productId === product.id);
              return (
                <BundleItemRow
                  key={product.id}
                  name={product.name}
                  checked={Boolean(selected)}
                  disabled={!selected && draft.items.length >= MAX_BUNDLE_ITEMS}
                  quantity={selected?.quantity}
                  onCheck={(checked) => setItem(product, checked)}
                  onQuantity={(quantity) => setDraft({ ...draft, items: draft.items.map((item) => (item.productId === product.id ? { ...item, quantity } : item)) })}
                />
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button
              size="xs"
              type="button"
              onClick={() => {
                const parsed = bundleInputSchema.safeParse(draft);
                if (!parsed.success) toast.error(parsed.error.issues[0].message);
                else save.mutate(parsed.data);
              }}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}Save bundle
            </Button>
            <Button size="xs" type="button" variant="ghost" onClick={() => { setDraft(null); setEditId(null); }}>Cancel</Button>
          </div>
        </fieldset>
      )}

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete bundle?</DialogTitle>
            <DialogDescription>
              “{deleting?.name}” is removed from your store. Products in it are not affected. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => setDeleting(null)}>Cancel</Button>
            <Button type="button" disabled={remove.isPending} className="bg-red-600 hover:bg-red-700" onClick={() => deleting && remove.mutate(deleting.id)}>
              {remove.isPending ? "Deleting…" : "Delete bundle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BundleItemRow({
  name,
  checked,
  disabled,
  quantity,
  onCheck,
  onQuantity,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  quantity?: number;
  onCheck: (checked: boolean) => void;
  onQuantity: (quantity: number) => void;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-md px-1 hover:bg-surface-soft">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        <input type="checkbox" className="size-4 accent-brand" checked={checked} disabled={disabled} onChange={(event) => onCheck(event.target.checked)} />
        <span className="truncate">{name}</span>
      </label>
      {checked ? (
        <Input
          aria-label={`Quantity of ${name}`}
          className="w-16"
          type="number"
          inputMode="numeric"
          min="1"
          max="99"
          value={quantity ?? 1}
          onChange={(event) => onQuantity(Math.min(99, Math.max(1, Math.trunc(Number(event.target.value) || 1))))}
        />
      ) : null}
    </div>
  );
}
