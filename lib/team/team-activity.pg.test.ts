/**
 * Isolated PGlite proof for the team migration: packing scans, permission checks,
 * suspended members, and the activity triggers. Does not connect to any Supabase project.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

let db: PGlite;

const ORG = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000a2";
const OWNER = "00000000-0000-0000-0000-000000000001";
const PACKER = "00000000-0000-0000-0000-000000000002";
const VIEWER = "00000000-0000-0000-0000-000000000003";
const OPERATOR = "00000000-0000-0000-0000-000000000004";
const SUSPENDED = "00000000-0000-0000-0000-000000000005";

function migration(file: string) {
  return readFileSync(`supabase/migrations/${file}`, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(revoke|grant)\b/i.test(line))
    .join("\n");
}

async function as(userId: string | null) {
  await db.query("select set_config('test.uid', $1, false)", [userId ?? ""]);
}

async function scan(code: string, org = ORG) {
  const result = await db.query<{ r: Record<string, unknown> }>("select public.record_pack_scan($1, $2) as r", [org, code]);
  return result.rows[0].r;
}

async function count(sql: string, params: unknown[] = []) {
  const result = await db.query<{ n: number }>(sql, params);
  return result.rows[0].n;
}

describe("team members and activity migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('test.uid', true), '')::uuid
      $$;
      create function public.set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end; $$;

      create type public.member_role as enum ('OWNER', 'ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER');
      create type public.order_status as enum ('IMPORTED', 'READY', 'PROCESSING', 'BOOKED', 'SHIPPED', 'DELIVERED', 'FAILED', 'CANCELLED');
      create type public.shipment_status as enum ('DRAFT', 'BOOKED');

      create table public.organizations (id uuid primary key, name text not null);
      create table public.profiles (id uuid primary key, email text, full_name text, active_organization_id uuid);
      create table public.organization_members (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        role public.member_role not null default 'VIEWER',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (organization_id, user_id)
      );
      create table public.organization_invites (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        email text not null,
        role public.member_role not null default 'OPERATOR',
        token_hash text not null,
        invited_by uuid,
        expires_at timestamptz not null,
        accepted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table public.orders (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        order_number text not null,
        status public.order_status not null default 'IMPORTED',
        created_at timestamptz not null default now()
      );
      create table public.shipments (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        order_id uuid not null references public.orders(id),
        barcode text,
        tracking_number text,
        status public.shipment_status not null default 'DRAFT',
        booked_at timestamptz,
        created_by uuid,
        created_at timestamptz not null default now()
      );
      create table public.labels (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        shipment_id uuid not null references public.shipments(id),
        downloaded_at timestamptz
      );
      create table public.manifests (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id),
        name text not null,
        shipment_count integer not null default 0,
        created_by uuid,
        created_at timestamptz not null default now()
      );

      -- Two open invites for one email, to prove the migration closes the older one.
      insert into public.organizations values ('${ORG}', 'Acme'), ('${OTHER_ORG}', 'Other');
      insert into public.organization_invites (organization_id, email, token_hash, expires_at, created_at)
      values ('${ORG}', 'dup@x.in', 'a', now() + interval '1 day', now() - interval '1 hour'),
             ('${ORG}', 'DUP@x.in', 'b', now() + interval '1 day', now());
    `);
    await db.exec(migration("20261127100000_member_role_packer.sql"));
    await db.exec(migration("20261127100100_team_members_activity.sql"));
    await db.exec(`
      insert into auth.users values ('${OWNER}'), ('${PACKER}'), ('${VIEWER}'), ('${OPERATOR}'), ('${SUSPENDED}');
      insert into public.profiles (id, email, full_name) values
        ('${OWNER}', 'owner@x.in', 'Owner'), ('${PACKER}', 'ravi@x.in', 'Ravi');
      insert into public.organization_members (organization_id, user_id, role) values
        ('${ORG}', '${OWNER}', 'OWNER'),
        ('${ORG}', '${PACKER}', 'PACKER'),
        ('${ORG}', '${VIEWER}', 'VIEWER'),
        ('${ORG}', '${OPERATOR}', 'OPERATOR');
      insert into public.organization_members (organization_id, user_id, role, status) values
        ('${ORG}', '${SUSPENDED}', 'PACKER', 'SUSPENDED');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("keeps only the newest open invite per email", async () => {
    expect(await count("select count(*)::int as n from organization_invites where revoked_at is null")).toBe(1);
    expect(await count("select count(*)::int as n from organization_invites where revoked_at is null and token_hash = 'b'")).toBe(1);
  });

  it("records a booking against the user who created the shipment", async () => {
    await as(OPERATOR);
    const order = await db.query<{ id: string }>(
      "insert into orders (organization_id, order_number) values ($1, '#1001') returning id",
      [ORG]
    );
    const orderId = order.rows[0].id;
    const shipment = await db.query<{ id: string; created_by: string }>(
      "insert into shipments (organization_id, order_id, barcode) values ($1, $2, 'EK123456789IN') returning id, created_by",
      [ORG, orderId]
    );
    expect(shipment.rows[0].created_by).toBe(OPERATOR);
    // A background worker books it later, without a signed-in user.
    await as(null);
    await db.query("update shipments set booked_at = now(), status = 'BOOKED' where id = $1", [shipment.rows[0].id]);
    await db.query("update shipments set booked_at = now() where id = $1", [shipment.rows[0].id]);
    const events = await db.query<{ actor_id: string }>(
      "select actor_id from team_activity_events where action = 'order.booked'"
    );
    expect(events.rows).toEqual([{ actor_id: OPERATOR }]);
  });

  it("counts a label print once per shipment", async () => {
    await as(OPERATOR);
    const shipment = await db.query<{ id: string }>("select id from shipments limit 1");
    await db.query("insert into labels (organization_id, shipment_id) values ($1, $2), ($1, $2)", [ORG, shipment.rows[0].id]);
    await db.query("update labels set downloaded_at = now()");
    await db.query("update labels set downloaded_at = now()");
    expect(await count("select count(*)::int as n from team_activity_events where action = 'label.printed'")).toBe(1);
  });

  it("marks an order packed from its barcode, once", async () => {
    await as(PACKER);
    const first = await scan(" ek123456789in ");
    expect(first.status).toBe("PACKED");
    expect(first.orderNumber).toBe("#1001");
    expect(first.packedBy).toBe(PACKER);

    await as(OPERATOR);
    const again = await scan("EK123456789IN");
    expect(again.status).toBe("ALREADY_PACKED");
    expect(again.packedByName).toBe("Ravi");
    expect(await count("select count(*)::int as n from team_activity_events where action = 'order.packed'")).toBe(1);
  });

  it("finds orders by order number with or without #", async () => {
    await as(OWNER);
    await db.query("insert into orders (organization_id, order_number) values ($1, '#1002')", [ORG]);
    expect((await scan("1002")).status).toBe("PACKED");
    expect((await scan("nothing-here")).status).toBe("NOT_FOUND");
  });

  it("refuses cancelled orders", async () => {
    await as(OWNER);
    await db.query("insert into orders (organization_id, order_number, status) values ($1, '1003', 'CANCELLED')", [ORG]);
    expect((await scan("1003")).status).toBe("CANCELLED");
  });

  it("enforces who may pack", async () => {
    await as(VIEWER);
    await expect(scan("1002")).rejects.toThrow(/packing station/);
    await as(SUSPENDED);
    await expect(scan("1002")).rejects.toThrow(/packing station/);
    await as(OWNER);
    await expect(scan("1002", OTHER_ORG)).rejects.toThrow(/packing station/);

    await db.query("update organization_members set extra_permissions = '{packing.scan}' where user_id = $1", [VIEWER]);
    await db.query("update organization_members set revoked_permissions = '{packing.scan}' where user_id = $1", [OPERATOR]);
    await as(VIEWER);
    expect((await scan("1002")).status).toBe("ALREADY_PACKED");
    await as(OPERATOR);
    await expect(scan("1002")).rejects.toThrow(/packing station/);
  });

  it("drops suspended members from membership checks", async () => {
    await as(SUSPENDED);
    expect((await db.query<{ ok: boolean }>("select public.is_org_member($1) as ok", [ORG])).rows[0].ok).toBe(false);
    await as(PACKER);
    expect((await db.query<{ ok: boolean }>("select public.is_org_member($1) as ok", [ORG])).rows[0].ok).toBe(true);
  });

  it("lets the packer undo their own recent scan but not someone else's", async () => {
    const order = await db.query<{ id: string }>("select id from orders where order_number = '#1001'");
    const orderId = order.rows[0].id;
    await as(VIEWER);
    await expect(db.query("select public.undo_pack_scan($1, $2)", [ORG, orderId])).rejects.toThrow(/cannot undo/);
    await as(PACKER);
    const undone = await db.query<{ ok: boolean }>("select public.undo_pack_scan($1, $2) as ok", [ORG, orderId]);
    expect(undone.rows[0].ok).toBe(true);
    expect(await count("select count(*)::int as n from team_activity_events where action = 'order.packed' and entity_id = $1", [orderId])).toBe(0);
  });

  it("records manifests with their shipment count and summarises per day", async () => {
    await as(OPERATOR);
    const manifest = await db.query<{ id: string }>(
      "insert into manifests (organization_id, name) values ($1, 'Morning') returning id",
      [ORG]
    );
    await db.query("update manifests set shipment_count = 12 where id = $1", [manifest.rows[0].id]);
    const summary = await db.query<{ actor_id: string; action: string; events: number; quantity: number }>(
      "select actor_id, action, events::int, quantity::int from team_activity_summary($1, now() - interval '1 day', now() + interval '1 day') order by action, actor_id",
      [ORG]
    );
    expect(summary.rows).toContainEqual({ actor_id: OPERATOR, action: "manifest.created", events: 1, quantity: 12 });
    expect(summary.rows).toContainEqual({ actor_id: OPERATOR, action: "order.booked", events: 1, quantity: 1 });
    expect(summary.rows).toContainEqual({ actor_id: OWNER, action: "order.packed", events: 1, quantity: 1 });
  });
});
