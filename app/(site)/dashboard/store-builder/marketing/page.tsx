"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SeoPanel, TrackingPanel } from "@/components/store-builder/settings-panels";
import { useCanEditStore } from "@/components/store-builder/use-store-builder";

const TABS = ["coupons", "covers", "seo", "tracking"] as const;
type Tab = (typeof TABS)[number];
const loading = () => <div role="status" aria-label="Loading" className="h-64 animate-pulse rounded-lg bg-surface-soft motion-reduce:animate-none" />;
const InventoryCoupons = dynamic(() => import("@/components/store-builder/coupons-panel").then((m) => m.InventoryCoupons), { loading });
const InventoryCovers = dynamic(() => import("@/components/store-builder/covers-panel").then((m) => m.InventoryCovers), { loading });

export default function StoreBuilderMarketingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { canWrite } = useCanEditStore();
  const tab = (TABS.includes(searchParams.get("tab") as Tab) ? searchParams.get("tab") : "coupons") as Tab;
  return (
    <Tabs value={tab} onValueChange={(next) => router.replace(`/dashboard/store-builder/marketing?tab=${next}`, { scroll: false })} className="w-full min-w-0">
      <TabsList className="h-9 w-full min-w-0 max-w-full overflow-x-auto rounded-lg sm:w-auto">
        <TabsTrigger value="coupons">Coupons</TabsTrigger>
        <TabsTrigger value="covers">Covers</TabsTrigger>
        <TabsTrigger value="seo">SEO & sharing</TabsTrigger>
        <TabsTrigger value="tracking">Tracking</TabsTrigger>
      </TabsList>
      <TabsContent value="coupons" className="mt-4 w-full min-w-0"><InventoryCoupons canWrite={canWrite} /></TabsContent>
      <TabsContent value="covers" className="mt-4 w-full min-w-0"><InventoryCovers canWrite={canWrite} /></TabsContent>
      <TabsContent value="seo" className="mt-4 w-full min-w-0"><SeoPanel /></TabsContent>
      <TabsContent value="tracking" className="mt-4 w-full min-w-0"><TrackingPanel /></TabsContent>
    </Tabs>
  );
}
