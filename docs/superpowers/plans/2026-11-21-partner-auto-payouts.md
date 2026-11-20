# Partner Auto Payouts, Emails and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay partners automatically through RazorpayX UPI behind safety caps, email them at lifecycle moments, and redesign `/partner/*`.

**Architecture:** One additive SQL migration holds all money rules: the gate, monthly creation, and provider settlement. The ledger stays the single source of truth. TypeScript workers run from the existing billing cron: payout engine and email outbox. A signed webhook confirms payouts. UI changes are client components on the existing partner/admin APIs.

**Tech Stack:** Next.js (repo version — read `node_modules/next/dist/docs/` before touching routes), Supabase Postgres, PGlite tests, vitest + happy-dom, nodemailer, TanStack Query, Tailwind tokens.

**Spec:** `docs/superpowers/specs/2026-11-21-partner-auto-payouts-design.md`

## Global Constraints

- All money is integer paise. No floats.
- Nothing sends money unless `POSTBUS_AFFILIATE_PAYOUTS_ENABLED=true` AND `affiliate_settings.auto_payout_enabled` AND `RAZORPAYX_ACCOUNT_NUMBER` is set.
- PAID is only set from a signed `payout.processed` webhook or a RazorpayX GET that returns `status=processed`.
- Defaults: `auto_payout_enabled=false`, `auto_payout_day=5`, `auto_payout_max_paise=1000000`, `auto_payout_daily_cap_paise=5000000`, `new_account_hold_hours=72`.
- RazorpayX payout: `mode:"UPI"`, `purpose:"payout"`, `currency:"INR"`, header `X-Payout-Idempotency: <payout request id>`.
- Emails are gated by `AFFILIATE_EMAIL_ENABLED=true`. In staging (`POSTBUS_ENV=staging`), send only if `AFFILIATE_EMAIL_TEST_RECIPIENT` is set, and send everything there.
- Migrations are local files only. Never apply to production (`.env.local`).

## Review Focus

1. Webhook arrives twice or out of order (processed then updated) → second call is a no-op, and the ledger has exactly one PAYOUT entry.
2. Engine crashes after RazorpayX accepted the payout but before `mark_processing` → the next run re-sends with the same idempotency key and records the same provider ID. No second transfer.
3. A partner changes UPI between request and send → the payout uses the account on the request, and the new account starts its 72h hold for future payouts.
4. A refund reversal leaves the partner with a recoverable (negative) balance after a request was created → the gate holds it (REVIEW), and the engine never sends a REVIEW payout.
5. Admin approves a held RAZORPAYX payout while payouts are globally disabled → it stays APPROVED and unsent, with no error loop.

---

### Task 1: Migration `20261121090000_affiliate_auto_payouts.sql`

**Files:** Create `supabase/migrations/20261121090000_affiliate_auto_payouts.sql`. Test `modules/affiliates/auto-payout.pg.test.ts` (copy the bootstrap from `ledger.pg.test.ts`, add the new file to the migration list).

**Produces (SQL, service_role only):**
- columns/tables per spec §Database.
- `affiliate_payout_gate(p_id uuid) returns text` → `'OK'` or the hold reason code (`OVER_PARTNER_CAP|OVER_DAILY_CAP|NEW_ACCOUNT|RISK_FLAG|FIRST_PAYOUT|NOT_ELIGIBLE`).
- `affiliate_auto_request_payouts(p_month date) returns integer` → the number created. Key `md5(affiliate||month)::uuid`. Uses the newest payout account. Sets `origin='AUTO'`.
- `affiliate_request_payout` replaced: sets `send_via`, then applies the gate (`APPROVED` or `REVIEW` + `hold_reason`) when `send_via='RAZORPAYX'`.
- `affiliate_mark_processing(p_id uuid, p_provider_id text, p_provider_status text) returns void` (APPROVED→PROCESSING, idempotent on the same provider ID).
- `affiliate_provider_settle(p_provider_id text, p_event text, p_utr text, p_reason text) returns text`. Events: `processed`→PAID+PAYOUT; `failed|rejected|cancelled`→FAILED+RELEASE; `reversed`→RETURNED+PAYOUT_RETURN (only from PAID; from PROCESSING it acts like failed). Returns the new status; repeats are no-ops.
- `affiliate_settle_payout` replaced: refuses `PAID` when `send_via='RAZORPAYX'`.
- `affiliate_admin_action('settings')` replaced to also save the 5 new settings (missing keys keep current values).
- `affiliate_email_outbox` + audit trigger mapping `application.submitted→application_received`, `status→status_<lower>`, `payout.sent→payout_sent`, `payout.PAID→payout_paid`, `payout.FAILED→payout_failed`, `payout.RETURNED→payout_returned`, `commission.first_cleared→first_commission`. `affiliate_claim_emails(p_limit int)` returns rows with the partner's email from `auth.users` and `application`.
- `affiliate_accrue` is not changed. The first APPROVAL per partner is detected by the trigger on `affiliate_ledger_entries` insert.

- [ ] Tests (fail first): `gate holds first payout`, `gate OK under caps on second payout`, `over partner cap → OVER_PARTNER_CAP`, `daily cap counts PROCESSING+PAID today`, `new account < 72h → NEW_ACCOUNT`, `monthly auto request is idempotent (2 calls → 1 row)`, `processed twice → one PAYOUT entry, balance paid = amount`, `failed releases reservation (available restored)`, `reversed after paid → PAYOUT_RETURN`, `manual PAID refused for RAZORPAYX`, `payout PAID enqueues payout_paid email once`, `settings action saves auto fields`.
- [ ] Run `npx vitest run modules/affiliates/auto-payout.pg.test.ts modules/affiliates/ledger.pg.test.ts` → all pass.
- [ ] Commit.

### Task 2: RazorpayX client `modules/affiliates/razorpayx.ts`

**Produces:** `razorpayxConfigured(): boolean`; `ensureFundAccount(input:{name:string;upi:string;referenceId:string}): Promise<{contactId:string;fundAccountId:string}>`; `createPayout(input:{fundAccountId:string;amountPaise:number;idempotencyKey:string;narration:string}): Promise<{id:string;status:string;utr:string|null}>`; `fetchPayout(id:string): Promise<{id;status;utr;failureReason}>`.
- [ ] Tests (`razorpayx.test.ts`, mocked fetch): sends the idempotency header and the account number; throws without leaking the secret; `razorpayxConfigured` is false without the account number.
- [ ] Implement, pass, commit.

### Task 3: Payout engine `modules/affiliates/payout-engine.ts` + cron wiring

**Consumes:** Task 1 RPCs, Task 2 client. **Produces:** `runPayoutEngine(db, now=new Date()): Promise<{created:number;sent:number;polled:number;skipped?:string}>`.
- Order: gate on flags → if the IST day ≥ `auto_payout_day`, call `affiliate_auto_request_payouts(first of month)` → send up to 10 `APPROVED & send_via=RAZORPAYX & provider_payout_id is null` (decrypt the account, ensure the fund account and cache it in `affiliate_razorpay_accounts`, create the payout, `mark_processing`, audit `payout.sent`) → poll up to 20 PROCESSING with `sent_at < now-30min` via `fetchPayout`, mapping into `affiliate_provider_settle`.
- On a send error, write `failure_reason` and leave it APPROVED. Retry next run, at most 3 times, then `affiliate_provider_settle(...,'failed')`.
- Wire into `app/api/cron/billing/route.ts` in its own try/catch after the affiliate sweep.
- [ ] Tests (`payout-engine.test.ts`, mocked db/client): `skips when flags off`, `does not create before payout day`, `sends approved and marks processing`, `poll maps processed to settle`.
- [ ] Implement, pass, commit.

### Task 4: Webhook `app/api/webhooks/razorpayx/route.ts`

- Verify with `verifyWebhookSignature(raw, sig, RAZORPAYX_WEBHOOK_SECRET)`. 400 on a bad signature. 200 on unknown events. Payload `payload.payout.entity` → `affiliate_provider_settle(id, event suffix, utr, failure_reason|status_details.description)`.
- [ ] Tests: bad signature 400; `payout.processed` calls settle with the UTR; `payout.updated` with status processed maps to processed.
- [ ] Implement, pass, commit.

### Task 5: Emails `modules/affiliates/emails.ts`

**Produces:** `renderPartnerEmail(kind:string, ctx:{name:string;payload:Record<string,unknown>;appUrl:string}): {subject:string;text:string;html:string}|null`; `runPartnerEmails(db): Promise<{sent:number;failed:number}>`.
- SMTP from `AFFILIATE_SMTP_*` falling back to `MANIFEST_SMTP_*`. From name "PostBus Partners". Skip `status_*` and `first_commission` when `application.notify===false` (mark SKIPPED). Retry backoff 15 min, give up after 5 attempts.
- Wire into the billing cron after the engine.
- [ ] Tests: templates for each kind include the amount/UTR and HTML-escape the name; staging without a test recipient sends nothing; staging redirect rewrites `to`.
- [ ] Implement, pass, commit.

### Task 6: APIs

- Partner `GET /api/partner/payouts/overview` → `{balance, minimumPaise, nextPayoutDate, autoEnabled, account:{masked,addedAt,heldUntil}|null, rules:{maxPaise,holdHours,day}}`. Payout list fields add `status,utr,hold_reason,failure_reason,origin,sent_at`.
- Admin `settings` action schema adds optional `autoPayoutEnabled, autoPayoutDay(1–28), autoPayoutMaxPaise, autoPayoutDailyCapPaise, newAccountHoldHours(0–720)`. Status filter adds `PROCESSING|FAILED`. `email-outbox` admin GET section.
- [ ] Extend `api.test.ts`: overview requires a profile; settings schema accepts the auto fields.
- [ ] Commit.

### Task 7: Admin UI

- Settings dialog: an automatic payouts section. Payouts tab: chips for PROCESSING/FAILED, hold reason under the status, "Approve & send" label when `send_via=RAZORPAYX`, Mark paid hidden for RAZORPAYX, UTR column. Health: email outbox failures.
- [ ] Update `admin-dashboard.test.tsx` (auto settings flag shown), commit.

### Task 8: Partner UI redesign

- Design tokens per the ui-ux-pro-max design-system query "fintech partner affiliate dashboard", mapped to the existing CSS variables.
- Rewrite `partner-shell.tsx` nav (Overview, Links, Referrals, Earnings, Payouts, Profile, Help). Overview hero + next payout card + chart + activity. Payouts page with account card, rules and timeline. Preserve the uncommitted edits already in `partner-portal.tsx`.
- [ ] Render tests `partner-portal.test.tsx`: the overview shows the formatted balance and next payout date; payouts shows the UTR and "On hold" with its reason.
- [ ] Commit.

### Task 9: Config + final verification

- `.env.example` gains the new vars with comments. Typecheck the touched files (scratch tsconfig), eslint, and run all affiliate tests.
- [ ] Commit.
