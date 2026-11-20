/**
 * Real PostgreSQL (PGlite) check for the fixes in 20261120160000_stop_postgres_query_errors:
 * order keys never reach orders.id as text, blank actor ids store null, and booking
 * recovery can select shipments.created_by.
 * Run: npx vitest run modules/orders/postgres-query-errors.pg.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const createShipmentsForOrdersSpy = vi.fn();
const enqueueShipmentBookingJob = vi.fn(async () => ({ id: "job-1" }));

vi.mock("@/modules/jobs/shipment-booking-job", () => ({
  enqueueShipmentBookingJob: (...args: unknown[]) => enqueueShipmentBookingJob(...(args as [])),
}));
vi.mock("@/modules/india-post/tracking-sync", () => ({ enqueueOrgTrackingSyncIfIdle: vi.fn() }));
vi.mock("@/modules/labels/load", () => ({ loadLabelPdfBytes: vi.fn() }));

import { setOrderBookingService, updateOrderWeights } from "@/modules/orders/service";
import { updateShipmentDimensions } from "@/modules/shipments/service";
import * as shipmentsService from "@/modules/shipments/service";
import { bookMerchantOrder } from "@/modules/merchant-api/shipments";
import { runBookingAutoRecovery } from "@/modules/india-post/booking-recovery";

type Filter = { column: string; op: "=" | "in" | "is" | "<"; value: unknown };
type PgError = { message: string; code?: string };

let db: PGlite;
const sqlLog: Array<{ sql: string; params: unknown[]; error?: string }> = [];

/** Columns from a PostgREST select string, dropping embedded relations. */
function selectColumns(cols: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of cols) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  const plain = parts.filter((part) => !part.includes("("));
  return plain.includes("*") || plain.length === 0 ? "*" : plain.map((c) => `"${c}"`).join(", ");
}

function bind(value: unknown) {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

/** Minimal PostgREST-shaped builder that runs real SQL in PGlite. */
class Query implements PromiseLike<{ data: unknown; error: PgError | null }> {
  private op: "select" | "update" | "insert" = "select";
  private cols = "*";
  private returning = false;
  private filters: Filter[] = [];
  private payload: Record<string, unknown> | null = null;
  private mode: "many" | "maybe" | "single" = "many";
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(private table: string) {}

  select(cols = "*") {
    if (this.op === "select") this.cols = cols;
    else {
      this.returning = true;
      this.cols = cols;
    }
    return this;
  }
  update(payload: Record<string, unknown>) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: Record<string, unknown>) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, op: "=", value });
    return this;
  }
  in(column: string, value: unknown[]) {
    this.filters.push({ column, op: "in", value });
    return this;
  }
  is(column: string, value: null) {
    this.filters.push({ column, op: "is", value });
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push({ column, op: "<", value });
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }

  private where(params: unknown[]) {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((f) => {
      if (f.op === "is") return `"${f.column}" is null`;
      if (f.op === "in") {
        const list = (f.value as unknown[]).map((v) => {
          params.push(bind(v));
          return `$${params.length}`;
        });
        return list.length ? `"${f.column}" in (${list.join(", ")})` : "false";
      }
      params.push(bind(f.value));
      return `"${f.column}" ${f.op} $${params.length}`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  private build() {
    const params: unknown[] = [];
    const table = this.table.includes(".") ? this.table : `public.${this.table}`;
    if (this.op === "insert") {
      const keys = Object.keys(this.payload ?? {});
      const values = keys.map((k) => {
        params.push(bind(this.payload![k]));
        return `$${params.length}`;
      });
      const ret = this.returning ? ` returning ${selectColumns(this.cols)}` : "";
      return { sql: `insert into ${table} (${keys.map((k) => `"${k}"`).join(", ")}) values (${values.join(", ")})${ret}`, params };
    }
    if (this.op === "update") {
      const sets = Object.entries(this.payload ?? {}).map(([k, v]) => {
        params.push(bind(v));
        return `"${k}" = $${params.length}`;
      });
      const where = this.where(params);
      const ret = this.returning ? ` returning ${selectColumns(this.cols)}` : "";
      return { sql: `update ${table} set ${sets.join(", ")}${where}${ret}`, params };
    }
    const where = this.where(params);
    const order = this.orderBy ? ` order by "${this.orderBy.column}" ${this.orderBy.ascending ? "asc" : "desc"}` : "";
    const limit = this.limitN != null ? ` limit ${this.limitN}` : "";
    return { sql: `select ${selectColumns(this.cols)} from ${table}${where}${order}${limit}`, params };
  }

  private async run(): Promise<{ data: unknown; error: PgError | null }> {
    const { sql, params } = this.build();
    try {
      const result = await db.query<Record<string, unknown>>(sql, params);
      sqlLog.push({ sql, params });
      const rows = result.rows;
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      if (this.mode === "many") return { data: rows, error: null };
      if (rows.length > 1) return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
      if (this.mode === "single" && rows.length === 0) {
        return { data: null, error: { message: "no rows", code: "PGRST116" } };
      }
      return { data: rows[0] ?? null, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sqlLog.push({ sql, params, error: message });
      return { data: null, error: { message, code: (error as { code?: string }).code } };
    }
  }

  then<A = { data: unknown; error: PgError | null }, B = never>(
    resolve?: ((value: { data: unknown; error: PgError | null }) => A | PromiseLike<A>) | null,
    reject?: ((reason: unknown) => B | PromiseLike<B>) | null
  ) {
    return this.run().then(resolve, reject);
  }
}

const supabase = {
  from: (table: string) => new Query(table),
  rpc: async () => ({ data: null, error: null }),
} as never;

const uuidErrors = () => sqlLog.filter((entry) => /invalid input syntax for type uuid/i.test(entry.error ?? ""));

let orgA: string;
let orgB: string;
let realUser: string;
let pbOrder: string;
let numericOrder: string;
let otherOrgPbOrder: string;
let shipmentA: string;

async function uuid() {
  return (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
}

beforeAll(async () => {
  db = new PGlite();
  const migration = readFileSync(
    path.join(process.cwd(), "supabase/migrations/20261120160000_stop_postgres_query_errors.sql"),
    "utf8"
  );
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table public.organizations (id uuid primary key);
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references public.organizations(id),
      order_number text not null,
      india_post_service text,
      parcel_weight_mode text,
      parcel_weight_grams int,
      metadata jsonb default '{}'::jsonb
    );
    create unique index orders_org_number_idx on public.orders (organization_id, order_number);
    create table public.order_line_items (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null,
      order_id uuid not null references public.orders(id),
      weight_grams int,
      weight_edited boolean
    );
    create table public.shipments (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null,
      order_id uuid references public.orders(id),
      status text not null default 'DRAFT',
      service_code text,
      weight_grams int,
      length_cm numeric, width_cm numeric, height_cm numeric,
      barcode text, tracking_number text, provider_ref text,
      booked_at timestamptz, last_error text, last_error_code text,
      metadata jsonb default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create table public.audit_logs (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references public.organizations(id) on delete cascade,
      actor_id uuid references auth.users(id),
      action text not null,
      entity_type text,
      entity_id uuid,
      before jsonb,
      after jsonb,
      created_at timestamptz not null default now()
    );
    create table public.background_jobs (
      id uuid primary key default gen_random_uuid(),
      organization_id uuid not null,
      job_type text, entity_type text, entity_id uuid
    );
    create table public.india_post_connections (id uuid primary key default gen_random_uuid(), organization_id uuid);
    create table public.india_post_contracts (id uuid primary key default gen_random_uuid(), organization_id uuid);
    create publication supabase_realtime;
  `);
  // Apply the real migration so the created_by column comes from the shipped SQL.
  await db.exec(migration);

  orgA = await uuid();
  orgB = await uuid();
  realUser = await uuid();
  await db.query("insert into public.organizations (id) values ($1), ($2)", [orgA, orgB]);
  await db.query("insert into auth.users (id) values ($1)", [realUser]);
  pbOrder = (await db.query<{ id: string }>(
    "insert into public.orders (organization_id, order_number) values ($1, 'PB-10058') returning id",
    [orgA]
  )).rows[0]!.id;
  numericOrder = (await db.query<{ id: string }>(
    "insert into public.orders (organization_id, order_number) values ($1, '1042') returning id",
    [orgA]
  )).rows[0]!.id;
  otherOrgPbOrder = (await db.query<{ id: string }>(
    "insert into public.orders (organization_id, order_number) values ($1, 'PB-20001') returning id",
    [orgB]
  )).rows[0]!.id;
  shipmentA = (await db.query<{ id: string }>(
    "insert into public.shipments (organization_id, status, service_code, weight_grams) values ($1, 'DRAFT', 'SP_INLAND_PARCEL', 500) returning id",
    [orgA]
  )).rows[0]!.id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  sqlLog.length = 0;
});

const ctxA = (userId = "user-x") => ({ organizationId: orgA, userId, role: "owner" }) as never;

describe("schema from the migration", () => {
  it("adds shipments.created_by as a nullable uuid FK to auth.users", async () => {
    const col = await db.query<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_name='shipments' and column_name='created_by'"
    );
    expect(col.rows[0]).toEqual({ data_type: "uuid", is_nullable: "YES" });
    const pub = await db.query<{ tablename: string }>(
      "select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1"
    );
    expect(pub.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining(["orders", "shipments", "india_post_connections", "india_post_contracts"])
    );
  });
});

describe("order key resolution", () => {
  const weights = { parcelWeightMode: "manual", parcelWeightGrams: 750, lineItems: [] } as never;

  it("updateOrderWeights by uuid updates that order", async () => {
    await updateOrderWeights(supabase, ctxA(), pbOrder, weights).catch((e) => {
      // getOrder at the end may fail on tables this double lacks; the update must have landed.
      if (/invalid input syntax for type uuid/i.test(String(e?.message))) throw e;
    });
    const row = await db.query<{ parcel_weight_grams: number }>("select parcel_weight_grams from public.orders where id=$1", [pbOrder]);
    expect(row.rows[0]!.parcel_weight_grams).toBe(750);
    expect(uuidErrors()).toEqual([]);
  });

  it("updateOrderWeights with PB-10058 resolves by order_number and never sends it to orders.id", async () => {
    await updateOrderWeights(supabase, ctxA(), "PB-10058", { ...(weights as object), parcelWeightGrams: 800 } as never).catch((e) => {
      if (/invalid input syntax for type uuid/i.test(String(e?.message))) throw e;
    });
    const row = await db.query<{ parcel_weight_grams: number }>("select parcel_weight_grams from public.orders where id=$1", [pbOrder]);
    expect(row.rows[0]!.parcel_weight_grams).toBe(800);
    const idFilteredWithText = sqlLog.filter((e) => /from public\.orders|update public\.orders/.test(e.sql) && e.params.includes("PB-10058") && /"id" = \$/.test(e.sql) && !/"order_number"/.test(e.sql));
    expect(idFilteredWithText).toEqual([]);
    expect(uuidErrors()).toEqual([]);
  });

  it("setOrderBookingService by uuid, PB number, and plain numeric number", async () => {
    await expect(setOrderBookingService(supabase, ctxA(), pbOrder, "SP_INLAND_PARCEL")).resolves.toMatchObject({ id: pbOrder });
    await expect(setOrderBookingService(supabase, ctxA(), "pb-10058", "BUSINESS_PARCEL")).resolves.toMatchObject({ id: pbOrder });
    await expect(setOrderBookingService(supabase, ctxA(), "1042", "SP_INLAND_PARCEL")).resolves.toMatchObject({ id: numericOrder });
    const rows = await db.query<{ id: string; india_post_service: string }>(
      "select id, india_post_service from public.orders where id in ($1, $2)",
      [pbOrder, numericOrder]
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.india_post_service]))).toEqual({ [pbOrder]: "BUSINESS_PARCEL", [numericOrder]: "SP_INLAND_PARCEL" });
    expect(uuidErrors()).toEqual([]);
  });

  it.each(["", "   ", "99999", "PB-99999"])("key %j is not found without a uuid cast error", async (key) => {
    await expect(setOrderBookingService(supabase, ctxA(), key, "SP_INLAND_PARCEL")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(updateOrderWeights(supabase, ctxA(), key, weights)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(bookMerchantOrder(supabase, { organizationId: orgA, createdBy: null } as never, key, {})).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    expect(uuidErrors()).toEqual([]);
  });

  it("a PB number from another organization is not found", async () => {
    await expect(setOrderBookingService(supabase, ctxA(), "PB-20001", "SP_INLAND_PARCEL")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(bookMerchantOrder(supabase, { organizationId: orgA } as never, "PB-20001", {})).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    await expect(bookMerchantOrder(supabase, { organizationId: orgA } as never, otherOrgPbOrder, {})).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
    const other = await db.query<{ india_post_service: string | null }>("select india_post_service from public.orders where id=$1", [otherOrgPbOrder]);
    expect(other.rows[0]!.india_post_service).toBeNull();
    expect(uuidErrors()).toEqual([]);
  });

  it("bookMerchantOrder passes the resolved uuid to booking for both uuid and PB number", async () => {
    const spy = vi.spyOn(shipmentsService, "createShipmentsForOrders").mockImplementation(async (...args: unknown[]) => {
      createShipmentsForOrdersSpy(...args);
      return { queued: 1, skipped: [], shipments: [{ id: "s", status: "QUEUED", order_id: (args[2] as string[])[0] }] } as never;
    });
    await bookMerchantOrder(supabase, { organizationId: orgA, createdBy: realUser } as never, pbOrder, {});
    await bookMerchantOrder(supabase, { organizationId: orgA, createdBy: realUser } as never, "PB-10058", {});
    expect(createShipmentsForOrdersSpy.mock.calls.map((call) => call[2])).toEqual([[pbOrder], [pbOrder]]);
    expect(uuidErrors()).toEqual([]);
    spy.mockRestore();
  });

  it("control: the old direct id filter with PB-10058 is what raised the uuid error", async () => {
    const { error } = await supabase.from("orders").select("id").eq("organization_id", orgA).eq("id", "PB-10058").maybeSingle() as unknown as { error: PgError | null };
    expect(error?.message).toMatch(/invalid input syntax for type uuid/i);
  });
});

describe("audit actor", () => {
  const box = { lengthCm: 20, widthCm: 15, heightCm: 10 } as never;

  it("blank user id stores actor_id null; real uuid is stored; org unchanged", async () => {
    await updateShipmentDimensions(supabase, ctxA(""), shipmentA, box);
    await updateShipmentDimensions(supabase, ctxA(realUser), shipmentA, box);
    const logs = await db.query<{ actor_id: string | null; organization_id: string; action: string }>(
      "select actor_id, organization_id, action from public.audit_logs where entity_id=$1 order by created_at, actor_id nulls first",
      [shipmentA]
    );
    expect(logs.rows).toEqual([
      { actor_id: null, organization_id: orgA, action: "shipment.dimensions_updated" },
      { actor_id: realUser, organization_id: orgA, action: "shipment.dimensions_updated" },
    ]);
    expect(sqlLog.filter((e) => e.sql.startsWith("insert into public.audit_logs") && e.error)).toEqual([]);
    expect(uuidErrors()).toEqual([]);
  });

  it("control: inserting actor_id '' directly raises the uuid error the fix avoids", async () => {
    const { error } = await supabase.from("audit_logs").insert({ organization_id: orgA, actor_id: "", action: "x" }) as unknown as { error: PgError | null };
    expect(error?.message).toMatch(/invalid input syntax for type uuid/i);
  });
});

describe("booking recovery", () => {
  it("selects created_by without error and enqueues rows with null and real created_by", async () => {
    process.env.BOOKING_AUTO_RECOVERY = "true";
    const nullCreator = (await db.query<{ id: string }>(
      "insert into public.shipments (organization_id, status, updated_at) values ($1, 'QUEUED', now() - interval '10 minutes') returning id",
      [orgA]
    )).rows[0]!.id;
    const withCreator = (await db.query<{ id: string }>(
      "insert into public.shipments (organization_id, status, created_by, updated_at) values ($1, 'QUEUED', $2, now() - interval '10 minutes') returning id",
      [orgA, realUser]
    )).rows[0]!.id;
    enqueueShipmentBookingJob.mockClear();
    const result = await runBookingAutoRecovery(supabase);
    expect(sqlLog.filter((e) => /created_by/.test(e.sql) && e.error)).toEqual([]);
    expect(result).toMatchObject({ enabled: true, recovered: 2 });
    const calls = enqueueShipmentBookingJob.mock.calls.map((c) => (c as unknown[])[1] as { entityId: string; userId?: string });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: nullCreator, userId: undefined }),
        expect.objectContaining({ entityId: withCreator, userId: realUser }),
      ])
    );
    delete process.env.BOOKING_AUTO_RECOVERY;
  });
});
