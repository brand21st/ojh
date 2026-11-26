import { describe, expect, it } from "vitest";
import { switchState, toggleSwitch } from "@/lib/permissions/feature-toggle";
import { meCan } from "@/lib/permissions/me";
import {
  FEATURE_GROUPS,
  canAssignRole,
  canManageMember,
  effectivePermissions,
  hasPermission,
  normalizeOverrides,
} from "@/lib/permissions/rbac";
import { permissionForTenantRoute } from "@/lib/api/v1-permissions";
import type { MeResponse } from "@/types/api";

const group = (key: string) => FEATURE_GROUPS.find((item) => item.key === key)!;

describe("team roles", () => {
  it("gives packers the packing station and read-only order lookups", () => {
    expect(hasPermission("PACKER", "packing.scan")).toBe(true);
    expect(hasPermission("PACKER", "orders.read")).toBe(true);
    expect(hasPermission("PACKER", "orders.write")).toBe(false);
    expect(hasPermission("PACKER", "members.manage")).toBe(false);
    expect(hasPermission("OPERATOR", "packing.scan")).toBe(true);
    expect(hasPermission("MANAGER", "team.read")).toBe(true);
    expect(hasPermission("OPERATOR", "team.read")).toBe(false);
    expect(hasPermission("VIEWER", "packing.scan")).toBe(false);
  });

  it("lets owners and admins hand out roles below them only", () => {
    expect(canAssignRole("OWNER", "ADMIN")).toBe(true);
    expect(canAssignRole("ADMIN", "PACKER")).toBe(true);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("MANAGER", "PACKER")).toBe(false);
    expect(canManageMember("ADMIN", "OWNER")).toBe(false);
    expect(canManageMember("ADMIN", "OPERATOR")).toBe(true);
  });

  it("maps team and packing routes to their permissions", () => {
    expect(permissionForTenantRoute("GET", "team/performance", ["team", "performance"])).toBe("team.read");
    expect(permissionForTenantRoute("POST", "packing/scan", ["packing", "scan"])).toBe("packing.scan");
    expect(permissionForTenantRoute("PATCH", "members/abc", ["members", "abc"])).toBe("members.manage");
    expect(permissionForTenantRoute("GET", "members", ["members"])).toBeUndefined();
  });
});

describe("per-member feature switches", () => {
  it("switches features off within the role and never adds writes", () => {
    const perms = effectivePermissions("OPERATOR", {
      revoked: ["manifests.write", "support.read"],
      extra: ["orders.write", "products.write", "team.read"],
    });
    expect(perms).not.toContain("manifests.write");
    expect(perms).toContain("manifests.read");
    expect(perms).toContain("team.read");
    expect(perms).not.toContain("products.write");
    // Turning off viewing support also drops replying.
    expect(perms).not.toContain("support.reply");
  });

  it("never reduces an owner or touches owner-only powers", () => {
    expect(effectivePermissions("OWNER", { revoked: ["orders.read", "org.billing"] })).toContain("orders.read");
    expect(normalizeOverrides("ADMIN", { revoked: ["members.manage", "org.manage"] }).revoked).toEqual([]);
  });

  it("drops overrides that don't fit the role", () => {
    expect(normalizeOverrides("VIEWER", { extra: ["orders.read", "packing.scan", "bogus"] }).extra).toEqual(["packing.scan"]);
  });

  it("drives the View/Edit switches", () => {
    const empty = { extra: [], revoked: [] };
    expect(switchState("PACKER", empty, group("orders"), "view")).toMatchObject({ on: true, available: true });
    expect(switchState("PACKER", empty, group("orders"), "edit")).toMatchObject({ on: false, available: false });
    expect(switchState("VIEWER", empty, group("packing"), "edit")).toMatchObject({ on: false, available: true });

    const offLabels = toggleSwitch("OPERATOR", empty, group("labels"), "view", false);
    expect(offLabels.revoked).toEqual(["labels.read", "labels.write"]);
    expect(switchState("OPERATOR", offLabels, group("labels"), "edit")).toMatchObject({ available: false });
    const back = toggleSwitch("OPERATOR", offLabels, group("labels"), "view", true);
    expect(back.revoked).toEqual(["labels.write"]);

    const packingViewer = toggleSwitch("VIEWER", empty, group("packing"), "edit", true);
    expect(packingViewer.extra).toEqual(["packing.scan"]);
  });

  it("checks the browser's permissions from /me, falling back to the role", () => {
    const me = { role: "OPERATOR", permissions: ["orders.read"] } as unknown as MeResponse;
    expect(meCan(me, "orders.read")).toBe(true);
    expect(meCan(me, "orders.write")).toBe(false);
    expect(meCan({ role: "OPERATOR" } as unknown as MeResponse, "orders.write")).toBe(true);
    expect(meCan(null, "orders.read")).toBe(false);
  });
});
