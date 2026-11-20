import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { publicRoutes } from "@/lib/seo/routes";
import { siteConfig } from "@/lib/site-config";
import { storeForHost, storeSitemap } from "@/modules/storefront/host-seo";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const store = await storeForHost((await headers()).get("host"));
  if (store) return storeSitemap(store.workspace, store.organizationId);
  return publicRoutes.map((route) => ({
    url: `${siteConfig.url}${route.path === "/" ? "" : route.path}`,
    lastModified: new Date("2026-09-26"),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
