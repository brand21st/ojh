import type { MetadataRoute } from "next";
import { parseTrackingSubdomain } from "@/modules/tracking-pages/host";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { storeSubdomainUrl, storeSubdomainsEnabled } from "./host";
import { resolveStoreHost } from "./host-resolver";

/** The store served on this Host header, when subdomain stores are live. */
export async function storeForHost(host: string | null) {
  if (!storeSubdomainsEnabled()) return null;
  const label = parseTrackingSubdomain(host);
  if (!label) return null;
  return (await resolveStoreHost(label)) ?? null;
}

export function storeRobots(workspace: string): MetadataRoute.Robots {
  const origin = storeSubdomainUrl(workspace);
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/track"] },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}

/** Home, active categories and visible products of one published store; nothing for another tenant. */
export async function storeSitemap(workspace: string, organizationId: string): Promise<MetadataRoute.Sitemap> {
  const origin = storeSubdomainUrl(workspace);
  if (!hasAdminClient()) return [{ url: origin }];
  const supabase = createAdminClient();
  const { data: settings } = await supabase
    .from("storefront_settings")
    .select("published")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (settings?.published === false) return [];
  const [{ data: categories }, { data: products }] = await Promise.all([
    supabase.from("product_categories").select("slug, updated_at").eq("organization_id", organizationId).eq("active", true).limit(200),
    supabase
      .from("products")
      .select("public_slug, updated_at")
      .eq("organization_id", organizationId)
      .eq("active", true)
      .eq("store_visible", true)
      .not("public_slug", "is", null)
      .order("updated_at", { ascending: false })
      .limit(2000),
  ]);
  return [
    { url: origin, changeFrequency: "daily", priority: 1 },
    ...(categories ?? []).map((row) => ({
      url: `${origin}/category/${row.slug}`,
      lastModified: row.updated_at ? new Date(String(row.updated_at)) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...(products ?? []).map((row) => ({
      url: `${origin}/products/${row.public_slug}`,
      lastModified: row.updated_at ? new Date(String(row.updated_at)) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
