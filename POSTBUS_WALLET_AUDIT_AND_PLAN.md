# PostBus Wallet & Usage-Based Billing: Audit and Implementation Plan

Date: 2026-11-21 · Status: **awaiting approval. No code or migrations written yet.**

---

## Part A: What exists today (audit)

### A1. Tenancy and access
- The tenant is the **organization** (`organizations`). Members link through `organization_members` with roles `OWNER / ADMIN / …`. There is one workspace per user (`20260921161500_one_workspace_per_user.sql`).
- RLS helpers already exist: `is_org_member(org)`, `has_org_role(org, roles[])`, and `is_platform_admin()`. Every tenant table uses them.
- **Super Admin** means a row in `platform_admins` or the configured admin email (`lib/admin/access.ts`). The `(admin)` route group and `/api/admin/*` go through `lib/api/admin/handle.ts`. Destructive admin actions already need a 6-digit step-up PIN (`lib/admin/action-pin.ts`). Admin nav lives in `lib/admin/nav.ts`.
- Security-definer RPCs follow one convention: `revoke` from `public`/`anon`, grant to `service_role` (and to `authenticated` only where needed). Money RPCs are service-role only.

### A2. Subscription billing (must stay untouched)
- `modules/billing/*`: plans, subscriptions, trials, quotas, GST tax policy, subscription tax invoices.
- Platform Razorpay: `modules/razorpay/{client,config,signature}.ts`. Credentials are encrypted in `platform_settings`.
- `payments` table has `payment_purpose` (`subscription | ai_credits | addon…`) and `billing_cycle`.
- Webhook `app/api/webhooks/razorpay/route.ts`:
  1. Verifies the HMAC.
  2. Stores the event in `razorpay_webhook_events` (unique `event_id`).
  3. Takes a lease (`claimBillingWebhook`).
  4. Runs `processRazorpayEvent`, which uses `classifyPlatformRazorpayPayment` to route payments to subscription, add-on or AI-credit fulfilment.
- This is the right place to add a **`wallet_recharge`** purpose. No second webhook endpoint is needed.

### A3. Existing AI credit wallet (this is the system the new wallet replaces)
Migrations `20261008120000_ai_credits.sql`, `20261008180000_ai_credit_wallet.sql` and `20261011140000_ai_image_studio.sql` set up:
- **Balance columns:** `organizations.ai_credits_balance / _purchased / _used`. These are integer *credits*, not INR. New orgs start with 500.
- **Ledger:** `ai_credit_ledger` is append-only. It has a unique `(org, idempotency_key)` and a unique purchase-per-`payment_id`.
- **Packs:** `ai_credit_packages` (₹99 for 500 up to ₹1,199 for 10,000), with a custom-amount min/max in `platform_settings`.
- **RPCs:**
  - `consume_ai_credit` and `reserve/finalize/release` both lock the org row with `FOR UPDATE`.
  - `fulfill_ai_credit_purchase` credits exactly once and checks the amount and org.
- **Consumers** (all in `modules/ai-credits/service.ts`):
  - WhatsApp paste parser: `openrouter/parse-whatsapp.ts`
  - Shopify address AI: `shopify/address-ai.ts`
  - Pre-booking address validation: `orders/prebooking-validation.ts`
  - Product copy, cover copy, AI image studio and prompt enhance: `ai-image/*`
- **UI:** `components/billing/ai-credits-section.tsx` on `/dashboard/billing`, and `/admin/ai-credits`.
- **Gaps:**
  - Each feature charges flat credits (1 or 10). Model and tokens are not recorded.
  - Only `ai-accountant/assistant/run.ts` reads `usage.prompt_tokens`.
  - No pricing versions, no admin adjustment audit, no INR value.

### A4. WhatsApp
There are three send paths:

| Path | Who pays Meta | Today |
|---|---|---|
| **Platform VaChat** (`platform_settings.vachat_enabled`, one PostBus API key for every merchant) | **PostBus** | Order Confirmation / Processing / Booked / In Transit / Delayed / Delivered notices, support replies, manifest WhatsApp |
| Merchant's own VaChat key (`vachat_connections`) | Merchant | Same notices, on the merchant's own account |
| Merchant's own WATI (`wati_connections`) | Merchant | Same notices |
| Platform OTP / signup welcome / abandoned-signup | PostBus (its own acquisition cost) | `lib/auth/otp/send-whatsapp.ts`, `vachat/signup-welcome.ts` |

- Sends run through background jobs (`modules/jobs`, `lib/jobs/drain.ts`, `claim_background_jobs`). Idempotency comes from `external_ref = postbus:{event}:{entity}[:scan]`, unique per org in `vachat_notification_logs`.
- Delivery status arrives on the `message.status_updated` webhook (`modules/vachat/webhook.ts`) as `sent / delivered / read / failed`. Inbound envelopes are de-duplicated. **The VaChat payload carries no Meta pricing or category fields.** Category comes from the template catalog (`vachat/templates.ts`, `category`); notices use UTILITY templates.

### A5. Jobs, cron, observability
- `background_jobs` has claim and lease RPCs, plus cron routes under `app/api/cron/*`. The prod billing cron is known **not** to run (see the prod-billing memory note), so wallet reconciliation must not depend on it alone.
- The repo uses PostHog, Sentry, and `logError`/`logInfo`.

### A6. Risks found during the audit
1. `.env.local` points at **production** Supabase. Wallet migrations must be applied on staging first, and only applied on prod after explicit approval.
2. The current branch `fix/auth-session-stability` has about 60 unrelated uncommitted files. The wallet should be built on a **separate branch/worktree off `main`**.
3. Prod may be missing billing tables (PGRST205 has been seen before). The migration must be self-contained and idempotent.

---

## Part B: Architecture

### B1. Core principle
**Turn the AI-credit wallet into a generic INR wallet.** Do not build a second, parallel system. The proven patterns carry over unchanged: org-row lock, unique idempotency keys, one purchase credit per payment, and fulfilment from the webhook. Subscription payments stay on their existing purpose and code path.

### B2. Money unit
- `bigint` **micro-rupees** (`*_micros`): 1 ₹ = 1,000,000 µ₹ and 1 paisa = 10,000 µ₹.
- This covers fractional-paisa Meta rates such as ₹0.1150 = 115,000 µ₹. The range is ±9.2 × 10¹² ₹.
- Razorpay amounts stay in paise and convert by ×10,000. The code never uses float. The TS side uses `bigint` or integer-only helpers in `modules/wallet/money.ts` with exhaustive tests.

### B3. Tables (one migration: `2026112112xxxx_tenant_wallet.sql`)

| Table | Purpose / key constraints |
|---|---|
| `wallets` | 1 row per org (`organization_id` unique).<br>Columns: `balance_micros`, `reserved_micros` (both `>= 0`, with `balance >= reserved`), `status` (`active / frozen`), `credit_limit_micros` (default 0, the "explicit credit policy"), `low_balance_thresholds_micros[]`, lifetime counters (recharged / whatsapp / ai / promo / refunded), `version`. |
| `wallet_ledger` | **Immutable**: an UPDATE/DELETE trigger raises.<br>Columns: `org`, `wallet_id`, `entry_type` (`RECHARGE, USAGE_WHATSAPP, USAGE_AI, PROMO_CREDIT, ADMIN_CREDIT, ADMIN_DEBIT, REFUND_TO_WALLET, RECHARGE_REVERSAL, MIGRATION_OPENING`), `amount_micros` (signed, ≠0), `balance_after_micros`, `reference_type/id`, `idempotency_key` (unique per wallet), `pricing_rule_id`, `actor_user_id`, `metadata`, `created_at`. |
| `wallet_reservations` | Holds funds before a send or AI call.<br>Status runs `HELD → CAPTURED / RELEASED / EXPIRED`. Unique `(wallet, idempotency_key)`, plus `expires_at`. |
| `wallet_recharge_orders` | One per checkout: `amount_paise`, `razorpay_order_id` (unique), `status` (`CREATED / PAID / FAILED / REFUNDED / PARTIALLY_REFUNDED`), `payment_id → payments`. |
| `payments` (existing) | Reused with `payment_purpose = 'wallet_recharge'`, so Razorpay audit and Super Admin payments keep a single list. |
| `wallet_pricing_rules` | **Versioned, never edited in place.** A change inserts a new row and closes the old one's `effective_to`.<br>Columns: `service` (`whatsapp / ai`), `whatsapp_category`, `country_code`, `provider`, `ai_feature`, `ai_model`, `unit` (`per_message / per_operation / per_1k_input_tokens / per_1k_output_tokens`), `base_cost_micros`, `markup_bps`, `discount_bps`, `organization_id` (null = global, set = tenant override), `effective_from/to`, `created_by`. |
| `wallet_free_allowances` | Optional per-org/category monthly free messages, with `period` and `used`. |
| `whatsapp_usage_records` | One per billable send.<br>Columns: `org`, `log_id → vachat_notification_logs`, `external_ref` (unique per org), `category`, `country`, `provider`, `pricing_rule_id`, `unit_price_micros`, `status` (`RESERVED / CHARGED / RELEASED / FREE`), `provider_message_id`, `reservation_id`, `ledger_id`. |
| `ai_usage_records` | Columns: `org`, `feature`, `model`, `input_tokens`, `output_tokens`, `pricing_rule_id`, `charge_micros`, `status`, `idempotency_key` (unique), `reservation_id`, `ledger_id`, `parent_operation_id` (links the AI and WhatsApp halves of a combined feature). |
| `wallet_adjustments` | Admin-only and immutable.<br>Columns: `admin_user_id`, `admin_email`, `kind` (`promo / refund / manual_credit / manual_debit`), `amount_micros`, `reason` (required, at least 10 chars), `ledger_id`, `created_at`. |
| `wallet_alerts` | Columns: `org`, `threshold_micros`, `fired_at`, `cleared_at`, `channel`. Unique open alert per (org, threshold), so each threshold fires once per crossing. |

**RLS**
- Tenants get `SELECT` only on their own rows (`is_org_member`). Pricing rules are readable only for their resolved price, through an RPC.
- No tenant `INSERT/UPDATE/DELETE` policy on any wallet table.
- All writes go through security-definer RPCs granted to `service_role` only.

**Indexes:** `(organization_id, created_at desc)` on ledger and usage tables, `status` partial indexes on reservations and recharge orders, and a pricing lookup index on `(service, category/feature, country, organization_id, effective_from)`.

### B4. RPCs (all atomic, all lock `wallets` row `FOR UPDATE`)
- `wallet_ensure(org)` is idempotent. A trigger on `organizations` insert also creates the wallet.
- `wallet_reserve(org, amount, key, ttl)` and `wallet_capture(reservation, final_amount, ledger fields)`:
  - Capture may be **less than or equal to** the held amount. AI token pricing settles to the actual amount.
  - Both reject if `balance − reserved + credit_limit < amount`.
- `wallet_release(reservation)`.
- `wallet_debit_direct(org, amount, key, …)` for immediate verified charges. It does the reserve and capture in one transaction.
- `wallet_fulfill_recharge(razorpay_order_id, payment_id, amount_paise, expected_org)` mirrors `fulfill_ai_credit_purchase`. It credits exactly once through the `PAID` transition plus the unique ledger key `recharge:{payment_id}`.
- `wallet_reverse_recharge(payment_id, refund_id, amount)` handles refunds.
- `wallet_admin_adjust(org, kind, amount, reason, admin_id, key)` writes the adjustment and ledger rows in one transaction.
- `wallet_expire_reservations()` and `wallet_reconcile(org?)`:
  - Reconcile asserts `balance = Σ ledger` and `reserved = Σ HELD` per wallet.
  - Mismatches are recorded, and Super Admin is alerted. Nothing is silently fixed.

### B5. Flows

**Recharge**
1. The UI calls `POST /api/v1/wallet/recharge` with the amount. The server validates it against the presets (₹100/250/500/1000/2000) and the admin min/max.
2. The server creates the Razorpay order, the `payments` row and the `wallet_recharge_orders` row.
3. Razorpay Checkout opens.
4. The client callback hits `POST /api/v1/wallet/recharge/verify`. The server checks the signature **and** fetches the payment from the Razorpay API before calling `wallet_fulfill_recharge`.
5. The `payment.captured` / `order.paid` webhook calls the same RPC. Whichever arrives first credits, and the other one no-ops.
6. `payment.failed` marks the recharge order FAILED. `refund.processed` reverses the credit.
7. A reconcile job re-fetches stale `CREATED` orders older than 15 minutes from Razorpay, which covers delayed or missed webhooks.

**WhatsApp**: billed only when sent through the **platform VaChat** account.
1. In `vachat/send.ts`, before the provider call, the code resolves the price:
   - category from the template catalog (notices are UTILITY);
   - country from the E.164 recipient.
   It then calls `wallet_reserve(key = whatsapp:{org}:{external_ref})`.
2. If the balance is insufficient, the send is **not attempted**:
   - The log gets `status = 'insufficient_balance'`.
   - The job is parked as "held for balance", not failed.
   - A recharge prompt shows.
   - Held jobs resume automatically after the next successful recharge, up to a configurable age such as 24h, so stale "Booked" notices are not sent days later.
3. On a provider send error, the reservation is released.
4. On the `sent`/`delivered` webhook, the reservation is captured (charged once, because the reservation is unique). On `failed`, it is released.
5. Webhook retries hit the already-captured/released state and no-op.
6. If no webhook arrives, a reservation older than 24h is captured if the provider accepted the message. The rule is configurable.
7. Merchant-own WATI/VaChat and PostBus's own OTP/signup messages are **not billed**. They still write a `FREE` usage record for reporting.

**AI**
- A new `modules/wallet/ai-billing.ts` wraps each AI call in `runBilledAiOperation({feature, model, idempotencyKey}, fn)`:
  1. Reserve the max estimated charge.
  2. Call OpenRouter and read `usage.prompt_tokens/completion_tokens`.
  3. Price from the rule (fixed + token).
  4. Capture the actual amount, or release it on failure.
- The existing call sites move from `consumeAiCredit/reserveAiCredits` to this wrapper. Their idempotency keys already exist and are reused.
- Combined features record two usage rows sharing `parent_operation_id`.

**Low balance**
- After every debit, the ledger RPC compares the new balance with the thresholds and inserts a `wallet_alerts` row on crossing. A job then sends an in-app notification through the existing `notifications` realtime table, plus email. The alert clears when the balance rises above the threshold again.
- Only wallet-billed operations are blocked. Booking, labels, tracking and the rest are never gated on the wallet.
- Auto-recharge is **out of scope for v1**. It needs Razorpay recurring/e-mandate consent, which I'd propose as a later phase.

### B6. Migrating existing AI credits
- Each org gets an opening ledger entry `MIGRATION_OPENING` = `ai_credits_balance × conversion_rate`.
- The old columns, RPCs and ledger are kept **read-only** for history. Old `ai_credits` payment fulfilment keeps working for any checkout already in flight.
- A feature flag `WALLET_ENABLED` switches the consumers and UI. While it is off, everything behaves exactly as today.

### B7. UI
- **Merchant:** a `Wallet` sidebar item → `/dashboard/wallet`, using the existing PageHeader, cards, data-table and sheet components. It shows:
  - KPI cards: balance, WhatsApp spend, AI spend, total recharged, this month.
  - Recharge sheet with presets and a custom amount.
  - Usage chart (daily, split by service).
  - Transactions table with filters and CSV export.
  - Low-balance banner.
  - The AI-credits section on `/dashboard/billing` becomes a link to Wallet.
- **Super Admin:** `Wallet Management` → `/admin/wallet` with three tabs:
  - **Tenant wallets:** a table with all the requested columns, plus freeze/unfreeze.
  - **Pricing:** versioned rules editor, tenant overrides, history view.
  - **Adjustments:** promo / refund / manual credit or debit. Each needs a reason and the action PIN, and the admin can export a statement.
  - Plus a reconciliation status card.

### B8. Code layout
- `modules/wallet/`: `money.ts`, `pricing.ts`, `service.ts`, `recharge.ts`, `webhooks.ts`, `whatsapp-billing.ts`, `ai-billing.ts`, `alerts.ts`, `reconcile.ts`, `admin.ts`, `constants.ts`, each with `*.test.ts`. Postgres-backed tests go in `*.pg.test.ts` (PGlite, matching the existing `inclusive-tax.pg.test.ts` pattern) to cover concurrency, idempotency and immutability.
- Routes:
  - `lib/api/v1/wallet.ts`
  - `lib/api/admin/wallet.ts`
  - cron `app/api/cron/wallet` for expiring reservations, reconciling, re-checking stale recharge orders and resuming held sends.

### B9. Test matrix (maps to Phase 10)

| # | Test | Kind |
|---|---|---|
| 1 | Wallet created on org insert and backfilled | pg |
| 2–4 | Recharge success, failure, and duplicate webhook + callback race | unit + pg |
| 5 | 50 concurrent reserves/recharges keep balance = Σ ledger | pg |
| 6–8 | WhatsApp charge, failed release, duplicate status webhook | unit + pg |
| 9 | AI token pricing, capture ≤ reserve, retry idempotency | unit + pg |
| 10 | Insufficient balance: no send, held job, resumes after recharge | unit |
| 11 | Org A cannot read or charge org B (RLS + RPC grants) | pg |
| 12 | Admin adjustment needs PIN + reason and is immutable | unit + pg |
| 13–14 | Statement totals, refund reversal, reconcile mismatch detection | pg |
| 15 | Existing billing/ai-credits/vachat suites stay green; typecheck; staging browser pass on desktop, tablet and mobile | regression |

### B10. Delivery phases (each one is a commit)
1. Migration + money/pricing/service RPCs + pg tests (staging only).
2. Recharge (API, webhook routing, verify, reconcile) + merchant Wallet page.
3. AI billing wrapper + migrate consumers (flagged).
4. WhatsApp billing in the platform VaChat path + held sends.
5. Super Admin wallet management + adjustments + exports.
6. Low-balance alerts + cron + reconciliation.
7. Full regression, staging E2E with Razorpay **test mode**, then a prod rollout plan for your approval.

---

## Part C: Decisions (answered 2026-11-21)
- **Credit conversion:** ₹0.20 per existing AI credit, recorded as a `MIGRATION_OPENING` entry.
- **WhatsApp billing:** only sends through the **platform VaChat** account are billed. Merchant-own WATI/VaChat sends and PostBus OTP/signup messages are recorded as `FREE`.
- **GST:** each recharge is **GST-inclusive** and gets a tax invoice at recharge time from the existing subscription tax-invoice engine. The wallet is credited with the net (taxable) value. *The recharge-confirm UI must show the split, for example "Pay ₹1,000 → ₹847.46 wallet credit + ₹152.54 GST"; please confirm this is the intended effect.*
- **New tenant:** gets a ₹100 `PROMO_CREDIT`.

### Original questions
1. **Credit conversion:** what INR value for each existing AI credit? My suggestion is ₹0.20, which is the Starter pack rate of ₹99 / 500.
2. **New-tenant starting balance:** today it is 500 free AI credits. Should new tenants get the equivalent promo INR (₹100 at ₹0.20), or start at ₹0?
3. **GST on recharges:** treat a recharge as an advance with a GST tax invoice at recharge time, reusing the subscription tax-invoice engine, or defer GST? This is an accounting call.
4. **Who gets billed for WhatsApp:** the proposal bills only sends through the platform VaChat account, not merchants on their own WATI/VaChat, and not PostBus's own OTP/signup messages. Confirm?

---

## Part D: Phase 1 status (2026-11-21, branch `feat/tenant-wallet`)

**Built**
- Migration `supabase/migrations/20261121120000_tenant_wallet.sql`. **Not applied to any database.**
  - **Tables:** `wallets`, `wallet_ledger`, `wallet_reservations`, `wallet_recharge_orders`, `wallet_pricing_rules`, `wallet_adjustments`, `wallet_alerts`, `wallet_reconciliation_issues`, `wallet_status_events`.
  - **Settings:** wallet columns on `platform_settings`, plus `wallet_recharge` added to `payments.payment_purpose`.
  - **Functions (service_role only):** reserve, capture, release, debit, reverse usage, expire, fulfil/fail/refund recharge, admin adjust, set status, versioned pricing (set/resolve/quote), reconcile, AI-credit cutover.
  - **Guards:** ledger, adjustments and status events can't be edited. Pricing rules can only be closed. Balances change only inside wallet functions.
  - **Backfill:** every existing org gets an empty wallet. Credits move only when `wallet_migrate_all_ai_credits` runs at cutover.
  - **Signup promo:** off until `wallet_signup_promo_enabled` is set at cutover.
- `modules/wallet/{money,pricing,constants,service}.ts`. Money is bigint micros, and the TS pricing mirrors the SQL exactly. `WALLET_ENABLED` flag; nothing calls the wallet yet.

**Tests**
- `money.test.ts` and `pricing.test.ts`: unit tests.
- `wallet.pg.test.ts`: 29 PGlite tests against the real migration. They cover:
  - creation, backfill and promo
  - recharge once-only, mismatch, wrong tenant, fail-then-retry
  - partial and full refunds, freeze and unfreeze
  - holds, captures and releases, plus idempotency
  - immutability, tenant isolation (RLS and function grants)
  - admin audit, pricing versions and overrides
  - SQL = TS pricing on 200 random cases
  - alerts, reconcile, cutover
- `scripts/wallet/concurrency-check.sh` runs on a throwaway real Postgres 17 cluster:
  - 80 clients × 250 mixed transactions (colliding keys, racing fulfilments).
  - A drain where 1,600 parallel charges stop exactly at ₹0.
  - Fails if the wallet row lock is removed.

**Changed from the original plan**
- Usage-record tables and free allowances move to the phases that write them (AI → Phase 3, WhatsApp → Phase 4).
- Credits move at cutover, not at migration time, so balances aren't double-counted while the old AI credit flow is still live.

**Known, not caused by this work:** `modules/billing/consume-quota.test.ts` has 2 failures at base commit `db76c90`.

---

## Part E: Phase 2 status (2026-11-21): recharge and merchant Wallet page

**Built**
- **Migration** `20261121140000_wallet_recharge.sql` (**not applied anywhere**):
  - Settings: GST rate (default 18%) and place of supply on `platform_settings`. Each order stores its own GST rate and CGST/SGST/IGST split.
  - `wallet_quote_recharge`: same rounding as the subscription GST engine.
  - `wallet_create_recharge_order`: writes the `payments` row and the recharge order in one transaction, enforcing the min/max.
  - Read models: `wallet_summary` (month boundaries in IST) and `wallet_usage_daily`.
- **Recharge flow** in `modules/wallet/recharge.ts`:
  1. The amount is validated before any Razorpay order is created.
  2. The Razorpay order is created and recorded through the database function.
  3. Verify checks the signature, reads the payment back from Razorpay, requires the same order and INR, and credits only a **captured** payment. An authorized-only payment returns PENDING and the webhook credits it.
- **Webhook:** `modules/wallet/webhooks.ts` handles `payment.captured`, `order.paid`, `payment.failed` and `refund.processed` for wallet orders.
  - `processRazorpayEvent` calls it first and returns early. Subscription, add-on and AI-credit paths are unchanged.
  - A lookup error other than "table missing" throws, so Razorpay retries instead of the event being lost.
- **Recovery:** `modules/wallet/reconcile.ts` asks Razorpay about orders still pending after 2 minutes and credits any captured payment.
  - It runs from the new `/api/cron/wallet` and also whenever a merchant opens the Wallet page, because the billing cron isn't scheduled in production.
- **API** `lib/api/v1/wallet.ts`:
  - `GET wallet`, `wallet/transactions`, `wallet/recharges`, `wallet/usage`, `wallet/statement` (CSV).
  - `POST wallet/recharge`, `wallet/recharge/verify`, `wallet/recharge/preview`.
  - Any member can read; recharging needs `org.billing` (owners). All of it returns 404 while `WALLET_ENABLED` is off.
- **UI:**
  - `/dashboard/wallet` shows the KPIs, a 30-day chart by service, Transactions / Recharges / Statement tabs, and low-balance and frozen notices.
  - The recharge dialog has presets, a custom amount and a live GST split.
  - The sidebar shows Wallet after Billing only when `me.wallet.enabled` is true.

**Tests**
- 114 tests pass across wallet, permissions and analytics:
  - PGlite: create-order split, limits, IGST, summary and daily usage, grants.
  - SQL = TS recharge split across 5 rates × 51 amounts.
  - Unit: webhook routing, verify, recovery.
- The concurrency check passes with the Phase 2 migration.
- Visual check: a temporary preview route with mocked API data on the worktree dev server, with no database credentials. It covered desktop and mobile; normal, low and frozen states; the recharge dialog; and the recharges list. It found and fixed a mobile overflow in the chart.
- **Not done:** an end-to-end payment in Razorpay test mode against a real database. That needs staging (Docker isn't installed) or a test-mode project.

**Still open**
- **Numbered GST tax invoice PDF for recharges.** The subscription invoice tables require a subscription, so this needs its own small invoice table and series. All amounts it needs are already stored on each order.
- **Place of supply** is a platform setting (INTRA by default). It should come from the merchant's billing profile state when invoices are built.
- **AI Accountant** books recharges as "platform fees"; strictly a wallet top-up is a prepaid asset.

---

## Part F: Recharge tax invoices (2026-11-21)

**Built**
- **Migration** `20261121160000_wallet_recharge_invoices.sql` (**not applied anywhere**):
  - `wallet_recharge_invoices` holds an immutable snapshot of each invoice: supplier, customer, place of supply, rate, CGST/SGST/IGST, payment reference.
  - Optional SAC setting (`platform_settings.wallet_invoice_sac`). It's blank until you set it with your accountant.
- **Numbering:** `subscription_allocate_invoice_number` with the Super Admin prefix (default `PB`). Subscription and wallet invoices share **one consecutive series per Indian financial year** (`PB/2026-27/000001`), using the same counter. No subscription code changed.
- **Supplier** details come from the existing Super Admin invoice settings. An invoice waits (`SUPPLIER_INCOMPLETE`) until legal name, address and GSTIN are filled in.
- **Customer** details come from the merchant's Billing details:
  - With no billing profile, the workspace name is used, as an unregistered buyer.
  - A GSTIN must be valid and needs an address.
  - Above ₹50,000 an address is required.
- **Place of supply** is set when the recharge order is created. If both GSTINs are known, the same state gives CGST + SGST and different states give IGST. Otherwise the platform default applies.
- **When invoices are issued:**
  - right after a credit (checkout callback, webhook, recovery);
  - by the wallet cron for any paid recharge still without one.
  - Issuing never blocks or reverses a credit.
- **PDF:** `GET /api/v1/wallet/recharges/{id}/invoice` returns it, only to the owning tenant. The Recharges tab shows an Invoice link, or "Invoice pending".

**Tests**
- 7 PGlite invoice tests: supplier wait, once-only shared numbering, unpaid refusal, buyer GSTIN/address rules, IGST across states, immutability, FY series in IST, merchant access.
- PDF render tests.
- Sample PDF checked by eye.
- Recharges tab checked in a mock-data preview.

**Open**
- **Refunds:** a refund doesn't issue a GST credit note. The invoice stays as issued and the refund amount is printed as a note.
- **GST timing:** whether a prepaid wallet top-up is taxed at recharge (as built) or at use is a question for your accountant.
- **Signature:** Rule 46 asks for a signature or digital signature. The PDF is unsigned.

---

## Part G: Phase 3: AI features charge the wallet (2026-11-21)

**How an organization switches:** `wallet_ai_mode` returns `wallet` once `wallet_migrate_ai_credits` has run for that organization (and `WALLET_ENABLED` is on). Every other organization keeps the legacy AI credits exactly as before. Moving the credits is the per-tenant switch.

**Built**
- **Migration** `20261121180000_wallet_ai_usage.sql` (**not applied anywhere**):
  - `ai_usage_records`: one row per operation, keyed by idempotency key. It records feature, model, units, input/output tokens, pricing rule, hold, charge and status (`RESERVED / CHARGED / FREE / RELEASED / REJECTED / ABANDONED`).
  - **Seeded AI prices at today's credit rate** (₹0.20 per credit): ₹0.20 per operation for data extraction, address checker, address validation, product/cover copy, prompt rewrite and error explanations; ₹2.00 per Image/Cover Studio variation; plus a ₹0.20 catch-all. Super Admin can add per-model, per-token rates, markup and tenant overrides through versioned pricing rules.
  - `wallet_ai_charge` charges an operation once it has run. A refusal is stored as `REJECTED`, and the same key can be retried after a recharge.
  - `wallet_ai_reserve` and `wallet_ai_settle` handle slow jobs. The hold is priced up front. Settling charges the actual usage at that same pinned rule, never above the hold; any shortfall is recorded as `underBilledMicros`.
  - `wallet_ai_quote`, `wallet_ai_mode`, and `wallet_ai_abandon_stale` (run from the wallet cron).
- **Routing:** `modules/ai-credits/service.ts` functions route wallet-billed organizations to the wallet:
  - `getAiCreditsRemaining` and the snapshot return the balance in credit terms (available ÷ ₹0.20), so existing screens and "out of credits" checks keep working.
  - `consumeAiCredit` returns `null` when the wallet refuses, so address features drop the AI result rather than giving it away.
  - Reserve, finalize and release go through the wallet hold.
  - Buying AI credit packs is blocked for wallet-billed organizations.
- **Every AI call site** now passes its feature, model and OpenRouter token usage: WhatsApp paste (`data_extraction`), Shopify address checker, pre-booking address validation, product copy, cover copy, prompt rewrite, order error explanations, Image Studio and Cover Studio (with units = variations).

**Tests**
- 98 wallet tests pass. They include 8 PGlite AI tests: mode switch, seeded prices, once-only charge with refusal and retry, per-model token pricing with markup, hold/settle/release, cap at hold, abandoned holds, tenant isolation. A routing test covers both the wallet path and the flag-off legacy path.
- Existing AI, billing and API suites pass. The only failures predate this work: 2 address-length tests and 2 consume-quota tests, all confirmed against the base commit. One Shopify test timed out under parallel load and passes on its own.
- The concurrency check passes.

**Known limits**
- **Quick AI calls** check affordability before the model call and charge after it, the same as credits today. Two simultaneous calls on a nearly empty wallet can each pass the check; the second charge is then refused and logged. Image jobs use a real hold.
- **Screens still say "AI credits".** For wallet-billed organizations the number shown is wallet-equivalent operations; changing the wording to rupees is a UI follow-up.

---

## Part H: Phase 4: WhatsApp notice billing (2026-11-21)

**What's billed:** the automated order notices (order confirmation, processing, booked, in transit, delayed, delivered) sent through the **PostBus platform VaChat account**.
- Merchants on their own WATI or VaChat, support replies, OTP and signup messages aren't billed.
- **Off by default.** Super Admin turns on `platform_settings.wallet_whatsapp_billing_enabled` *after* entering rates.
- Only Service (₹0) is seeded. Meta's Marketing, Utility and Authentication rates aren't guessed, and an unpriced category sends free, recorded with `NO_PRICE`.

**Built**
- **Migration** `20261121200000_wallet_whatsapp_usage.sql` (**not applied anywhere**):
  - `whatsapp_usage_records`: one row per notice, keyed by `external_ref`. Status is `RESERVED / CHARGED / FREE / RELEASED / BLOCKED / UNCONFIRMED`, with category, country, provider ids and attempts.
  - `wallet_free_allowances`: monthly free messages per category, global or per tenant (the tenant row wins).
  - `vachat_notification_logs.wallet_hold_payload`.
  - Settings `wallet_whatsapp_billing_enabled` and `wallet_whatsapp_resume_hours` (default 24).
  - Functions `wallet_whatsapp_reserve`, `wallet_whatsapp_settle` and `wallet_whatsapp_expire`.
- **Charge timing:**
  1. **Before send** (`modules/vachat/send.ts`): the price is held. Each attempt gets its own hold key, so a retry after a release can hold again.
  2. **Low balance:** if the wallet can't pay (or is frozen), the notice isn't sent and is logged as `held_balance` with what's needed to send it.
  3. **Send error:** the hold is released and the job retries as before.
  4. **Delivered or read** (status webhook, platform account only): charged once.
  5. **`failed`, or Meta pricing `billable:false`:** released.
  6. **Reported category:** the charge is re-priced at the category Meta reports, never above the hold.
  7. **Duplicate or out-of-order webhooks:** no-ops.
  8. **No confirmation within 72h:** the hold expires and the record becomes `UNCONFIRMED`. A late delivery report is still charged directly if the balance allows.
- **Resume after a recharge:** notices held for balance are re-queued as `vachat-notify` jobs after a successful recharge (callback, webhook, cron), only when the wallet can pay and only if they're younger than the resume window.
- **Billing faults never stop a notice.** If the wallet itself errors, the notice sends unbilled and the error is logged.

**Tests**
- 107 wallet tests pass, including 9 PGlite WhatsApp tests: billing off, hold → deliver → charge once, failures release, low balance blocks then holds after a recharge, category re-pricing capped at the hold, late delivery after expiry, free allowance precedence, unpriced categories, access.
- 9 unit tests cover hold and webhook mapping, resume (only affordable wallets), and the send path (hold, park, release on error, merchant-own account never billed).
- The VaChat, WATI, support, manifest, jobs, billing and API suites pass, apart from the 2 consume-quota failures that predate this work.
- The concurrency check passes.

**Before turning WhatsApp billing on**
- Enter current Meta rates per category (and markup) in Pricing. The Super Admin pricing screen is Phase 5; until then rules go in through `wallet_set_pricing_rule`.
- Check whether VaChat forwards Meta's `pricing` block on status webhooks. Without it every notice is priced as UTILITY, and "not billable" can't be detected.
