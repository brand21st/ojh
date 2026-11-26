/**
 * Isolated PGlite proof for the packing video migration: starting a recording,
 * free quota, Rs 1 wallet charge, UNPAID when short, idempotent finalize and expiry.
 * Wallet tables and helpers are minimal stubs of migration 20261121120000 (which lives
 * on feat/tenant-wallet); the real wallet__post is not exercised here.
 * Does not connect to any Supabase project.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

let db: PGlite;

const ORG = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000b2";
const PACKER = "00000000-0000-0000-0000-000000000011";
const OUTSIDER = "00000000-0000-0000-0000-000000000012";
const ORDER = "00000000-0000-0000-0000-0000000000c1";
const CANCELLED_ORDER = "00000000-0000-0000-0000-0000000000c2";

function migration(file: string) {
  return readFileSync(`supabase/migrations/${file}`, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(revoke|grant)\b/i.test(line))
    .join("\n");
}

async function as(userId: string | null) {
  await db.query("select set_config('test.uid', $1, false)", [userId ?? ""]);
}

async function rpc(sql: string, params: unknown[] = []) {
  const result = await db.query<{ r: Record<string, unknown> }>(`select ${sql} as r`, params);
  return result.rows[0].r;
}

async function start(code: string, org = ORG) {
  return rpc("public.vms_start_recording($1, $2)", [org, code]);
}

async function finalize(videoId: string) {
  return rpc("public.vms_finalize_video($1, $2, $3, $4, $5)", [videoId, `vms/${videoId}.mp4`, 1234, 5000, "video/mp4"]);
}

async function balance(org = ORG) {
  const result = await db.query<{ b: string }>("select balance_micros::text as b from public.wallets where organization_id = $1", [org]);
  return Number(result.rows[0]?.b ?? 0);
}

describe("packing videos migration", () => {
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

      create table public.organizations (id uuid primary key);
      create table public.organization_members (organization_id uuid, user_id uuid);
      create function public.is_org_member(p uuid) returns boolean language sql stable as $$
        select exists (select 1 from public.organization_members where organization_id = p and user_id = auth.uid())
      $$;
      create function public.member_can_pack(p uuid) returns boolean language sql stable as $$
        select public.is_org_member(p)
      $$;
      create table public.orders (
        id uuid primary key, organization_id uuid not null, order_number text, status text not null default 'READY',
        created_at timestamptz not null default now()
      );
      create table public.shipments (
        id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid,
        barcode text, tracking_number text, created_at timestamptz not null default now()
      );
      create table public.platform_settings (id integer primary key);
      insert into public.platform_settings (id) values (1);

      -- Minimal tenant wallet stubs.
      create table public.wallets (
        id uuid primary key default gen_random_uuid(), organization_id uuid unique not null,
        status text not null default 'ACTIVE', balance_micros bigint not null default 0,
        reserved_micros bigint not null default 0, credit_limit_micros bigint not null default 0
      );
      create table public.wallet_ledger (
        id uuid primary key default gen_random_uuid(), wallet_id uuid not null, organization_id uuid not null,
        entry_type text not null, service text, amount_micros bigint not null, idempotency_key text not null,
        reference_type text, reference_id text, description text, metadata jsonb,
        constraint wallet_ledger_service_chk check (service is null or service in ('whatsapp', 'ai')),
        constraint wallet_ledger_type_sign_chk check (amount_micros <> 0),
        unique (wallet_id, idempotency_key)
      );
      create function public.wallet__lock(p_org uuid) returns public.wallets language plpgsql as $$
      declare w public.wallets;
      begin
        insert into public.wallets (organization_id) values (p_org) on conflict (organization_id) do nothing;
        select * into w from public.wallets where organization_id = p_org for update;
        return w;
      end; $$;
      create function public.wallet__post(
        p_wallet_id uuid, p_entry_type text, p_amount bigint, p_key text, p_service text default null,
        p_reference_type text default null, p_reference_id text default null, p_reservation_id uuid default null,
        p_pricing_rule_id uuid default null, p_actor uuid default null, p_description text default null,
        p_metadata jsonb default '{}'::jsonb
      ) returns public.wallet_ledger language plpgsql as $$
      declare l public.wallet_ledger; w public.wallets;
      begin
        update public.wallets set balance_micros = balance_micros + p_amount where id = p_wallet_id returning * into w;
        insert into public.wallet_ledger (wallet_id, organization_id, entry_type, service, amount_micros, idempotency_key,
          reference_type, reference_id, description, metadata)
        values (w.id, w.organization_id, p_entry_type, p_service, p_amount, p_key, p_reference_type, p_reference_id,
          p_description, p_metadata)
        returning * into l;
        return l;
      end; $$;
    `);
    await db.exec(migration("20261127120000_packing_videos.sql"));
    await db.exec(`
      insert into auth.users (id) values ('${PACKER}'), ('${OUTSIDER}');
      insert into public.organizations (id) values ('${ORG}'), ('${OTHER_ORG}');
      insert into public.organization_members values ('${ORG}', '${PACKER}'), ('${OTHER_ORG}', '${OUTSIDER}');
      insert into public.orders (id, organization_id, order_number) values ('${ORDER}', '${ORG}', '#1001');
      insert into public.orders (id, organization_id, order_number, status) values ('${CANCELLED_ORDER}', '${ORG}', '#1002', 'CANCELLED');
      insert into public.shipments (organization_id, order_id, barcode) values ('${ORG}', '${ORDER}', 'EK123456789IN');
      update public.platform_settings set vms_free_videos = 2;
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("refuses people outside the workspace", async () => {
    await as(OUTSIDER);
    await expect(start("EK123456789IN", ORG)).rejects.toThrow(/packing station/);
  });

  it("matches a scanned tracking barcode to its order", async () => {
    await as(PACKER);
    const result = await start(" ek123456789in ");
    expect(result.status).toBe("RECORDING");
    expect(result.code).toBe("EK123456789IN");
    expect(result.orderId).toBe(ORDER);
    expect(result.orderNumber).toBe("#1001");
    expect(result.trackingNumber).toBe("EK123456789IN");
    expect(result.free).toBe(true);
  });

  it("records an unknown barcode without an order and refuses cancelled orders", async () => {
    await as(PACKER);
    const unknown = await start("MEESHO-AWB-555");
    expect(unknown.status).toBe("RECORDING");
    expect(unknown.orderId).toBeNull();
    const cancelled = await start("1002");
    expect(cancelled.status).toBe("CANCELLED");
    expect((await start("ab")).status).toBe("INVALID_CODE");
  });

  it("uses free videos first, then charges Rs 1 from the wallet, once per video", async () => {
    await as(PACKER);
    await db.exec(`delete from public.packing_videos`);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(String((await start(`PARCEL${i}00`)).videoId));

    expect((await finalize(ids[0])).status).toBe("FREE");
    expect((await finalize(ids[1])).status).toBe("FREE");

    // Third video: wallet empty, so the file is kept but unpaid.
    expect((await finalize(ids[2])).status).toBe("UNPAID");

    // Free quota is gone and the wallet is empty: new recordings are refused.
    const refused = await start("PARCEL900");
    expect(refused.status).toBe("NO_BALANCE");
    expect(refused.priceMicros).toBe("1000000");

    await db.exec(`update public.wallets set balance_micros = 5000000 where organization_id = '${ORG}'`);
    const charged = await rpc("public.vms__charge($1)", [ids[2]]);
    expect(charged.status).toBe("CHARGED");
    expect(await balance()).toBe(4000000);

    // Charging or finalizing again never debits twice.
    expect((await rpc("public.vms__charge($1)", [ids[2]])).status).toBe("CHARGED");
    expect((await finalize(ids[2])).status).toBe("CHARGED");
    expect(await balance()).toBe(4000000);

    const ledger = await db.query<{ entry_type: string; service: string; amount_micros: string }>(
      "select entry_type, service, amount_micros::text from public.wallet_ledger"
    );
    expect(ledger.rows).toEqual([{ entry_type: "USAGE_VMS", service: "vms", amount_micros: "-1000000" }]);

    const row = await db.query<{ status: string; expires_at: string | null; size_bytes: string }>(
      "select status, expires_at::text, size_bytes::text from public.packing_videos where id = $1",
      [ids[2]]
    );
    expect(row.rows[0].status).toBe("READY");
    expect(row.rows[0].expires_at).not.toBeNull();
    expect(row.rows[0].size_bytes).toBe("1234");
  });

  it("lets only the recorder cancel, and only while recording", async () => {
    await as(PACKER);
    const video = String((await start("CANCELME1")).videoId);
    await as(OUTSIDER);
    await expect(rpc("public.vms_cancel_recording($1)", [video])).rejects.toThrow(/Only the person/);
    await as(PACKER);
    expect(await rpc("public.vms_cancel_recording($1)", [video])).toBe(true);
    expect(await rpc("public.vms_cancel_recording($1)", [video])).toBe(false);
    expect((await finalize(video)).status).toBe("NOT_RECORDING");
  });

  it("hides other workspaces' videos through RLS", async () => {
    await db.exec(`
      create role vms_reader;
      grant usage on schema public, auth to vms_reader;
      grant select on public.packing_videos, public.organization_members to vms_reader;
      grant execute on all functions in schema public, auth to vms_reader;
    `);
    await as(OUTSIDER);
    await db.exec("set role vms_reader");
    const visible = await db.query<{ n: number }>("select count(*)::int as n from public.packing_videos");
    await db.exec("reset role");
    expect(visible.rows[0].n).toBe(0);
  });

  it("expires saved videos past retention and fails abandoned recordings", async () => {
    await as(PACKER);
    const stale = String((await start("STALE0001")).videoId);
    await db.exec(`
      update public.packing_videos set started_at = now() - interval '7 hours' where id = '${stale}';
      update public.packing_videos set expires_at = now() - interval '1 minute' where status = 'READY' and billing_status = 'FREE';
    `);
    const expired = await db.query<{ id: string; previous_status: string; storage_path: string | null }>(
      "select * from public.vms_expire_videos(100)"
    );
    const byStatus = expired.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.previous_status] = (acc[row.previous_status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus.READY).toBe(2);
    expect(byStatus.RECORDING).toBeGreaterThanOrEqual(1);
    expect(expired.rows.find((row) => row.id === stale)).toBeTruthy();
    expect((await db.query("select * from public.vms_expire_videos(100)")).rows).toHaveLength(0);
  });
});
