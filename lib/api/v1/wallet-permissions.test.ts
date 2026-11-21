import { describe, expect, it } from "vitest";
import { permissionForTenantRoute } from "@/lib/api/v1-permissions";
import { hasPermission } from "@/lib/permissions/rbac";

const perm = (method: string, path: string) => permissionForTenantRoute(method, path, path.split("/"));

describe("wallet route permissions", () => {
  it("lets every member read the wallet", () => {
    for (const path of ["wallet", "wallet/transactions", "wallet/recharges", "wallet/usage", "wallet/statement"]) {
      expect(perm("GET", path)).toBeUndefined();
    }
    expect(perm("POST", "wallet/recharge/preview")).toBeUndefined();
  });

  it("keeps paying into the wallet to owners", () => {
    expect(perm("POST", "wallet/recharge")).toBe("org.billing");
    expect(perm("POST", "wallet/recharge/verify")).toBe("org.billing");
    expect(hasPermission("OWNER", "org.billing")).toBe(true);
    expect(hasPermission("ADMIN", "org.billing")).toBe(false);
  });
});
