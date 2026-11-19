# PostBus — Merchant Razorpay Payment Gateway: Implementation Report

**Date:** 2026-11-19
**Branch:** `release/product-box-on-0000595` (uncommitted)
**Status:** Code complete and tested locally. **Migration not applied anywhere.** Not deployed.

---

## 1. Audit findings

### Existing PostBus SaaS billing (Domain A): left untouched

| Piece | Location |
| --- | --- |
| Platform credentials | `platform_settings` (encrypted), with `RAZORPAY_*` env fallback (`modules/razorpay/config.ts`) |
| HTTP client | `modules/razorpay/client.ts`, which is bound to the platform keys |
| Checkout | `modules/billing/subscriptions.ts`, `modules/ai-credits/service.ts`, `lib/api/v1/billing.ts` |
| Webhook | `POST /api/webhooks/razorpay` → `processRazorpayEvent` (`modules/billing/webhooks.ts`) |
| Tables | `payments`, `subscriptions`, `razorpay_customers`, `razorpay_webhook_events`, `billing_*` |
| Super Admin | `/admin/razorpay`, `modules/razorpay/admin-settings.ts` |

`git status` shows **no file in `modules/billing`, `modules/razorpay`, `lib/api/v1/billing.ts`, `app/api/webhooks/razorpay` or `app/api/cron/billing` was modified.**

### Storefront checkout as it was before this change
- The submit route (`/api/v1/public/order-links/*/submit`) → `submitPublicCustomerOrderLink` re-prices the cart on the server (coupons, bundles and COD advance included). It then creates an `IMPORTED` order with `payment_status = PENDING`.
- Prepaid orders were then paid by **manual UPI/QR**. The merchant confirmed the payment on WhatsApp through the `resolve_whatsapp_payment_claim` RPC, which moves the order `IMPORTED/PENDING` → `READY/PAID|PARTIAL`.
- Storefront orders **never** auto-book India Post. `auto_booking` applies only to Shopify and WooCommerce imports.

### Risks found and how they are handled
| Risk | Handling |
| --- | --- |
| The platform client falls back to env keys, so reusing it would send merchant money to PostBus | A separate client (`modules/merchant-payments/razorpay.ts`) takes keys explicitly. It has no defaults and never imports platform config. A static test enforces this. |
| The platform webhook routes `payment.captured` to AI credits and subscriptions | The merchant webhooks have their own route, tables and processor. Platform billing code never references them (static test). |
| `payments` has no domain discriminator | Merchant payments live in a new table, `merchant_storefront_payments`. `payments` is never touched. |
| `wati_connections` RLS lets members read encrypted tokens | The new credential table is **service-role only**: browsers have no grant at all. |
| Client-supplied amounts and organization IDs | The amount comes from the server-priced order. The organization comes from the store link. Payment status comes from Razorpay, fetched with the merchant's keys. |

---

## 2. Architecture decisions

1. **Two independent payment contexts.**
   - `platform_billing`: the existing code, unchanged.
   - `merchant_storefront_payments`: the new `modules/merchant-payments/*`, `lib/api/v1/merchant-payments.ts` and the new routes.
2. **Manual API keys per merchant** (Key ID, Key Secret and Webhook Secret, each AES-256-GCM encrypted with `INTEGRATION_ENCRYPTION_KEY`). Razorpay Partner OAuth would be cleaner, but PostBus is not a verified Technology Partner (see the 2026-10-10 pre-implementation audit).
3. **No fallback, ever.** `activeMerchantGateway()` throws a customer-safe message when the merchant has no usable, enabled configuration. A test sets platform `RAZORPAY_*` env vars and proves checkout still refuses.
4. **The order is created first, then paid.** This reuses the existing order creation, coupon reservation and idempotency path, so retries cannot create duplicate orders.
   - There is exactly one payment attempt per PostBus order (`unique(order_id)`), and retries reuse the same Razorpay order.
   - If Razorpay is down when the order is placed, the order still exists. The customer can start payment later with the same bearer token, whose hash is kept in order metadata.
5. **One state machine.** Every status change (browser callback, webhook, reconciliation) goes through the SQL function `apply_merchant_storefront_payment`. It runs in one transaction, locks the rows, and checks amount and currency against the stored attempt. It is idempotent and never regresses state (a late `payment.failed` cannot undo `PAID`). A second captured payment on the same order is flagged for refund, not double-settled.
6. **Order effect on payment.** The payment only settles an order that is still `IMPORTED/PENDING`:
   - Prepaid order → `READY/PAID`.
   - COD advance → `READY/PARTIAL`, with `amount_paid` and `cod_amount` set.

   This is the same transition the merchant's manual "payment verified" confirmation makes today. It **does not book India Post**: storefront orders have no auto-booking, and nothing new enqueues booking. A payment that arrives for a cancelled or already-settled order is recorded and flagged for review; the order itself is left alone.
7. **Online orders skip the YES/NO WhatsApp prompt**, because paying is the confirmation. After a verified payment, the customer gets the existing "payment confirmed" WhatsApp message, and the merchant gets a dashboard notification. Both are sent once per order (idempotency key).
8. **Per-merchant webhook URL:** `/api/webhooks/merchant/razorpay/<48-hex token>`.
   - The token selects exactly one integration, and the body must be signed with that merchant's webhook secret.
   - The token rotates on disconnect.
   - Payments on the merchant's account that PostBus did not create are ignored.
9. **Disconnect and key replacement reconcile open attempts with the old keys first.**
   - Replacing keys with a different Razorpay account turns checkout off and requires that account's webhook secret.
   - Disconnect wipes all keys and keeps payment history.
10. **Test and Live are independent.** The Key ID prefix must match the selected mode. Each attempt stores its mode and a key fingerprint, and verification only uses keys whose fingerprint matches.

---

## 3. Files

### New
| File | Purpose |
| --- | --- |
| `supabase/migrations/20261120090000_merchant_razorpay_payments.sql` | 3 tables, RLS and grants, `apply_merchant_storefront_payment` RPC |
| `modules/merchant-payments/razorpay.ts` | Merchant-only Razorpay client (explicit keys, 15 s timeout, no secrets in logs) |
| `modules/merchant-payments/credentials.ts` | Key validation, mode/prefix check, masking, encryption wrappers |
| `modules/merchant-payments/integration.ts` | Connect / verify / enable / disconnect; masked view; gateway resolution |
| `modules/merchant-payments/payments.ts` | Create, resume, confirm and status for attempts; reconciliation; cron sweep; dashboard view |
| `modules/merchant-payments/webhook.ts` | Signature check, event claim and lease, dedupe, processing |
| `lib/api/v1/merchant-payments.ts` | Dashboard API routes |
| `app/api/webhooks/merchant/razorpay/[token]/route.ts` | Merchant webhook endpoint |
| `app/api/v1/public/store/payment/route.ts` | Public storefront payment endpoint |
| `app/api/cron/merchant-payments/route.ts` | Reconciliation sweep (`CRON_SECRET`) |
| `app/(site)/dashboard/integrations/razorpay/page.tsx` | Integration setup and management UI |
| `components/storefront/online-payment.tsx` | Razorpay Checkout panel (pay, retry, check status) |
| `components/orders/online-payment-card.tsx` | Order detail payment card plus "Check status with Razorpay" |
| `components/brand/razorpay-logo.tsx` | Wordmark |
| `modules/merchant-payments/*.test.ts`, `pg-supabase.testkit.ts` | Tests (see §6) |

### Modified (small, additive)
| File | Change |
| --- | --- |
| `modules/customer-order-links/public.ts`, `schema.ts` | `payOnline` flag; availability check before saving; online-payment metadata; Razorpay order creation; skip YES/NO prompt for online orders |
| `modules/storefront/public.ts`, `components/storefront/store-types.ts` | `onlinePayment` boolean on the public store payload |
| `components/storefront/checkout-form.tsx` | "Pay online" option; "Pay ₹X" button |
| `components/storefront/store-app.tsx`, `order-success.tsx` | Open Razorpay Checkout after placing the order; show the verified payment state |
| `app/(site)/dashboard/integrations/page.tsx`, `types/api.ts` | Razorpay — Online Payments card |
| `lib/api/v1/integrations.ts` | Razorpay status in `GET integrations` (null when tables are missing) |
| `lib/api/v1/dispatch.ts` | Registers the merchant payment routes |
| `app/(site)/dashboard/orders/[id]/page.tsx` | Online payment card |
| `components/dashboard/status-badge.tsx` | `VERIFICATION_FAILED` shown as an error |

---

## 4. Database migration — `20261120090000_merchant_razorpay_payments.sql`

The migration is re-runnable (verified by applying it twice in PGlite).

- **`merchant_payment_integrations`**: one row per org and provider.
  - Encrypted Key ID, Key Secret and Webhook Secret; key fingerprint; masked hint; `payment_mode` TEST/LIVE; `connection_status`; `enabled`; unique `webhook_token`.
  - A CHECK constraint stops `enabled` being true without a full connection.
  - **Service role only.**
- **`merchant_storefront_payments`**: one attempt per order (`unique(order_id)`).
  - `razorpay_order_id` is unique; `razorpay_payment_id` is partially unique.
  - Amounts are in integer paise; currency is fixed to `INR`.
  - `checkout_token_hash`, `needs_review` / `review_reason`, `extra_payment_ids`.
  - Members can SELECT their own organization's rows; all writes are service role only.
- **`merchant_payment_webhook_events`**: `unique(payment_integration_id, provider_event_id)`, processing lease, attempts, result.
  - It stores only Razorpay IDs, no payload, because the payload contains customer contact details.
  - **Service role only.**
- **`apply_merchant_storefront_payment(...)`**: `security definer`, executable by `service_role` only.

**No existing table is altered.**

---

## 5. Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/v1/integrations/razorpay` | Session + `integrations.manage` (Owner/Admin) |
| PUT | `/api/v1/integrations/razorpay` `{mode, keyId?, keySecret?, webhookSecret?}` | Same; rate-limited |
| POST | `/api/v1/integrations/razorpay/verify` | Same |
| PATCH | `/api/v1/integrations/razorpay` `{enabled}` | Same |
| DELETE | `/api/v1/integrations/razorpay` | Same |
| GET | `/api/v1/orders/:id/online-payment` | `orders.read` |
| POST | `/api/v1/orders/:id/online-payment/reconcile` | `orders.write`; rate-limited |
| POST | `/api/v1/public/store/payment` `{action: resume\|status\|confirm, store link, orderId, paymentToken, …}` | Public; store link + attempt token; rate-limited per IP and per order |
| POST | `/api/webhooks/merchant/razorpay/:token` | Razorpay signature (merchant's webhook secret) |
| POST | `/api/cron/merchant-payments` | `CRON_SECRET` |

Order placement still uses the existing submit routes, which now accept `payOnline: true`.

---

## 6. Test results

| Suite | Result |
| --- | --- |
| `modules/merchant-payments/migration.pg.test.ts` (real SQL, PGlite) | **11/11 pass** |
| `modules/merchant-payments/merchant-payments.pg.test.ts` (service + real schema + fake Razorpay accounts) | **25/25 pass** |
| `modules/merchant-payments/isolation.test.ts` (static isolation + credentials) | **5/5 pass** |

Scenarios covered, by area:

- **Connecting:**
  - Valid test keys connect.
  - Invalid keys are rejected and nothing is saved.
  - A live key in test mode is rejected, and a test key in live mode is rejected.
  - The webhook secret is required before checkout can be enabled.
  - Replacing keys reconciles open attempts and turns checkout off.
  - Keys that Razorpay starts rejecting turn the status to Verification failed.
  - Disconnect wipes keys, rotates the webhook URL, keeps history, and makes the old URL return 404.
- **Isolation:**
  - Two merchants each use their own account.
  - Missing configuration fails safely even with platform env keys present.
  - Disabled checkout stops new payments.
  - Merchant B's store link and webhook cannot touch merchant A's payment.
- **Checkout:**
  - A successful payment settles the order.
  - A duplicate callback is a no-op.
  - Forged signatures and wrong attempt tokens are rejected.
  - A payment for a different Razorpay order is rejected.
  - Amount and currency mismatches are refused and leave the order unpaid.
  - A failed payment followed by a retry on the same Razorpay order works.
  - A cancelled checkout stays pending, with no duplicate attempt.
  - A Razorpay timeout when the order is placed can be recovered later.
  - A COD advance settles as a partial payment.
- **Webhooks and reconciliation:**
  - An unknown URL gets 404; an invalid signature gets 400.
  - A webhook before the browser callback settles the order, and repeated events are deduped.
  - A delayed `payment.failed` cannot undo a paid order.
  - Payments PostBus did not create are ignored.
  - A captured payment whose callback and webhook were both lost is recovered by the cron sweep.
  - A Razorpay timeout during a status check is survived.
  - A full refund from the refund webhook marks the order Refunded.

**Lint:** `eslint` is clean on all new and changed files.
**Typecheck:** there are no errors in new or changed files. The repo has about 290 pre-existing errors in unrelated files, mostly tests.
**HTTP smoke test** on the running dev server, read-only:

| Check | Result |
| --- | --- |
| Integration page while signed out | 307 to login |
| Unknown webhook URL | 404 |
| Malformed public payment request | 422 |
| Cron route without its secret | 401 |
| Settings API without a session | 401 |

## 7. Regression results (SaaS billing and the rest)

A targeted run covered `modules/billing`, `modules/razorpay`, `modules/ai-credits`, `modules/addons`, `modules/storefront`, `modules/customer-order-links`, `modules/orders`, `lib/api/v1` and `app/api`. **585 tests passed and 4 failed. None of the 4 are caused by this change:**
- `billing/cron.test.ts`: timed out under parallel load and **passes in isolation**.
- `billing/consume-quota.test.ts` (2 tests): its fixtures hard-code a subscription period that ended 2026-11-01, so the test has expired with the date. No billing file was modified.
- `orders/address.test.ts`: part of another session's uncommitted contact-correction work (`modules/orders/contact-correction.ts`).

The billing webhook, subscription checkout, AI-credit and platform-settings RLS suites all pass. No billing code path was edited.

**Production build** (`POSTBUS_NEXT_DIST_DIR=.next-verify next build`): **compiled successfully in 85 s**. Its type-check step then **failed on 18 errors**, none of them in this feature's files:

| File | Errors | Cause |
| --- | --- | --- |
| `modules/orders/service.ts` | 16 | Another session's uncommitted contact-correction change to `modules/orders/schema.ts` |
| `components/integrations/shopify-dimension-settings.tsx` | 1 | Untracked file from another session (uses `variant="outline"`) |
| `modules/shopify/dimensions.ts` | 1 | Typing mismatch from other in-progress work |

`tsc -p tsconfig.build.json` reports **0 errors in merchant-payment files**. The tree builds once those other changes are finished.

---

## 8. Environment variables

**No new variables.** The feature uses these existing ones:

| Variable | Use |
| --- | --- |
| `INTEGRATION_ENCRYPTION_KEY` | **Required in production.** Encrypts merchant keys. Rotating it makes stored merchant keys unreadable; merchants would have to reconnect. |
| `NEXT_PUBLIC_APP_URL` | Builds the merchant webhook URL. It must be the public HTTPS origin. |
| `CRON_SECRET` | Protects `/api/cron/merchant-payments`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Needed for all merchant payment tables. |

The platform variables `RAZORPAY_*` and `NEXT_PUBLIC_RAZORPAY_KEY_ID` are **not read** by this feature.

---

## 9. Merchant onboarding

1. In Razorpay, choose **Test** or **Live** mode. Under **Account & Settings → API Keys**, generate a key pair.
2. In PostBus, go to **Integrations → Razorpay — Online Payments → Connect Razorpay**. Pick the mode, paste the Key ID and Key Secret, and click **Connect account**. PostBus checks the keys with Razorpay before saving them.
3. Copy the **webhook URL** shown on the page. In Razorpay, go to **Webhooks → Add**, paste the URL, set a secret, and tick `payment.captured`, `payment.failed`, `order.paid`, `payment.authorized` and `refund.processed`.
4. Paste that secret into **Razorpay Webhook Secret** and save. The status becomes **Connected**.
5. Turn on **Online checkout**. The store's checkout now shows **Pay online**.
6. Place a test order with a test card or UPI ID. It shows **Paid** on the order page, with the transaction ID.
7. To go live, switch the mode to Live and enter the `rzp_live_` keys and the Live webhook's secret. Checkout switches off on account change, so turn it back on.

---

## 10. Production deployment requirements

1. **Apply the migration** `20261120090000_merchant_razorpay_payments.sql`, staging first. It only creates new objects.
2. Make sure `INTEGRATION_ENCRYPTION_KEY` and `NEXT_PUBLIC_APP_URL` are set in production.
3. **Schedule** `POST /api/cron/merchant-payments` every 5–10 minutes with `Authorization: Bearer $CRON_SECRET`. Without it, missed callbacks are still recovered when the customer checks status or the merchant clicks **Check status with Razorpay**, but not automatically.
4. Deploy the code. Until the migration is applied:
   - the Razorpay card shows **Not connected**;
   - the setup page says the feature is not available yet;
   - storefronts behave exactly as before (`onlinePayment: false`).
5. After deploying, run the onboarding steps above with Razorpay **Test** keys on a staging merchant before enabling Live for anyone.

### Known limits / follow-ups
- Refunds are made by the merchant in the Razorpay Dashboard. A **full** refund is reflected automatically; partial refunds are not reflected on the order.
- The orders **list** still shows only the order's payment status badge. Full payment details are on the order page.
- Razorpay Partner OAuth is not implemented. It would remove the need for merchants to paste keys, but PostBus partner enrolment comes first.
