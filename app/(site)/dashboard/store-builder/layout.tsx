"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { BuilderNav } from "@/components/store-builder/builder-nav";
import { StoreStatusBar } from "@/components/store-builder/store-status-bar";
import styles from "@/components/store-builder/store-builder.module.css";
import { cn } from "@/lib/utils";

export default function StoreBuilderLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The visual editor needs the full width for its preview, so its nav sits on top.
  const wide = pathname.startsWith("/dashboard/store-builder/customize");
  return (
    <div className={cn(styles.builder, "w-full min-w-0 space-y-3")}>
      <PageHeader title="Store Builder" description="Design, publish and grow your online store." icon={<Store className="size-6 text-brand" />} />
      <StoreStatusBar />
      <div className={cn("grid min-w-0 gap-4", !wide && "lg:grid-cols-[220px_minmax(0,1fr)]")}>
        <div className={cn(!wide && "lg:sticky lg:top-4 lg:self-start")}>
          <BuilderNav horizontal={wide} />
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
