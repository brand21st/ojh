import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const orgA = "40000000-0000-4000-8000-00000000000a";
const orgB = "40000000-0000-4000-8000-00000000000b";
const migration = "supabase/migrations/20261120130000_storefront_subdomain_namespace.sql";
let db: PGlite;

describe("storefront subdomain namespace migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create table organizations(id uuid primary key);
      insert into organizations values ('${orgA}'), ('${orgB}');
      create table customer_order_links(
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id),
        status text not null default 'ACTIVE',
        public_workspace text,
        created_at timestamptz not null default now()
      );
      create unique index customer_order_links_active_workspace on customer_order_links (lower(public_workspace))
        where status = 'ACTIVE' and public_workspace is not null;
      create table tracking_pages(
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id),
        subdomain text not null unique
      );
      -- A legacy cross-merchant overlap that exists before the migration.
      insert into customer_order_links(organization_id, public_workspace) values ('${orgA}', 'legacy');
      insert into tracking_pages(organization_id, subdomain) values ('${orgB}', 'legacy');
    `);
    await db.exec(readFileSync(migration, "utf8"));
    await db.exec(readFileSync(migration, "utf8")); // re-runnable
  }, 30000);

  afterAll(async () => { await db?.close(); });

  const link = (org: string, slug: string) =>
    db.query("insert into customer_order_links(organization_id, public_workspace) values ($1, $2) returning id", [org, slug]);
  const page = (org: string, sub: string) =>
    db.query("insert into tracking_pages(organization_id, subdomain) values ($1, $2) returning id", [org, sub]);

  it("lets one merchant use the same label for store and tracking page", async () => {
    await page(orgA, "kala");
    await link(orgA, "kala");
  });

  it("blocks a store slug that is another merchant's tracking subdomain", async () => {
    await page(orgB, "priya");
    await expect(link(orgA, "priya")).rejects.toThrow(/another merchant/);
  });

  it("blocks a tracking subdomain that is another merchant's active store", async () => {
    await link(orgA, "tekiom-ventures");
    await expect(page(orgB, "tekiom-ventures")).rejects.toThrow(/another merchant/);
  });

  it("blocks renaming onto a taken label and moving a page onto a store", async () => {
    const { rows } = await link(orgA, "free-name");
    await expect(
      db.query("update customer_order_links set public_workspace = 'priya' where id = $1", [(rows[0] as { id: string }).id])
    ).rejects.toThrow();
    await expect(db.query("update tracking_pages set subdomain = 'tekiom-ventures' where subdomain = 'priya'")).rejects.toThrow();
  });

  it("allows store slugs freed by an inactive link", async () => {
    await db.query("insert into customer_order_links(organization_id, status, public_workspace) values ($1, 'DISABLED', 'gone')", [orgA]);
    await page(orgB, "gone");
  });

  it("keeps grandfathered overlaps editable without changing their label", async () => {
    await db.query("update customer_order_links set public_workspace = 'legacy' where public_workspace = 'legacy'");
    await db.query("update tracking_pages set subdomain = 'legacy' where subdomain = 'legacy'");
  });

  it("does not let clients call the guard functions", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      "select has_function_privilege('anon', 'public.assert_store_slug_host_free()', 'execute') as ok"
    );
    expect(rows[0].ok).toBe(false);
  });
});
