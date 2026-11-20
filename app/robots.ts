import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { siteConfig } from "@/lib/site-config";
import { storeForHost, storeRobots } from "@/modules/storefront/host-seo";

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Merchant hosts ({slug}.postbus.in) get their own robots pointing at their own sitemap.
  const store = await storeForHost((await headers()).get("host"));
  if (store) return storeRobots(store.workspace);
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin/",
        "/api/",
        "/auth/",
        "/dashboard/",
        "/forgot-password",
        "/login",
        "/onboarding",
        "/register",
        "/reset-password",
      ],
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
    host: siteConfig.url,
  };
}
