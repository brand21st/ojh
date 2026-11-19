import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const orgA = "40000000-0000-4000-8000-00000000000a";
const orgB = "40000000-0000-4000-8000-00000000000b";
const integrationA = "41000000-0000-4000-8000-00000000000a";
const integrationB = "41000000-0000-4000-8000-00000000000b";
const fp = "f".repeat(64);
const tokenHash = "a".repeat(64);
const MIGRATION = "supabase/migrations/20261120090000_merchant_razorpay_payments.sql";
let db: PGlite;

async function apply(args: {
  org?: string;
  order?: string;
  payment?: string;
  status: string;
  amount?: number;
  currency?: string;
  source?: string;
}) {
  const result = await db.query<{ r: { result: string; settled?: boolean } }>(
    "select public.apply_merchant_storefront_payment($1, $2, $3, $4, $5, $6, 'upi', null, $7) as r",
    [args.org ?? orgA, args.order ?? "order_A1", args.payment ?? "pay_1", args.status, args.amount ?? 49900, args.currency ?? "INR", args.source ?? "CHECKOUT"]
  );
  return result.rows[0].r;
}

async function orderRow(id = "50000000-0000-4000-8000-000000000001") {
  const result = await db.query<{ status: string; payment_status: string; amount_paid: string; cod_amount: string; metadata: { storefront: Record<string, unknown> & { onlinePayment: Record<string, unknown> }; whatsappLifecycle: Record<string, unknown> } }>(
    "select status, payment_status, amount_paid, cod_amount, metadata from orders where id = $1",
    [id]
  );
  return result.rows[0];
}

async function paymentRow(order = "order_A1") {
  const result = await db.query<{ payment_status: string; razorpay_payment_id: string | null; needs_review: boolean; extra_payment_ids: string[] }>(
    "select payment_status, razorpay_payment_id, needs_review, extra_payment_ids from merchant_storefront_payments where razorpay_order_id = $1",
    [order]
  );
  return result.rows[0];
}

describe("merchant razorpay payments migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create type public.payment_status as enum ('PENDING', 'PAID', 'PARTIAL', 'COD', 'REFUNDED', 'FAILED');
      create type public.order_status as enum ('IMPORTED', 'READY', 'PROCESSING', 'BOOKED', 'SHIPPED', 'DELIVERED', 'FAILED', 'CANCELLED', 'IN_TRANSIT');
      create table organizations(id uuid primary key);
      create table orders(
        id uuid primary key, organization_id uuid not null references organizations(id),
        status public.order_status not null default 'IMPORTED',
        payment_status public.payment_status not null default 'PENDING',
        total_amount numeric(12,2) not null default 0, amount_paid numeric(12,2), cod_amount numeric(12,2),
        metadata jsonb not null default '{}'::jsonb);
      create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
      create function public.is_org_member(uuid) returns boolean language sql as $$ select false $$;
      insert into organizations values ('${orgA}'), ('${orgB}');
    `);
    // Applying twice proves the migration is re-runnable.
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(`
      insert into merchant_payment_integrations(id, organization_id, webhook_token, connection_status)
      values ('${integrationA}', '${orgA}', '${"1".repeat(48)}', 'NOT_CONNECTED'),
             ('${integrationB}', '${orgB}', '${"2".repeat(48)}', 'NOT_CONNECTED');
    `);
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      delete from merchant_storefront_payments; delete from orders;
      insert into orders(id, organization_id, total_amount, metadata) values
        ('50000000-0000-4000-8000-000000000001', '${orgA}', 499, '{"storefront":{"total":499}}'),
        ('50000000-0000-4000-8000-000000000002', '${orgA}', 1000, '{}'),
        ('50000000-0000-4000-8000-000000000003', '${orgB}', 499, '{}');
      insert into merchant_storefront_payments(organization_id, integration_id, order_id, payment_mode, key_fingerprint, payment_kind, razorpay_order_id, amount_paise, order_total_paise, checkout_token_hash)
      values ('${orgA}', '${integrationA}', '50000000-0000-4000-8000-000000000001', 'TEST', '${fp}', 'FULL', 'order_A1', 49900, 49900, '${tokenHash}'),
             ('${orgA}', '${integrationA}', '50000000-0000-4000-8000-000000000002', 'TEST', '${fp}', 'COD_ADVANCE', 'order_A2', 20000, 100000, '${tokenHash}'),
             ('${orgB}', '${integrationB}', '50000000-0000-4000-8000-000000000003', 'LIVE', '${fp}', 'FULL', 'order_B1', 49900, 49900, '${tokenHash}');
    `);
  });

  it("settles a prepaid order once and treats a repeated callback as idempotent", async () => {
    expect(await apply({ status: "PAID" })).toMatchObject({ result: "paid", settled: true });
    const order = await orderRow();
    expect(order).toMatchObject({ status: "READY", payment_status: "PAID", amount_paid: "499.00", cod_amount: "0.00" });
    expect(order.metadata.storefront.total).toBe(499);
    expect(order.metadata.storefront.onlinePayment).toMatchObject({ status: "PAID", razorpayPaymentId: "pay_1", provider: "RAZORPAY" });
    expect(order.metadata.whatsappLifecycle.customer_confirmed_via).toBe("online_payment");

    expect(await apply({ status: "PAID", source: "WEBHOOK" })).toMatchObject({ result: "already_paid" });
    expect((await paymentRow()).needs_review).toBe(false);
  });

  it("records a COD advance as a partial payment with the balance due on delivery", async () => {
    expect(await apply({ order: "order_A2", payment: "pay_adv", status: "PAID", amount: 20000 })).toMatchObject({ result: "paid", settled: true });
    expect(await orderRow("50000000-0000-4000-8000-000000000002")).toMatchObject({
      status: "READY",
      payment_status: "PARTIAL",
      amount_paid: "200.00",
      cod_amount: "800.00",
    });
  });

  it("refuses amount and currency mismatches without changing the order", async () => {
    expect(await apply({ status: "PAID", amount: 100 })).toMatchObject({ result: "amount_mismatch" });
    expect(await apply({ status: "PAID", currency: "USD" })).toMatchObject({ result: "amount_mismatch" });
    expect(await orderRow()).toMatchObject({ status: "IMPORTED", payment_status: "PENDING" });
    expect(await paymentRow()).toMatchObject({ payment_status: "CREATED", needs_review: true });
  });

  it("never lets one merchant settle another merchant's Razorpay order", async () => {
    expect(await apply({ org: orgA, order: "order_B1", status: "PAID" })).toMatchObject({ result: "not_found" });
    expect(await orderRow("50000000-0000-4000-8000-000000000003")).toMatchObject({ status: "IMPORTED", payment_status: "PENDING" });
    expect((await paymentRow("order_B1")).payment_status).toBe("CREATED");
  });

  it("does not let a failed retry or late authorization undo a paid attempt", async () => {
    expect(await apply({ status: "FAILED", payment: "pay_0" })).toMatchObject({ result: "failed" });
    expect(await apply({ status: "PAID" })).toMatchObject({ result: "paid" });
    expect(await apply({ status: "FAILED", payment: "pay_2" })).toMatchObject({ result: "ignored" });
    expect(await apply({ status: "AUTHORIZED", payment: "pay_1" })).toMatchObject({ result: "ignored" });
    expect((await paymentRow()).payment_status).toBe("PAID");
  });

  it("flags a second captured payment on the same order for refund instead of double-settling", async () => {
    await apply({ status: "PAID" });
    expect(await apply({ status: "PAID", payment: "pay_extra" })).toMatchObject({ result: "duplicate_payment" });
    expect(await apply({ status: "PAID", payment: "pay_extra" })).toMatchObject({ result: "duplicate_payment" });
    expect(await paymentRow()).toMatchObject({ payment_status: "PAID", razorpay_payment_id: "pay_1", needs_review: true, extra_payment_ids: ["pay_extra"] });
  });

  it("records payment on a cancelled order but leaves the order for the merchant", async () => {
    await db.exec("update orders set status = 'CANCELLED' where id = '50000000-0000-4000-8000-000000000001'");
    expect(await apply({ status: "PAID" })).toMatchObject({ result: "paid", settled: false });
    expect(await orderRow()).toMatchObject({ status: "CANCELLED", payment_status: "PENDING" });
    expect((await paymentRow()).needs_review).toBe(true);
  });

  it("marks a full refund on the order before fulfilment", async () => {
    await apply({ status: "PAID" });
    expect(await apply({ status: "REFUNDED" })).toMatchObject({ result: "refunded" });
    expect((await orderRow()).payment_status).toBe("REFUNDED");
    expect((await paymentRow()).payment_status).toBe("REFUNDED");
  });

  it("keeps one attempt per order and one row per Razorpay payment id", async () => {
    await expect(
      db.query(
        `insert into merchant_storefront_payments(organization_id, integration_id, order_id, payment_mode, key_fingerprint, payment_kind, razorpay_order_id, amount_paise, order_total_paise, checkout_token_hash)
         values ($1, $2, '50000000-0000-4000-8000-000000000001', 'TEST', $3, 'FULL', 'order_dup', 49900, 49900, $4)`,
        [orgA, integrationA, fp, tokenHash]
      )
    ).rejects.toThrow();
    await apply({ status: "PAID" });
    await expect(apply({ order: "order_A2", status: "PAID", amount: 20000 })).rejects.toThrow();
  });

  it("refuses to enable checkout without a full connection", async () => {
    await expect(db.query("update merchant_payment_integrations set enabled = true where id = $1", [integrationA])).rejects.toThrow();
  });

  it("keeps credentials and webhook events away from browsers", async () => {
    const grants = await db.query<{ table_name: string; grantee: string; privilege_type: string }>(
      "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_name like 'merchant_%' and grantee in ('anon', 'authenticated') order by 1, 2, 3"
    );
    expect(grants.rows).toEqual([{ table_name: "merchant_storefront_payments", grantee: "authenticated", privilege_type: "SELECT" }]);
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname like 'merchant_%' and relkind = 'r'");
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
    const execute = await db.query<{ ok: boolean }>(
      "select has_function_privilege('authenticated', 'public.apply_merchant_storefront_payment(uuid, text, text, text, bigint, text, text, text, text)', 'execute') as ok"
    );
    expect(execute.rows[0].ok).toBe(false);
  });
});
