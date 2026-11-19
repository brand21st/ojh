"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, MoreHorizontal, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable, type DataTableColumn } from "@/components/dashboard/data-table";
import { LineItemThumb } from "@/components/dashboard/line-item-thumb";
import { ProductAiCopyBox } from "@/components/dashboard/product-ai-copy";
import { ProductAiStudioLauncher } from "@/components/dashboard/product-ai-studio";
import { emptyPhotoSlots, padPhotoSlots, ProductImageSlots } from "@/components/dashboard/product-image-slots";
import { SideSheet } from "@/components/dashboard/side-sheet";
import { ProductEditorFields } from "@/app/(site)/dashboard/inventory/product-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { asPaginated } from "@/lib/dashboard/records";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { api, toSearchParams } from "@/lib/hooks/use-api";
import { optimizeImageFile } from "@/lib/images/optimize-client";
import { createProductSchema, editProductFormSchema } from "@/modules/products/schema";
import { formatParcelSize } from "@/modules/shopify/dimensions";
import type { InventoryMovementRecord, Paginated, ProductRecord } from "@/types/api";

const PAGE_SIZE_OPTIONS = [10, 20, 50];
type CreateValues = z.infer<typeof createProductSchema>;
type EditValues = z.infer<typeof editProductFormSchema>;
type ProductRow = ProductRecord & Record<string, unknown>;

function stockBadge(product: ProductRecord) {
  const threshold = product.lowStockThreshold ?? 5;
  if (product.onHand <= 0) return <Badge variant="outline">Out of stock</Badge>;
  if (product.onHand <= threshold) return <Badge variant="warning">Low · {product.onHand}</Badge>;
  return <span className="tabular-nums">{product.onHand}</span>;
}

const FILTER_LABELS: Record<string, string> = {
  active: "Status",
  storeVisible: "Store",
  stock: "Stock",
  categoryId: "Category",
  prepaid: "Prepaid",
  cod: "COD",
  bestSeller: "Best seller",
  priceMin: "Price ≥",
  priceMax: "Price ≤",
  stockMin: "Stock ≥",
  stockMax: "Stock ≤",
  createdFrom: "Created from",
  createdTo: "Created to",
  updatedFrom: "Updated from",
  updatedTo: "Updated to",
};

const FILTER_VALUE_LABELS: Record<string, Record<string, string>> = {
  active: { true: "Active", false: "Inactive" },
  storeVisible: { true: "Published", false: "Hidden" },
  stock: { inStock: "Healthy", lowStock: "Low stock", outOfStock: "Out of stock" },
  bestSeller: { true: "Best sellers", false: "Other products" },
};

/** Shopify-style saved views over the existing server filters. */
const VIEWS = [
  { id: "all", label: "All", active: undefined, stock: undefined },
  { id: "active", label: "Active", active: "true", stock: undefined },
  { id: "inactive", label: "Inactive", active: "false", stock: undefined },
  { id: "low", label: "Low stock", active: undefined, stock: "lowStock" },
  { id: "out", label: "Out of stock", active: undefined, stock: "outOfStock" },
] as const;

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-1 h-11 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FilterNumber({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string | undefined) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        key={value}
        className="mt-1 h-11"
        type="number"
        min={0}
        defaultValue={value}
        onBlur={(event) => onCommit(event.target.value || undefined)}
      />
    </div>
  );
}

function FilterDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input className="mt-1 h-11" type="date" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export function InventoryProducts({
  canWrite,
  searchParams,
}: {
  canWrite: boolean;
  searchParams: URLSearchParams;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const page = Number(searchParams.get("page") || 1);
  const pageSize = Number(searchParams.get("pageSize") || 20);
  const q = searchParams.get("q") ?? "";
  const active = searchParams.get("active") || "all";
  const storeVisible = searchParams.get("storeVisible") || "all";
  const stock = searchParams.get("stock") || "all";
  const categoryId = searchParams.get("categoryId") || "all";
  const prepaid = searchParams.get("prepaid") || "all";
  const cod = searchParams.get("cod") || "all";
  const bestSeller = searchParams.get("bestSeller") || "all";
  const analyticsRange = searchParams.get("analyticsRange") || "all";
  const sort = searchParams.get("sort") || "newest";
  const priceMin = searchParams.get("priceMin") ?? "";
  const priceMax = searchParams.get("priceMax") ?? "";
  const stockMin = searchParams.get("stockMin") ?? "";
  const stockMax = searchParams.get("stockMax") ?? "";
  const createdFrom = searchParams.get("createdFrom") ?? "";
  const createdTo = searchParams.get("createdTo") ?? "";
  const updatedFrom = searchParams.get("updatedFrom") ?? "";
  const updatedTo = searchParams.get("updatedTo") ?? "";

  const [createOpen, setCreateOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<ProductRecord | null>(null);
  const [adjustProduct, setAdjustProduct] = useState<ProductRecord | null>(null);
  const [historyProduct, setHistoryProduct] = useState<ProductRecord | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("0");
  const [adjustNote, setAdjustNote] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [historyReason, setHistoryReason] = useState<string>("all");
  const [createFiles, setCreateFiles] = useState<Array<File | null>>([null, null, null]);
  const [createUrls, setCreateUrls] = useState<Array<string | null>>(emptyPhotoSlots());
  const [editUrls, setEditUrls] = useState<Array<string | null>>(emptyPhotoSlots());
  const [photoBusy, setPhotoBusy] = useState<number | null>(null);
  const [searchDraft, setSearchDraft] = useState(q);
  const searchTimer = useRef<number | null>(null);

  // Keep the box in sync when q changes from outside (tab switch, back/forward).
  useEffect(() => {
    if (searchTimer.current == null) setSearchDraft(q);
  }, [q]);

  const categoriesQuery = useQuery({
    queryKey: ["product-categories"],
    queryFn: () => api<Array<{ id: string; name: string; active: boolean }>>("/api/v1/inventory/categories"),
  });
  const catalogQuery = useQuery({
    queryKey: ["products", "picker"],
    queryFn: () => api<Paginated<ProductRecord>>("/api/v1/products?page=1&pageSize=100&active=true"),
  });
  const listQuery = useQuery({
    queryKey: [
      "products",
      page,
      pageSize,
      q,
      active,
      storeVisible,
      stock,
      categoryId,
      prepaid,
      cod,
      bestSeller,
      analyticsRange,
      priceMin,
      priceMax,
      stockMin,
      stockMax,
      createdFrom,
      createdTo,
      updatedFrom,
      updatedTo,
      sort,
    ],
    queryFn: () =>
      api<Paginated<ProductRecord>>(
        `/api/v1/products?${toSearchParams({
          page,
          pageSize,
          q,
          active,
          storeVisible,
          stock,
          categoryId: categoryId === "all" ? undefined : categoryId,
          prepaid,
          cod,
          bestSeller,
          analyticsRange,
          priceMin: priceMin || undefined,
          priceMax: priceMax || undefined,
          stockMin: stockMin || undefined,
          stockMax: stockMax || undefined,
          createdFrom: createdFrom || undefined,
          createdTo: createdTo || undefined,
          updatedFrom: updatedFrom || undefined,
          updatedTo: updatedTo || undefined,
          sort,
        })}`
      ),
    placeholderData: keepPreviousData,
  });
  const pageData = asPaginated<ProductRecord>(listQuery.data);
  const rows = (pageData.items ?? []) as ProductRow[];

  const movements = useQuery({
    queryKey: ["inventory-movements", historyProduct?.id, historyReason],
    enabled: Boolean(historyProduct?.id),
    queryFn: () =>
      api<Paginated<InventoryMovementRecord>>(
        `/api/v1/inventory/movements?${toSearchParams({
          productId: historyProduct?.id,
          reason: historyReason === "all" ? undefined : historyReason,
          page: 1,
          pageSize: 50,
        })}`
      ),
  });

  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createProductSchema) as never,
    defaultValues: {
      name: "",
      sku: "",
      price: 0,
      weightGrams: 0,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      openingStock: 0,
      prepaidEnabled: true,
      codEnabled: true,
      codAdvancePercent: 0,
      returnAvailable: true,
      compareAtPrice: null,
      description: "",
      storeVisible: true,
      featured: false,
      lowStockThreshold: 5,
      categoryIds: [],
      upsellProductIds: [],
      crossSellProductIds: [],
    },
  });
  const editForm = useForm<EditValues>({
    resolver: zodResolver(editProductFormSchema) as never,
  });

  function setParams(patch: Record<string, string | number | undefined>) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "products");
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "" || value === "all") next.delete(key);
      else next.set(key, String(value));
    }
    router.replace(`/dashboard/inventory?${next.toString()}`);
  }

  function revokeIfBlob(url: string | null | undefined) {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  function resetCreatePhotos() {
    createUrls.forEach(revokeIfBlob);
    setCreateFiles([null, null, null]);
    setCreateUrls(emptyPhotoSlots());
  }

  function moveItem<T>(items: T[], from: number, to: number) {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }

  function reorderCreatePhotos(from: number, to: number) {
    setCreateFiles((current) => moveItem(current, from, to));
    setCreateUrls((current) => moveItem(current, from, to));
  }

  async function reorderSavedPhotos(from: number, to: number) {
    if (!editProduct) return;
    const reordered = moveItem(editUrls, from, to);
    setEditUrls(reordered);
    setPhotoBusy(to);
    try {
      const next = await api<ProductRecord>(`/api/v1/products/${editProduct.id}`, {
        method: "PATCH",
        body: JSON.stringify({ imageUrls: reordered.filter((url): url is string => Boolean(url)) }),
      });
      setEditProduct(next);
      setEditUrls(padPhotoSlots(next.imageUrls));
      queryClient.invalidateQueries({ queryKey: ["products"] });
    } catch (error) {
      setEditUrls(padPhotoSlots(editProduct.imageUrls));
      toast.error(error instanceof Error ? error.message : "Could not reorder photos.");
    } finally {
      setPhotoBusy(null);
    }
  }

  async function uploadProductPhoto(id: string, file: File, slot?: number) {
    const optimized = await optimizeImageFile(file, { maxWidth: 1200, maxHeight: 1200 });
    const body = new FormData();
    body.append("image", optimized);
    if (slot != null) body.append("slot", String(slot));
    return api<ProductRecord>(`/api/v1/products/${id}/images`, { method: "POST", body });
  }

  const createMutation = useMutation({
    mutationFn: async (values: CreateValues) => {
      const created = await api<ProductRecord>("/api/v1/products", {
        method: "POST",
        body: JSON.stringify(values),
      });
      // The product exists from here on: a failed photo must not surface as a failed create,
      // or a retry would create a duplicate (or hit the SKU conflict).
      let failedPhotos = 0;
      for (const [slot, file] of createFiles.entries()) {
        if (!file) continue;
        try {
          await uploadProductPhoto(created.id, file, slot);
        } catch {
          failedPhotos += 1;
        }
      }
      return { created, failedPhotos };
    },
    onSuccess: ({ created, failedPhotos }) => {
      if (failedPhotos) {
        toast.warning(
          `Product added, but ${failedPhotos} photo${failedPhotos === 1 ? "" : "s"} did not upload. Add them from the product editor.`
        );
      } else {
        toast.success("Product added.");
      }
      setCreateOpen(false);
      resetCreatePhotos();
      createForm.reset();
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-analytics"] });
      if (failedPhotos) void api<ProductRecord>(`/api/v1/products/${created.id}`).then(openEdit).catch(() => undefined);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: EditValues }) =>
      api<ProductRecord>(`/api/v1/products/${id}`, { method: "PATCH", body: JSON.stringify(values) }),
    onSuccess: () => {
      toast.success("Product updated.");
      setEditProduct(null);
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const adjustMutation = useMutation({
    mutationFn: (input: { id: string; quantityDelta: number; note?: string }) =>
      api(`/api/v1/products/${input.id}/adjustments`, {
        method: "POST",
        body: JSON.stringify({ quantityDelta: input.quantityDelta, note: input.note, reason: "ADJUSTMENT" }),
      }),
    onSuccess: () => {
      toast.success("Stock updated.");
      setAdjustProduct(null);
      setAdjustDelta("0");
      setAdjustNote("");
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-analytics"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const bulkMutation = useMutation({
    mutationFn: (patch: { active?: boolean; storeVisible?: boolean }) =>
      api("/api/v1/products/bulk", { method: "POST", body: JSON.stringify({ ids: selectedIds, ...patch }) }),
    onSuccess: () => {
      toast.success("Products updated.");
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function refreshAfterProductDelete() {
    queryClient.invalidateQueries({ queryKey: ["products"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-analytics"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-bundles"] });
    queryClient.invalidateQueries({ queryKey: ["product-categories"] });
  }

  async function deleteProductRow(row: ProductRow) {
    if (!window.confirm(`Delete ${row.name}? It will leave the catalog. Past orders keep their line items.`)) return;
    try {
      await api(`/api/v1/products/${row.id}`, { method: "DELETE" });
      toast.success("Product deleted.");
      setSelectedIds((current) => current.filter((id) => id !== row.id));
      refreshAfterProductDelete();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete product.");
    }
  }

  async function deleteSelectedProducts() {
    if (!selectedIds.length) return;
    const ids = [...selectedIds];
    if (!window.confirm(`Delete ${ids.length} product${ids.length === 1 ? "" : "s"}? They will leave the catalog. Past orders keep their line items. This cannot be undone.`)) return;
    const results = await Promise.allSettled(ids.map((id) => api(`/api/v1/products/${id}`, { method: "DELETE" })));
    const failedIds = ids.filter((_, index) => results[index].status === "rejected");
    const deleted = ids.length - failedIds.length;
    if (!failedIds.length) {
      toast.success(deleted === 1 ? "Product deleted." : `${deleted} products deleted.`);
    } else {
      const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      toast.error(
        `${deleted} deleted, ${failedIds.length} could not be deleted${firstError instanceof Error ? `: ${firstError.message}` : "."}`
      );
    }
    // Keep only the failures selected so the merchant can retry them.
    setSelectedIds(failedIds);
    refreshAfterProductDelete();
  }

  function openEdit(product: ProductRecord) {
    setEditProduct(product);
    setEditUrls(padPhotoSlots(product.imageUrls));
    editForm.reset({
      name: product.name,
      sku: product.sku,
      price: product.price,
      compareAtPrice: product.compareAtPrice ?? null,
      description: product.description ?? "",
      weightGrams: product.weightGrams,
      lengthCm: product.lengthCm ?? null,
      widthCm: product.widthCm ?? null,
      heightCm: product.heightCm ?? null,
      prepaidEnabled: product.prepaidEnabled,
      codEnabled: product.codEnabled,
      codAdvancePercent: product.codAdvancePercent,
      returnAvailable: product.returnAvailable !== false,
      storeVisible: product.storeVisible !== false,
      featured: Boolean(product.featured),
      active: product.active,
      lowStockThreshold: product.lowStockThreshold ?? 5,
      categoryIds: product.categoryIds ?? [],
      upsellProductIds: product.upsellProductIds ?? [],
      crossSellProductIds: product.crossSellProductIds ?? [],
    });
  }

  const storeUrl = useQuery({
    queryKey: ["inventory-storefront"],
    queryFn: () => api<{ storeUrl: string }>("/api/v1/inventory/storefront"),
    staleTime: 5 * 60_000,
  });
  const categoryNames = useMemo(
    () => new Map((categoriesQuery.data ?? []).map((category) => [category.id, category.name])),
    [categoriesQuery.data]
  );

  function productStoreUrl(row: ProductRecord) {
    const base = storeUrl.data?.storeUrl;
    if (!base) return null;
    if (row.publicSlug && row.active && row.storeVisible !== false) return `${base}/products/${row.publicSlug}`;
    return null;
  }

  const columns = useMemo<DataTableColumn<ProductRow>[]>(
    () => [
      {
        id: "product",
        header: "Product",
        fill: true,
        cell: (row) => (
          <div className="flex items-center gap-3">
            <LineItemThumb title={row.name} imageUrl={row.imageUrls?.[0]} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate font-medium">{row.name}</p>
                {row.bestSeller ? (
                  <Badge variant="warning">
                    <Flame className="mr-1 size-3" /> Best seller
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted">{row.sku}</p>
              {row.lengthCm && row.widthCm && row.heightCm ? (
                <p className="text-xs text-muted">{formatParcelSize(Number(row.lengthCm), Number(row.widthCm), Number(row.heightCm))}</p>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: "pricing",
        header: "Pricing",
        hug: true,
        cell: (row) => {
          const discount =
            row.compareAtPrice && row.compareAtPrice > row.price
              ? Math.round(((row.compareAtPrice - row.price) / row.compareAtPrice) * 100)
              : 0;
          return (
            <div>
              <p className="font-medium tabular-nums">{formatCurrency(row.price)}</p>
              {row.compareAtPrice ? (
                <p className="text-xs text-muted">
                  <span className="line-through">{formatCurrency(row.compareAtPrice)}</span>
                  {discount ? ` · ${discount}% off` : ""}
                </p>
              ) : null}
            </div>
          );
        },
      },
      { id: "stock", header: "Stock", hug: true, cell: (row) => stockBadge(row) },
      {
        id: "category",
        header: "Category",
        hug: true,
        cell: (row) => {
          const names = (row.categoryIds ?? []).map((id) => categoryNames.get(id)).filter(Boolean) as string[];
          if (!names.length) return <span className="text-xs text-muted">—</span>;
          return (
            <span className="text-xs" title={names.join(", ")}>
              {names[0]}
              {names.length > 1 ? <span className="text-muted"> +{names.length - 1}</span> : null}
            </span>
          );
        },
      },
      {
        id: "performance",
        header: "Performance",
        hug: true,
        cell: (row) => (
          <div className="text-xs">
            <p><span className="font-semibold tabular-nums">{formatNumber(row.orderCount ?? 0)}</span> orders</p>
            <p className="text-muted"><span className="tabular-nums">{formatNumber(row.unitsSold ?? 0)}</span> units</p>
          </div>
        ),
      },
      {
        id: "payment",
        header: "Payment",
        hug: true,
        cell: (row) => (
          <div className="text-xs">
            <p>{row.prepaidEnabled ? "Prepaid" : "No prepaid"}</p>
            <p className="text-muted">{row.codEnabled ? `COD · ${row.codAdvancePercent}% advance` : "No COD"}</p>
          </div>
        ),
      },
      {
        id: "store",
        header: "Store",
        hug: true,
        cell: (row) => (row.storeVisible === false ? <Badge variant="outline">Hidden</Badge> : <Badge variant="brand">Published</Badge>),
      },
      {
        id: "status",
        header: "Status",
        hug: true,
        cell: (row) => (row.active ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Inactive</Badge>),
      },
      {
        id: "actions",
        header: "",
        hug: true,
        cell: (row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Actions for ${row.name}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            {/* Portal events still bubble through React to the row's click-to-edit handler. */}
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              {canWrite ? <DropdownMenuItem onClick={() => openEdit(row)}>Edit</DropdownMenuItem> : null}
              {canWrite ? <DropdownMenuItem onClick={() => setAdjustProduct(row)}>Adjust stock</DropdownMenuItem> : null}
              <DropdownMenuItem onClick={() => setHistoryProduct(row)}>Stock history</DropdownMenuItem>
              {productStoreUrl(row) ? (
                <DropdownMenuItem asChild>
                  <a href={productStoreUrl(row)!} target="_blank" rel="noreferrer">
                    View on store
                  </a>
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <DropdownMenuItem
                  onClick={async () => {
                    try {
                      await api(`/api/v1/products/${row.id}/duplicate`, { method: "POST" });
                      toast.success("Product duplicated.");
                      queryClient.invalidateQueries({ queryKey: ["products"] });
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Could not duplicate.");
                    }
                  }}
                >
                  Duplicate
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({
                      id: row.id,
                      values: { storeVisible: row.storeVisible === false } as EditValues,
                    })
                  }
                >
                  {row.storeVisible === false ? "Publish" : "Hide"}
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <DropdownMenuItem
                  onClick={() =>
                    updateMutation.mutate({
                      id: row.id,
                      values: { active: !row.active } as EditValues,
                    })
                  }
                >
                  {row.active ? "Deactivate" : "Activate"}
                </DropdownMenuItem>
              ) : null}
              {canWrite ? <DropdownMenuSeparator /> : null}
              {canWrite ? (
                <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => void deleteProductRow(row)}>
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, queryClient, storeUrl.data?.storeUrl, categoryNames]
  );

  const currentView = VIEWS.find(
    (view) => (view.active ?? "all") === active && (view.stock ?? "all") === stock
  )?.id;

  function filterChipLabel(key: string, value: string) {
    const label = FILTER_LABELS[key] ?? key;
    if (key === "categoryId") return `${label}: ${categoryNames.get(value) ?? "Unknown"}`;
    if (key.endsWith("From") || key.endsWith("To")) return `${label}: ${formatDate(value)}`;
    if (key.startsWith("price")) return `${label} ${formatCurrency(Number(value))}`;
    if (key.startsWith("stock") && key !== "stock") return `${label} ${value}`;
    const mapped = FILTER_VALUE_LABELS[key]?.[value];
    if (mapped) return `${label}: ${mapped}`;
    return `${label}: ${value === "true" ? "Enabled" : value === "false" ? "Disabled" : value}`;
  }

  const after = Number(adjustProduct?.onHand ?? 0) + Number(adjustDelta || 0);
  const filterKeys = [
    "active",
    "storeVisible",
    "stock",
    "categoryId",
    "prepaid",
    "cod",
    "bestSeller",
    "priceMin",
    "priceMax",
    "stockMin",
    "stockMax",
    "createdFrom",
    "createdTo",
    "updatedFrom",
    "updatedTo",
  ] as const;
  const activeFilters = filterKeys
    .map((key) => ({ key, value: searchParams.get(key) }))
    .filter((item): item is { key: (typeof filterKeys)[number]; value: string } => Boolean(item.value));

  function clearFilters() {
    setParams(Object.fromEntries(filterKeys.map((key) => [key, undefined])));
  }

  function dateValue(key: string) {
    const value = searchParams.get(key);
    return value ? value.slice(0, 10) : "";
  }

  function setDate(key: string, value: string, endOfDay = false) {
    setParams({
      [key]: value
        ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString()
        : undefined,
      page: 1,
    });
  }

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Product views" className="-mb-1 flex gap-1 overflow-x-auto">
        {VIEWS.map((view) => {
          const selected = currentView === view.id;
          return (
            <button
              key={view.id}
              type="button"
              aria-pressed={selected}
              className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                selected ? "bg-ink/[0.07] text-ink" : "text-muted hover:bg-surface-soft hover:text-ink"
              }`}
              onClick={() => setParams({ active: view.active, stock: view.stock, page: 1 })}
            >
              {view.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input
            className="h-9 pl-9 pr-24 text-sm"
            placeholder="Search products or SKU"
            aria-label="Search products or SKU"
            value={searchDraft}
            onChange={(event) => {
              const value = event.target.value;
              setSearchDraft(value);
              if (searchTimer.current) window.clearTimeout(searchTimer.current);
              searchTimer.current = window.setTimeout(() => {
                searchTimer.current = null;
                setParams({ q: value.trim(), page: 1 });
              }, 300);
            }}
          />
          {listQuery.isFetching && q ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted" aria-live="polite">Searching…</span>
          ) : null}
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setFiltersOpen(true)}>
          <SlidersHorizontal className="size-4" />
          Filters
          {activeFilters.length ? <Badge variant="brand">{activeFilters.length}</Badge> : null}
        </Button>
        <Select value={sort} onValueChange={(value) => setParams({ sort: value, page: 1 })}>
          <SelectTrigger className="h-9 w-full text-xs sm:w-[170px]"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
            <SelectItem value="nameAsc">Name A → Z</SelectItem>
            <SelectItem value="nameDesc">Name Z → A</SelectItem>
            <SelectItem value="priceAsc">Price low → high</SelectItem>
            <SelectItem value="priceDesc">Price high → low</SelectItem>
            <SelectItem value="stockAsc">Stock low → high</SelectItem>
            <SelectItem value="stockDesc">Stock high → low</SelectItem>
            <SelectItem value="orders">Most orders</SelectItem>
            <SelectItem value="units">Most units sold</SelectItem>
            <SelectItem value="bestSeller">Best sellers</SelectItem>
          </SelectContent>
        </Select>
        <Select value={analyticsRange} onValueChange={(value) => setParams({ analyticsRange: value, page: 1 })}>
          <SelectTrigger className="h-9 w-full text-xs sm:w-[140px]"><SelectValue placeholder="Sales period" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All-time sales</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
        {canWrite ? (
          <Button className="ml-auto" size="sm" type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Add product
          </Button>
        ) : null}
      </div>

      {activeFilters.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map(({ key, value }) => (
            <button
              key={key}
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-3 text-xs font-medium hover:bg-surface-soft"
              aria-label={`Remove filter ${filterChipLabel(key, value)}`}
              onClick={() => setParams({ [key]: undefined, page: 1 })}
            >
              {filterChipLabel(key, value)}
              <X className="size-3" aria-hidden="true" />
            </button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>Clear all</Button>
        </div>
      ) : null}

      {selectedIds.length && canWrite ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2">
          <p className="text-sm font-medium" aria-live="polite">{selectedIds.length} selected</p>
          {/* Reversible actions run straight away (Shopify-style); only delete asks to confirm. */}
          <Button size="sm" variant="secondary" disabled={bulkMutation.isPending} onClick={() => bulkMutation.mutate({ storeVisible: true })}>
            Publish
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkMutation.isPending} onClick={() => bulkMutation.mutate({ storeVisible: false })}>
            Hide
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkMutation.isPending} onClick={() => bulkMutation.mutate({ active: true })}>
            Activate
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkMutation.isPending} onClick={() => bulkMutation.mutate({ active: false })}>
            Deactivate
          </Button>
          <Button size="sm" variant="secondary" className="text-red-600" disabled={bulkMutation.isPending} onClick={() => void deleteSelectedProducts()}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelectedIds([])}>
            Clear selection
          </Button>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        loading={listQuery.isLoading}
        fetching={listQuery.isFetching}
        error={listQuery.error as Error | null}
        emptyTitle="Add your first product"
        emptyDescription="Add a product to manage SKU, price, weight, and stock."
        emptyAction={
          canWrite ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Add product
            </Button>
          ) : undefined
        }
        page={pageData.page || page}
        pageSize={pageData.pageSize || pageSize}
        total={pageData.total}
        onPageChange={(next) => setParams({ page: next })}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setParams({ pageSize: size, page: 1 })}
        selectable={canWrite}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        getRowId={(row) => row.id}
        onRowClick={canWrite ? (row) => openEdit(row) : undefined}
        stackBelow="lg"
        mobileView={
          <div className="grid gap-3">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl border border-border bg-card p-3 shadow-sm">
                <div className="flex gap-3">
                  <LineItemThumb title={row.name} imageUrl={row.imageUrls?.[0]} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="font-semibold">{row.name}</p>
                      {row.bestSeller ? <Badge variant="warning">Best seller</Badge> : null}
                    </div>
                    <p className="text-xs text-muted">{row.sku}</p>
                    {row.lengthCm && row.widthCm && row.heightCm ? (
                      <p className="text-xs text-muted">{formatParcelSize(Number(row.lengthCm), Number(row.widthCm), Number(row.heightCm))}</p>
                    ) : null}
                    <p className="mt-1 text-sm font-medium">{formatCurrency(row.price)}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {stockBadge(row)}
                      <span className="text-xs text-muted">
                        {formatNumber(row.orderCount ?? 0)} orders · {formatNumber(row.unitsSold ?? 0)} units
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {canWrite ? <Button size="sm" variant="secondary" onClick={() => openEdit(row)}>Edit</Button> : null}
                  {canWrite ? <Button size="sm" variant="secondary" onClick={() => setAdjustProduct(row)}>Adjust</Button> : null}
                  <Button size="sm" variant="secondary" onClick={() => setHistoryProduct(row)}>History</Button>
                  {canWrite ? (
                    <Button size="sm" variant="secondary" className="text-red-600" onClick={() => void deleteProductRow(row)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        }
      />

      <SideSheet
        open={filtersOpen}
        title="Advanced filters"
        description="Filters and sorting run on the server, so large catalogs stay fast."
        onClose={() => setFiltersOpen(false)}
        footer={
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={clearFilters}>Clear all</Button>
            <Button type="button" onClick={() => setFiltersOpen(false)}>Show products</Button>
          </div>
        }
      >
        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Catalog state</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <FilterSelect
                label="Product status"
                value={active}
                onChange={(value) => setParams({ active: value, page: 1 })}
                options={[
                  ["all", "All statuses"],
                  ["true", "Active"],
                  ["false", "Inactive"],
                ]}
              />
              <FilterSelect
                label="Store visibility"
                value={storeVisible}
                onChange={(value) => setParams({ storeVisible: value, page: 1 })}
                options={[
                  ["all", "All visibility"],
                  ["true", "Published"],
                  ["false", "Hidden"],
                ]}
              />
              <FilterSelect
                label="Stock state"
                value={stock}
                onChange={(value) => setParams({ stock: value, page: 1 })}
                options={[
                  ["all", "All stock"],
                  ["inStock", "Healthy"],
                  ["lowStock", "Low stock"],
                  ["outOfStock", "Out of stock"],
                ]}
              />
              <FilterSelect
                label="Category"
                value={categoryId}
                onChange={(value) => setParams({ categoryId: value, page: 1 })}
                options={[
                  ["all", "All categories"],
                  ...(categoriesQuery.data ?? []).map((category) => [category.id, category.name] as [string, string]),
                ]}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Payments and performance</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <FilterSelect
                label="Prepaid"
                value={prepaid}
                onChange={(value) => setParams({ prepaid: value, page: 1 })}
                options={[["all", "Any"], ["true", "Enabled"], ["false", "Disabled"]]}
              />
              <FilterSelect
                label="COD"
                value={cod}
                onChange={(value) => setParams({ cod: value, page: 1 })}
                options={[["all", "Any"], ["true", "Enabled"], ["false", "Disabled"]]}
              />
              <FilterSelect
                label="Best seller"
                value={bestSeller}
                onChange={(value) => setParams({ bestSeller: value, page: 1 })}
                options={[["all", "Any"], ["true", "Best sellers"], ["false", "Other products"]]}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Price and stock range</h3>
            <div className="grid grid-cols-2 gap-3">
              <FilterNumber label="Minimum price" value={priceMin} onCommit={(value) => setParams({ priceMin: value, page: 1 })} />
              <FilterNumber label="Maximum price" value={priceMax} onCommit={(value) => setParams({ priceMax: value, page: 1 })} />
              <FilterNumber label="Minimum stock" value={stockMin} onCommit={(value) => setParams({ stockMin: value, page: 1 })} />
              <FilterNumber label="Maximum stock" value={stockMax} onCommit={(value) => setParams({ stockMax: value, page: 1 })} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Dates</h3>
            <div className="grid grid-cols-2 gap-3">
              <FilterDate label="Created from" value={dateValue("createdFrom")} onChange={(value) => setDate("createdFrom", value)} />
              <FilterDate label="Created to" value={dateValue("createdTo")} onChange={(value) => setDate("createdTo", value, true)} />
              <FilterDate label="Updated from" value={dateValue("updatedFrom")} onChange={(value) => setDate("updatedFrom", value)} />
              <FilterDate label="Updated to" value={dateValue("updatedTo")} onChange={(value) => setDate("updatedTo", value, true)} />
            </div>
          </section>
        </div>
      </SideSheet>

      <SideSheet
        open={createOpen}
        title="Add product"
        description="Catalog price and weight are copied onto new order lines."
        onClose={() => {
          setCreateOpen(false);
          resetCreatePhotos();
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCreateOpen(false);
                resetCreatePhotos();
              }}
            >
              Cancel
            </Button>
            <Button type="button" disabled={createMutation.isPending} onClick={createForm.handleSubmit((values) => createMutation.mutate(values))}>
              {createMutation.isPending ? "Saving…" : "Save product"}
            </Button>
          </div>
        }
      >
        <form className="space-y-4" onSubmit={createForm.handleSubmit((values) => createMutation.mutate(values))}>
          <ProductImageSlots
            urls={createUrls}
            disabled={!canWrite || createMutation.isPending}
            onSetCover={(slot) => reorderCreatePhotos(slot, 0)}
            onReorder={reorderCreatePhotos}
            onPick={(slot, file) => {
              setCreateFiles((current) => {
                const next = [...current];
                next[slot] = file;
                return next;
              });
              setCreateUrls((current) => {
                const next = [...current];
                if (next[slot]?.startsWith("blob:")) URL.revokeObjectURL(next[slot]!);
                next[slot] = URL.createObjectURL(file);
                return next;
              });
            }}
            onRemove={(slot) => {
              setCreateFiles((current) => {
                const next = [...current];
                next[slot] = null;
                return next;
              });
              setCreateUrls((current) => {
                const next = [...current];
                if (next[slot]?.startsWith("blob:")) URL.revokeObjectURL(next[slot]!);
                next[slot] = null;
                return next;
              });
            }}
          />
          {canWrite ? (
            <ProductAiStudioLauncher
              files={createFiles}
              urls={createUrls}
              productName={String(createForm.watch("name") ?? "")}
              price={Number(createForm.watch("price") || 0)}
              compareAtPrice={createForm.watch("compareAtPrice") ? Number(createForm.watch("compareAtPrice")) : null}
              disabled={createMutation.isPending}
              onApplyFiles={(nextFiles) => {
                setCreateFiles((current) => {
                  const next = [...current];
                  nextFiles.slice(0, 3).forEach((file, index) => {
                    next[index] = file;
                  });
                  return next;
                });
                setCreateUrls((current) => {
                  const next = [...current];
                  nextFiles.slice(0, 3).forEach((file, index) => {
                    if (next[index]?.startsWith("blob:")) URL.revokeObjectURL(next[index]!);
                    next[index] = URL.createObjectURL(file);
                  });
                  return next;
                });
              }}
            />
          ) : null}
          <ProductAiCopyBox
            form={createForm}
            files={createFiles}
            urls={createUrls}
            disabled={!canWrite || createMutation.isPending}
          />
          <ProductEditorFields
            form={createForm}
            showOpening
            categories={categoriesQuery.data ?? []}
            catalog={(catalogQuery.data?.items ?? []).map((item) => ({ id: item.id, name: item.name, sku: item.sku }))}
          />
        </form>
      </SideSheet>

      <SideSheet
        open={Boolean(editProduct)}
        title="Edit product"
        description="Changing price or weight does not update existing orders."
        onClose={() => {
          setEditProduct(null);
          setEditUrls(emptyPhotoSlots());
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditProduct(null);
                setEditUrls(emptyPhotoSlots());
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={updateMutation.isPending || photoBusy != null}
              onClick={editForm.handleSubmit((values) => {
                if (!editProduct) return;
                updateMutation.mutate({ id: editProduct.id, values });
              })}
            >
              {updateMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        }
      >
        {editProduct ? (
          <form className="space-y-4">
            <ProductImageSlots
              urls={editUrls}
              disabled={!canWrite || updateMutation.isPending}
              busySlot={photoBusy}
              onSetCover={(slot) => void reorderSavedPhotos(slot, 0)}
              onReorder={(from, to) => void reorderSavedPhotos(from, to)}
              onPick={async (slot, file) => {
                setPhotoBusy(slot);
                try {
                  const filled = Boolean(editUrls[slot]);
                  const next = await uploadProductPhoto(editProduct.id, file, filled ? slot : undefined);
                  setEditProduct(next);
                  setEditUrls(padPhotoSlots(next.imageUrls));
                  queryClient.invalidateQueries({ queryKey: ["products"] });
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not upload that photo.");
                } finally {
                  setPhotoBusy(null);
                }
              }}
              onRemove={async (slot) => {
                if (!editUrls[slot]) return;
                setPhotoBusy(slot);
                try {
                  const next = await api<ProductRecord>(`/api/v1/products/${editProduct.id}/images?slot=${slot}`, {
                    method: "DELETE",
                  });
                  setEditProduct(next);
                  setEditUrls(padPhotoSlots(next.imageUrls));
                  queryClient.invalidateQueries({ queryKey: ["products"] });
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not remove that photo.");
                } finally {
                  setPhotoBusy(null);
                }
              }}
            />
            {canWrite ? (
              <ProductAiStudioLauncher
                files={[null, null, null]}
                urls={editUrls}
                productId={editProduct.id}
                productName={String(editForm.watch("name") ?? "")}
                price={Number(editForm.watch("price") || 0)}
                compareAtPrice={editForm.watch("compareAtPrice") ? Number(editForm.watch("compareAtPrice")) : null}
                disabled={updateMutation.isPending || photoBusy != null}
                onAttached={() => {
                  queryClient.invalidateQueries({ queryKey: ["products"] });
                  void api<ProductRecord>(`/api/v1/products/${editProduct.id}`).then((next) => {
                    setEditProduct(next);
                    setEditUrls(padPhotoSlots(next.imageUrls));
                  });
                }}
              />
            ) : null}
            <ProductAiCopyBox
              form={editForm}
              files={[null, null, null]}
              urls={editUrls}
              disabled={!canWrite || updateMutation.isPending || photoBusy != null}
            />
            <ProductEditorFields
              form={editForm}
              showOpening={false}
              categories={categoriesQuery.data ?? []}
              catalog={(catalogQuery.data?.items ?? [])
                .filter((item) => item.id !== editProduct.id)
                .map((item) => ({ id: item.id, name: item.name, sku: item.sku }))}
            />
          </form>
        ) : null}
      </SideSheet>

      <Dialog open={Boolean(adjustProduct)} onOpenChange={(open) => !open && setAdjustProduct(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust stock</DialogTitle>
            <DialogDescription>
              {adjustProduct?.name} · current stock {adjustProduct?.onHand ?? 0}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="adjust-delta">Adjustment</Label>
              <Input id="adjust-delta" className="mt-1 h-11" type="number" value={adjustDelta} onChange={(event) => setAdjustDelta(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="adjust-note">Reason</Label>
              <Textarea id="adjust-note" className="mt-1 min-h-[80px]" placeholder="Purchase, correction, damaged, restock…" value={adjustNote} onChange={(event) => setAdjustNote(event.target.value)} />
            </div>
            <p className="rounded-xl bg-surface-soft px-3 py-2 text-sm">
              Preview: {adjustProduct?.onHand ?? 0} → {Number.isFinite(after) ? after : "—"}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAdjustProduct(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={adjustMutation.isPending || Number(adjustDelta) === 0 || after < 0}
              onClick={() => {
                if (!adjustProduct) return;
                adjustMutation.mutate({ id: adjustProduct.id, quantityDelta: Number(adjustDelta), note: adjustNote });
              }}
            >
              {adjustMutation.isPending ? "Saving…" : "Confirm adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(historyProduct)} onOpenChange={(open) => !open && setHistoryProduct(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Stock history</DialogTitle>
            <DialogDescription>
              {historyProduct?.name} · SKU {historyProduct?.sku}
            </DialogDescription>
          </DialogHeader>
          <Select value={historyReason} onValueChange={setHistoryReason}>
            <SelectTrigger className="h-11 w-full sm:w-[220px]"><SelectValue placeholder="Reason" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              <SelectItem value="OPENING">Opening</SelectItem>
              <SelectItem value="ADJUSTMENT">Adjustment</SelectItem>
              <SelectItem value="ORDER_COMMIT">Order commit</SelectItem>
              <SelectItem value="ORDER_RELEASE">Order release</SelectItem>
              <SelectItem value="RTO_RETURN">RTO return</SelectItem>
            </SelectContent>
          </Select>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-2">Date</th>
                  <th>Type</th>
                  <th>Qty</th>
                  <th>After</th>
                  <th>Note / order</th>
                </tr>
              </thead>
              <tbody>
                {(movements.data?.items ?? []).map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2">{formatDate(row.createdAt, true)}</td>
                    <td>{row.reason}</td>
                    <td className="tabular-nums">{row.quantityDelta > 0 ? "+" : ""}{row.quantityDelta}</td>
                    <td className="tabular-nums">{row.balanceAfter}</td>
                    <td>
                      {row.orderId ? (
                        <a className="text-brand" href={`/dashboard/orders/${row.orderId}`}>Order</a>
                      ) : (
                        row.note || "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {movements.isLoading ? <p className="py-6 text-sm text-muted">Loading movements…</p> : null}
            {!movements.isLoading && !(movements.data?.items ?? []).length ? (
              <p className="py-6 text-sm text-muted">No stock movements yet.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
