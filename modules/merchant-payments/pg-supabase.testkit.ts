import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test-only: a tiny supabase-js look-alike that runs the query-builder calls used by the merchant
 * payments module as real SQL on PGlite, so tests exercise the real migration, constraints and RPC.
 * Supports: select/insert/update, eq/in/gte/lte/or(in|lt), order, limit, single/maybeSingle, rpc.
 */

type Filter = { sql: string; values: unknown[] };
type Result = { data: unknown; error: { code?: string; message: string } | null };

function ident(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported identifier ${name}`);
  return `"${name}"`;
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private columns = "*";
  private returning = false;
  private payload: Record<string, unknown> | null = null;
  private filters: Filter[] = [];
  private orderBy: string | null = null;
  private max: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private db: PGlite, private table: string) {}

  select(columns = "*") {
    if (this.op === "select") this.columns = columns;
    else this.returning = true;
    if (this.op !== "select") this.columns = columns;
    return this;
  }
  insert(row: Record<string, unknown>) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(row: Record<string, unknown>) {
    this.op = "update";
    this.payload = row;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ sql: `${ident(column)} = ?`, values: [value] });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ sql: `${ident(column)}::text = any(?::text[])`, values: [values.map(String)] });
    return this;
  }
  gte(column: string, value: unknown) {
    this.filters.push({ sql: `${ident(column)} >= ?`, values: [value] });
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push({ sql: `${ident(column)} <= ?`, values: [value] });
    return this;
  }
  /** Only the shapes used in the module: `col.in.(A,B),col2.lt.<iso>`. */
  or(expression: string) {
    const parts = expression.split(/,(?![^(]*\))/).map((part): Filter => {
      const inMatch = /^([a-z_]+)\.in\.\((.*)\)$/.exec(part);
      if (inMatch) return { sql: `${ident(inMatch[1])}::text = any(?::text[])`, values: [inMatch[2].split(",")] };
      const ltMatch = /^([a-z_]+)\.lt\.(.*)$/.exec(part);
      if (ltMatch) return { sql: `${ident(ltMatch[1])} < ?`, values: [ltMatch[2]] };
      throw new Error(`unsupported or() part ${part}`);
    });
    this.filters.push({ sql: `(${parts.map((part) => part.sql).join(" or ")})`, values: parts.flatMap((part) => part.values) });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = `${ident(column)} ${options?.ascending === false ? "desc" : "asc"}`;
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }

  private columnList() {
    if (this.columns.trim() === "*") return "*";
    return this.columns
      .split(",")
      .map((column) => column.trim())
      .map((column) => {
        if (column.includes("(")) throw new Error(`embedded selects are not supported: ${column}`);
        return ident(column);
      })
      .join(", ");
  }

  private build() {
    const values: unknown[] = [];
    const where = this.filters.length
      ? ` where ${this.filters
          .map((filter) => {
            values.push(...filter.values);
            return filter.sql;
          })
          .join(" and ")}`
      : "";
    let sql: string;
    const setValues: unknown[] = [];
    if (this.op === "insert") {
      const keys = Object.keys(this.payload ?? {});
      sql = `insert into public.${ident(this.table)} (${keys.map(ident).join(", ")}) values (${keys.map(() => "?").join(", ")}) returning ${this.columnList()}`;
      setValues.push(...keys.map((key) => this.payload![key]));
      return { sql, values: setValues };
    }
    if (this.op === "update") {
      const keys = Object.keys(this.payload ?? {});
      sql = `update public.${ident(this.table)} set ${keys.map((key) => `${ident(key)} = ?`).join(", ")}${where} returning ${this.columnList()}`;
      return { sql, values: [...keys.map((key) => this.payload![key]), ...values] };
    }
    sql = `select ${this.columnList()} from public.${ident(this.table)}${where}`;
    if (this.orderBy) sql += ` order by ${this.orderBy}`;
    if (this.max != null) sql += ` limit ${Number(this.max)}`;
    return { sql, values };
  }

  async run(): Promise<Result> {
    try {
      const { sql, values } = this.build();
      let index = 0;
      const text = sql.replace(/\?/g, () => `$${++index}`);
      const result = await this.db.query<Record<string, unknown>>(
        text,
        values.map((value) => (value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : value))
      );
      const rows = result.rows.map(normalize);
      if (this.mode === "many") return { data: rows, error: null };
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      if (!rows.length && this.mode === "single") return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: rows[0] ?? null, error: null };
    } catch (error) {
      const pg = error as { code?: string; message?: string };
      return { data: null, error: { code: pg.code, message: pg.message ?? "query failed" } };
    }
  }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(onFulfilled, onRejected);
  }
}

function normalize(row: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = value instanceof Date ? value.toISOString() : typeof value === "bigint" ? Number(value) : value;
  }
  return output;
}

export function pgSupabase(db: PGlite) {
  return {
    from: (table: string) => new Query(db, table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const keys = Object.keys(args);
        const sql = `select public.${ident(name)}(${keys.map((key, index) => `${ident(key)} => $${index + 1}`).join(", ")}) as result`;
        const result = await db.query<{ result: unknown }>(sql, keys.map((key) => args[key]));
        return { data: result.rows[0]?.result ?? null, error: null };
      } catch (error) {
        const pg = error as { code?: string; message?: string };
        return { data: null, error: { code: pg.code, message: pg.message ?? "rpc failed" } };
      }
    },
  } as unknown as SupabaseClient;
}

/** Minimal schema the merchant payments module touches, plus the real migration. */
export const BASE_SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create type public.payment_status as enum ('PENDING', 'PAID', 'PARTIAL', 'COD', 'REFUNDED', 'FAILED');
  create type public.order_status as enum ('IMPORTED', 'READY', 'PROCESSING', 'BOOKED', 'SHIPPED', 'DELIVERED', 'FAILED', 'CANCELLED', 'IN_TRANSIT');
  create table public.organizations(id uuid primary key);
  create table public.orders(
    id uuid primary key, organization_id uuid not null references public.organizations(id),
    order_number text not null default 'WA-1',
    status public.order_status not null default 'IMPORTED',
    payment_status public.payment_status not null default 'PENDING',
    total_amount numeric(12,2) not null default 0, amount_paid numeric(12,2), cod_amount numeric(12,2),
    metadata jsonb not null default '{}'::jsonb);
  create table public.audit_logs(id bigserial primary key, organization_id uuid, actor_id uuid, action text, entity_type text, entity_id text, after jsonb);
  create table public.notifications(id bigserial primary key, organization_id uuid, type text, title text, body text, entity_type text, entity_id text);
  create table public.idempotency_keys(organization_id uuid, key text, request_hash text, response jsonb, primary key (organization_id, key));
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create function public.is_org_member(uuid) returns boolean language sql as $$ select false $$;
`;
