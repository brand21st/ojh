import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
let db: PGlite;
const u = "10000000-0000-4000-8000-000000000001", merchant = "10000000-0000-4000-8000-000000000002", other = "10000000-0000-4000-8000-000000000003";
const a = "20000000-0000-4000-8000-000000000001", org = "30000000-0000-4000-8000-000000000001", link = "40000000-0000-4000-8000-000000000001", pay = "50000000-0000-4000-8000-000000000001", sub = "60000000-0000-4000-8000-000000000001", account = "70000000-0000-4000-8000-000000000001";
const key = "80000000-0000-4000-8000-000000000001";
async function scalar(sql: string, args: unknown[] = []) { const r = await db.query<Record<string, unknown>>(sql, args); return Object.values(r.rows[0] || {})[0]; }
async function rejected(sql: string, args: unknown[] = []) { await db.exec("savepoint rejection"); try {
    await expect(db.query(sql, args)).rejects.toThrow();
}
finally {
    await db.exec("rollback to savepoint rejection");
} }
async function evidence(refund = 0, refundTax = 0) { await db.query("insert into affiliate_payment_evidence(payment_id,provider_payment_id,amount_paise,refunded_paise,captured_at,source) values($1,'pay_test',1000000,$2,now()-interval '40 days','test')", [pay, refund]); await db.query("insert into affiliate_tax_evidence(payment_id,refunded_paise,tax_paise,refunded_tax_paise,reason,actor_id) values($1,$2,0,$3,'Verified test invoice',$4)", [pay, refund, refundTax, u]); }
async function accrue() { return scalar("select affiliate_accrue($1)", [pay]); }
async function balance() { return scalar("select affiliate_balance($1)", [a]) as Promise<{
    available: string;
    paid: string;
    recoverable: string;
}>; }
async function payout(amount = 100000, k = key) { return scalar("select affiliate_request_payout($1,$2,$3,$4)", [a, account, amount, k]); }
describe("affiliate automatic payouts (PostgreSQL)", () => {
    beforeAll(async () => {
        db = new PGlite();
        await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,created_at timestamptz default now());
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;
 create table organizations(id uuid primary key default gen_random_uuid(),name text);
 create table organization_members(organization_id uuid references organizations(id),user_id uuid references auth.users(id));
 create table subscriptions(id uuid primary key,organization_id uuid,status text default 'ACTIVE',created_at timestamptz default now());
 create table payments(id uuid primary key,organization_id uuid,subscription_id uuid,billing_cycle text,currency text default 'INR',amount_paise bigint,razorpay_payment_id text,paid_at timestamptz,created_at timestamptz default now());
 create table platform_admins(user_id uuid);
 create table razorpay_webhook_events(id uuid primary key default gen_random_uuid(),event_id text unique,event text,payload jsonb,status text,created_at timestamptz default now());
 create function create_organization_for_user(p_name text) returns organizations language plpgsql as $$declare o organizations;begin insert into organizations(name) values(p_name) returning * into o;insert into organization_members values(o.id,auth.uid());return o;end$$;
 `);
        for (const file of ["20261017120000_affiliate_program.sql", "20261017121000_affiliate_operations.sql", "20261017122000_affiliate_webhook_leases.sql", "20261017123000_affiliate_reporting.sql", "20261017124000_affiliate_reconciliation.sql", "20261017125000_affiliate_partner_portal.sql", "20261017130000_subscription_tax_policy.sql", "20261017140000_subscription_tax_invoices.sql", "20261121090000_affiliate_auto_payouts.sql"]) {
            await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
        }
    }, 30000);
    afterAll(async () => { await db?.close(); });
    beforeEach(async () => {
        await db.exec("begin");
        await db.query("insert into auth.users(id) values($1),($2),($3)", [u, merchant, other]);
        await db.query("insert into platform_admins values($1)", [u]);
        await db.query("insert into affiliate_profiles(id,user_id,status,application,terms_version) values($1,$2,'APPROVED','{}','v1')", [a, u]);
        await db.query("insert into organizations(id,name) values($1,'Merchant')", [org]);
        await db.query("insert into subscriptions(id,organization_id) values($1,$2)", [sub, org]);
        await db.query("insert into affiliate_links(id,affiliate_id,code) values($1,$2,'abcdefghijklmnopqrstuvwx')", [link, a]);
        await db.query("insert into affiliate_attributions(organization_id,affiliate_id,link_id,created_at) values($1,$2,$3,now()-interval '60 days')", [org, a, link]);
        await db.query("insert into payments(id,organization_id,subscription_id,billing_cycle,amount_paise,razorpay_payment_id) values($1,$2,$3,'MONTHLY',1000000,'pay_test')", [pay, org, sub]);
        await db.query("insert into affiliate_payout_accounts(id,affiliate_id,encrypted_details,masked_details) values($1,$2,'encrypted','masked')", [account, a]);
        // Program policy predates this test's captured payment.
        await db.query("insert into affiliate_policies(basis_points,effective_at) values(2000,now()-interval '90 days')");
    });
    afterEach(async () => { await db.exec("rollback"); });
    async function auto(on = true, extra = "") { await db.query(`update affiliate_settings set auto_payout_enabled=$1${extra}`, [on]); }
    async function row(id: unknown) { return (await db.query<Record<string, unknown>>("select * from affiliate_payout_requests where id=$1", [id])).rows[0]; }
    async function priorPaid(amount: number, via = "RAZORPAYX") { await db.query("insert into affiliate_payout_requests(affiliate_id,account_id,amount_paise,status,idempotency_key,send_via,sent_at) values($1,$2,$3,'PAID',gen_random_uuid(),$4,now())", [a, account, amount, via]); }
    async function cleared() { await evidence(); await accrue(); }
    async function sendable(amount = 100000) { await cleared(); await priorPaid(1, "MANUAL"); await auto(true, ",new_account_hold_hours=0"); const id = await payout(amount); expect((await row(id)).status).toBe("APPROVED"); return id; }
    async function emails(kind: string) { return Number(await scalar("select count(*) from affiliate_email_outbox where kind=$1", [kind])); }

    it("keeps manual payouts when automation is off", async () => { await cleared(); const r = await row(await payout()); expect(r.send_via).toBe("MANUAL"); expect(r.status).toBe("REQUESTED"); });
    it("holds a partner's first automatic payout", async () => { await cleared(); await auto(true, ",new_account_hold_hours=0"); const r = await row(await payout()); expect(r.status).toBe("REVIEW"); expect(r.hold_reason).toBe("FIRST_PAYOUT"); });
    it("holds payouts to a newly added UPI account", async () => { await cleared(); await priorPaid(1, "MANUAL"); await auto(true); expect((await row(await payout())).hold_reason).toBe("NEW_ACCOUNT"); });
    it("approves automatically when every check passes", async () => { await sendable(); });
    it("holds over the per-partner cap", async () => { await cleared(); await priorPaid(1, "MANUAL"); await auto(true, ",new_account_hold_hours=0,auto_payout_max_paise=50000"); expect((await row(await payout())).hold_reason).toBe("OVER_PARTNER_CAP"); });
    it("counts today's RazorpayX payouts toward the daily cap", async () => { await cleared(); await priorPaid(100000); await auto(true, ",new_account_hold_hours=0,auto_payout_daily_cap_paise=150000"); expect((await row(await payout())).hold_reason).toBe("OVER_DAILY_CAP"); });
    it("holds risk-flagged partners", async () => { await cleared(); await priorPaid(1, "MANUAL"); await db.query("insert into affiliate_audit_logs(affiliate_id,action) values($1,'risk.identity_overlap')", [a]); await auto(true, ",new_account_hold_hours=0"); expect((await row(await payout())).hold_reason).toBe("RISK_FLAG"); });
    it("creates one automatic request per partner per month", async () => { await cleared(); await auto(true); expect(await scalar("select affiliate_auto_request_payouts('2026-12-01')")).toBe(1); expect(await scalar("select affiliate_auto_request_payouts('2026-12-01')")).toBe(0); const r = (await db.query<Record<string, unknown>>("select * from affiliate_payout_requests")).rows; expect(r).toHaveLength(1); expect(r[0].origin).toBe("AUTO"); expect(String(r[0].amount_paise)).toBe("200000"); });
    it("does nothing monthly when automation is off", async () => { await cleared(); expect(await scalar("select affiliate_auto_request_payouts('2026-12-01')")).toBe(0); });
    it("settles processed exactly once with UTR and emails", async () => {
        const id = await sendable();
        await db.query("select affiliate_mark_processing($1,'pout_1','processing')", [id]);
        await db.query("select affiliate_mark_processing($1,'pout_1','processing')", [id]);
        await rejected("select affiliate_mark_processing($1,'pout_other','processing')", [id]);
        expect(await scalar("select affiliate_provider_settle('pout_1','processed','UTR123','')")).toBe("PAID");
        expect(await scalar("select affiliate_provider_settle('pout_1','processed','UTR123','')")).toBe("PAID");
        expect(Number(await scalar("select count(*) from affiliate_ledger_entries where kind='PAYOUT'"))).toBe(1);
        expect((await balance()).paid).toBe("100000");
        expect((await balance()).available).toBe("100000");
        expect((await row(id)).utr).toBe("UTR123");
        expect(await emails("payout_sent")).toBe(1);
        expect(await emails("payout_paid")).toBe(1);
    });
    it("failed payouts return the money to the balance once", async () => { const id = await sendable(); await db.query("select affiliate_mark_processing($1,'pout_2','processing')", [id]); expect(await scalar("select affiliate_provider_settle('pout_2','failed','','Invalid VPA')")).toBe("FAILED"); await db.query("select affiliate_provider_settle('pout_2','failed','','Invalid VPA')"); expect((await balance()).available).toBe("200000"); expect((await row(id)).failure_reason).toBe("Invalid VPA"); expect(await emails("payout_failed")).toBe(1); });
    it("a reversal after payment restores the balance", async () => { const id = await sendable(); await db.query("select affiliate_mark_processing($1,'pout_3','processing')", [id]); await db.query("select affiliate_provider_settle('pout_3','processed','UTR9','')"); expect(await scalar("select affiliate_provider_settle('pout_3','reversed','','Beneficiary bank')")).toBe("RETURNED"); expect((await balance()).available).toBe("200000"); expect((await balance()).paid).toBe("0"); });
    it("refuses manual settlement of RazorpayX payouts", async () => { const id = await sendable(); await rejected("select affiliate_settle_payout($1,'PAID','ref-x',$2,'Manual')", [id, u]); });
    it("never sends a held payout and admin approval queues it", async () => { await cleared(); await auto(true, ",new_account_hold_hours=0"); const id = await payout(); await rejected("select affiliate_mark_processing($1,'pout_4','processing')", [id]); await db.query("select affiliate_settle_payout($1,'APPROVED','',$2,'Checked partner')", [id, u]); const r = await row(id); expect(r.status).toBe("APPROVED"); expect(r.hold_reason).toBeNull(); await db.query("select affiliate_mark_processing($1,'pout_4','processing')", [id]); });
    it("gives up after repeated send failures and releases funds", async () => { const id = await sendable(); expect(await scalar("select affiliate_record_send_failure($1,'timeout',3)", [id])).toBe("APPROVED"); await db.query("select affiliate_record_send_failure($1,'timeout',3)", [id]); expect(await scalar("select affiliate_record_send_failure($1,'timeout',3)", [id])).toBe("FAILED"); expect((await balance()).available).toBe("200000"); });
    it("enqueues the first cleared commission email once", async () => { await cleared(); await accrue(); expect(await emails("first_commission")).toBe(1); });
    it("claims due emails with the partner address under a lease", async () => {
        await db.query("update auth.users set email='partner@example.test' where id=$1", [u]);
        await db.query("insert into affiliate_audit_logs(affiliate_id,action,details) values($1,'status','{\"status\":\"APPROVED\"}')", [a]);
        const claimed = (await db.query<Record<string, unknown>>("select * from affiliate_claim_emails(10)")).rows;
        expect(claimed.map((c) => c.kind).sort()).toEqual(["application_received", "status_approved"]);
        expect(claimed[0].email).toBe("partner@example.test");
        expect((await db.query("select * from affiliate_claim_emails(10)")).rows).toHaveLength(0);
        await db.query("select affiliate_finish_email($1,$2,'SENT','')", [claimed[0].id, claimed[0].lease]);
        expect(await scalar("select status from affiliate_email_outbox where id=$1", [claimed[0].id])).toBe("SENT");
    });
    it("saves automatic payout settings with an audit row", async () => { await db.query(`select affiliate_admin_auto_settings($1,'{"autoPayoutEnabled":true,"autoPayoutDay":7,"autoPayoutMaxPaise":200000,"autoPayoutDailyCapPaise":900000,"newAccountHoldHours":48,"reason":"Go live"}')`, [u]); const s = (await db.query<Record<string, unknown>>("select * from affiliate_settings")).rows[0]; expect(s.auto_payout_enabled).toBe(true); expect(s.auto_payout_day).toBe(7); expect(Number(await scalar("select count(*) from affiliate_audit_logs where action='settings.auto_payout'"))).toBe(1); await rejected(`select affiliate_admin_auto_settings($1,'{"reason":"x1"}')`, [other]); });
});
