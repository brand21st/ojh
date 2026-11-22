"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";
import { coverLifecycle } from "@/modules/storefront/cover-model";
import { findTheme } from "@/modules/storefront/layout/themes";
import { formatStorePrice } from "@/modules/storefront/pricing";
import { GATEWAY_QUERY_KEY, type GatewayOverview } from "@/components/integrations/payment-gateway-default";
import { BUILDER_SECTIONS } from "./builder-nav";
import { Kpi, useStoreAnalytics } from "./analytics";
import { WithStorefront } from "./settings-panels";
import { useStoreBuilder } from "./use-store-builder";


const SECTION_BLURBS: Record<string, string> = {
  "/dashboard/store-builder/ai": "Describe your brand; AI designs the whole store.",
  "/dashboard/store-builder/themes": "Pick a design made for what you sell.",
  "/dashboard/store-builder/customize": "Sections, colours, header, footer and WhatsApp.",
  "/dashboard/store-builder/products": "Collections, bundles and what’s in the store.",
  "/dashboard/store-builder/pages": "Policy pages and menu links.",
  "/dashboard/store-builder/domains": "Your store link and subdomain.",
  "/dashboard/store-builder/checkout": "Fast checkout, COD and shipping.",
  "/dashboard/store-builder/payments": "Razorpay, Cashfree and UPI.",
  "/dashboard/store-builder/marketing": "Coupons, covers, SEO and pixels.",
  "/dashboard/store-builder/analytics": "Views, carts and orders.",
  "/dashboard/store-builder/settings": "Name, logo, visibility and history.",
};

export function StoreOverview() {
  const builder = useStoreBuilder();
  const analytics = useStoreAnalytics("30d");
  const gateway = useQuery({ queryKey: GATEWAY_QUERY_KEY, retry: false, queryFn: () => api<GatewayOverview>("/api/v1/integrations/payment-gateway") });
  return (
    <WithStorefront>
      {(settings) => {
        const state = builder.data;
        const liveCovers = settings.slides.filter((slide) => slide.status !== "ARCHIVED" && coverLifecycle(slide) === "live").length;
        const hasGateway = Boolean(gateway.data?.activeProvider);
        const checklist = [
          { label: "Choose your business category", done: Boolean(state?.businessCategory), href: "/dashboard/store-builder/themes" },
          { label: "Add your logo", done: Boolean(settings.logoUrl), href: "/dashboard/store-builder/settings" },
          { label: "Pick a theme and publish your design", done: Boolean(state?.publishedLayout), href: "/dashboard/store-builder/themes" },
          { label: "Feature your best products", done: (state?.draft.featuredProductIds.length ?? settings.featuredProductIds.length) > 0, href: "/dashboard/store-builder/customize" },
          { label: "Add a homepage cover", done: liveCovers > 0, href: "/dashboard/store-builder/marketing?tab=covers" },
          { label: "Write a search description", done: Boolean(settings.seoDescription), href: "/dashboard/store-builder/marketing?tab=seo" },
          { label: "Set up payments (gateway or UPI)", done: hasGateway || Boolean(settings.upiId || settings.qrImageUrl), href: "/dashboard/store-builder/payments" },
          { label: "Make the store visible", done: settings.published, href: "/dashboard/store-builder/settings" },
        ];
        const done = checklist.filter((item) => item.done).length;
        const theme = state?.publishedLayout ? findTheme(state.publishedLayout.themeId) : null;
        return (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              <section aria-labelledby="setup-title" className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 id="setup-title" className="text-sm font-semibold">{done === checklist.length ? "Your store is set up" : "Finish setting up your store"}</h2>
                  <span className="text-xs tabular-nums text-muted">{done} of {checklist.length}</span>
                </div>
                <div role="progressbar" aria-label="Store setup progress" aria-valuemin={0} aria-valuemax={checklist.length} aria-valuenow={done} className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-soft">
                  <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(done / checklist.length) * 100}%` }} />
                </div>
                <ul className="mt-3 grid gap-0.5">
                  {checklist.map((item) => (
                    <li key={item.label}>
                      <Link href={item.href} className="flex min-h-9 items-center gap-2 rounded-md px-1.5 text-xs hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-brand">
                        {item.done ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden /> : <Circle className="size-4 shrink-0 text-zinc-400" aria-hidden />}
                        <span className={cn("flex-1", item.done && "text-muted line-through")}>{item.label}</span>
                        <span className="sr-only">{item.done ? "Done" : "To do"}</span>
                        {!item.done ? <ArrowRight className="size-3.5 text-muted" aria-hidden /> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-labelledby="design-title" className="flex flex-col rounded-xl border border-border bg-card p-4">
                <h2 id="design-title" className="text-sm font-semibold">Store design</h2>
                <dl className="mt-3 grid gap-2 text-xs">
                  <div className="flex justify-between gap-2"><dt className="text-muted">Live design</dt><dd className="font-medium">{theme ? `${theme.name} theme` : "Classic layout"}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Last published</dt><dd className="font-medium">{state?.publishedAt ? new Date(state.publishedAt).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "Never"}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Draft</dt><dd className="font-medium">{state?.hasUnpublishedChanges ? "Unpublished changes" : "Up to date"}</dd></div>
                </dl>
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <Link href="/dashboard/store-builder/ai" className={buttonVariants({ size: "xs" })}>Design with AI</Link>
                  <Link href="/dashboard/store-builder/customize" className={buttonVariants({ size: "xs", variant: "secondary" })}>Customize store</Link>
                  <Link href="/dashboard/store-builder/themes" className={buttonVariants({ size: "xs", variant: "secondary" })}>Browse themes</Link>
                </div>
              </section>
            </div>

            <section aria-labelledby="kpi-title">
              <div className="mb-2 flex items-baseline justify-between"><h2 id="kpi-title" className="text-sm font-semibold">Last 30 days</h2><Link href="/dashboard/store-builder/analytics" className="text-xs font-medium text-brand hover:underline">Full analytics →</Link></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="Product views" value={analytics.data ? analytics.data.funnel.PRODUCT_VIEW.toLocaleString("en-IN") : "—"} />
                <Kpi label="Added to cart" value={analytics.data ? analytics.data.funnel.ADD_TO_CART.toLocaleString("en-IN") : "—"} />
                <Kpi label="Orders" value={analytics.data ? analytics.data.funnel.PURCHASE.toLocaleString("en-IN") : "—"} />
                <Kpi label="Store revenue" value={analytics.data ? formatStorePrice(analytics.data.revenue) : "—"} />
              </div>
            </section>

            <section aria-labelledby="tools-title">
              <h2 id="tools-title" className="mb-2 text-sm font-semibold">Manage your store</h2>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {BUILDER_SECTIONS.slice(1).map(({ href, label, icon: Icon }) => (
                  <li key={href}>
                    <Link href={href} className="flex h-full items-start gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-brand">
                      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-soft text-muted"><Icon className="size-4" aria-hidden /></span>
                      <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted">{SECTION_BLURBS[href]}</span></span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      }}
    </WithStorefront>
  );
}
