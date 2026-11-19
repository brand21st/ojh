import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "30000000-0000-4000-8000-000000000001";
const otherOrg = "30000000-0000-4000-8000-000000000002";
const A = "10000000-0000-4000-8000-00000000000a";
const B = "10000000-0000-4000-8000-00000000000b";
const C = "10000000-0000-4000-8000-00000000000c";
const D = "10000000-0000-4000-8000-00000000000d";
const NOW = "2026-11-18T12:00:00Z";

let db: PGlite;
type Overview = {
  catalog: Record<string, number>;
  current: Record<string, number>;
  previous: Record<string, number>;
  series: Array<{ bucket: string; orders: number; orderValue: number }>;
  topProducts: Array<{ productId: string; units: number; revenue: number; orders: number }>;
  attention: Array<{ productId: string; onHand: number; units30d: number }>;
};

async function order(id: number, opts: { org?: string; daysAgo: number; status?: string; payment: string; total: number; paid?: number; rto?: boolean; lines?: Array<[string, number, number]> }) {
  const orderId = `20000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  const owner = opts.org ?? org;
  await db.query(
    "insert into orders(id, organization_id, created_at, status, payment_status, total_amount, amount_paid) values ($1, $2, $3::timestamptz - make_interval(days => $4), $5, $6, $7, $8)",
    [orderId, owner, NOW, opts.daysAgo, opts.status ?? "BOOKED", opts.payment, opts.total, opts.paid ?? 0]
  );
  for (const [productId, quantity, unitPrice] of opts.lines ?? []) {
    await db.query("insert into order_line_items(organization_id, order_id, product_id, quantity, unit_price) values ($1, $2, $3, $4, $5)", [owner, orderId, productId, quantity, unitPrice]);
  }
  if (opts.rto) await db.query("insert into shipments(organization_id, order_id, operational_status) values ($1, $2, 'RTO_DELIVERED')", [owner, orderId]);
}

describe("inventory_overview", () => {
  let result: Overview;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table products(id uuid primary key, organization_id uuid, name text, sku text, active boolean, price numeric, low_stock_threshold integer);
      create table inventory_balances(organization_id uuid, product_id uuid, on_hand integer);
      create table orders(id uuid primary key, organization_id uuid, created_at timestamptz, status text, payment_status text, total_amount numeric, amount_paid numeric, cod_amount numeric default 0);
      create table order_line_items(organization_id uuid, order_id uuid, product_id uuid, quantity integer, unit_price numeric);
      create table shipments(organization_id uuid, order_id uuid, operational_status text);
    `);
    await db.exec(readFileSync("supabase/migrations/20261119100000_inventory_overview.sql", "utf8"));
    for (const [id, name, active, price, onHand] of [[A, "Alpha", true, 100, 50], [B, "Beta", true, 200, 3], [C, "Gamma", true, 80, 0], [D, "Archived", false, 90, 0]] as const) {
      await db.query("insert into products values ($1, $2, $3, $4, $5, $6, 5)", [id, org, name, name.toUpperCase(), active, price]);
      await db.query("insert into inventory_balances values ($1, $2, $3)", [org, id, onHand]);
    }
    await order(1, { daysAgo: 1, payment: "PAID", total: 300, lines: [[A, 1, 100], [B, 1, 200]] });
    await order(2, { daysAgo: 2, payment: "COD", total: 500, lines: [[A, 5, 100]] });
    await order(3, { daysAgo: 3, payment: "PARTIAL", total: 400, paid: 100, lines: [[B, 2, 200]] });
    await order(4, { daysAgo: 4, payment: "PENDING", total: 250, lines: [[A, 2, 125]] });
    await order(5, { daysAgo: 1, status: "CANCELLED", payment: "PENDING", total: 999, lines: [[A, 9, 111]] });
    await order(6, { daysAgo: 2, payment: "COD", total: 700, rto: true, lines: [[A, 7, 100]] });
    await order(7, { daysAgo: 2, payment: "REFUNDED", total: 150, lines: [[B, 1, 150]] });
    await order(8, { daysAgo: 10, payment: "PAID", total: 1000, lines: [[A, 10, 100]] });
    await order(9, { org: otherOrg, daysAgo: 1, payment: "PAID", total: 5000, lines: [[A, 50, 100]] });
    const res = await db.query<{ data: Overview }>(
      "select inventory_overview($1, $2::timestamptz - interval '7 days', $2::timestamptz, $2::timestamptz - interval '14 days', $2::timestamptz - interval '7 days', 'day') as data",
      [org, NOW]
    );
    result = res.rows[0].data;
  }, 30000);

  afterAll(async () => { await db?.close(); });

  it("splits sales money so collected, COD due and prepaid due add up to order value", () => {
    const c = result.current;
    expect(Number(c.orders)).toBe(4);
    expect(Number(c.orderValue)).toBe(1450);
    expect(Number(c.collected)).toBe(400);
    expect(Number(c.codDue)).toBe(800);
    expect(Number(c.prepaidDue)).toBe(250);
    expect(Number(c.collected) + Number(c.codDue) + Number(c.prepaidDue)).toBe(Number(c.orderValue));
    expect(Number(c.units)).toBe(11);
  });

  it("keeps cancelled, returned and refunded orders out of sales and counts them separately", () => {
    expect(Number(result.current.cancelled)).toBe(1);
    expect(Number(result.current.returned)).toBe(1);
    expect(Number(result.current.refunded)).toBe(1);
  });

  it("reports the previous period of equal length and ignores other organizations", () => {
    expect(Number(result.previous.orders)).toBe(1);
    expect(Number(result.previous.orderValue)).toBe(1000);
    expect(Number(result.previous.units)).toBe(10);
  });

  it("counts stock for active products only", () => {
    expect(result.catalog).toMatchObject({ totalProducts: 4, activeProducts: 3, stockUnits: 53, outOfStock: 1, lowStock: 1 });
    expect(Number(result.catalog.stockValue)).toBe(5600);
  });

  it("ranks top products by units sold in qualifying orders", () => {
    expect(result.topProducts.map((p) => [p.productId, Number(p.units), Number(p.revenue)])).toEqual([[A, 8, 850], [B, 3, 600]]);
  });

  it("lists active products needing attention, emptiest first, with 30-day demand", () => {
    expect(result.attention.map((p) => [p.productId, Number(p.onHand), Number(p.units30d)])).toEqual([[C, 0, 0], [B, 3, 3]]);
  });

  it("compares today with the same hours yesterday", async () => {
    await db.query("insert into orders(id, organization_id, created_at, status, payment_status, total_amount, amount_paid) values ('20000000-0000-4000-8000-0000000000aa', $1, '2026-11-17T05:00:00Z', 'BOOKED', 'PAID', 40, 40), ('20000000-0000-4000-8000-0000000000ab', $1, '2026-11-17T15:00:00Z', 'BOOKED', 'PAID', 60, 60)", [org]);
    const res = await db.query<{ data: Overview }>(
      "select inventory_overview($1, '2026-11-17T18:30:00Z', '2026-11-18T06:00:00Z', '2026-11-16T18:30:00Z', '2026-11-17T06:00:00Z', 'hour') as data",
      [org]
    );
    expect(Number(res.rows[0].data.previous.orderValue)).toBe(40);
    expect(res.rows[0].data.series).toHaveLength(12);
  });

  it("returns one bucket per IST day with sales orders only", () => {
    expect(result.series).toHaveLength(8);
    expect(result.series.reduce((sum, b) => sum + Number(b.orders), 0)).toBe(4);
  });
});
