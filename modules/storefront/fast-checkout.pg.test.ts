import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const org = "30000000-0000-4000-8000-000000000001";
let db: PGlite;

describe("storefront fast checkout migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table organizations(id uuid primary key);
      insert into organizations values ('${org}');
    `);
    await db.exec(readFileSync("supabase/migrations/20261119140000_storefront_fast_checkout.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261119140000_storefront_fast_checkout.sql", "utf8"));
  }, 30000);

  afterAll(async () => { await db?.close(); });

  it("keeps one row per saved address and rejects malformed phones and PIN codes", async () => {
    const insert = (phone: string, pincode: string, fingerprint: string) =>
      db.query("insert into storefront_buyer_addresses(organization_id, phone, customer_name, line1, city, state, pincode, fingerprint) values ($1, $2, 'A', 'L1', 'Kochi', 'Kerala', $3, $4)", [org, phone, pincode, fingerprint]);
    await insert("9876543210", "682001", "f1");
    await expect(insert("9876543210", "682001", "f1")).rejects.toThrow();
    await expect(insert("12345", "682001", "f2")).rejects.toThrow();
    await expect(insert("9876543210", "6820", "f3")).rejects.toThrow();
  });

  it("only accepts sha256 device token hashes", async () => {
    await expect(db.query("insert into storefront_buyer_devices(organization_id, phone, token_hash, expires_at) values ($1, '9876543210', 'raw-token', now())", [org])).rejects.toThrow();
    await db.query("insert into storefront_buyer_devices(organization_id, phone, token_hash, expires_at) values ($1, '9876543210', $2, now())", [org, "a".repeat(64)]);
  });

  it("enables row level security and gives anon and signed-in users no access", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('storefront_buyer_addresses', 'storefront_buyer_devices', 'storefront_checkout_otps') order by relname"
    );
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
    const grants = await db.query<{ grantee: string }>(
      "select distinct grantee from information_schema.role_table_grants where table_name like 'storefront_%' and grantee in ('anon', 'authenticated', 'service_role')"
    );
    expect(grants.rows.map((row) => row.grantee)).toEqual(["service_role"]);
  });
});
