"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/store-builder/settings-panels";
import { MarketplaceBundles } from "@/components/store-builder/marketplace-settings";
import { useCanEditStore } from "@/components/store-builder/use-store-builder";

const loading = () => <div role="status" aria-label="Loading" className="h-40 animate-pulse rounded-lg bg-surface-soft motion-reduce:animate-none" />;
// Collections are the same product categories Inventory uses: one source of truth.
const InventoryCategoriesManager = dynamic(() => import("../../inventory/categories-manager").then((m) => m.InventoryCategoriesManager), { loading });

export default function StoreBuilderProductsPage() {
  const { canWrite } = useCanEditStore();
  return (
    <div className="space-y-4">
      <Panel title="Products in your store" description="Your store sells your Inventory products. A product shows in the store when it is Active and “Shown in store” is on. Stock, prices, COD and advance settings come from Inventory."
        actions={<Link href="/dashboard/inventory?tab=products" className={buttonVariants({ size: "xs", variant: "secondary" })}>Manage products</Link>}>
        <p className="text-xs text-muted">Pick featured products and build product rows in <Link href="/dashboard/store-builder/customize" className="text-brand underline">Customize</Link>.</p>
      </Panel>
      <Panel id="collections" title="Collections" description="Collections are your product categories. Use them in the store menu, category tiles and collection rows.">
        <InventoryCategoriesManager canWrite={canWrite} />
      </Panel>
      <Panel id="bundles" title="Bundles" description="Sell products together at a set price or discount.">
        <MarketplaceBundles canWrite={canWrite} />
      </Panel>
    </div>
  );
}
