import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const orgA = "50000000-0000-4000-8000-00000000000a";
const orgB = "50000000-0000-4000-8000-00000000000b";
const manager = "60000000-0000-4000-8000-000000000001";
const operator = "60000000-0000-4000-8000-000000000002";
const other = "60000000-0000-4000-8000-000000000003";
const migration = "supabase/migrations/20261120150000_store_builder.sql";
let db: PGlite;

async function as<T>(uid: string, fn: () => Promise<T>) {
  await db.exec(`set role authenticated; select set_config('test.uid', '${uid}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;");
  }
}

const publish = (org: string, layout: string | null, expected: string | null = null) =>
  db.query<{ publish_storefront_layout: string }>(
    "select public.publish_storefront_layout($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6::uuid[], $7::timestamptz)",
    [org, layout, layout ? "#16A34A" : null, layout ? '{"version":1,"secondaryColor":"#0f766e","font":"inter"}' : null, null, null, expected]
  );

describe("store builder migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
      create type public.member_role as enum ('OWNER','ADMIN','MANAGER','OPERATOR','VIEWER');
      create table public.organizations(id uuid primary key);
      insert into public.organizations values ('${orgA}'), ('${orgB}');
      create table public.organization_members(organization_id uuid, user_id uuid, role public.member_role);
      insert into public.organization_members values ('${orgA}', '${manager}', 'MANAGER'), ('${orgA}', '${operator}', 'OPERATOR'), ('${orgB}', '${other}', 'OWNER');
      create function public.has_org_role(org_id uuid, roles public.member_role[]) returns boolean language sql stable security definer set search_path = public as $$
        select exists (select 1 from public.organization_members where organization_id = org_id and user_id = auth.uid() and role = any(roles)) $$;
      create function public.is_org_member(org_id uuid) returns boolean language sql stable security definer set search_path = public as $$
        select exists (select 1 from public.organization_members where organization_id = org_id and user_id = auth.uid()) $$;
      create function public.inventory_writer(org_id uuid) returns boolean language sql stable security definer set search_path = public as $$
        select public.has_org_role(org_id, array['OWNER','ADMIN','MANAGER']::public.member_role[]) $$;
      create table public.storefront_settings (
        organization_id uuid primary key references public.organizations(id) on delete cascade,
        store_name text, logo_path text, accent_color text, published boolean not null default true,
        featured_product_ids uuid[] not null default '{}', footer jsonb, theme jsonb not null default '{}', tracking jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      alter table public.storefront_settings enable row level security;
      create policy storefront_settings_select on public.storefront_settings for select using (public.is_org_member(organization_id));
      create policy storefront_settings_write on public.storefront_settings for all using (public.inventory_writer(organization_id)) with check (public.inventory_writer(organization_id));
      grant usage on schema public, auth to authenticated;
      grant select, insert, update, delete on all tables in schema public to authenticated;
      insert into public.storefront_settings(organization_id, accent_color, featured_product_ids) values ('${orgA}', '#E11D48', '{}'), ('${orgB}', '#2563EB', '{}');
    `);
    await db.exec(readFileSync(migration, "utf8"));
    await db.exec(readFileSync(migration, "utf8")); // re-runnable
    await db.exec("grant select, insert, update, delete on public.storefront_layout_versions to authenticated;");
  }, 30000);

  afterAll(async () => { await db?.close(); });

  it("adds the columns without touching existing rows", async () => {
    const { rows } = await db.query<{ accent_color: string; draft_layout: unknown; published_layout: unknown }>(
      "select accent_color, draft_layout, published_layout from public.storefront_settings where organization_id = $1", [orgA]
    );
    expect(rows[0]).toEqual({ accent_color: "#E11D48", draft_layout: null, published_layout: null });
  });

  it("lets a manager publish and records the pre-builder state first", async () => {
    await as(manager, () => publish(orgA, '{"version":1,"themeId":"fresh-mart"}'));
    const { rows } = await db.query<{ accent_color: string; published_layout: { themeId: string } }>(
      "select accent_color, published_layout from public.storefront_settings where organization_id = $1", [orgA]
    );
    expect(rows[0].accent_color).toBe("#16A34A");
    expect(rows[0].published_layout.themeId).toBe("fresh-mart");
    const versions = await db.query<{ label: string; accent: string }>(
      "select label, snapshot->>'accentColor' as accent from public.storefront_layout_versions where organization_id = $1 order by published_at", [orgA]
    );
    expect(versions.rows).toEqual([{ label: "before-store-builder", accent: "#E11D48" }, { label: "published", accent: "#16A34A" }]);
  });

  it("does not let an operator publish", async () => {
    await expect(as(operator, () => publish(orgA, '{"version":1}'))).rejects.toThrow(/Not allowed/);
  });

  it("does not let another merchant publish, read or restore this store", async () => {
    await expect(as(other, () => publish(orgA, '{"version":1}'))).rejects.toThrow(/Not allowed/);
    const versions = await as(other, () => db.query("select id from public.storefront_layout_versions where organization_id = $1", [orgA]));
    expect(versions.rows).toHaveLength(0);
    const settings = await as(other, () => db.query("select draft_layout from public.storefront_settings where organization_id = $1", [orgA]));
    expect(settings.rows).toHaveLength(0);
    const insert = as(other, () => db.query("insert into public.storefront_layout_versions(organization_id, snapshot) values ($1, '{}')", [orgA]));
    await expect(insert).rejects.toThrow();
  });

  it("rejects publishing a draft that changed since it was loaded", async () => {
    await db.query("update public.storefront_settings set draft_updated_at = '2026-11-20T10:00:00Z' where organization_id = $1", [orgA]);
    await expect(as(manager, () => publish(orgA, '{"version":1}', "2026-11-20T09:00:00Z"))).rejects.toThrow(/draft changed/);
    await as(manager, () => publish(orgA, '{"version":1,"themeId":"couture"}', "2026-11-20T10:00:00Z"));
  });

  it("reverting to classic clears the layout but keeps branding and history", async () => {
    await as(manager, () => publish(orgA, null));
    const { rows } = await db.query<{ published_layout: unknown; accent_color: string }>(
      "select published_layout, accent_color from public.storefront_settings where organization_id = $1", [orgA]
    );
    expect(rows[0].published_layout).toBeNull();
    expect(rows[0].accent_color).toBe("#16A34A");
    const labels = await db.query<{ label: string }>("select label from public.storefront_layout_versions where organization_id = $1 order by published_at desc limit 1", [orgA]);
    expect(labels.rows[0].label).toBe("reverted-to-classic");
  });

  it("keeps at most 20 published versions plus the original", async () => {
    for (let i = 0; i < 25; i += 1) await as(manager, () => publish(orgA, `{"version":1,"n":${i}}`));
    const { rows } = await db.query<{ label: string; n: number }>(
      "select label, count(*)::int as n from public.storefront_layout_versions where organization_id = $1 group by label order by label", [orgA]
    );
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.n]));
    expect(byLabel["before-store-builder"]).toBe(1);
    expect((byLabel.published ?? 0) + (byLabel["reverted-to-classic"] ?? 0)).toBe(20);
  });

  it("leaves other merchants' stores untouched", async () => {
    const { rows } = await db.query<{ accent_color: string; published_layout: unknown }>(
      "select accent_color, published_layout from public.storefront_settings where organization_id = $1", [orgB]
    );
    expect(rows[0]).toEqual({ accent_color: "#2563EB", published_layout: null });
  });

  it("does not let anonymous users call publish", async () => {
    const { rows } = await db.query<{ ok: boolean }>("select has_function_privilege('anon', 'public.publish_storefront_layout(uuid, jsonb, text, jsonb, jsonb, uuid[], timestamptz)', 'execute') as ok");
    expect(rows[0].ok).toBe(false);
  });
});
