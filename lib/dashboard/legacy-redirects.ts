/**
 * Inventory tabs that moved to the Store Builder. Used by next.config redirects so old
 * bookmarks, WhatsApp-shared links and in-app links keep working. Query strings pass through.
 */
export const STORE_BUILDER_LEGACY_TABS = [
  { tab: "storefront", destination: "/dashboard/store-builder/customize" },
  { tab: "covers", destination: "/dashboard/store-builder/marketing" },
  { tab: "coupons", destination: "/dashboard/store-builder/marketing" },
] as const;

export function storeBuilderLegacyRedirects() {
  return STORE_BUILDER_LEGACY_TABS.map(({ tab, destination }) => ({
    source: "/dashboard/inventory",
    has: [{ type: "query" as const, key: "tab", value: tab }],
    destination,
    permanent: false,
  }));
}
