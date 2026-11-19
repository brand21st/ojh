import { describe, expect, it } from "vitest";
import type { TenantContext } from "@/lib/api/context";
import { getInventoryOverview, overviewWindow } from "@/modules/products/overview";

const ctx = { organizationId: "org-1" } as TenantContext;
// 2026-11-18 11:30 IST
const now = new Date("2026-11-18T06:00:00Z");

describe("overviewWindow", () => {
  it("starts today at IST midnight and compares with the same hours yesterday", () => {
    const w = overviewWindow("today", now);
    expect(w.from.toISOString()).toBe("2026-11-17T18:30:00.000Z");
    expect(w.prevFrom.toISOString()).toBe("2026-11-16T18:30:00.000Z");
    expect(w.prevTo.toISOString()).toBe("2026-11-17T06:00:00.000Z");
    expect(w.bucket).toBe("hour");
  });

  it("counts today as day one of a 7 day window", () => {
    const w = overviewWindow("7d", now);
    expect(w.from.toISOString()).toBe("2026-11-11T18:30:00.000Z");
    expect(w.prevFrom.toISOString()).toBe("2026-11-04T18:30:00.000Z");
    expect(w.prevTo.toISOString()).toBe("2026-11-11T06:00:00.000Z");
    expect(w.bucket).toBe("day");
  });

  it("handles the IST date boundary just after midnight", () => {
    const w = overviewWindow("today", new Date("2026-11-18T18:45:00Z"));
    expect(w.from.toISOString()).toBe("2026-11-18T18:30:00.000Z");
  });
});

describe("getInventoryOverview", () => {
  it("scopes the RPC to the tenant and passes both windows", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: { catalog: { totalProducts: 3 }, current: { orders: 2, orderValue: "450.50" }, previous: { orders: 1 }, series: [], topProducts: [], attention: [] }, error: null };
      },
    };
    const result = await getInventoryOverview(supabase as never, ctx, { range: "30d" }, now);
    expect(calls[0].name).toBe("inventory_overview");
    expect(calls[0].args.p_organization_id).toBe("org-1");
    expect(calls[0].args.p_prev_to).toBe("2026-10-19T06:00:00.000Z");
    expect(result.complete).toBe(true);
    expect(result.current.orderValue).toBe(450.5);
    expect(result.previous?.orders).toBe(1);
  });

  it("falls back to the older RPCs when the migration is not applied yet", async () => {
    const supabase = {
      rpc: async (name: string) => {
        if (name === "inventory_overview") return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
        if (name === "inventory_analytics_window") return { data: [{ total_products: 5, order_count: 2, total_sales: 900, amount_received: 300, pending_amount: 600, cod_outstanding: 400 }], error: null };
        return { data: [], error: null };
      },
    };
    const result = await getInventoryOverview(supabase as never, ctx, { range: "7d" }, now);
    expect(result.complete).toBe(false);
    expect(result.previous).toBeNull();
    expect(result.current).toMatchObject({ orders: 2, orderValue: 900, collected: 300, codDue: 400, prepaidDue: 200 });
  });
});
