import type { MemberRole, Permission } from "@/types/domain";

export type TeamAction = "order.booked" | "order.packed" | "label.printed" | "manifest.created";

export const TEAM_ACTIONS: TeamAction[] = ["order.booked", "order.packed", "label.printed", "manifest.created"];

export const TEAM_ACTION_LABELS: Record<TeamAction, string> = {
  "order.booked": "Booked",
  "order.packed": "Packed",
  "label.printed": "Labels printed",
  "manifest.created": "Manifests",
};

export type TeamCounts = Record<TeamAction, number>;

export type TeamMember = {
  id: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  role: MemberRole;
  status: "ACTIVE" | "SUSPENDED";
  team: string | null;
  title: string | null;
  extraPermissions: Permission[];
  revokedPermissions: Permission[];
  permissions: Permission[];
  joinedAt: string;
  lastActiveAt: string | null;
  isYou: boolean;
  canManage: boolean;
  today: TeamCounts;
};

export type TeamInvite = {
  id: string;
  email: string;
  fullName: string | null;
  role: MemberRole;
  team: string | null;
  title: string | null;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
};

export type CreatedInvite = TeamInvite & {
  /** Shown once, right after creating or resending. Share it on WhatsApp or by email. */
  inviteUrl: string;
  emailSent: boolean;
};

export type TeamPerformanceMember = {
  actorId: string | null;
  name: string;
  email: string | null;
  role: MemberRole | null;
  team: string | null;
  totals: TeamCounts;
  /** Busiest-day booked + packed count, for the "best day" column. */
  bestDay: { day: string; count: number } | null;
  activeDays: number;
};

export type TeamPerformance = {
  from: string;
  to: string;
  days: string[];
  totals: TeamCounts;
  members: TeamPerformanceMember[];
  /** One row per day per member, for the daily chart and table. */
  daily: Array<{ day: string; actorId: string | null } & TeamCounts>;
};

export type TeamActivityItem = {
  id: string;
  action: TeamAction;
  actorId: string | null;
  actorName: string;
  orderId: string | null;
  orderNumber: string | null;
  barcode: string | null;
  quantity: number;
  occurredAt: string;
};

export type PackScanResult = {
  status: "PACKED" | "ALREADY_PACKED" | "NOT_FOUND" | "CANCELLED";
  code?: string;
  orderId?: string;
  orderNumber?: string;
  barcode?: string | null;
  shipmentStatus?: string | null;
  packedAt?: string;
  packedBy?: string;
  packedByName?: string | null;
};

export type InviteLookup = {
  status: "OPEN" | "EXPIRED" | "ACCEPTED" | "REVOKED" | "NOT_FOUND";
  organizationName?: string;
  email?: string;
  fullName?: string | null;
  role?: MemberRole;
  invitedByName?: string | null;
  hasAccount?: boolean;
};
