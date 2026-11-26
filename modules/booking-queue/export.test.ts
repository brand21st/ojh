import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/api/errors";
import type { TenantContext } from "@/lib/api/context";
import { bookedSelectionMessage, exportRequestBody } from "@/components/booking-queue/export-booked-dialog";
import { BOOKED_EXPORT_MAX, bookedArticleDetailsPlan } from "@/modules/booking-queue/export";

type Row = Record<string, unknown>;

function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table] ?? [];
    const run = () => ({ data: rows().filter((row) => filters.every((test) => test(row))), error: null });
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
      not: (column: string, operator: string, value: unknown) => {
        if (operator === "is" && value === null) filters.push((row) => row[column] != null);
        return builder;
      },
      gte: () => builder,
      lte: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const result = run();
        return { data: result.data[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient };
}

const ctx: TenantContext = {
  userId: "user-1",
  email: null,
  fullName: null,
  organizationId: "org-1",
  organizationName: "Org",
  role: "OWNER",
  permissions: [],
};

const originalFlag = process.env.BOOKING_QUEUE_ORGS;

afterEach(() => {
  process.env.BOOKING_QUEUE_ORGS = originalFlag;
});

function shipment(id: string, orderId: string, bookedAt: string | null): Row {
  return {
    id,
    organization_id: "org-1",
    order_id: orderId,
    barcode: "EA000000001IN",
    tracking_number: "EA000000001IN",
    service_code: "SP_INLAND_PARCEL",
    weight_grams: 500,
    length_cm: 10,
    width_cm: 10,
    height_cm: 10,
    payment_mode: "PREPAID",
    cod_amount: 0,
    booked_at: bookedAt,
    orders: { order_number: `#${orderId}`, source: "SHOPIFY" },
    addresses: { name: "Asha", line1: "12 MG Road", city: "Kochi", state: "Kerala", pincode: "682001", phone: "9876543210" },
  };
}

describe("exportRequestBody", () => {
  it("sends selected order ids and keeps history filters", () => {
    expect(exportRequestBody({ orderIds: ["order-1"], q: "  " })).toEqual({ orderIds: ["order-1"] });
    expect(exportRequestBody({ q: "asha", source: "SHOPIFY", from: "2026-11-01" }, 2)).toEqual({
      q: "asha",
      source: "SHOPIFY",
      from: "2026-11-01",
      part: 2,
    });
  });

  it("says how many selected orders were left out", () => {
    expect(bookedSelectionMessage(5, 3)).toBe("Downloaded 3 booked orders. 2 selected orders are not booked yet.");
    expect(bookedSelectionMessage(1, 1)).toBe("Downloaded 1 booked order.");
  });
});

describe("bookedArticleDetailsPlan", () => {
  it("exports only booked shipments for the selected orders without the queue flag", async () => {
    process.env.BOOKING_QUEUE_ORGS = "";
    const db = memoryDb({
      shipments: [
        shipment("ship-1", "11111111-1111-4111-8111-111111111111", "2026-11-01T00:00:00.000Z"),
        shipment("ship-2", "22222222-2222-4222-8222-222222222222", null),
        shipment("ship-3", "33333333-3333-4333-8333-333333333333", "2026-11-02T00:00:00.000Z"),
      ],
      organizations: [{ id: "org-1", name: "KL Trends", pincode: "682001" }],
      pickup_locations: [],
      shopify_stores: [],
      india_post_connections: [{ organization_id: "org-1", excel_booking_limit: 500 }],
    });

    const plan = await bookedArticleDetailsPlan(db.client, ctx, {
      orderIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    });

    expect(plan.total).toBe(2);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]?.count).toBe(2);
  });

  it("still requires the booking queue for a filter-only export", async () => {
    process.env.BOOKING_QUEUE_ORGS = "";
    const db = memoryDb({ shipments: [], organizations: [], pickup_locations: [], shopify_stores: [], india_post_connections: [] });
    await expect(bookedArticleDetailsPlan(db.client, ctx, { from: "2026-11-01" })).rejects.toBeInstanceOf(AppError);
  });

  it("refuses more order ids than one export can hold", async () => {
    process.env.BOOKING_QUEUE_ORGS = "";
    const db = memoryDb({ shipments: [], organizations: [], pickup_locations: [], shopify_stores: [], india_post_connections: [] });
    const orderIds = Array.from({ length: BOOKED_EXPORT_MAX + 1 }, (_, index) => `order-${index}`);
    await expect(bookedArticleDetailsPlan(db.client, ctx, { orderIds })).rejects.toMatchObject({
      message: expect.stringContaining(String(BOOKED_EXPORT_MAX)),
    });
  });
});
