import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/logger";

/** A merchant host label that is an active store slug. */
export type ResolvedStoreHost = {
  workspace: string;
  organizationId: string;
  /** The same merchant owns the tracking page with this label, so `/track` on this host is theirs. */
  hasTrackingPage: boolean;
};

type Entry = { value: ResolvedStoreHost | null; expiresAt: number };

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 15_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, Entry>();

/** Drop a label after its store address changes, so this process picks it up immediately. */
export function forgetStoreHost(...labels: Array<string | null | undefined>) {
  for (const label of labels) if (label) cache.delete(label.toLowerCase());
}

export async function lookupStoreHost(supabase: SupabaseClient, label: string): Promise<ResolvedStoreHost | null> {
  const { data: link, error } = await supabase
    .from("customer_order_links")
    .select("organization_id, public_workspace")
    .eq("status", "ACTIVE")
    .eq("public_workspace", label)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!link?.organization_id) return null;
  const { data: page, error: pageError } = await supabase
    .from("tracking_pages")
    .select("organization_id")
    .eq("subdomain", label)
    .maybeSingle();
  if (pageError) throw new Error(pageError.message);
  return {
    workspace: String(link.public_workspace).toLowerCase(),
    organizationId: String(link.organization_id),
    hasTrackingPage: page?.organization_id === link.organization_id,
  };
}

/**
 * Resolves a host label to its store, cached per process. Returns `undefined` when the lookup
 * failed, so the caller can fall back to the pre-existing host behaviour instead of a wrong store.
 */
export async function resolveStoreHost(label: string, now = Date.now()): Promise<ResolvedStoreHost | null | undefined> {
  const key = label.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (!hasAdminClient()) return undefined;
  try {
    const value = await lookupStoreHost(createAdminClient(), key);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { value, expiresAt: now + (value ? HIT_TTL_MS : MISS_TTL_MS) });
    return value;
  } catch (error) {
    logError("storefront.host_resolve_failed", { label: key, message: error instanceof Error ? error.message : "unknown" });
    return undefined;
  }
}
