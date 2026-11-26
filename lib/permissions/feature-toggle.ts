import {
  GRANTABLE_PERMISSIONS,
  effectivePermissions,
  normalizeOverrides,
  permissionsFor,
  type FeatureGroup,
} from "@/lib/permissions/rbac";
import type { MemberRole, Permission } from "@/types/domain";

export type Overrides = { extra: Permission[]; revoked: Permission[] };

export type SwitchState = {
  /** The member has every permission this switch covers. */
  on: boolean;
  /** The switch can be flipped for this role (otherwise it needs a different role). */
  available: boolean;
  /** Why it can't be flipped, when it can't. */
  reason?: string;
};

function canHave(role: MemberRole, permission: Permission) {
  return permissionsFor(role).includes(permission) || GRANTABLE_PERMISSIONS.includes(permission);
}

export function switchState(
  role: MemberRole,
  overrides: Overrides,
  group: FeatureGroup,
  level: "view" | "edit"
): SwitchState | null {
  const permissions = level === "view" ? group.view : group.edit;
  if (!permissions.length) return null;
  const effective = new Set(effectivePermissions(role, overrides));
  const on = permissions.every((permission) => effective.has(permission));
  if (role === "OWNER") return { on: true, available: false, reason: "Owners always have everything." };
  const reachable = permissions.every((permission) => canHave(role, permission));
  if (!reachable) return { on, available: false, reason: "Needs a higher role." };
  if (level === "edit" && group.view.some((permission) => !effective.has(permission))) {
    return { on, available: false, reason: "Turn on viewing first." };
  }
  return { on, available: true };
}

/** Flip one switch, returning cleaned overrides for that role. */
export function toggleSwitch(
  role: MemberRole,
  overrides: Overrides,
  group: FeatureGroup,
  level: "view" | "edit",
  on: boolean
): Overrides {
  const base = new Set(permissionsFor(role));
  const extra = new Set(overrides.extra);
  const revoked = new Set(overrides.revoked);
  const permissions = level === "view" ? [...group.view, ...(on ? [] : group.edit)] : group.edit;
  for (const permission of permissions) {
    if (on) {
      revoked.delete(permission);
      if (!base.has(permission)) extra.add(permission);
    } else {
      extra.delete(permission);
      if (base.has(permission)) revoked.add(permission);
    }
  }
  return normalizeOverrides(role, { extra: [...extra], revoked: [...revoked] }) as Overrides;
}

/** Count of features on, for a compact "8 of 13 features" summary. */
export function featureSummary(role: MemberRole, overrides: Overrides, groups: FeatureGroup[]) {
  const effective = new Set(effectivePermissions(role, overrides));
  const on = groups.filter((group) =>
    [...group.view, ...group.edit].some((permission) => effective.has(permission))
  ).length;
  return { on, total: groups.length };
}
