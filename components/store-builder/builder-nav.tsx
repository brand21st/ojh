"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CreditCard,
  FileText,
  Globe,
  LayoutDashboard,
  Megaphone,
  Package,
  Paintbrush,
  Palette,
  Settings,
  ShoppingCart,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const BUILDER_SECTIONS = [
  { href: "/dashboard/store-builder", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/store-builder/themes", label: "Themes", icon: Palette },
  { href: "/dashboard/store-builder/customize", label: "Customize", icon: Paintbrush },
  { href: "/dashboard/store-builder/products", label: "Products & Collections", icon: Package },
  { href: "/dashboard/store-builder/pages", label: "Pages & Navigation", icon: FileText },
  { href: "/dashboard/store-builder/domains", label: "Domains", icon: Globe },
  { href: "/dashboard/store-builder/checkout", label: "Checkout", icon: ShoppingCart },
  { href: "/dashboard/store-builder/payments", label: "Payments", icon: CreditCard },
  { href: "/dashboard/store-builder/marketing", label: "Marketing", icon: Megaphone },
  { href: "/dashboard/store-builder/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/store-builder/settings", label: "Settings", icon: Settings },
] as const;

export function isBuilderSectionActive(href: string, pathname: string) {
  return href === "/dashboard/store-builder" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Left rail on desktop, horizontally scrolling chips on mobile. */
export function BuilderNav({ horizontal = false }: { horizontal?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Store Builder sections" className="min-w-0">
      <ul className={cn("-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]", !horizontal && "lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0")}>
        {BUILDER_SECTIONS.map(({ href, label, icon: Icon }) => {
          const active = isBuilderSectionActive(href, pathname);
          return (
            <li key={href} className="shrink-0">
              <Link
                href={href}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  active ? "bg-rose-50 text-brand-dark dark:bg-brand/15 dark:text-rose-200" : "text-muted hover:bg-surface-soft hover:text-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
