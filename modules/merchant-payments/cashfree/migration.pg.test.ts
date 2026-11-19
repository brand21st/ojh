import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_SCHEMA } from "../pg-supabase.testkit";

const orgA = "80000000-0000-4000-8000-00000000000a";
const orgB = "80000000-0000-4000-8000-00000000000b";
const intA = "81000000-0000-4000-8000-00000000000a";
const intRzp = "81000000-0000-4000-8000-0000000000aa";
const order1 = "82000000-0000-4000-8000-000000000001";
const order2 = "82000000-0000-4000-8000-000000000002";
const fp = "f".repeat(64);
const th = "a".repeat(64);
const RAZORPAY = "supabase/migrations/20261120090000_merchant_razorpay_payments.sql";
const CASHFREE = "supabase/migrations/20261120100000_merchant_cashfree_payments.sql";
let db: PGlite;

async function apply(status: string, opts: { org?: string; cfOrder?: string; payment?: string; amount?: number; currency?: string } = {}) {
  const result = await db.query<{ r: { result: string; settled?: boolean } }>(
    "select public.apply_merchant_cashfree_payment($1, $2, $3, $4, $5, $6, 'upi', null, 'WEBHOOK') as r",
    [opts.org ?? orgA, opts.cfOrder ?? "pb_order1", opts.payment ?? "5001", status, opts.amount ?? 49900, opts.currency ?? "INR"]
  );
  return result.rows[0].r;
}

async function row() {
  return (
    await db.query<{ payment_status: string; cashfree_payment_id: string | null; needs_review: boolean }>(
      "select payment_status, cashfree_payment_id, needs_review from merchant_storefront_payments where cashfree_order_id = 'pb_order1'"
    )
  ).rows[0];
}

async function ord(id = order1) {
  return (await db.query<{ status: string; payment_status: string }>("select status, payment_status from orders where id = $1", [id])).rows[0];
}

describe("merchant cashfree migration", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(readFileSync(RAZORPAY, "utf8"));
    await db.exec(readFileSync(CASHFREE, "utf8"));
    // Re-runnable.
    await db.exec(readFileSync(CASHFREE, "utf8"));
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      delete from merchant_payment_webhook_events; delete from merchant_storefront_payments; delete from merchant_payment_integrations;
      delete from merchant_payment_settings; delete from orders; delete from organizations;
      insert into organizations values ('${orgA}'), ('${orgB}');
      insert into orders(id, organization_id, total_amount) values ('${order1}', '${orgA}', 499), ('${order2}', '${orgA}', 499);
      insert into merchant_payment_integrations(id, organization_id, provider, webhook_token, encrypted_key_id, encrypted_key_secret, key_fingerprint, payment_mode, connection_status, enabled)
        values ('${intA}', '${orgA}', 'CASHFREE', '${"b".repeat(48)}', 'enc-id', 'enc-secret', '${fp}', 'TEST', 'CONNECTED', true);
      insert into merchant_storefront_payments(organization_id, integration_id, order_id, provider, payment_mode, key_fingerprint, payment_kind, cashfree_order_id, amount_paise, order_total_paise, checkout_token_hash)
        values ('${orgA}', '${intA}', '${order1}', 'CASHFREE', 'TEST', '${fp}', 'FULL', 'pb_order1', 49900, 49900, '${th}');
    `);
  });

  it("lets Cashfree be enabled without a webhook secret, but still requires a connection", async () => {
    await expect(
      db.exec(`update merchant_payment_integrations set connection_status = 'VERIFICATION_FAILED' where id = '${intA}'`)
    ).rejects.toThrow(/enabled_requires_connection/);
    await db.exec(`
      insert into merchant_payment_integrations(id, organization_id, provider, webhook_token, encrypted_key_id, encrypted_key_secret, key_fingerprint, payment_mode, connection_status, enabled)
      values ('${intRzp}', '${orgA}', 'RAZORPAY', '${"c".repeat(48)}', 'k', 's', '${fp}', 'TEST', 'CONNECTED', false);
    `);
    // Razorpay still needs its webhook secret before it can be enabled.
    await expect(db.exec(`update merchant_payment_integrations set enabled = true where id = '${intRzp}'`)).rejects.toThrow(/enabled_requires_connection/);
    await expect(db.exec(`insert into merchant_payment_integrations(organization_id, provider, webhook_token) values ('${orgA}', 'PAYPAL', '${"d".repeat(48)}')`)).rejects.toThrow(
      /provider_check/
    );
  });

  it("requires the provider's own order id on each attempt", async () => {
    await expect(
      db.exec(`insert into merchant_storefront_payments(organization_id, integration_id, order_id, provider, payment_mode, key_fingerprint, payment_kind, amount_paise, order_total_paise, checkout_token_hash)
        values ('${orgA}', '${intA}', '${order2}', 'CASHFREE', 'TEST', '${fp}', 'FULL', 100, 100, '${th}')`)
    ).rejects.toThrow(/provider_ids_check/);
    await expect(
      db.exec(`insert into merchant_storefront_payments(organization_id, integration_id, order_id, provider, payment_mode, key_fingerprint, payment_kind, cashfree_order_id, amount_paise, order_total_paise, checkout_token_hash)
        values ('${orgA}', '${intA}', '${order2}', 'CASHFREE', 'TEST', '${fp}', 'FULL', 'pb_order1', 100, 100, '${th}')`)
    ).rejects.toThrow(/duplicate key/);
  });

  it("settles a paid order once and never undoes it", async () => {
    expect(await apply("PROCESSING")).toMatchObject({ result: "processing" });
    expect(await apply("PAID")).toMatchObject({ result: "paid", settled: true });
    expect(await ord()).toMatchObject({ status: "READY", payment_status: "PAID" });
    expect(await apply("PAID")).toMatchObject({ result: "already_paid" });
    expect(await apply("FAILED", { payment: "5002" })).toMatchObject({ result: "ignored" });
    expect(await apply("CANCELLED")).toMatchObject({ result: "ignored" });
    expect(await apply("PROCESSING", { payment: "5003" })).toMatchObject({ result: "ignored" });
    expect(await row()).toMatchObject({ payment_status: "PAID", cashfree_payment_id: "5001" });
    expect(await apply("PAID", { payment: "5004" })).toMatchObject({ result: "duplicate_payment" });
    expect((await row()).needs_review).toBe(true);
  });

  it("only clears a processing payment with the same payment's failure", async () => {
    await apply("PROCESSING", { payment: "6001" });
    expect(await apply("FAILED", { payment: "6000" })).toMatchObject({ result: "ignored" });
    expect(await apply("FAILED", { payment: "6001" })).toMatchObject({ result: "failed" });
    expect(await apply("CANCELLED", { payment: "6002" })).toMatchObject({ result: "cancelled" });
    expect((await row()).payment_status).toBe("CANCELLED");
    expect(await ord()).toMatchObject({ status: "IMPORTED", payment_status: "PENDING" });
  });

  it("refuses amount/currency mismatches and other merchants' orders", async () => {
    expect(await apply("PAID", { amount: 100 })).toMatchObject({ result: "amount_mismatch" });
    expect(await apply("PAID", { currency: "USD" })).toMatchObject({ result: "amount_mismatch" });
    expect(await apply("PAID", { org: orgB })).toMatchObject({ result: "not_found" });
    expect(await ord()).toMatchObject({ payment_status: "PENDING" });
  });

  it("never touches Razorpay attempts and keeps the Razorpay function intact", async () => {
    await db.exec(`
      insert into merchant_payment_integrations(id, organization_id, provider, webhook_token, encrypted_key_id, encrypted_key_secret, encrypted_webhook_secret, key_fingerprint, payment_mode, connection_status, enabled)
      values ('${intRzp}', '${orgA}', 'RAZORPAY', '${"c".repeat(48)}', 'k', 's', 'w', '${fp}', 'TEST', 'CONNECTED', true);
      insert into merchant_storefront_payments(organization_id, integration_id, order_id, provider, payment_mode, key_fingerprint, payment_kind, razorpay_order_id, amount_paise, order_total_paise, checkout_token_hash)
      values ('${orgA}', '${intRzp}', '${order2}', 'RAZORPAY', 'TEST', '${fp}', 'FULL', 'order_R1', 49900, 49900, '${th}');
    `);
    expect(await apply("PAID", { cfOrder: "order_R1" })).toMatchObject({ result: "not_found" });
    const rzp = await db.query<{ r: { result: string } }>(
      "select public.apply_merchant_storefront_payment($1, 'order_R1', 'pay_1', 'PAID', 49900, 'INR', 'upi', null, 'CHECKOUT') as r",
      [orgA]
    );
    expect(rzp.rows[0].r).toMatchObject({ result: "paid" });
    expect(await ord(order2)).toMatchObject({ payment_status: "PAID" });
  });

  it("keeps all new tables away from browsers", async () => {
    const grants = await db.query<{ table_name: string; grantee: string }>(
      "select table_name, grantee from information_schema.role_table_grants where table_name in ('merchant_payment_settings', 'merchant_payment_integrations', 'merchant_payment_webhook_events') and grantee in ('anon', 'authenticated')"
    );
    expect(grants.rows).toEqual([]);
    const exec = await db.query<{ ok: boolean }>("select has_function_privilege('authenticated', 'public.apply_merchant_cashfree_payment(uuid, text, text, text, bigint, text, text, text, text)', 'execute') as ok");
    expect(exec.rows[0].ok).toBe(false);
  });
});
