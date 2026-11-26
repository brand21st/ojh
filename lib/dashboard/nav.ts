import type { ComponentType } from "react";
import {
  LayoutDashboard,
  BarChart3,
  ShoppingBag,
  Package,
  Truck,
  PackageX,
  Tag,
  Receipt,
  ClipboardList,
  Radio,
  Workflow,
  MessageCircle,
  Plug,
  CreditCard,
  Settings,
  LifeBuoy,
  Calculator,
  Store,
  PackageCheck,
  Users,
} from "lucide-react";
import type { Permission } from "@/types/domain";
import { YoutubeIcon } from "@/components/icons/youtube-icon";

export type NavChildItem = {
  label: string;
  href: string;
};

export type NavItem = {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  tour?: string;
  children?: NavChildItem[];
  /** Hidden from members without this permission (role plus their feature switches). */
  permission?: Permission;
};

export const sidebarNav: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "orders.read" },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3, permission: "orders.read" },
  {
    label: "Orders",
    href: "/dashboard/orders",
    icon: ShoppingBag,
    tour: "nav-orders",
    permission: "orders.read",
    children: [{ label: "Bulk Excel Booking", href: "/dashboard/orders/bulk-excel" }],
  },
  { label: "Inventory", href: "/dashboard/inventory", icon: Package, permission: "products.read" },
  { label: "Store Builder", href: "/dashboard/store-builder", icon: Store, permission: "products.write" },
  { label: "Shipments", href: "/dashboard/shipments", icon: Truck, tour: "nav-shipments", permission: "shipments.read" },
  { label: "NDR & RTO", href: "/dashboard/ndr-rto", icon: PackageX, permission: "shipments.read" },
  {
    label: "Labels",
    href: "/dashboard/labels",
    icon: Tag,
    tour: "nav-labels",
    permission: "labels.read",
    children: [{ label: "Multi print", href: "/dashboard/labels/multi-print" }],
  },
  { label: "Packing", href: "/dashboard/packing", icon: PackageCheck, permission: "packing.scan" },
  { label: "Invoices", href: "/dashboard/invoices", icon: Receipt, permission: "orders.read" },
  { label: "Manifest", href: "/dashboard/manifests", icon: ClipboardList, permission: "manifests.read" },
  { label: "Tracking", href: "/dashboard/tracking", icon: Radio, permission: "tracking.read" },
  { label: "Automation", href: "/dashboard/automation", icon: Workflow, permission: "automation.manage" },
  { label: "Support Center", href: "/dashboard/support", icon: MessageCircle, permission: "support.read" },
  { label: "Integrations", href: "/dashboard/integrations", icon: Plug, tour: "nav-integrations", permission: "integrations.manage" },
  { label: "Team", href: "/dashboard/team", icon: Users, permission: "team.read" },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard, permission: "org.billing" },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

export const aiAccountantNav: NavItem = {
  label: "AI Accountant",
  href: "/dashboard/ai-accountant",
  icon: Calculator,
};

export const tutorialsNav: NavItem = {
  label: "Tutorials",
  href: "/dashboard/tutorials",
  icon: YoutubeIcon,
};

export const helpNav: NavItem = {
  label: "Help",
  href: "/contact",
  icon: LifeBuoy,
};

export function isNavItemActive(href: string, pathname: string) {
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
}

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResourceIdSegment(segment: string) {
  return RESOURCE_ID.test(segment);
}

export type Breadcrumb = {
  label: string;
  href: string;
  resourceId?: boolean;
};

export function breadcrumbs(pathname: string): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [];
  let href = "";
  for (const segment of segments) {
    href += `/${segment}`;
    if (segment === "dashboard") {
      crumbs.push({ label: "Dashboard", href: "/dashboard" });
      continue;
    }
    if (segment === "tutorials") {
      crumbs.push({ label: "Tutorials", href });
      continue;
    }
    if (isResourceIdSegment(segment)) {
      crumbs.push({ label: segment, href, resourceId: true });
      continue;
    }
    crumbs.push({
      label:
        segment === "new"
          ? "New"
            : segment === "customer-links"
            ? "Customer order link"
            : segment === "bulk-excel"
              ? "Bulk Excel Booking"
            : segment === "support"
              ? "Support Center"
              : segment === "developer"
                ? "Developer API"
              : segment === "google-sheets"
                ? "Google Sheets"
              : segment === "ai-accountant"
                ? "AI Accountant"
              : segment === "store-builder"
                ? "Store Builder"
              : segment.replace(/-/g, " "),
      href,
    });
  }
  return crumbs;
}
