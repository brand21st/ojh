import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import { updateCategory } from "@/modules/products/categories";

type Call = { table: string; op: string };

/** Minimal chainable Supabase fake: every query resolves to `result(table, op)`. */
function fakeSupabase(result: (table: string, op: string) => { data: unknown; error: unknown; count?: number }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      let op = "select";
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const name of ["eq", "in", "order", "select"]) builder[name] = chain;
      for (const name of ["insert", "update", "delete"]) {
        builder[name] = () => {
          op = name;
          calls.push({ table, op });
          return builder;
        };
      }
      builder.maybeSingle = async () => result(table, op);
      builder.single = async () => result(table, op);
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result(table, op));
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const ctx = { organizationId: "00000000-0000-0000-0000-00000000000a", userId: "u1" } as TenantContext;

describe("updateCategory", () => {
  it("refuses to link products to a category this organization does not own", async () => {
    const { client, calls } = fakeSupabase(() => ({ data: null, error: null, count: 1 }));
    await expect(
      updateCategory(client, ctx, "00000000-0000-0000-0000-0000000000bb", {
        productIds: ["00000000-0000-0000-0000-000000000001"],
      })
    ).rejects.toMatchObject({ message: "Category not found." });
    expect(calls.filter((call) => call.table === "product_category_members")).toEqual([]);
  });

  it("maps a slug collision on rename to a conflict error", async () => {
    const { client } = fakeSupabase((table, op) =>
      table === "product_categories" && op === "update"
        ? { data: null, error: { code: "23505", message: "duplicate key value" } }
        : { data: [], error: null }
    );
    await expect(
      updateCategory(client, ctx, "00000000-0000-0000-0000-0000000000cc", { name: "T Shirts" })
    ).rejects.toMatchObject({ message: "A category with this name already exists." });
  });
});
