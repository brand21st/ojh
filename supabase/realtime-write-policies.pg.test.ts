/**
 * 20261120170000: anon must not hit has_org_role() through write policies.
 * Run: npx vitest run supabase/realtime-write-policies.pg.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20261120170000_realtime_write_policies_authenticated.sql"),
  "utf8"
);

let db: PGlite;
let org: string;

async function asRole(role: string, sql: string) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create table public.members (organization_id uuid, role text);
    create function public.is_org_member(org uuid) returns boolean language sql security definer
      as $$ select exists (select 1 from public.members m where m.organization_id = org) $$;
    create function public.has_org_role(org uuid, roles text[]) returns boolean language sql security definer
      as $$ select exists (select 1 from public.members m where m.organization_id = org and m.role = any(roles)) $$;
    revoke execute on function public.has_org_role(uuid, text[]) from public;
    grant execute on function public.has_org_role(uuid, text[]) to authenticated;
    grant execute on function public.is_org_member(uuid) to anon, authenticated;
  `);
  for (const table of ["india_post_connections", "print_agents", "print_jobs", "support_conversations", "support_messages", "support_tickets"]) {
    const cmd = table === "support_conversations" ? "update" : "all";
    await db.exec(`
      create table public.${table} (id uuid primary key default gen_random_uuid(), organization_id uuid);
      alter table public.${table} enable row level security;
      grant select, insert, update, delete on public.${table} to anon, authenticated;
      create policy ${table}_select on public.${table} for select using (public.is_org_member(organization_id));
      create policy ${table}_write on public.${table} for ${cmd}
        using (public.has_org_role(organization_id, array['OWNER']))
        with check (public.has_org_role(organization_id, array['OWNER']));
    `);
  }
  org = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
  await db.query("insert into public.members values ($1, 'OWNER')", [org]);
  await db.query("insert into public.india_post_connections (organization_id) values ($1)", [org]);
  await db.query("insert into public.support_conversations (organization_id) values ($1)", [org]);
});

afterAll(async () => {
  await db?.close();
});

describe("write policies scoped to authenticated", () => {
  it("before: anon reading india_post_connections fails on has_org_role", async () => {
    await expect(asRole("anon", "select * from public.india_post_connections")).rejects.toThrow(
      /permission denied for function has_org_role/
    );
  });

  it("after: anon reads nothing without error; authenticated keeps the same access", async () => {
    await db.exec(migration);
    const roles = await db.query<{ tablename: string; roles: string }>(
      "select tablename, roles::text from pg_policies where policyname like '%\\_write' order by 1"
    );
    expect(roles.rows.every((r) => r.roles === "{authenticated}")).toBe(true);
    expect(roles.rows).toHaveLength(6);

    for (const table of ["india_post_connections", "print_agents", "print_jobs", "support_conversations", "support_messages", "support_tickets"]) {
      await expect(asRole("anon", `select * from public.${table}`)).resolves.toBeTruthy();
    }
    const authed = await asRole("authenticated", "select organization_id from public.india_post_connections");
    expect(authed.rows).toEqual([{ organization_id: org }]);
    const authedUpdate = await asRole("authenticated", "update public.support_conversations set organization_id = organization_id returning id");
    expect(authedUpdate.rows).toHaveLength(1);
    await expect(
      asRole("anon", `insert into public.india_post_connections (organization_id) values ('${org}')`)
    ).rejects.toThrow(/row-level security/);
  });

  it("is idempotent", async () => {
    await expect(db.exec(migration)).resolves.toBeTruthy();
  });
});
