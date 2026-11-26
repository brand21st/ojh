import type { MemberRole, Permission } from "@/types/domain";

const ALL: Permission[] = [
  "org.manage",
  "org.billing",
  "members.manage",
  "orders.read",
  "orders.write",
  "products.read",
  "products.write",
  "shipments.read",
  "shipments.write",
  "labels.read",
  "labels.write",
  "manifests.read",
  "manifests.write",
  "tracking.read",
  "tracking.pages",
  "automation.manage",
  "integrations.manage",
  "api_keys.manage",
  "webhooks.manage",
  "audit.read",
  "settings.manage",
  "support.read",
  "support.reply",
  "support.assign",
  "support.manage",
  "support.settings",
  "accounting.read",
  "accounting.write",
  "packing.scan",
  "team.read",
];

const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((permission) => permission !== "org.billing"),
  MANAGER: [
    "support.read",
    "support.reply",
    "support.assign",
    "support.manage",
    "accounting.read",
    "orders.read",
    "orders.write",
    "products.read",
    "products.write",
    "shipments.read",
    "shipments.write",
    "labels.read",
    "labels.write",
    "manifests.read",
    "manifests.write",
    "tracking.read",
    "tracking.pages",
    "automation.manage",
    "packing.scan",
    "team.read",
  ],
  OPERATOR: [
    "support.read",
    "support.reply",
    "accounting.read",
    "orders.read",
    "orders.write",
    "products.read",
    "shipments.read",
    "shipments.write",
    "labels.read",
    "labels.write",
    "manifests.read",
    "manifests.write",
    "tracking.read",
    "packing.scan",
  ],
  // Packing team: scans parcels at the packing station and can look orders and labels up.
  PACKER: ["orders.read", "shipments.read", "labels.read", "tracking.read", "packing.scan"],
  VIEWER: [
    "support.read",
    "accounting.read",
    "orders.read",
    "products.read",
    "shipments.read",
    "labels.read",
    "manifests.read",
    "tracking.read",
    "audit.read",
  ],
};

export function permissionsFor(role: MemberRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: MemberRole, permission: Permission) {
  return permissionsFor(role).includes(permission);
}

/** Roles shown in the team UI, highest access first, with a one-line explanation. */
export const ROLE_DETAILS: Array<{ role: MemberRole; label: string; description: string }> = [
  { role: "OWNER", label: "Owner", description: "Everything, including billing and team." },
  { role: "ADMIN", label: "Admin", description: "Everything except billing. Can add and manage members." },
  {
    role: "MANAGER",
    label: "Manager",
    description: "Runs daily operations: orders, products, booking, labels, manifests, support, and team performance.",
  },
  {
    role: "OPERATOR",
    label: "Operator",
    description: "Order fulfilment: creates and books orders, prints labels, builds manifests, packs.",
  },
  { role: "PACKER", label: "Packer", description: "Packing team: scans parcels at the packing station." },
  { role: "VIEWER", label: "Viewer", description: "Read-only access to orders, shipments, and reports." },
];

export function roleLabel(role: MemberRole | string | null | undefined) {
  return ROLE_DETAILS.find((item) => item.role === role)?.label ?? String(role ?? "Member");
}

/**
 * Permissions a member can be given on top of their role. Writes stay with the role because
 * database row security checks the role itself; reads and the two app-only features are safe to add.
 */
export const GRANTABLE_PERMISSIONS: Permission[] = [
  "orders.read",
  "products.read",
  "shipments.read",
  "labels.read",
  "manifests.read",
  "tracking.read",
  "support.read",
  "accounting.read",
  "audit.read",
  "packing.scan",
  "team.read",
];

/** Features an owner switches on and off per member. Each maps to the permissions it covers. */
export type FeatureGroup = {
  key: string;
  label: string;
  description: string;
  view: Permission[];
  edit: Permission[];
};

export const FEATURE_GROUPS: FeatureGroup[] = [
  { key: "orders", label: "Orders", description: "See orders; create, edit and import them.", view: ["orders.read"], edit: ["orders.write"] },
  { key: "products", label: "Inventory & products", description: "Products, stock and the store catalogue.", view: ["products.read"], edit: ["products.write"] },
  { key: "shipments", label: "Booking & shipments", description: "Book with India Post, NDR and RTO.", view: ["shipments.read"], edit: ["shipments.write"] },
  { key: "labels", label: "Labels", description: "Print and reprint shipping labels.", view: ["labels.read"], edit: ["labels.write"] },
  { key: "packing", label: "Packing station", description: "Scan parcels to mark them packed.", view: [], edit: ["packing.scan"] },
  { key: "manifests", label: "Manifests", description: "Build and send daily manifests.", view: ["manifests.read"], edit: ["manifests.write"] },
  { key: "tracking", label: "Tracking pages", description: "Customer tracking and the tracking page editor.", view: ["tracking.read"], edit: ["tracking.pages"] },
  { key: "support", label: "Support inbox", description: "Customer conversations.", view: ["support.read"], edit: ["support.reply", "support.assign"] },
  { key: "accounting", label: "Accounting", description: "Invoices and the AI Accountant.", view: ["accounting.read"], edit: ["accounting.write"] },
  { key: "automation", label: "Automation & printing", description: "Automation rules and printer setup.", view: [], edit: ["automation.manage"] },
  { key: "integrations", label: "Integrations", description: "Shopify, WooCommerce, India Post connections.", view: [], edit: ["integrations.manage"] },
  { key: "team", label: "Team performance", description: "See who did what and daily counts.", view: ["team.read"], edit: [] },
  { key: "settings", label: "Workspace settings", description: "Policies and workspace settings.", view: [], edit: ["settings.manage"] },
];

/** Every permission a per-member switch can touch. Owner-only powers (billing, members, API keys) are not here. */
export const TOGGLEABLE_PERMISSIONS: Permission[] = Array.from(
  new Set(FEATURE_GROUPS.flatMap((group) => [...group.view, ...group.edit]))
);

export type PermissionOverrides = {
  extra?: readonly string[] | null;
  revoked?: readonly string[] | null;
};

function isPermission(value: string): value is Permission {
  return (ALL as string[]).includes(value);
}

/** Cleans overrides so they only hold what that role may gain or lose. */
export function normalizeOverrides(role: MemberRole, overrides: PermissionOverrides) {
  const base = new Set(permissionsFor(role));
  const extra = Array.from(new Set(overrides.extra ?? []))
    .filter(isPermission)
    .filter((permission) => GRANTABLE_PERMISSIONS.includes(permission) && !base.has(permission))
    .sort();
  const revoked = Array.from(new Set(overrides.revoked ?? []))
    .filter(isPermission)
    .filter((permission) => TOGGLEABLE_PERMISSIONS.includes(permission) && base.has(permission))
    .sort();
  return { extra, revoked };
}

/** Role permissions, plus granted extras, minus switched-off features. Owners are never reduced. */
export function effectivePermissions(role: MemberRole, overrides?: PermissionOverrides | null): Permission[] {
  if (role === "OWNER" || !overrides) return [...permissionsFor(role)];
  const { extra, revoked } = normalizeOverrides(role, overrides);
  const set = new Set<Permission>([...permissionsFor(role), ...extra]);
  for (const permission of revoked) set.delete(permission);
  // A write without its read is useless in the UI; drop the write too.
  for (const group of FEATURE_GROUPS) {
    if (group.view.length && group.view.some((permission) => !set.has(permission))) {
      for (const permission of group.edit) set.delete(permission);
    }
  }
  return ALL.filter((permission) => set.has(permission));
}

/** Who can hand out which role. Owners: any. Admins: anything below admin. */
export function canAssignRole(actorRole: MemberRole, assignedRole: MemberRole) {
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return assignedRole !== "OWNER" && assignedRole !== "ADMIN";
  return false;
}

/** Whether the actor may change or remove a member who currently holds targetRole. */
export function canManageMember(actorRole: MemberRole, targetRole: MemberRole) {
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return targetRole !== "OWNER" && targetRole !== "ADMIN";
  return false;
}

export const MEMBER_TEAMS = ["MANAGEMENT", "FULFILLMENT", "PACKING", "SUPPORT", "ACCOUNTS"] as const;
export type MemberTeam = (typeof MEMBER_TEAMS)[number];

export const TEAM_LABELS: Record<MemberTeam, string> = {
  MANAGEMENT: "Management",
  FULFILLMENT: "Order fulfilment",
  PACKING: "Packing",
  SUPPORT: "Customer support",
  ACCOUNTS: "Accounts",
};

/** The role and team a new member usually gets for each team. */
export const TEAM_DEFAULT_ROLE: Record<MemberTeam, MemberRole> = {
  MANAGEMENT: "MANAGER",
  FULFILLMENT: "OPERATOR",
  PACKING: "PACKER",
  SUPPORT: "OPERATOR",
  ACCOUNTS: "VIEWER",
};
