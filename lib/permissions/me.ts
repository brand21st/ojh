import { permissionsFor } from "@/lib/permissions/rbac";
import type { MeResponse } from "@/types/api";
import type { MemberRole, Permission } from "@/types/domain";

/**
 * Whether the signed-in member may do something, in the browser. Uses the effective permissions
 * /api/v1/me returns (role plus per-member feature switches); falls back to the role alone.
 */
export function meCan(me: MeResponse | null | undefined, permission: Permission) {
  if (!me) return false;
  if (Array.isArray(me.permissions)) return me.permissions.includes(permission);
  return permissionsFor((me.role ?? "VIEWER") as MemberRole).includes(permission);
}
