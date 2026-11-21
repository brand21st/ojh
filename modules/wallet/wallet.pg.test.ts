import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chargeMicros } from "@/modules/wallet/pricing";
import { quoteRecharge } from "@/modules/wallet/recharge-quote";

let db: PGlite;

const admin = "10000000-0000-4000-8000-000000000001";
const merchant = "10000000-0000-4000-8000-000000000002";
const outsider = "10000000-0000-4000-8000-000000000003";
const org = "30000000-0000-4000-8000-000000000001";
const otherOrg = "30000000-0000-4000-8000-000000000002";

const RUPEE = 1_000_000;

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  const result = await db.query<T>(sql, args);
  return result.rows[0] as T;
}

async function rpc(sql: string, args: unknown[] = []) {
  const row = await one<{ r: Record<string, unknown> }>(`select ${sql} as r`, args);
  return row.r;
}

async function scalar(sql: string, args: unknown[] = []) {
  const row = await one<Record<string, unknown>>(sql, args);
  return Object.values(row ?? {})[0];
}

async function rejected(sql: string, args: unknown[] = [], pattern?: RegExp) {
  await db.exec("savepoint rejection");
  try {
    const attempt = db.query(sql, args);
    if (pattern) await expect(attempt).rejects.toThrow(pattern);
    else await expect(attempt).rejects.toThrow();
  } finally {
    await db.exec("rollback to savepoint rejection");
  }
}

async function balance(o = org) {
  return Number(await scalar("select balance_micros from wallets where organization_id=$1", [o]));
}

async function reserved(o = org) {
  return Number(await scalar("select reserved_micros from wallets where organization_id=$1", [o]));
}

async function ledgerSum(o = org) {
  return Number(await scalar("select coalesce(sum(amount_micros),0) from wallet_ledger where organization_id=$1", [o]));
}

async function credit(amountMicros: number, key = "seed", o = org) {
  return rpc("wallet_admin_adjust($1,'MANUAL_CREDIT',$2,'Seed balance for tests',$3,'admin@test',$4)", [
    o,
    amountMicros,
    admin,
    key,
  ]);
}

/** Rs 1,000 at 18% GST: Rs 847.46 credit, Rs 152.54 GST. */
async function rechargeOrder(opts: { amountPaise?: number; orderId?: string } = {}) {
  const orderId = opts.orderId ?? "order_w1";
  const created = await rpc("wallet_create_recharge_order($1,$2,$3,$4)", [org, orderId, opts.amountPaise ?? 100000, merchant]);
  expect(created.status).toBe("CREATED");
  return orderId;
}

async function paymentStatus(orderId = "order_w1") {
  return scalar("select status from payments where razorpay_order_id=$1", [orderId]);
}

describe("tenant wallet", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at = now(); return new; end$$;
      create table organizations(
        id uuid primary key, name text,
        ai_credits_balance integer not null default 500,
        ai_credits_purchased integer not null default 0,
        ai_credits_used integer not null default 0,
        updated_at timestamptz default now());
      create table organization_members(organization_id uuid, user_id uuid);
      create table platform_admins(user_id uuid, email text);
      create table subscriptions(id uuid primary key, organization_id uuid);
      create table platform_settings(id integer primary key default 1 check (id = 1), updated_at timestamptz default now());
      insert into platform_settings(id) values (1);
      create table payments(
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        subscription_id uuid, amount_paise bigint not null default 0, currency text default 'INR',
        status text not null default 'PENDING' check (status in ('PENDING','CAPTURED','FAILED','REFUNDED')),
        razorpay_payment_id text, razorpay_order_id text, billing_cycle text, method text,
        failure_reason text, paid_at timestamptz, refunded_at timestamptz, created_at timestamptz default now(),
        payment_purpose text not null default 'subscription');
      create function public.is_org_member(org_id uuid) returns boolean language sql stable security definer set search_path = public
        as $$select exists(select 1 from organization_members m where m.organization_id = org_id and m.user_id = auth.uid())$$;
      create function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public
        as $$select exists(select 1 from platform_admins a where a.user_id = auth.uid())$$;
      insert into organizations(id,name) values ('${org}','Merchant'), ('${otherOrg}','Other');
    `);
    await db.exec(readFileSync("supabase/migrations/20261008120000_ai_credits.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261008180000_ai_credit_wallet.sql", "utf8"));
    // 20261011140000 widens the ledger status for AI image holds; only that part matters here.
    await db.exec(`
      alter table ai_credit_ledger drop constraint ai_credit_ledger_status_chk;
      alter table ai_credit_ledger add constraint ai_credit_ledger_status_chk check (status in ('POSTED','REVERSED','RESERVED','RELEASED'));
    `);
    await db.exec(readFileSync("supabase/migrations/20261121120000_tenant_wallet.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261121140000_wallet_recharge.sql", "utf8"));
    // Stand-ins for 20261017140000 (subscription invoices): same columns and the same allocator.
    await db.exec(`
      create table subscription_invoice_settings (id boolean primary key default true check (id), legal_name text not null default '',
        address text not null default '', gstin text not null default '', numbering_prefix text not null default 'PB',
        financial_year_start_month integer not null default 4);
      insert into subscription_invoice_settings(id) values (true);
      create table subscription_invoice_counters (series text primary key, last_value bigint not null);
      create table organization_billing_profiles (organization_id uuid primary key, legal_name text not null default '',
        address text not null default '', gstin text not null default '');
      create table billing_audit_logs (id uuid primary key default gen_random_uuid(), actor_id uuid, actor_type text, action text,
        target_type text, target_id text, organization_id uuid, ip text, metadata jsonb, created_at timestamptz default now());
      create function public.subscription_allocate_invoice_number(p_prefix text, p_series text) returns text
      language plpgsql security definer set search_path = public as $$
      declare n bigint;
      begin
        if p_prefix !~ '^[A-Za-z0-9]{1,8}$' or p_series !~ '^[0-9]{4}-[0-9]{2}$' then
          raise exception 'Invoice numbering policy is incomplete';
        end if;
        insert into subscription_invoice_counters(series, last_value) values (p_series, 1)
          on conflict (series) do update set last_value = subscription_invoice_counters.last_value + 1
          returning last_value into n;
        return upper(p_prefix) || '/' || p_series || '/' || lpad(n::text, 6, '0');
      end $$;
    `);
    await db.exec(readFileSync("supabase/migrations/20261121160000_wallet_recharge_invoices.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261121180000_wallet_ai_usage.sql", "utf8"));
    await db.exec(`create table vachat_notification_logs (id uuid primary key default gen_random_uuid(), organization_id uuid,
      order_id uuid, shipment_id uuid, event text, phone text, external_ref text not null, status text not null default 'queued',
      error text, created_at timestamptz default now(), updated_at timestamptz default now());`);
    await db.exec(readFileSync("supabase/migrations/20261121200000_wallet_whatsapp_usage.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261121220000_wallet_admin.sql", "utf8"));
    await db.exec(`create table profiles (id uuid primary key, email text);
      alter table organization_members add column role text not null default 'VIEWER';`);
    await db.exec(readFileSync("supabase/migrations/20261121230000_wallet_alerts.sql", "utf8"));
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec("begin");
    await db.query("insert into auth.users(id) values($1),($2),($3)", [admin, merchant, outsider]);
    await db.query("insert into platform_admins(user_id,email) values($1,'admin@test')", [admin]);
    await db.query("insert into organization_members values($1,$2)", [org, merchant]);
  });

  afterEach(async () => {
    await db.exec("rollback");
  });

  describe("wallet creation", () => {
    it("backfills a zero wallet for every existing organization", async () => {
      expect(Number(await scalar("select count(*) from wallets"))).toBe(2);
      expect(await balance()).toBe(0);
      expect(Number(await scalar("select ai_credits_balance from organizations where id=$1", [org]))).toBe(500);
    });

    it("gives a new tenant an empty wallet while the signup promo is off", async () => {
      const id = "30000000-0000-4000-8000-000000000009";
      await db.query("insert into organizations(id,name) values($1,'New')", [id]);
      expect(await balance(id)).toBe(0);
      expect(Number(await scalar("select ai_credits_balance from organizations where id=$1", [id]))).toBe(500);
    });

    it("gives a new tenant Rs 100 and no legacy credits once the promo is on", async () => {
      await db.query("update platform_settings set wallet_signup_promo_enabled = true");
      const id = "30000000-0000-4000-8000-000000000009";
      await db.query("insert into organizations(id,name) values($1,'New')", [id]);
      expect(await balance(id)).toBe(100 * RUPEE);
      expect(Number(await scalar("select ai_credits_balance from organizations where id=$1", [id]))).toBe(0);
      expect(await scalar("select entry_type from wallet_ledger where organization_id=$1", [id])).toBe("PROMO_CREDIT");
      expect(await scalar("select ai_credits_migrated_at is not null from wallets where organization_id=$1", [id])).toBe(true);
      expect((await rpc("wallet_migrate_ai_credits($1)", [id])).status).toBe("DUPLICATE");
    });
  });

  describe("recharge", () => {
    it("credits the net amount exactly once across callback and webhook", async () => {
      const orderId = await rechargeOrder();
      const first = await rpc("wallet_fulfill_recharge($1,'pay_1',100000,'upi',$2)", [orderId, org]);
      expect(first.status).toBe("CREDITED");
      expect(first.creditMicros).toBe(String(84746 * 10000));
      const second = await rpc("wallet_fulfill_recharge($1,'pay_1',100000,null,null)", [orderId]);
      expect(second.status).toBe("DUPLICATE");
      expect(await balance()).toBe(847_460_000);
      expect(Number(await scalar("select count(*) from wallet_ledger where entry_type='RECHARGE'"))).toBe(1);
      expect(await paymentStatus()).toBe("CAPTURED");
      expect(await scalar("select status from wallet_recharge_orders where razorpay_order_id=$1", [orderId])).toBe("PAID");
      expect(Number(await scalar("select lifetime_recharged_micros from wallets where organization_id=$1", [org]))).toBe(847_460_000);
    });

    it("never credits a wrong amount or another tenant's order", async () => {
      const orderId = await rechargeOrder();
      expect((await rpc("wallet_fulfill_recharge($1,'pay_1',99999,null,null)", [orderId])).status).toBe("AMOUNT_MISMATCH");
      expect((await rpc("wallet_fulfill_recharge($1,'pay_1',100000,null,$2)", [orderId, otherOrg])).status).toBe("FORBIDDEN");
      expect((await rpc("wallet_fulfill_recharge('order_missing','pay_1',100000,null,null)")).status).toBe("NOT_FOUND");
      expect(await balance()).toBe(0);
    });

    it("records a failure and still credits a later successful retry", async () => {
      const orderId = await rechargeOrder();
      expect((await rpc("wallet_mark_recharge_failed($1,'Card declined')", [orderId])).status).toBe("FAILED");
      expect(await paymentStatus()).toBe("FAILED");
      expect((await rpc("wallet_mark_recharge_failed($1,'again')", [orderId])).status).toBe("UNCHANGED");
      expect((await rpc("wallet_fulfill_recharge($1,'pay_2',100000,null,null)", [orderId])).status).toBe("CREDITED");
      expect(await balance()).toBe(847_460_000);
      expect((await rpc("wallet_mark_recharge_failed($1,'late failure')", [orderId])).status).toBe("UNCHANGED");
    });

    it("reverses partial refunds without drift and full refunds exactly", async () => {
      const orderId = await rechargeOrder({ amountPaise: 100000 });
      await rpc("wallet_fulfill_recharge($1,'pay_1',100000,null,null)", [orderId]);
      const a = await rpc("wallet_reverse_recharge('pay_1','rfnd_a',33333)");
      expect(a.status).toBe("REVERSED");
      expect((await rpc("wallet_reverse_recharge('pay_1','rfnd_a',33333)")).status).toBe("DUPLICATE");
      await rpc("wallet_reverse_recharge('pay_1','rfnd_b',33333)");
      await rpc("wallet_reverse_recharge('pay_1','rfnd_c',33334)");
      expect(await balance()).toBe(0);
      expect(await scalar("select status from wallet_recharge_orders")).toBe("REFUNDED");
      expect(await paymentStatus()).toBe("REFUNDED");
      expect((await rpc("wallet_reverse_recharge('pay_1','rfnd_d',1)")).status).toBe("NOT_PAID");
      expect(await ledgerSum()).toBe(await balance());
    });

    it("freezes a wallet whose refunded money was already spent", async () => {
      const orderId = await rechargeOrder();
      await rpc("wallet_fulfill_recharge($1,'pay_1',100000,null,null)", [orderId]);
      await rpc("wallet_debit($1,'whatsapp',500000000,'spent')", [org]);
      const result = await rpc("wallet_reverse_recharge('pay_1','rfnd_full',100000)");
      expect(result.frozen).toBe(true);
      expect(await balance()).toBe(-500_000_000);
      expect((await rpc("wallet_reserve($1,'ai',1,'blocked')", [org])).status).toBe("WALLET_FROZEN");
      expect((await rpc("wallet_set_status($1,'ACTIVE','Customer paid back the balance',$2)", [org, admin])).status).toBe("BALANCE_SHORT");
      await credit(500 * RUPEE, "repay");
      expect((await rpc("wallet_set_status($1,'ACTIVE','Customer paid back the balance',$2)", [org, admin])).status).toBe("UPDATED");
      expect(Number(await scalar("select count(*) from wallet_status_events"))).toBe(1);
    });
  });

  describe("holds and charges", () => {
    it("holds, captures less than held, and frees the rest", async () => {
      await credit(10 * RUPEE);
      const hold = await rpc("wallet_reserve($1,'ai',$2,'ai:job1')", [org, 2 * RUPEE]);
      expect(hold.status).toBe("HELD");
      expect(hold.availableMicros).toBe(String(8 * RUPEE));
      expect(hold.walletStatus).toBe("ACTIVE");
      const cap = await rpc("wallet_capture($1,$2,'AI address check')", [hold.reservationId, 1_234_567]);
      expect(cap.status).toBe("CAPTURED");
      expect(await balance()).toBe(10 * RUPEE - 1_234_567);
      expect(await reserved()).toBe(0);
      expect(Number(await scalar("select lifetime_ai_micros from wallets where organization_id=$1", [org]))).toBe(1_234_567);
      expect((await rpc("wallet_capture($1,$2)", [hold.reservationId, 1])).status).toBe("DUPLICATE");
      expect((await rpc("wallet_release($1)", [hold.reservationId])).status).toBe("ALREADY_CAPTURED");
    });

    it("refuses a hold larger than the available balance", async () => {
      await credit(RUPEE);
      await rpc("wallet_reserve($1,'whatsapp',$2,'wa:1')", [org, 600_000]);
      const second = await rpc("wallet_reserve($1,'whatsapp',$2,'wa:2')", [org, 600_000]);
      expect(second.status).toBe("INSUFFICIENT_BALANCE");
      expect(second.availableMicros).toBe("400000");
    });

    it("returns the same hold for a retried key", async () => {
      await credit(RUPEE);
      const a = await rpc("wallet_reserve($1,'whatsapp',138000,'wa:dup')", [org]);
      const b = await rpc("wallet_reserve($1,'whatsapp',138000,'wa:dup')", [org]);
      expect(b.status).toBe("DUPLICATE");
      expect(b.reservationId).toBe(a.reservationId);
      expect(await reserved()).toBe(138_000);
    });

    it("releases failed sends and charges nothing", async () => {
      await credit(RUPEE);
      const hold = await rpc("wallet_reserve($1,'whatsapp',138000,'wa:fail')", [org]);
      expect((await rpc("wallet_release($1,'provider failed')", [hold.reservationId])).status).toBe("RELEASED");
      expect((await rpc("wallet_release($1)", [hold.reservationId])).status).toBe("DUPLICATE");
      expect((await rpc("wallet_capture($1,138000)", [hold.reservationId])).status).toBe("NOT_HELD");
      expect(await balance()).toBe(RUPEE);
      expect(await reserved()).toBe(0);
    });

    it("treats a zero capture as a release and rejects more than the hold", async () => {
      await credit(RUPEE);
      const hold = await rpc("wallet_reserve($1,'ai',1000,'ai:zero')", [org]);
      expect((await rpc("wallet_capture($1,1001)", [hold.reservationId])).status).toBe("EXCEEDS_HOLD");
      expect((await rpc("wallet_capture($1,0)", [hold.reservationId])).status).toBe("RELEASED");
      expect(Number(await scalar("select count(*) from wallet_ledger where entry_type='USAGE_AI'"))).toBe(0);
    });

    it("charges a direct debit once per key", async () => {
      await credit(RUPEE);
      expect((await rpc("wallet_debit($1,'whatsapp',138000,'msg:1')", [org])).status).toBe("CHARGED");
      expect((await rpc("wallet_debit($1,'whatsapp',138000,'msg:1')", [org])).status).toBe("DUPLICATE");
      expect((await rpc("wallet_debit($1,'whatsapp',$2,'msg:2')", [org, RUPEE])).status).toBe("INSUFFICIENT_BALANCE");
      expect(await balance()).toBe(RUPEE - 138_000);
    });

    it("reverses a usage charge once", async () => {
      await credit(RUPEE);
      const charge = await rpc("wallet_debit($1,'whatsapp',138000,'msg:r')", [org]);
      expect((await rpc("wallet_reverse_usage($1,'Not billable',null)", [charge.ledgerId])).status).toBe("REVERSED");
      expect((await rpc("wallet_reverse_usage($1,'Not billable',null)", [charge.ledgerId])).status).toBe("DUPLICATE");
      expect(await balance()).toBe(RUPEE);
      expect(Number(await scalar("select lifetime_whatsapp_micros from wallets where organization_id=$1", [org]))).toBe(0);
    });

    it("expires stale holds", async () => {
      await credit(RUPEE);
      const hold = await rpc("wallet_reserve($1,'ai',5000,'ai:stale')", [org]);
      await db.query("update wallet_reservations set expires_at = now() - interval '1 minute' where id=$1", [hold.reservationId]);
      expect(Number(await scalar("select wallet_expire_reservations(100)"))).toBe(1);
      expect(await reserved()).toBe(0);
      expect(await scalar("select status from wallet_reservations where id=$1", [hold.reservationId])).toBe("EXPIRED");
    });

    it("keeps balance equal to the ledger over a long mixed sequence", async () => {
      await credit(50 * RUPEE);
      for (let i = 0; i < 60; i += 1) {
        const hold = await rpc("wallet_reserve($1,$2,$3,$4)", [org, i % 2 ? "ai" : "whatsapp", 100_000 + i, `seq:${i}`]);
        if (hold.status !== "HELD") continue;
        if (i % 3 === 0) await rpc("wallet_release($1)", [hold.reservationId]);
        else await rpc("wallet_capture($1,$2)", [hold.reservationId, 50_000 + i]);
      }
      expect(await ledgerSum()).toBe(await balance());
      expect(await reserved()).toBe(0);
      expect(Number(await scalar("select wallet_reconcile(null)"))).toBe(0);
    });
  });

  describe("integrity", () => {
    it("blocks edits and deletes of ledger rows", async () => {
      await credit(RUPEE);
      await rejected("update wallet_ledger set amount_micros = 5", [], /immutable/);
      await rejected("delete from wallet_ledger", [], /immutable/);
      await rejected("update wallet_adjustments set reason = 'changed reason here'", [], /immutable/);
    });

    it("blocks balance changes outside wallet functions", async () => {
      await rejected("update wallets set balance_micros = 999 where organization_id=$1", [org], /wallet functions/);
      await rejected("update wallets set reserved_micros = 1 where organization_id=$1", [org], /wallet functions/);
      await db.query("update wallets set credit_limit_micros = 0 where organization_id=$1", [org]);
    });

    it("rejects malformed ledger rows even from the service role", async () => {
      await rejected(
        "insert into wallet_ledger(wallet_id,organization_id,entry_type,amount_micros,balance_after_micros,idempotency_key) select id,organization_id,'RECHARGE',-5,0,'bad' from wallets limit 1",
        [],
        /type_sign/
      );
    });

    it("finds a wallet that disagrees with its ledger", async () => {
      await credit(RUPEE);
      await db.exec("alter table wallets disable trigger wallets_balance_guard");
      await db.query("update wallets set balance_micros = balance_micros + 1 where organization_id=$1", [org]);
      await db.exec("alter table wallets enable trigger wallets_balance_guard");
      expect(Number(await scalar("select wallet_reconcile(null)"))).toBe(1);
      expect(Number(await scalar("select wallet_reconcile(null)"))).toBe(1);
      expect(Number(await scalar("select count(*) from wallet_reconciliation_issues where resolved_at is null"))).toBe(1);
    });

    it("lets an organization be deleted with its wallet history", async () => {
      await credit(RUPEE, "seed", otherOrg);
      await db.query("delete from organizations where id=$1", [otherOrg]);
      expect(Number(await scalar("select count(*) from wallet_ledger where organization_id=$1", [otherOrg]))).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("shows a merchant only their own wallet rows", async () => {
      await credit(RUPEE);
      await credit(2 * RUPEE, "seed", otherOrg);
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      const rows = await db.query<{ organization_id: string }>("select organization_id from wallets");
      expect(rows.rows.map((r) => r.organization_id)).toEqual([org]);
      expect(Number(await scalar("select count(*) from wallet_ledger"))).toBe(1);
      expect(Number(await scalar("select count(*) from wallet_adjustments"))).toBe(0);
      expect(Number(await scalar("select count(*) from wallet_pricing_rules"))).toBe(0);
      await db.exec("reset role");
    });

    it("gives a signed-in merchant no way to change money", async () => {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_debit($1,'ai',1,'x')", [org], /permission denied/);
      await rejected("select wallet_admin_adjust($1,'MANUAL_CREDIT',1,'give me money please',$2,null,'k')", [org, merchant], /permission denied/);
      await rejected("select wallet_fulfill_recharge('o','p',1,null,null)", [], /permission denied/);
      await rejected("select wallet__post((select id from wallets limit 1),'RECHARGE',1,'k')", [], /permission denied/);
      await rejected("update wallets set credit_limit_micros = 999999999", [], /permission denied/);
      await rejected("insert into wallet_ledger(wallet_id,organization_id,entry_type,amount_micros,balance_after_micros,idempotency_key) values(gen_random_uuid(),$1,'RECHARGE',1,1,'k')", [org], /permission denied/);
      await db.exec("reset role");
      await db.exec("set local role anon");
      await rejected("select count(*) from wallets", [], /permission denied/);
      await db.exec("reset role");
    });
  });

  describe("super admin adjustments", () => {
    it("requires a platform admin, a real reason, and records who did it", async () => {
      await rejected("select wallet_admin_adjust($1,'PROMO',1000,'Diwali promo credit',$2,null,'p1')", [org, outsider], /platform admin/);
      await rejected("select wallet_admin_adjust($1,'PROMO',1000,'short',$2,null,'p1')", [org, admin], /reason/);
      const r = await rpc("wallet_admin_adjust($1,'PROMO',$2,'Diwali promo credit',$3,'admin@test','p1')", [org, 50 * RUPEE, admin]);
      expect(r.status).toBe("ADJUSTED");
      expect((await rpc("wallet_admin_adjust($1,'PROMO',$2,'Diwali promo credit',$3,'admin@test','p1')", [org, 50 * RUPEE, admin])).status).toBe("DUPLICATE");
      const audit = await one<{ admin_user_id: string; admin_email: string; kind: string; reason: string }>(
        "select admin_user_id, admin_email, kind, reason from wallet_adjustments"
      );
      expect(audit).toEqual({ admin_user_id: admin, admin_email: "admin@test", kind: "PROMO", reason: "Diwali promo credit" });
      expect(Number(await scalar("select lifetime_promo_micros from wallets where organization_id=$1", [org]))).toBe(50 * RUPEE);
      expect((await rpc("wallet_admin_adjust($1,'MANUAL_DEBIT',$2,'Correct a duplicate credit',$3,null,'d1')", [org, 51 * RUPEE, admin])).status).toBe("INSUFFICIENT_BALANCE");
      expect((await rpc("wallet_admin_adjust($1,'MANUAL_DEBIT',$2,'Correct a duplicate credit',$3,null,'d1')", [org, 50 * RUPEE, admin])).status).toBe("ADJUSTED");
      expect(await balance()).toBe(0);
    });
  });

  describe("pricing", () => {
    it("versions rules so past charges keep their rate", async () => {
      const v1 = await rpc(
        `wallet_set_pricing_rule('{"service":"whatsapp","whatsappCategory":"UTILITY","countryCode":"IN","perUnitMicros":"115000","markupBps":2000,"effectiveFrom":"2026-01-01T00:00:00Z"}'::jsonb,$1)`,
        [admin]
      );
      expect(v1.status).toBe("OK");
      const v2 = await rpc(
        `wallet_set_pricing_rule('{"service":"whatsapp","whatsappCategory":"utility","countryCode":"in","perUnitMicros":"120000","markupBps":2000,"effectiveFrom":"2026-07-01T00:00:00Z"}'::jsonb,$1)`,
        [admin]
      );
      expect(v2.supersededRuleId).toBe(v1.ruleId);
      const before = await rpc("wallet_quote('whatsapp',$1,'UTILITY','IN','*','*','*',1,0,0,'2026-03-01T00:00:00Z')", [org]);
      const after = await rpc("wallet_quote('whatsapp',$1,'UTILITY','IN','*','*','*',1,0,0,'2026-08-01T00:00:00Z')", [org]);
      expect(before).toMatchObject({ status: "OK", pricingRuleId: v1.ruleId, chargeMicros: "138000" });
      expect(after).toMatchObject({ status: "OK", pricingRuleId: v2.ruleId, chargeMicros: "144000" });
      const early = await rpc(
        `wallet_set_pricing_rule('{"service":"whatsapp","whatsappCategory":"UTILITY","countryCode":"IN","perUnitMicros":"1","effectiveFrom":"2026-02-01T00:00:00Z"}'::jsonb,$1)`,
        [admin]
      );
      expect(early.status).toBe("EFFECTIVE_FROM_TOO_EARLY");
      await rejected("update wallet_pricing_rules set per_unit_micros = 1 where id=$1", [v1.ruleId], /closed, not edited/);
      await rejected("delete from wallet_pricing_rules where id=$1", [v1.ruleId], /never deleted/);
      await rejected(`select wallet_set_pricing_rule('{"service":"ai"}'::jsonb,$1)`, [outsider], /platform admin/);
    });

    it("lets a tenant override beat the global rate", async () => {
      await rpc(`wallet_set_pricing_rule('{"service":"ai","aiFeature":"address_check","perUnitMicros":"200000","effectiveFrom":"2026-01-01T00:00:00Z"}'::jsonb,$1)`, [admin]);
      await rpc(`wallet_set_pricing_rule($2::jsonb,$1)`, [
        admin,
        JSON.stringify({ service: "ai", organizationId: org, aiFeature: "address_check", perUnitMicros: "100000", effectiveFrom: "2026-01-01T00:00:00Z" }),
      ]);
      expect((await rpc("wallet_quote('ai',$1,'*','*','*','address_check')", [org])).chargeMicros).toBe("100000");
      expect((await rpc("wallet_quote('ai',$1,'*','*','*','address_check')", [otherOrg])).chargeMicros).toBe("200000");
      // Phase 3 seeds a catch-all AI price (Rs 0.20, the old credit rate) for features without their own rule.
      expect((await rpc("wallet_quote('ai',$1,'*','*','*','unknown_feature')", [org])).chargeMicros).toBe("200000");
    });

    it("matches the TypeScript price calculation", async () => {
      let seed = 7;
      const rand = (max: number) => {
        seed = (seed * 48271) % 2147483647;
        return seed % max;
      };
      for (let i = 0; i < 200; i += 1) {
        const rule = {
          perUnitMicros: BigInt(rand(2_000_000)),
          per1kInputTokensMicros: BigInt(rand(50_000)),
          per1kOutputTokensMicros: BigInt(rand(150_000)),
          markupBps: rand(50_000),
          discountBps: rand(10_001),
        };
        const usage = { units: rand(5), inputTokens: rand(100_000), outputTokens: rand(20_000) };
        const sql = await scalar("select wallet_charge_micros($1,$2,$3,$4,$5,$6,$7,$8)::text", [
          rule.perUnitMicros.toString(),
          rule.per1kInputTokensMicros.toString(),
          rule.per1kOutputTokensMicros.toString(),
          rule.markupBps,
          rule.discountBps,
          usage.units,
          usage.inputTokens,
          usage.outputTokens,
        ]);
        expect(sql).toBe(chargeMicros(rule, usage).toString());
      }
    });
  });

  describe("low balance alerts", () => {
    it("opens one alert per threshold crossed and clears on recharge", async () => {
      await credit(150 * RUPEE);
      expect(Number(await scalar("select count(*) from wallet_alerts where status='OPEN'"))).toBe(0);
      await rpc("wallet_debit($1,'ai',$2,'a1')", [org, 110 * RUPEE]); // Rs 40 left: below 100 and 50
      await rpc("wallet_debit($1,'ai',$2,'a2')", [org, RUPEE]); // still Rs 39: no duplicates
      const open = await db.query<{ t: string }>("select threshold_micros::text t from wallet_alerts where status='OPEN' order by 1");
      expect(open.rows.map((r) => r.t)).toEqual(["100000000", "50000000"]);
      await credit(100 * RUPEE, "topup");
      expect(Number(await scalar("select count(*) from wallet_alerts where status='OPEN'"))).toBe(0);
      expect(Number(await scalar("select count(*) from wallet_alerts where status='CLEARED'"))).toBe(2);
    });
  });

  describe("AI credit cutover", () => {
    it("moves legacy credits at Rs 0.20 each, exactly once", async () => {
      const r = await rpc("wallet_migrate_ai_credits($1)", [org]);
      expect(r).toMatchObject({ status: "MIGRATED", credits: 500, creditedMicros: String(100 * RUPEE) });
      expect(await balance()).toBe(100 * RUPEE);
      expect(Number(await scalar("select ai_credits_balance from organizations where id=$1", [org]))).toBe(0);
      expect(Number(await scalar("select delta from ai_credit_ledger where organization_id=$1 and type='MIGRATED_TO_WALLET'", [org]))).toBe(-500);
      expect((await rpc("wallet_migrate_ai_credits($1)", [org])).status).toBe("DUPLICATE");
      expect(await balance()).toBe(100 * RUPEE);
    });

    it("waits while an AI image job still holds legacy credits", async () => {
      await db.query(
        "insert into ai_credit_ledger(organization_id,type,reason_code,delta,balance_after,status,idempotency_key) values($1,'AI_IMAGE_STUDIO','AI_IMAGE_STUDIO',-10,490,'RESERVED','img:1')",
        [otherOrg]
      );
      const all = await rpc("wallet_migrate_all_ai_credits(100)");
      expect(all).toEqual({ migrated: 1, pending: 1 });
      expect(await balance(otherOrg)).toBe(0);
      expect(await balance(org)).toBe(100 * RUPEE);
    });
  });
  describe("recharge orders (phase 2)", () => {
    it("writes the payment and the order together with the GST split", async () => {
      const created = await rpc("wallet_create_recharge_order($1,'order_g1',100000,$2)", [org, merchant]);
      expect(created).toMatchObject({
        status: "CREATED",
        amountPaise: 100000,
        taxablePaise: 84746,
        taxPaise: 15254,
        cgstPaise: 7627,
        sgstPaise: 7627,
        igstPaise: 0,
        gstRateBps: 1800,
        creditMicros: "847460000",
      });
      const payment = await one<{ payment_purpose: string; status: string; amount_paise: string }>(
        "select payment_purpose, status, amount_paise::text from payments where razorpay_order_id='order_g1'"
      );
      expect(payment).toEqual({ payment_purpose: "wallet_recharge", status: "PENDING", amount_paise: "100000" });
      expect((await rpc("wallet_create_recharge_order($1,'order_g1',100000,$2)", [org, merchant])).status).toBe("DUPLICATE");
    });

    it("refuses amounts outside the Super Admin limits", async () => {
      expect((await rpc("wallet_create_recharge_order($1,'o_low',9900,null)", [org])).status).toBe("AMOUNT_OUT_OF_RANGE");
      expect((await rpc("wallet_create_recharge_order($1,'o_high',5000100,null)", [org])).status).toBe("AMOUNT_OUT_OF_RANGE");
      await db.query("update platform_settings set wallet_recharge_min_paise = 50000");
      expect((await rpc("wallet_create_recharge_order($1,'o_mid',25000,null)", [org])).status).toBe("AMOUNT_OUT_OF_RANGE");
      expect(Number(await scalar("select count(*) from payments where payment_purpose='wallet_recharge'"))).toBe(0);
    });

    it("splits inter-state GST as IGST and keeps the rate each order was sold at", async () => {
      await db.query("update platform_settings set wallet_gst_place_of_supply='INTER', wallet_gst_rate_bps=500");
      const created = await rpc("wallet_create_recharge_order($1,'order_i1',25000,null)", [org]);
      expect(created).toMatchObject({ taxablePaise: 23810, taxPaise: 1190, igstPaise: 1190, cgstPaise: 0, placeOfSupply: "INTER" });
      await db.query("update platform_settings set wallet_gst_rate_bps=1800");
      expect(Number(await scalar("select gst_rate_bps from wallet_recharge_orders where razorpay_order_id='order_i1'"))).toBe(500);
    });

    it("matches the TypeScript recharge split for every whole-rupee amount tried", async () => {
      for (const rate of [0, 500, 1200, 1800, 2800]) {
        for (let rupees = 100; rupees <= 50000; rupees += 997) {
          const sql = await rpc("wallet_quote_recharge($1,$2,'INTRA')", [rupees * 100, rate]);
          const ts = quoteRecharge(rupees * 100, rate, "INTRA");
          expect([sql.taxablePaise, sql.taxPaise, sql.cgstPaise, sql.sgstPaise, sql.creditMicros]).toEqual([
            ts.taxablePaise,
            ts.taxPaise,
            ts.cgstPaise,
            ts.sgstPaise,
            ts.creditMicros.toString(),
          ]);
        }
      }
    });

    it("summarises this month by service in India time", async () => {
      await credit(100 * RUPEE);
      await rpc("wallet_debit($1,'whatsapp',138000,'m1')", [org]);
      await rpc("wallet_debit($1,'ai',$2,'m2')", [org, 2 * RUPEE]);
      const charge = await rpc("wallet_debit($1,'whatsapp',138000,'m3')", [org]);
      await rpc("wallet_reverse_usage($1,'Not delivered',null)", [charge.ledgerId]);
      const orderId = await rechargeOrder();
      await rpc("wallet_fulfill_recharge($1,'pay_s',100000,null,null)", [orderId]);
      const summary = await rpc("wallet_summary($1)", [org]);
      expect(summary).toMatchObject({
        status: "OK",
        walletStatus: "ACTIVE",
        monthWhatsappMicros: "138000",
        monthAiMicros: String(2 * RUPEE),
        monthSpendMicros: String(2 * RUPEE + 138000),
        monthRechargedMicros: "847460000",
        lifetimeRechargedMicros: "847460000",
      });
      expect(summary.balanceMicros).toBe(String(100 * RUPEE - 2 * RUPEE - 138000 + 847460000));
      expect((await rpc("wallet_summary('30000000-0000-4000-8000-0000000000ff')")).status).toBe("NO_WALLET");
    });

    it("returns one row per day with zeros for quiet days", async () => {
      await credit(10 * RUPEE);
      await rpc("wallet_debit($1,'ai',500000,'d1')", [org]);
      const rows = await db.query<{ day: string; ai_micros: string }>(
        "select day::text, ai_micros::text from wallet_usage_daily($1, 7)",
        [org]
      );
      expect(rows.rows).toHaveLength(7);
      expect(rows.rows.at(-1)?.ai_micros).toBe("500000");
      expect(rows.rows.slice(0, 6).every((r) => r.ai_micros === "0")).toBe(true);
    });

    it("keeps the new functions away from signed-in merchants", async () => {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_create_recharge_order($1,'x',10000,null)", [org], /permission denied/);
      await rejected("select wallet_summary($1)", [org], /permission denied/);
      await rejected("select * from wallet_usage_daily($1,7)", [org], /permission denied/);
      await db.exec("reset role");
    });
  });
  describe("recharge tax invoices", () => {
    const supplier =
      "update subscription_invoice_settings set legal_name='PostBus Technologies Pvt Ltd', address='12 MG Road, Bengaluru 560001', gstin='29AAACP1234A1Z5'";

    async function paidOrder(orderId: string, amountPaise = 100000) {
      await rechargeOrder({ orderId, amountPaise });
      await rpc("wallet_fulfill_recharge($1,$2,$3,'upi',null)", [orderId, `pay_${orderId}`, amountPaise]);
      return String(await scalar("select id from wallet_recharge_orders where razorpay_order_id=$1", [orderId]));
    }

    it("waits for supplier details, then numbers invoices once in the shared series", async () => {
      const first = await paidOrder("inv_1");
      expect((await rpc("wallet_issue_recharge_invoice($1)", [first])).status).toBe("SUPPLIER_INCOMPLETE");
      await db.query(supplier);
      const issued = await rpc("wallet_issue_recharge_invoice($1)", [first]);
      expect(issued.status).toBe("ISSUED");
      expect(issued.invoiceNumber).toMatch(/^PB\/\d{4}-\d{2}\/000001$/);
      expect(await rpc("wallet_issue_recharge_invoice($1)", [first])).toMatchObject({
        status: "DUPLICATE",
        invoiceNumber: issued.invoiceNumber,
      });

      // A subscription invoice in between takes the next number; the series stays gap-free across both.
      const series = String(issued.invoiceNumber).split("/")[1];
      expect(await scalar("select subscription_allocate_invoice_number('PB',$1)", [series])).toBe(`PB/${series}/000002`);
      const second = await paidOrder("inv_2", 25000);
      expect((await rpc("wallet_issue_recharge_invoice($1)", [second])).invoiceNumber).toBe(`PB/${series}/000003`);

      const row = await one<Record<string, unknown>>(
        "select gross_paise::text, taxable_paise::text, total_tax_paise::text, customer_legal_name, customer_gstin, payment_reference from wallet_recharge_invoices where recharge_order_id=$1",
        [first]
      );
      expect(row).toEqual({
        gross_paise: "100000",
        taxable_paise: "84746",
        total_tax_paise: "15254",
        customer_legal_name: "Merchant",
        customer_gstin: "",
        payment_reference: "pay_inv_1",
      });
      expect(Number(await scalar("select count(*) from billing_audit_logs where action='wallet_invoice.issued'"))).toBe(2);
    });

    it("never invoices an unpaid recharge", async () => {
      await db.query(supplier);
      await rechargeOrder({ orderId: "inv_unpaid" });
      const id = await scalar("select id from wallet_recharge_orders where razorpay_order_id='inv_unpaid'");
      expect((await rpc("wallet_issue_recharge_invoice($1)", [id])).status).toBe("NOT_PAID");
      expect((await rpc("wallet_issue_recharge_invoice('30000000-0000-4000-8000-0000000000ff')")).status).toBe("NOT_FOUND");
    });

    it("needs a valid GSTIN and an address for a registered buyer", async () => {
      await db.query(supplier);
      const id = await paidOrder("inv_b2b");
      await db.query(
        "insert into organization_billing_profiles(organization_id,legal_name,address,gstin) values($1,'Merchant Pvt Ltd','','29ABCDE1234F1Z5')",
        [org]
      );
      expect(await rpc("wallet_issue_recharge_invoice($1)", [id])).toMatchObject({
        status: "CUSTOMER_INCOMPLETE",
        reason: expect.stringMatching(/address/),
      });
      await db.query("update organization_billing_profiles set address='4 Residency Road, Bengaluru', gstin='29-BAD'");
      expect(await rpc("wallet_issue_recharge_invoice($1)", [id])).toMatchObject({
        status: "CUSTOMER_INCOMPLETE",
        reason: expect.stringMatching(/GSTIN/),
      });
      await db.query("update organization_billing_profiles set gstin='29abcde1234f1z5'");
      expect((await rpc("wallet_issue_recharge_invoice($1)", [id])).status).toBe("ISSUED");
      expect(await scalar("select customer_gstin from wallet_recharge_invoices")).toBe("29ABCDE1234F1Z5");
      expect(await scalar("select customer_legal_name from wallet_recharge_invoices")).toBe("Merchant Pvt Ltd");
    });

    it("charges IGST when the buyer is registered in another state", async () => {
      await db.query(supplier);
      await db.query(
        "insert into organization_billing_profiles(organization_id,legal_name,address,gstin) values($1,'Merchant','Pune','27ABCDE1234F1Z5')",
        [org]
      );
      const created = await rpc("wallet_create_recharge_order($1,'inv_inter',100000,null)", [org]);
      expect(created).toMatchObject({ placeOfSupply: "INTER", igstPaise: 15254, cgstPaise: 0 });
      await db.query("update organization_billing_profiles set gstin='29ABCDE1234F1Z5'");
      expect(await rpc("wallet_create_recharge_order($1,'inv_intra',100000,null)", [org])).toMatchObject({
        placeOfSupply: "INTRA",
        cgstPaise: 7627,
      });
      const states = await one(
        "select supplier_state_code, customer_state_code from wallet_recharge_orders where razorpay_order_id='inv_inter'"
      );
      expect(states).toEqual({ supplier_state_code: "29", customer_state_code: "27" });
    });

    it("keeps issued invoices unchangeable and lists recharges still waiting", async () => {
      const waiting = await paidOrder("inv_wait");
      const ids = await db.query<{ id: string }>("select r as id from wallet_recharges_missing_invoice(10) r");
      expect(ids.rows.map((r) => r.id)).toEqual([waiting]);
      await db.query(supplier);
      await rpc("wallet_issue_recharge_invoice($1)", [waiting]);
      expect((await db.query("select * from wallet_recharges_missing_invoice(10)")).rows).toHaveLength(0);
      await rejected("update wallet_recharge_invoices set gross_paise = 1", [], /immutable/);
      await rejected("delete from wallet_recharge_invoices", [], /immutable/);
    });

    it("dates the series by the Indian financial year", async () => {
      expect(await scalar("select wallet__fy_series('2026-03-31T20:00:00Z', 4)")).toBe("2026-27");
      expect(await scalar("select wallet__fy_series('2026-03-31T10:00:00Z', 4)")).toBe("2025-26");
      expect(await scalar("select wallet__fy_series('2026-11-21T00:00:00Z', 4)")).toBe("2026-27");
    });

    it("keeps invoice functions away from signed-in merchants", async () => {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_issue_recharge_invoice(gen_random_uuid())", [], /permission denied/);
      await rejected("select * from wallet_recharges_missing_invoice(1)", [], /permission denied/);
      expect(Number(await scalar("select count(*) from wallet_recharge_invoices"))).toBe(0);
      await db.exec("reset role");
    });
  });
  describe("AI usage billing (phase 3)", () => {
    async function migrate() {
      await db.query("update organizations set ai_credits_balance = 0 where id=$1", [org]);
      expect((await rpc("wallet_migrate_ai_credits($1)", [org])).status).toBe("MIGRATED");
    }

    it("bills an organization from its wallet only after its credits moved", async () => {
      expect(await scalar("select wallet_ai_mode($1)", [org])).toBe("credits");
      await migrate();
      expect(await scalar("select wallet_ai_mode($1)", [org])).toBe("wallet");
      expect(await scalar("select wallet_ai_mode($1)", [otherOrg])).toBe("credits");
    });

    it("seeds today's credit prices so the switch changes nothing", async () => {
      const q = async (feature: string, units = 1) =>
        (await rpc("wallet_ai_quote($1,$2,'openai/gpt-4o-mini',$3)", [org, feature, units])).chargeMicros;
      expect(await q("data_extraction")).toBe("200000");
      expect(await q("address_validation")).toBe("200000");
      expect(await q("image_studio", 3)).toBe("6000000");
      expect(await q("some_future_feature")).toBe("200000");
    });

    it("charges once per key, refuses without balance, and retries after a recharge", async () => {
      await migrate();
      const first = await rpc("wallet_ai_charge($1,'data_extraction','m','wa-1',1,900,120)", [org]);
      expect(first.status).toBe("INSUFFICIENT_BALANCE");
      expect(await scalar("select status || ':' || reject_reason from ai_usage_records where idempotency_key='wa-1'")).toBe(
        "REJECTED:INSUFFICIENT_BALANCE"
      );
      await credit(RUPEE);
      const retried = await rpc("wallet_ai_charge($1,'data_extraction','m','wa-1',1,900,120)", [org]);
      expect(retried).toMatchObject({ status: "CHARGED", chargeMicros: "200000" });
      expect((await rpc("wallet_ai_charge($1,'data_extraction','m','wa-1',1,900,120)", [org])).status).toBe("DUPLICATE");
      expect(await balance()).toBe(RUPEE - 200000);
      const record = await one(
        "select feature, model, input_tokens::text, output_tokens::text, charge_micros::text, status from ai_usage_records where idempotency_key='wa-1'"
      );
      expect(record).toEqual({
        feature: "data_extraction",
        model: "m",
        input_tokens: "900",
        output_tokens: "120",
        charge_micros: "200000",
        status: "CHARGED",
      });
      expect(Number(await scalar("select lifetime_ai_micros from wallets where organization_id=$1", [org]))).toBe(200000);
    });

    it("prices tokens per model when Super Admin sets token rates", async () => {
      await migrate();
      await credit(10 * RUPEE);
      await rpc(
        `wallet_set_pricing_rule('{"service":"ai","aiFeature":"product_copy","aiModel":"anthropic/claude","perUnitMicros":"50000","per1kInputTokensMicros":"3000","per1kOutputTokensMicros":"15000","markupBps":2000}'::jsonb,$1)`,
        [admin]
      );
      // 50000 + 2000 in * 3/1k = 6000 + 400 out * 15/1k = 6000 -> 62000 + 20% = 74400
      const charged = await rpc("wallet_ai_charge($1,'product_copy','anthropic/claude','pc-1',1,2000,400)", [org]);
      expect(charged.chargeMicros).toBe("74400");
      const other = await rpc("wallet_ai_charge($1,'product_copy','openai/gpt-4o-mini','pc-2',1,2000,400)", [org]);
      expect(other.chargeMicros).toBe("200000");
    });

    it("holds an image job, charges the actual usage up to the hold, and releases failures", async () => {
      await migrate();
      await credit(10 * RUPEE);
      const held = await rpc("wallet_ai_reserve($1,'image_studio','img','job-1',3)", [org]);
      expect(held).toMatchObject({ status: "HELD", holdMicros: "6000000" });
      expect(await reserved()).toBe(6000000);
      expect((await rpc("wallet_ai_reserve($1,'image_studio','img','job-1',3)", [org])).status).toBe("DUPLICATE");
      const settled = await rpc("wallet_ai_settle($1,'job-1',true)", [org]);
      expect(settled).toMatchObject({ status: "CHARGED", chargeMicros: "6000000" });
      expect((await rpc("wallet_ai_settle($1,'job-1',true)", [org])).status).toBe("DUPLICATE");
      expect(await balance()).toBe(4 * RUPEE);
      expect(await reserved()).toBe(0);

      await rpc("wallet_ai_reserve($1,'image_studio','img','job-2',1)", [org]);
      expect(await rpc("wallet_ai_settle($1,'job-2',false,null,null,'model timeout')", [org])).toMatchObject({ status: "RELEASED" });
      expect(await balance()).toBe(4 * RUPEE);
      expect(await reserved()).toBe(0);
      expect((await rpc("wallet_ai_reserve($1,'image_studio','img','job-3',3)", [org])).status).toBe("INSUFFICIENT_BALANCE");
      expect((await rpc("wallet_ai_settle($1,'nope',true)", [org])).status).toBe("NOT_FOUND");
    });

    it("never charges more than was held when tokens run over the estimate", async () => {
      await migrate();
      await credit(10 * RUPEE);
      await rpc(
        `wallet_set_pricing_rule('{"service":"ai","aiFeature":"cover_studio","per1kOutputTokensMicros":"1000000"}'::jsonb,$1)`,
        [admin]
      );
      expect((await rpc("wallet_ai_reserve($1,'cover_studio','img','cv-1',1,0,1000)", [org])).holdMicros).toBe("1000000");
      const settled = await rpc("wallet_ai_settle($1,'cv-1',true,0,3000)", [org]);
      expect(settled).toMatchObject({ chargeMicros: "1000000", actualMicros: "3000000" });
      expect(await scalar("select metadata->>'underBilledMicros' from ai_usage_records where idempotency_key='cv-1'")).toBe("2000000");
    });

    it("marks a job abandoned once its hold expired", async () => {
      await migrate();
      await credit(10 * RUPEE);
      const held = await rpc("wallet_ai_reserve($1,'image_studio','img','job-x',1)", [org]);
      await db.query("update wallet_reservations set expires_at = now() - interval '1 minute' where id=$1", [held.reservationId]);
      await scalar("select wallet_expire_reservations(10)");
      expect(Number(await scalar("select wallet_ai_abandon_stale(10)"))).toBe(1);
      expect(await scalar("select status from ai_usage_records where idempotency_key='job-x'")).toBe("ABANDONED");
      expect((await rpc("wallet_ai_settle($1,'job-x',true)", [org])).status).toBe("DUPLICATE");
      expect(await balance()).toBe(10 * RUPEE);
    });

    it("keeps AI billing functions and other tenants' usage away from merchants", async () => {
      await migrate();
      await credit(RUPEE);
      await rpc("wallet_ai_charge($1,'data_extraction','m','own',1,0,0)", [org]);
      await db.query("update organizations set ai_credits_balance = 0 where id=$1", [otherOrg]);
      await rpc("wallet_migrate_ai_credits($1)", [otherOrg]);
      await credit(RUPEE, "seed", otherOrg);
      await rpc("wallet_ai_charge($1,'data_extraction','m','theirs',1,0,0)", [otherOrg]);
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      expect(Number(await scalar("select count(*) from ai_usage_records"))).toBe(1);
      await rejected("select wallet_ai_charge($1,'x','m','k',1,0,0)", [org], /permission denied/);
      await rejected("select wallet_ai_mode($1)", [org], /permission denied/);
      await db.exec("reset role");
    });
  });
  describe("WhatsApp notice billing (phase 4)", () => {
    const utility = `wallet_set_pricing_rule('{"service":"whatsapp","whatsappCategory":"UTILITY","countryCode":"IN","perUnitMicros":"115000","markupBps":2000,"effectiveFrom":"2026-01-01T00:00:00Z"}'::jsonb,$1)`;
    const marketing = `wallet_set_pricing_rule('{"service":"whatsapp","whatsappCategory":"MARKETING","countryCode":"IN","perUnitMicros":"785000","effectiveFrom":"2026-01-01T00:00:00Z"}'::jsonb,$1)`;
    const reserve = (ref: string, category = "UTILITY") =>
      rpc("wallet_whatsapp_reserve($1,$2,'booked',$3,'IN','vachat')", [org, ref, category]);
    const settle = (ref: string, outcome: string, category: string | null = null) =>
      rpc("wallet_whatsapp_settle($1,$2,$3,$4,'msg_1','wamid_1')", [org, ref, outcome, category]);

    async function on() {
      await db.query("update platform_settings set wallet_whatsapp_billing_enabled = true");
      await rpc(utility, [admin]);
    }

    it("does nothing until Super Admin turns WhatsApp billing on", async () => {
      expect((await reserve("postbus:booked:s1")).status).toBe("BILLING_OFF");
      expect(Number(await scalar("select count(*) from whatsapp_usage_records"))).toBe(0);
    });

    it("holds the rate before sending and charges once when delivered", async () => {
      await on();
      await credit(RUPEE);
      const held = await reserve("postbus:booked:s1");
      expect(held).toMatchObject({ status: "HELD", holdMicros: "138000" });
      expect(await reserved()).toBe(138000);
      expect((await reserve("postbus:booked:s1")).status).toBe("DUPLICATE");
      expect((await settle("postbus:booked:s1", "sent")).status).toBe("PENDING");
      expect(await settle("postbus:booked:s1", "delivered")).toMatchObject({ status: "CHARGED", chargeMicros: "138000" });
      expect((await settle("postbus:booked:s1", "delivered")).status).toBe("DUPLICATE");
      expect((await settle("postbus:booked:s1", "read")).status).toBe("DUPLICATE");
      expect((await settle("postbus:booked:s1", "failed")).status).toBe("DUPLICATE");
      expect(await balance()).toBe(RUPEE - 138000);
      expect(await reserved()).toBe(0);
      expect(Number(await scalar("select lifetime_whatsapp_micros from wallets where organization_id=$1", [org]))).toBe(138000);
      const row = await one("select status, provider_message_id, whatsapp_message_id, provider_status from whatsapp_usage_records");
      expect(row).toEqual({ status: "CHARGED", provider_message_id: "msg_1", whatsapp_message_id: "wamid_1", provider_status: "failed" });
    });

    it("charges nothing for a failed, unsent or non-billable message", async () => {
      await on();
      await credit(RUPEE);
      await reserve("r-failed");
      expect((await settle("r-failed", "failed")).status).toBe("RELEASED");
      await reserve("r-error");
      expect((await settle("r-error", "send_error")).status).toBe("RELEASED");
      await reserve("r-free");
      expect((await settle("r-free", "not_billable")).status).toBe("RELEASED");
      expect(await balance()).toBe(RUPEE);
      expect(await reserved()).toBe(0);
      // A send error that the job retries holds again with a fresh hold.
      expect((await reserve("r-error")).status).toBe("HELD");
      expect(Number(await scalar("select attempts from whatsapp_usage_records where external_ref='r-error'"))).toBe(2);
    });

    it("holds a notice back when the wallet cannot pay, then sends it after a recharge", async () => {
      await on();
      await credit(100000);
      expect((await reserve("r-low")).status).toBe("INSUFFICIENT_BALANCE");
      expect(await scalar("select status || ':' || reject_reason from whatsapp_usage_records where external_ref='r-low'")).toBe(
        "BLOCKED:INSUFFICIENT_BALANCE"
      );
      await credit(RUPEE, "topup");
      expect((await reserve("r-low")).status).toBe("HELD");
    });

    it("prices at the category Meta reports, never above the hold", async () => {
      await on();
      await rpc(marketing, [admin]);
      await credit(RUPEE);
      await reserve("r-cat", "MARKETING");
      expect(await settle("r-cat", "delivered", "UTILITY")).toMatchObject({ chargeMicros: "138000" });
      await reserve("r-up", "UTILITY");
      expect(await settle("r-up", "delivered", "MARKETING")).toMatchObject({ chargeMicros: "138000" });
      expect(await scalar("select category from whatsapp_usage_records where external_ref='r-up'")).toBe("MARKETING");
    });

    it("charges a delivery that arrives after the hold expired, if the balance allows", async () => {
      await on();
      await credit(RUPEE);
      const held = await reserve("r-late");
      await db.query(
        "update wallet_reservations set expires_at = now() - interval '1 minute' where reference_id = $1",
        [String(held.recordId)]
      );
      await scalar("select wallet_expire_reservations(10)");
      expect(Number(await scalar("select wallet_whatsapp_expire(10)"))).toBe(1);
      expect(await scalar("select status from whatsapp_usage_records where external_ref='r-late'")).toBe("UNCONFIRMED");
      expect(await settle("r-late", "delivered")).toMatchObject({ status: "CHARGED", late: true });
      expect(await balance()).toBe(RUPEE - 138000);
      expect((await settle("r-late", "delivered")).status).toBe("DUPLICATE");
    });

    it("uses free monthly messages before charging, tenant allowance first", async () => {
      await on();
      await credit(RUPEE);
      await db.query("insert into wallet_free_allowances(organization_id, whatsapp_category, monthly_messages) values (null,'UTILITY',5), ($1,'UTILITY',2)", [org]);
      expect(await reserve("f1")).toMatchObject({ status: "FREE", freeAllowance: true });
      expect((await reserve("f2")).status).toBe("FREE");
      expect((await reserve("f3")).status).toBe("HELD");
      expect(await balance()).toBe(RUPEE);
    });

    it("sends unpriced categories free and records why", async () => {
      await db.query("update platform_settings set wallet_whatsapp_billing_enabled = true");
      expect((await reserve("u1", "AUTHENTICATION")).status).toBe("UNPRICED");
      expect((await reserve("u2", "SERVICE")).status).toBe("FREE");
      expect(await scalar("select reject_reason from whatsapp_usage_records where external_ref='u1'")).toBe("NO_PRICE");
    });

    it("keeps WhatsApp billing functions away from merchants", async () => {
      await on();
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_whatsapp_reserve($1,'x','booked','UTILITY','IN','vachat')", [org], /permission denied/);
      await rejected("select wallet_whatsapp_settle($1,'x','delivered',null,null,null)", [org], /permission denied/);
      // Readable only by platform admins: a merchant sees no rows.
      expect(Number(await scalar("select count(*) from wallet_free_allowances"))).toBe(0);
      await db.exec("reset role");
    });
  });
  describe("Super Admin wallet management (phase 5)", () => {
    it("lists wallets with search, filters, sorting and totals", async () => {
      await credit(5 * RUPEE);
      await credit(9 * RUPEE, "seed", otherOrg);
      await db.query("update organizations set ai_credits_balance = 0 where id=$1", [org]);
      await rpc("wallet_migrate_ai_credits($1)", [org]);
      const all = await rpc("wallet_admin_list(null,null,'balance_desc',50,0)");
      expect(all.total).toBe(2);
      expect((all.rows as Array<{ organizationName: string }>).map((r) => r.organizationName)).toEqual(["Other", "Merchant"]);
      const search = await rpc("wallet_admin_list('merch',null,'balance_asc',50,0)");
      expect((search.rows as Array<{ organizationId: string }>).map((r) => r.organizationId)).toEqual([org]);
      const pending = await rpc("wallet_admin_list(null,'NOT_MIGRATED','name_asc',50,0)");
      expect((pending.rows as Array<{ organizationId: string }>).map((r) => r.organizationId)).toEqual([otherOrg]);
      const page2 = await rpc("wallet_admin_list(null,null,'balance_asc',1,1)");
      expect(page2.total).toBe(2);
      expect((page2.rows as unknown[]).length).toBe(1);
      expect((await rpc("wallet_admin_list('100%_',null,'balance_asc',50,0)")).total).toBe(0);

      const totals = await rpc("wallet_admin_totals()");
      expect(totals).toMatchObject({ wallets: 2, frozen: 0, totalBalanceMicros: String(14 * RUPEE), pendingAiMigrations: 1 });
    });

    it("sets a credit limit only for admins, never below money on hold, and records it", async () => {
      await credit(RUPEE);
      await rejected("select wallet_set_credit_limit($1, 100, 'Trusted merchant line', $2)", [org, outsider], /platform admin/);
      await rpc("wallet_reserve($1,'ai',$2,'big-hold')", [org, RUPEE]);
      const set = await rpc("wallet_set_credit_limit($1, $2, 'Trusted merchant line', $3)", [org, 50 * RUPEE, admin]);
      expect(set.status).toBe("UPDATED");
      expect(set.availableMicros).toBe(String(50 * RUPEE));
      expect(await scalar("select reason from wallet_status_events order by created_at desc limit 1")).toMatch(/credit limit 0 -> 50000000/);
      // With the credit line the wallet may hold more than its balance; removing it would break the holds.
      await rpc("wallet_reserve($1,'ai',$2,'bigger')", [org, 20 * RUPEE]);
      expect((await rpc("wallet_set_credit_limit($1, 0, 'Remove credit line', $2)", [org, admin])).status).toBe("BELOW_HOLDS");
    });

    it("versions free allowances and removes them with zero", async () => {
      expect((await rpc("wallet_set_free_allowance(null,'UTILITY',100,'launch offer',$1)", [admin])).status).toBe("OK");
      expect((await rpc("wallet_set_free_allowance(null,'UTILITY',250,'raised',$1)", [admin])).status).toBe("OK");
      expect(Number(await scalar("select count(*) from wallet_free_allowances where effective_to is null"))).toBe(1);
      expect(Number(await scalar("select monthly_messages from wallet_free_allowances where effective_to is null"))).toBe(250);
      expect((await rpc("wallet_set_free_allowance(null,'UTILITY',0,null,$1)", [admin])).status).toBe("REMOVED");
      expect(Number(await scalar("select count(*) from wallet_free_allowances where effective_to is null"))).toBe(0);
      await rejected("select wallet_set_free_allowance(null,'UTILITY',5,null,$1)", [outsider], /platform admin/);
    });

    it("resolves a reconciliation issue with a note, once", async () => {
      await credit(RUPEE);
      await db.exec("alter table wallets disable trigger wallets_balance_guard");
      await db.query("update wallets set balance_micros = balance_micros + 1 where organization_id=$1", [org]);
      await db.exec("alter table wallets enable trigger wallets_balance_guard");
      await scalar("select wallet_reconcile(null)");
      const id = await scalar("select id from wallet_reconciliation_issues where resolved_at is null");
      await rejected("select wallet_resolve_reconciliation_issue($1,'short',$2)", [id, admin], /10 characters/);
      expect((await rpc("wallet_resolve_reconciliation_issue($1,'Test tamper, corrected by hand',$2)", [id, admin])).status).toBe("RESOLVED");
      expect((await rpc("wallet_resolve_reconciliation_issue($1,'Test tamper, corrected by hand',$2)", [id, admin])).status).toBe("NOT_FOUND");
      expect((await rpc("wallet_admin_totals()")).openReconciliationIssues).toBe(0);
    });

    it("keeps admin wallet functions away from signed-in merchants", async () => {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_admin_totals()", [], /permission denied/);
      await rejected("select wallet_admin_list(null,null,'balance_asc',10,0)", [], /permission denied/);
      await rejected("select wallet_set_credit_limit($1,1,'give me credit please',$2)", [org, merchant], /permission denied/);
      await db.exec("reset role");
    });
  });
  describe("low-balance alerts (phase 6)", () => {
    async function owner(email: string, o = org) {
      const id = crypto.randomUUID();
      await db.query("insert into auth.users(id) values($1)", [id]);
      await db.query("insert into profiles(id,email) values($1,$2)", [id, email]);
      await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'OWNER')", [o, id]);
    }

    it("sends one alert per wallet at the lowest level crossed, once", async () => {
      await owner("owner@merchant.test");
      await credit(150 * RUPEE);
      await rpc("wallet_debit($1,'ai',$2,'drop')", [org, 135 * RUPEE]); // Rs 15 left: below 100, 50 and 20
      const claimed = (await rpc("wallet_claim_alerts(100)")) as unknown as Array<Record<string, unknown>>;
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        organizationId: org,
        organizationName: "Merchant",
        thresholdMicros: String(20 * RUPEE),
        balanceMicros: String(15 * RUPEE),
        ownerEmails: ["owner@merchant.test"],
      });
      expect((await rpc("wallet_claim_alerts(100)")) as unknown as unknown[]).toEqual([]);
      expect(Number(await scalar("select count(*) from wallet_alerts where notified_at is null"))).toBe(0);
    });

    it("stays quiet for a wallet that recovered before the alert went out", async () => {
      await credit(150 * RUPEE);
      await rpc("wallet_debit($1,'ai',$2,'drop')", [org, 60 * RUPEE]); // Rs 90: below 100
      await credit(50 * RUPEE, "topup");
      expect((await rpc("wallet_claim_alerts(100)")) as unknown as unknown[]).toEqual([]);
    });

    it("lets a wallet choose its own levels and keeps open alerts in line", async () => {
      await credit(150 * RUPEE);
      await rpc("wallet_debit($1,'ai',$2,'drop')", [org, 110 * RUPEE]); // Rs 40: below 100 and 50
      expect(Number(await scalar("select count(*) from wallet_alerts where status='OPEN'"))).toBe(2);
      const set = await rpc("wallet_set_thresholds($1,$2::bigint[])", [org, [String(500 * RUPEE), String(30 * RUPEE), String(500 * RUPEE)]]);
      expect(set.thresholdsMicros).toEqual([String(500 * RUPEE), String(30 * RUPEE)]);
      const open = await db.query<{ t: string }>("select threshold_micros::text t from wallet_alerts where status='OPEN' order by 1");
      expect(open.rows.map((r) => r.t)).toEqual([String(500 * RUPEE)]);
      await rpc("wallet_set_thresholds($1,$2::bigint[])", [org, []]);
      expect(Number(await scalar("select count(*) from wallet_alerts where status='OPEN'"))).toBe(0);
      await rejected("select wallet_set_thresholds($1, array[1,2,3,4,5,6]::bigint[])", [org], /at most 5/);
    });

    it("keeps alert functions away from merchants", async () => {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${merchant}',true);`);
      await rejected("select wallet_claim_alerts(1)", [], /permission denied/);
      await rejected("select wallet_set_thresholds($1, array[1]::bigint[])", [org], /permission denied/);
      await db.exec("reset role");
    });
  });
});
