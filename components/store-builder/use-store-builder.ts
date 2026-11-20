"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { hasPermission } from "@/lib/permissions/rbac";
import type { StorefrontPreviewSettings } from "@/modules/storefront/preview";
import type { FeaturedProductSummary } from "@/modules/storefront/service";
import type { StoreBuilderState, StoreDraft, StoreLayoutVersion } from "@/modules/storefront/builder";
import type { StoreLayout } from "@/modules/storefront/layout/schema";
import type { StorePayload } from "@/components/storefront/store-types";

/** GET /api/v1/inventory/storefront — the live (immediate) store settings. */
export type Storefront = StorefrontPreviewSettings & {
  published: boolean;
  storeUrl: string;
  storeSubdomainUrl?: string;
  storeHostSuffix?: string;
  subdomainsEnabled?: boolean;
  footerPreview: StorePayload["footer"];
  featuredProducts?: FeaturedProductSummary[];
  logoPath?: string | null;
  upiId?: string | null;
  gpayNumber?: string | null;
  qrImageUrl?: string | null;
  qrImagePath?: string | null;
  publishedLayout?: StoreLayout | null;
  businessCategory?: string | null;
  whatsappPhone?: string | null;
};

export const STOREFRONT_KEY = ["inventory-storefront"] as const;
export const BUILDER_KEY = ["store-builder"] as const;
export const VERSIONS_KEY = ["store-builder", "versions"] as const;

export function useCanEditStore() {
  const me = useMe();
  const role = me.data?.role ?? "VIEWER";
  return {
    canWrite: hasPermission(role, "products.write"),
    isAdmin: role === "OWNER" || role === "ADMIN",
    loading: me.isPending,
  };
}

export function useStorefront() {
  return useQuery({ queryKey: STOREFRONT_KEY, queryFn: () => api<Storefront>("/api/v1/inventory/storefront") });
}

/** Saves operational settings that apply immediately (visibility, name, SEO, payments, tracking). */
export function useStorefrontSave() {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: "storefront-settings" },
    mutationFn: (patch: Record<string, unknown>) =>
      api<Storefront>("/api/v1/inventory/storefront", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (data) => queryClient.setQueryData(STOREFRONT_KEY, data),
    onError: (error: Error) => toast.error(error.message),
  });
}

export function useStoreBuilder() {
  return useQuery({ queryKey: BUILDER_KEY, queryFn: () => api<StoreBuilderState>("/api/v1/inventory/storefront/builder") });
}

export function useBuilderMutations() {
  const queryClient = useQueryClient();
  const onState = (state: StoreBuilderState) => {
    queryClient.setQueryData(BUILDER_KEY, state);
    void queryClient.invalidateQueries({ queryKey: STOREFRONT_KEY });
  };
  const saveDraft = useMutation({
    scope: { id: "store-builder-draft" },
    mutationFn: (input: StoreDraft & { expectedDraftUpdatedAt?: string | null }) =>
      api<StoreBuilderState>("/api/v1/inventory/storefront/builder/draft", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (state) => queryClient.setQueryData(BUILDER_KEY, state),
  });
  const publish = useMutation({
    mutationFn: (expectedDraftUpdatedAt: string | null) =>
      api<StoreBuilderState>("/api/v1/inventory/storefront/builder/publish", { method: "POST", body: JSON.stringify({ expectedDraftUpdatedAt }) }),
    onSuccess: (state) => {
      onState(state);
      void queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
    },
  });
  const discard = useMutation({
    mutationFn: () => api<StoreBuilderState>("/api/v1/inventory/storefront/builder/draft", { method: "DELETE" }),
    onSuccess: onState,
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => api<StoreBuilderState>(`/api/v1/inventory/storefront/versions/${versionId}/restore`, { method: "POST" }),
    onSuccess: onState,
  });
  const revertClassic = useMutation({
    mutationFn: () => api<StoreBuilderState>("/api/v1/inventory/storefront/builder/revert-classic", { method: "POST" }),
    onSuccess: (state) => {
      onState(state);
      void queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
    },
  });
  const setCategory = useMutation({
    mutationFn: (businessCategory: string | null) =>
      api<StoreBuilderState>("/api/v1/inventory/storefront/builder/category", { method: "PATCH", body: JSON.stringify({ businessCategory }) }),
    onSuccess: onState,
    onError: (error: Error) => toast.error(error.message),
  });
  return { saveDraft, publish, discard, restore, revertClassic, setCategory };
}

export function useLayoutVersions(enabled = true) {
  return useQuery({ queryKey: VERSIONS_KEY, enabled, queryFn: () => api<StoreLayoutVersion[]>("/api/v1/inventory/storefront/versions") });
}
