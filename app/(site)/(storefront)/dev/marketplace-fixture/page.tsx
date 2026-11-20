import { notFound } from "next/navigation";
import { StoreApp } from "@/components/storefront/store-app";
import { marketplaceFixture } from "@/modules/storefront/marketplace-fixture";
import { makeSection, storeLayoutSchema } from "@/modules/storefront/layout/schema";
import { findTheme, installTheme } from "@/modules/storefront/layout/themes";

export const dynamic = "force-dynamic";

/** Dev-only. `?theme=<id>` renders the Store Builder layout for that theme with sample section content. */
export default async function MarketplaceFixturePage({ searchParams }: { searchParams: Promise<{ empty?: string; theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const empty = params.empty === "1";
  const base = empty
    ? { ...marketplaceFixture, bundles: [], products: { ...marketplaceFixture.products, items: [], featured: [], bestSellers: [], total: 0 } }
    : marketplaceFixture;
  if (!params.theme) return <StoreApp preview={base} workspace="samanga" />;

  const theme = findTheme(params.theme);
  const sample = storeLayoutSchema.parse({
    header: {
      announcement: { enabled: true, text: "Free shipping on prepaid orders above ₹999", href: "#all-products" },
      menu: [{ label: "All products", kind: "section", value: "catalog" }, { label: "Shipping", kind: "policy", value: "shipping" }],
    },
    whatsappButton: { enabled: true },
    sections: [
      makeSection("promo_banner", "promo", { title: "Festive sale is live", body: "Flat 15% off on prepaid orders this week.", ctaLabel: "Shop the sale", ctaHref: "#all-products" }),
      makeSection("testimonials", "reviews", { items: [{ name: "Asha", quote: "Beautiful quality and it reached in 4 days.", rating: 5, location: "Kochi" }, { name: "Ravi", quote: "COD made it easy to try.", rating: 4, location: "Pune" }] }),
      makeSection("video_shopping", "videos", { videos: [{ url: "https://youtu.be/dQw4w9WgXcQ", caption: "How it’s made", productIds: [] }] }),
      makeSection("countdown", "drop", { title: "Ends soon", body: "Reserve the pieces before they disappear.", endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
      makeSection("rich_text", "story", { title: "Our story", body: "Handmade in small batches by artisans we know by name." }),
      makeSection("catalog", "catalog"),
    ],
  });
  const layout = installTheme(sample, theme, { applyLayout: true });
  // Show the sample sections the theme would otherwise keep hidden.
  // Fixture product ids aren't UUIDs (the schema rightly drops them), so attach them after parsing.
  const videoIds = base.products.items.slice(0, 2).map((p) => p.id);
  const visible = {
    ...layout,
    sections: layout.sections.map((s) =>
      s.type === "video_shopping"
        ? { ...s, visible: true, settings: { ...s.settings, videos: (s.settings as { videos: Array<Record<string, unknown>> }).videos.map((v) => ({ ...v, productIds: videoIds })) } }
        : { ...s, visible: true }
    ),
  } as typeof layout;
  const store = {
    ...base,
    marketplace: true,
    layout: visible,
    accentColor: visible.tokens.accent,
    whatsappPhone: "9876543210",
    sectionProducts: {
      videos: base.products.items.slice(0, 2),
      // Category rows ("<sectionId>:<categoryId>") from the fixture catalog.
      ...Object.fromEntries(
        visible.sections
          .filter((s) => s.type === "category_grid")
          .flatMap((s) => base.categories.map((c) => [`${s.id}:${c.id}`, base.products.items.filter((p) => p.categoryIds?.includes(c.id)).slice(0, 8)]))
      ),
    },
  };
  return <StoreApp preview={store} workspace="samanga" />;
}
