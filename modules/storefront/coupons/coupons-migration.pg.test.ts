/**
 * Applies the storefront coupons migration to in-process Postgres (PGlite) on top of minimal
 * stubs and checks constraints, the auto-apply uniqueness, limit enforcement and stats.
 * No hosted database is touched.
 *
 * Run: npx vitest run modules/storefront/coupons/coupons-migration.pg.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) =>
  readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(revoke|grant)\b/i.test(line))
    .join("\n");

let db: PGlite;
let org: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.organizations (id uuid primary key default gen_random_uuid());
    create table public.orders (id uuid primary key default gen_random_uuid(), organization_id uuid not null);
    create function public.is_org_member(org uuid) returns boolean language sql stable as $$ select true $$;
    create function public.inventory_writer(org uuid) returns boolean language sql stable as $$ select true $$;
    create function public.set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at := now(); return new; end; $$;
    create table public.storefront_events (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null,
      event_type text not null,
      created_at timestamptz not null default now(),
      constraint storefront_events_type_chk check (event_type in ('PRODUCT_VIEW'))
    );
  `);
  await db.exec(migration("20261119130000_storefront_coupons.sql"));
  // Deploy retries must be safe.
  await db.exec(migration("20261119130000_storefront_coupons.sql"));
  org = (await db.query<{ id: string }>("insert into public.organizations default values returning id")).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

async function coupon(overrides: Record<string, unknown> = {}) {
  const row = { organization_id: org, code: `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`, discount_type: "PERCENT", value: 10, ...overrides };
  const columns = Object.keys(row);
  const result = await db.query<{ id: string }>(
    `insert into public.storefront_coupons (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row)
  );
  return result.rows[0].id;
}

const reserve = (id: string, phone = "9876543210") =>
  db.query<{ id: string }>("select public.reserve_storefront_coupon($1, $2, $3, 1000, 100, 900, 'PREPAID') as id", [org, id, phone]);

describe("storefront coupons migration", () => {
  it("rejects bad codes, 100% off, and incomplete Buy X get Y coupons", async () => {
    await expect(coupon({ code: "bad code" })).rejects.toThrow();
    await expect(coupon({ value: 100 })).rejects.toThrow();
    await expect(coupon({ discount_type: "BUY_X_GET_Y", value: 100 })).rejects.toThrow();
    await expect(coupon({ discount_type: "BUY_X_GET_Y", value: 100, buy_quantity: 2, get_quantity: 1 })).resolves.toBeTruthy();
    await expect(coupon({ applies_to: "PRODUCTS" })).rejects.toThrow();
  });

  it("keeps codes unique per store", async () => {
    await coupon({ code: "SAVE10" });
    await expect(coupon({ code: "SAVE10" })).rejects.toThrow();
  });

  it("allows only one active auto-apply coupon", async () => {
    await coupon({ auto_apply: true });
    await expect(coupon({ auto_apply: true })).rejects.toThrow();
    await expect(coupon({ auto_apply: true, status: "PAUSED" })).resolves.toBeTruthy();
  });

  it("enforces total and per-customer limits", async () => {
    const id = await coupon({ usage_limit: 2, per_customer_limit: 1 });
    await reserve(id, "9000000001");
    await expect(reserve(id, "9000000001")).rejects.toThrow(/COUPON_CUSTOMER_LIMIT/);
    await reserve(id, "9000000002");
    await expect(reserve(id, "9000000003")).rejects.toThrow(/COUPON_USAGE_LIMIT/);
  });

  it("refuses paused or expired coupons", async () => {
    const paused = await coupon({ status: "PAUSED" });
    await expect(reserve(paused)).rejects.toThrow(/COUPON_UNAVAILABLE/);
    const expired = await coupon({ starts_at: "2020-01-01", ends_at: "2020-02-01" });
    await expect(reserve(expired)).rejects.toThrow(/COUPON_EXPIRED/);
  });

  it("accepts coupon funnel events and reports stats", async () => {
    const id = await coupon();
    await db.query("insert into public.storefront_events (organization_id, event_type, coupon_id) values ($1, 'COUPON_LINK_OPENED', $2), ($1, 'COUPON_APPLIED', $2)", [org, id]);
    await reserve(id);
    const { rows } = await db.query<{ stats: { totals: Record<string, number>; coupons: Array<Record<string, unknown>>; daily: unknown[] } }>(
      "select public.storefront_coupon_stats($1, now() - interval '1 day', now() + interval '1 day') as stats",
      [org]
    );
    const stats = rows[0].stats;
    const row = stats.coupons.find((item) => item.couponId === id)!;
    expect(row).toMatchObject({ redemptions: 1, linkOpens: 1, applies: 1, lifetimeRedemptions: 1 });
    expect(Number(row.discount)).toBe(100);
    expect(Number(stats.totals.revenue)).toBeGreaterThanOrEqual(900);
    expect(stats.daily.length).toBe(1);
  });
});
