import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chargeMicros } from "@/modules/wallet/pricing";

let db: PGlite;

const admin = "10000000-0000-4000-8000-000000000001";
const merchant = "10000000-0000-4000-8000-000000000002";
const outsider = "10000000-0000-4000-8000-000000000003";
const org = "30000000-0000-4000-8000-000000000001";
const otherOrg = "30000000-0000-4000-8000-000000000002";
const pay = "50000000-0000-4000-8000-000000000001";

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

async function rechargeOrder(opts: { amountPaise?: number; taxPaise?: number; orderId?: string } = {}) {
  const amount = opts.amountPaise ?? 100000;
  const tax = opts.taxPaise ?? 15254;
  const orderId = opts.orderId ?? "order_w1";
  await db.query(
    "insert into payments(id,organization_id,amount_paise,status,razorpay_order_id,payment_purpose,billing_cycle) values($1,$2,$3,'PENDING',$4,'wallet_recharge','wallet')",
    [pay, org, amount, orderId]
  );
  await db.query(
    `insert into wallet_recharge_orders(wallet_id,organization_id,payment_id,razorpay_order_id,amount_paise,taxable_paise,tax_paise,credit_micros,created_by)
     select id,$1,$2,$3,$4,$5,$6,$7,$8 from wallets where organization_id=$1`,
    [org, pay, orderId, amount, amount - tax, tax, (amount - tax) * 10000, merchant]
  );
  return orderId;
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
      expect(await scalar("select status from payments where id=$1", [pay])).toBe("CAPTURED");
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
      expect(await scalar("select status from payments where id=$1", [pay])).toBe("FAILED");
      expect((await rpc("wallet_mark_recharge_failed($1,'again')", [orderId])).status).toBe("UNCHANGED");
      expect((await rpc("wallet_fulfill_recharge($1,'pay_2',100000,null,null)", [orderId])).status).toBe("CREDITED");
      expect(await balance()).toBe(847_460_000);
      expect((await rpc("wallet_mark_recharge_failed($1,'late failure')", [orderId])).status).toBe("UNCHANGED");
    });

    it("reverses partial refunds without drift and full refunds exactly", async () => {
      const orderId = await rechargeOrder({ amountPaise: 100000, taxPaise: 15254 });
      await rpc("wallet_fulfill_recharge($1,'pay_1',100000,null,null)", [orderId]);
      const a = await rpc("wallet_reverse_recharge('pay_1','rfnd_a',33333)");
      expect(a.status).toBe("REVERSED");
      expect((await rpc("wallet_reverse_recharge('pay_1','rfnd_a',33333)")).status).toBe("DUPLICATE");
      await rpc("wallet_reverse_recharge('pay_1','rfnd_b',33333)");
      await rpc("wallet_reverse_recharge('pay_1','rfnd_c',33334)");
      expect(await balance()).toBe(0);
      expect(await scalar("select status from wallet_recharge_orders")).toBe("REFUNDED");
      expect(await scalar("select status from payments where id=$1", [pay])).toBe("REFUNDED");
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
      expect((await rpc("wallet_quote('ai',$1,'*','*','*','unknown_feature')", [org])).status).toBe("NO_PRICE");
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
});
