"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import type { Paginated, ProductRecord } from "@/types/api";
import { useDebounced } from "./store-address-field";

export type PickedProduct = { id: string; name: string; sku: string | null; imageUrl: string | null; visible: boolean; missing: boolean };

/**
 * Ordered product selection over the existing inventory (active + shown in store).
 * Products are only referenced by id; nothing is copied out of inventory.
 */
export function ProductPicker({
  id,
  label,
  ids,
  max,
  known,
  disabled,
  onChange,
  highlightFirst,
}: {
  id: string;
  label: string;
  ids: string[];
  max: number;
  /** Rows already resolved (e.g. featured summaries from the server). */
  known?: PickedProduct[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
  /** Visually separates the first N picks (e.g. the 8 shown in the featured row). */
  highlightFirst?: number;
}) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 250);
  const list = useQuery({
    queryKey: ["products", "store-builder-picker", term],
    queryFn: ({ signal }) =>
      api<Paginated<ProductRecord>>(`/api/v1/products?page=1&pageSize=50&active=true&storeVisible=true${term ? `&q=${encodeURIComponent(term)}` : ""}`, { signal }),
  });
  // Resolve picks the search list may not contain (other pages, hidden or deleted products).
  const unresolved = ids.filter((pid) => !known?.some((row) => row.id === pid));
  const selected = useQuery({
    queryKey: ["store-builder", "product-summaries", unresolved.join(",")],
    enabled: unresolved.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api<PickedProduct[]>(`/api/v1/inventory/storefront/builder/product-summaries?ids=${unresolved.join(",")}`, { signal }),
  });
  const byId = new Map<string, PickedProduct>();
  for (const row of [...(known ?? []), ...(selected.data ?? [])]) byId.set(row.id, row);
  for (const product of list.data?.items ?? []) {
    if (byId.has(product.id)) continue;
    byId.set(product.id, {
      id: product.id,
      name: product.name,
      sku: product.sku,
      imageUrl: product.imageUrls?.[0] ?? null,
      visible: product.active !== false && product.storeVisible !== false,
      missing: false,
    });
  }
  const rows = ids.map((pid) => byId.get(pid) ?? { id: pid, name: "Loading…", sku: null, imageUrl: null, visible: true, missing: false });
  const unavailable = rows.filter((row) => !row.visible);

  function toggle(productId: string, checked: boolean) {
    if (checked && ids.length >= max) return;
    onChange(checked ? [...new Set([...ids, productId])] : ids.filter((pid) => pid !== productId));
  }
  function move(index: number, direction: -1 | 1) {
    const to = index + direction;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        <span className="text-[11px] tabular-nums text-muted">{ids.length} of {max}</span>
      </div>
      {unavailable.length ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="flex-1">{unavailable.length} picked product{unavailable.length === 1 ? " is" : "s are"} hidden, inactive or deleted, so customers won’t see {unavailable.length === 1 ? "it" : "them"}.</p>
          {!disabled ? <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={() => onChange(ids.filter((pid) => !unavailable.some((row) => row.id === pid)))}>Remove</button> : null}
        </div>
      ) : null}
      {rows.length ? (
        <ol className="mt-2 space-y-1">
          {rows.map((row, index) => (
            <li key={row.id} className={cn("flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5", highlightFirst && index === highlightFirst && "mt-3")}>
              <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-muted">{index + 1}</span>
              {row.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.imageUrl} alt="" loading="lazy" className="size-8 shrink-0 rounded object-cover" />
              ) : (
                <span aria-hidden className="size-8 shrink-0 rounded bg-surface-soft" />
              )}
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-xs font-medium", !row.visible && "text-muted line-through")}>{row.name}</p>
                <p className="truncate text-[11px] text-muted">{row.missing ? "Deleted" : !row.visible ? "Hidden from store" : row.sku ?? ""}</p>
              </div>
              {!disabled ? (
                <div className="flex shrink-0 items-center">
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${row.name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${row.name} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${row.name}`} onClick={() => toggle(row.id, false)}><X /></Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted">Nothing picked yet.</p>
      )}
      {!disabled ? (
        <div className="mt-3">
          <Label htmlFor={`${id}-search`}>Add products</Label>
          <Input id={`${id}-search`} className="mt-1" type="search" placeholder="Search by name or SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
          {list.isError ? <Button size="xs" variant="ghost" className="mt-1" onClick={() => void list.refetch()}>Couldn’t load products. Retry</Button> : null}
          {list.isPending ? <p role="status" className="mt-2 text-xs text-muted">Loading products…</p> : null}
          {list.data && !list.data.items.length ? (
            <p className="mt-2 text-xs text-muted">
              {term ? "No matching products." : <>No visible products yet. Products must be active and shown in store. <Link href="/dashboard/inventory?tab=products" className="text-brand underline">Go to Products</Link></>}
            </p>
          ) : null}
          <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
            {(list.data?.items ?? []).map((product) => {
              const checked = ids.includes(product.id);
              return (
                <label key={product.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs transition-colors hover:bg-surface-soft">
                  <input type="checkbox" className="size-4 accent-brand" disabled={!checked && ids.length >= max} checked={checked} onChange={(event) => toggle(product.id, event.target.checked)} />
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  <span className="shrink-0 text-[11px] text-muted">{product.sku}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
