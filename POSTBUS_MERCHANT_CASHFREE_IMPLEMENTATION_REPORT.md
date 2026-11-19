# PostBus — Merchant Cashfree Payment Gateway: Implementation Report

**Date:** 2026-11-19
**Branch:** `fix/auth-session-stability` (uncommitted)
**Status:** Code complete and tested locally against mocked Cashfree accounts. **Migration not applied anywhere. Not deployed. No real Cashfree sandbox transaction was run** (no Cashfree credentials were available).

---

## 1. Codebase audit findings

| Area | Finding |
| --- | --- |
| Merchant payment infrastructure | A merchant Razorpay layer already existed (commit `d0d7f0f`, `modules/merchant-payments/*`). It provides per-org encrypted credentials, one payment attempt per order, a state-machine RPC, a per-merchant webhook token, a reconcile cron, and a static test that keeps it isolated from SaaS billing. **This is extended. No second checkout system was built.** |
| Its migration | `20261120090000_merchant_razorpay_payments.sql` is **not applied anywhere**. The Cashfree migration builds on it, so both must be applied together, in order. |
| SaaS billing (Domain A) | `modules/billing`, `modules/razorpay/{config,client,admin-settings}`, `/api/webhooks/razorpay`, `/api/cron/billing`, plus the `payments`, `subscriptions` and `platform_settings` tables. **None of it was modified** (`git status` shows them clean). |
| Mini Store checkout | `submitPublicCustomerOrderLink` prices the cart on the server, then creates an `IMPORTED/PENDING` order. Online payment is attached afterwards with a per-order bearer token. Storefront orders never auto-book India Post. |
| Tenant resolution | Dashboard: the org comes from the session `TenantContext`. Public: the org comes from the store link, never from the request body. |
| Permissions | Every `integrations/*` route except the listed read-only GETs requires `integrations.manage` (`lib/api/v1-permissions.ts`). The new routes inherit this. |
| Encryption | AES-256-GCM via `lib/security/crypto.ts` with `INTEGRATION_ENCRYPTION_KEY`. |
| Webhooks | Raw-body Next route handlers. No middleware rewrites `/api/webhooks/*`. |

### Cashfree API facts verified against current docs (2026-11-19)
- `x-api-version: 2026-01-01` is the documented default. Base URLs: `https://sandbox.cashfree.com/pg` and `https://api.cashfree.com/pg`.
- `POST /orders`:
  - `order_id`: 3–45 characters of `[A-Za-z0-9_-]`.
  - `order_amount`: in **rupees**, with up to 2 decimals.
  - `customer_details.customer_id` and `customer_phone` (10 digits) are required.
  - `order_meta.notify_url` and `return_url` are each limited to 250 characters.
  - Idempotency header: **`x-idempotency-key`** (UUID).
- `GET /orders/{id}` and `GET /orders/{id}/payments`. Payment statuses: `SUCCESS`, `NOT_ATTEMPTED`, `FAILED`, `USER_DROPPED`, `VOID`, `CANCELLED`, `PENDING`.
- Webhook signature: `Base64(HMAC-SHA256(x-webhook-timestamp + rawBody, client_secret))`.
  - The dedupe header is **`x-idempotency-key`** (the brief said `x-idempotency-header`; the docs use `-key`). It is sent on webhook versions 2025-01-01 and later.
- Events: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`.
- A per-order `notify_url` receives webhooks without any dashboard configuration.
- JS SDK: `https://sdk.cashfree.com/js/v3/cashfree.js`, called as `Cashfree({mode}).checkout({paymentSessionId, redirectTarget: "_modal"})`.

## 2. Final architecture

```
PostBus SaaS billing   → PostBus's own Razorpay account      (unchanged)
Merchant storefront    → merchant's OWN Razorpay  OR  Cashfree account
                         chosen by merchant_payment_settings.default_provider
```

- **`modules/merchant-payments/gateway.ts`** decides which gateway new checkouts use:
  - The merchant's explicit default always wins.
  - If the default gateway is unavailable, online payment turns off. **There is no silent switch** to the other gateway.
  - With no default set, the single enabled gateway is used, so existing Razorpay-only merchants keep working.
  - Enabling the first gateway makes it the default.
- **`modules/merchant-payments/checkout.ts`** routes every public and dashboard payment call to the gateway that created the attempt. An order that is mid-payment is never moved to another account.
- **`modules/merchant-payments/cashfree/*`** holds the client, credentials, integration, payments and webhook code.
- **Trust model:** the browser sends only `orderId` and the attempt token. The amount comes from the server-priced order. **Status comes only from Cashfree's Get Order and Get Payments APIs**, called with the merchant's own keys. The checkout promise, return URL and webhook body are only triggers to re-check; none of them is proof of payment.

## 3. UI changes
- `/dashboard/integrations` has a new **Cashfree Payments** card. It shows Not connected, Test mode, Live mode, Connection error, or Disabled, and its button reads **Connect Cashfree** or **Manage Integration**.
- `/dashboard/integrations/cashfree` (new page):
  - **Connection:** Environment (Sandbox/Production), Client ID, Client Secret; Connect, Verify connection, Update credentials / switch environment, Disconnect (with confirmation).
  - **Status details:** environment, masked Client ID, credential check result, last successful check, last webhook received.
  - **Controls:** Enable/Disable payments, and the **Default online payment gateway** selector.
  - **Help:** setup instructions, troubleshooting, and the notification URL.
- The same default-gateway selector was added to the Razorpay page.
- **Storefront:**
  - Checkout reads "secured by Cashfree" when Cashfree is the active gateway.
  - Payment opens in Cashfree's popup (`_modal`).
- If the browser blocks Cashfree's page (for example a stale tab, an extension, or a network filter), PostBus detects the CSP violation, removes the blank Cashfree modal, and shows "Reload and pay". The receipt is restored after the reload.
  - If an in-app browser redirects instead, the receipt is kept in `sessionStorage` (token only, no gateway session) and re-verified when the customer returns.
- The order page payment card shows the gateway, the Cashfree order ID, `cf_payment_id`, and "Check status with Cashfree".
- The layouts reuse the existing responsive grids from the Razorpay page. **They were not checked visually in a browser** (see §11).

## 4. Database migration — `supabase/migrations/20261120100000_merchant_cashfree_payments.sql`
Additive only, and it can be run more than once (tested by applying it twice). **It must be applied after `20261120090000`.**

- `merchant_payment_integrations`:
  - Provider may now be `RAZORPAY` or `CASHFREE`.
  - The "enabled needs a webhook secret" rule applies to Razorpay only.
  - New column `last_webhook_at`.
  - Cashfree's Client ID and Secret reuse the encrypted key columns.
- New table `merchant_payment_settings (organization_id PK, default_provider)`. Service role only.
- `merchant_storefront_payments`:
  - `razorpay_order_id` may now be null.
  - New columns: `cashfree_order_id` (unique per org), `cashfree_cf_order_id`, `cashfree_payment_id`.
  - A CHECK requires each provider's own order ID.
  - New statuses `PROCESSING` and `CANCELLED`.
  - `unique(order_id)` is kept: one attempt per order, and Cashfree allows retries on the same Cashfree order.
- `merchant_payment_webhook_events`: new columns `provider`, `provider_order_id`, `provider_payment_id` and `payload_hash`. No customer payload is stored.
- New RPC `apply_merchant_cashfree_payment(...)`, `security definer`, executable by `service_role` only:
  - Locks the rows and checks amount and currency against the stored attempt.
  - Idempotent.
  - A late failed or dropped event cannot undo PAID. A second success is flagged for refund.
  - Settles `IMPORTED/PENDING` → `READY/PAID`, or `PARTIAL` for a COD advance.
- **`apply_merchant_storefront_payment` (Razorpay) is not redefined.**

## 5. API

| Method | Path | Auth |
| --- | --- | --- |
| GET / PUT / PATCH / DELETE | `/api/v1/integrations/cashfree` | Session + `integrations.manage`; rate-limited |
| POST | `/api/v1/integrations/cashfree/verify` | Same |
| GET / PUT | `/api/v1/integrations/payment-gateway` `{defaultProvider}` | Same |
| GET / POST | `/api/v1/orders/:id/online-payment[/reconcile]` | Now routes by gateway |
| POST | `/api/v1/public/store/payment` | Public. New `verify` action (Cashfree). `resume` accepts `returnUrl` |
| POST | `/api/webhooks/merchant/cashfree/:token` | Signature checked with that merchant's Client Secret |
| POST | `/api/cron/merchant-payments` | `CRON_SECRET`. Sweeps both gateways |

The order submit route also accepts an optional `returnUrl`. The server cleans it: only https URLs (http only for localhost), with the query, fragment and any user info removed, at most 250 characters.

## 6. Cashfree checkout details
- Cashfree `order_id` = `pb_<order uuid hex>`. The idempotency key is a stable UUID derived from the org and order.
- **Lost create response:** if the first create succeeded at Cashfree but PostBus never got the reply, the retry gets 409. PostBus then reads that order and adopts it only if the amount, currency and `postbus_order_id` tag all match.
- **Amounts:** paise are converted to rupees only when building the Cashfree request (`paiseToCashfreeAmount`), and Cashfree amounts are converted back to paise (`cashfreeAmountToPaise`). Everything stored stays in integer paise.
- **Customer details:** a hashed `customer_id`, a 10-digit phone, and the name only when it has at least 3 characters.
- **Resume:** asks Cashfree for the order and gets a fresh `payment_session_id`. If the order is PAID it reconciles instead. If it is expired or terminated it shows a clear message.

## 7. Webhooks
- The `:token` (48 hex characters) selects exactly one Cashfree integration; a Razorpay token returns 404.
- The signature is checked over the raw bytes with a constant-time comparison. A missing timestamp is rejected.
- Dedupe uses `x-idempotency-key`, falling back to a hash of the signed bytes. Events are claimed with a lease and retried after failure.
- The handler then **re-reads payment status from Cashfree** and applies the result. This makes delayed, out-of-order and replayed events safe.
- Payments on the merchant's Cashfree account that PostBus did not create are ignored.
- `last_webhook_at` is how the dashboard shows "webhooks working".
- There is no timestamp-age window. Cashfree retries for up to about 30 minutes, the status is always re-fetched, and events are deduped, so a replay cannot change state.

## 8. Gateway selection
Covered in §2. Disabling or disconnecting the default gateway stops new online checkouts and shows a notice. Attempts already open still reconcile with the keys that created them. Cash on delivery is unchanged.

## 9. Security verification
- **Credentials:**
  - Encrypted at rest.
  - The integrations table is not readable from browsers.
  - API responses show only masked hints. Tests check that no secret appears in API responses, the database, the audit log or the checkout session.
  - Logs carry only method, mode and a redacted path. Gateway error messages that look like key material are dropped.
- **Isolation:**
  - The org always comes from the tenant context or the store link.
  - Every query filters by `organization_id`.
  - Attempts verify only with the integration whose fingerprint matches; the fingerprint covers both Client ID and environment.
  - `isolation.test.ts` now also covers the Cashfree route and forbids any `process.env.CASHFREE*` platform fallback.
- **Rotation:** replacing credentials reconciles open attempts with the old keys first. Checkout then turns off when the account or environment changed. Disconnect wipes the keys and rotates the webhook URL. History is kept.
- **CSP:**
  - Added `https://sdk.cashfree.com` to script-src, and `https://*.cashfree.com` to frame-src and connect-src.
  - Added `https://sandbox.cashfree.com` and `https://api.cashfree.com` to **form-action**. The SDK opens Hosted Checkout by POSTing the payment session to `/pg/view/sessions/checkout`. Without this, the checkout modal stayed blank: this was the reported bug, fixed 2026-11-19 and checked in the browser with a real Sandbox session.

## 10. Automated test results (executed)

| Suite | Result |
| --- | --- |
| `modules/merchant-payments/cashfree/cashfree.pg.test.ts` (service + real SQL on PGlite + fake Cashfree accounts) | **35/35 pass** |
| `modules/merchant-payments/cashfree/client.test.ts` (HTTP shape, environments, money, signature, helpers) | pass |
| `modules/merchant-payments/cashfree/migration.pg.test.ts` (constraints, RPC, grants, Razorpay untouched) | pass |
| Existing Razorpay suites, now run against both migrations | **41/41 pass** |
| **All merchant payments** | **93/93 pass** |
| Regression run: merchant-payments, billing, razorpay, ai-credits, addons, storefront, customer-order-links, lib/security, lib/api/v1, app/api | **427 passed, 2 failed** |

The 2 failures are `billing/consume-quota.test.ts`. The fixtures hard-code a subscription period ending 2026-11-01, so the code correctly throws "subscription is not active". No billing file was changed. This failure is already noted in the Razorpay report.

Scenarios covered:
- **Credentials:** valid and invalid credentials; Sandbox/Production mix-up, both detected by probing and by the secret marker; account not activated (403); timeout; credential replacement; revoked credentials; disconnect.
- **Isolation:** two merchants on separate accounts; no platform fallback even with env keys set; cross-tenant buyer and webhook rejected; a Razorpay token on the Cashfree route returns 404.
- **Gateway selection:** default routing; no silent switch; an unusable gateway cannot be chosen as default.
- **Checkout:** amount sent in rupees; paid only after Cashfree agrees; duplicate verify is a no-op and notifies once; wrong token rejected; fail-then-retry; dropped (cancelled); pending → processing → swept to paid; amount and currency mismatch; tampered Cashfree order amount; lost create response adopted; Cashfree down when the order was placed, then resumed; COD advance; double payment flagged; disabled gateway still verifies an in-flight payment.
- **Webhooks:** invalid signature; missing timestamp; raw body vs re-serialised JSON; webhook before redirect; duplicate idempotency key; late failure or drop after PAID; a lying webhook body; foreign orders and events ignored; Cashfree unreachable → 500, then a successful retry.

**Lint:** `eslint` is clean on all new and changed files.
**Typecheck:** 0 errors in new or changed files. The repo has about 185 unrelated errors from earlier work.

## 11. Production build verification
See the build result appended at the end of this report.

**Not verified:**
- No browser check of the new pages. The local dev server uses the production database, which lacks these tables, so the pages would only show "not available yet".
- No real Cashfree Sandbox transaction (UPI or card). These need merchant Sandbox credentials.

## 12. Deployment requirements
1. Apply **both** migrations, in order and on staging first: `20261120090000_merchant_razorpay_payments.sql`, then `20261120100000_merchant_cashfree_payments.sql`.
2. Check the environment:
   - `INTEGRATION_ENCRYPTION_KEY` must be set.
   - `NEXT_PUBLIC_APP_URL` must be the public **HTTPS** origin, because Cashfree requires an https `notify_url`.
   - `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` must be set.
   - **No new environment variables.**
3. Schedule `POST /api/cron/merchant-payments` every 5–10 minutes with `Authorization: Bearer $CRON_SECRET`.
4. Deploy. The CSP change ships with the code.
5. Run a Sandbox end-to-end test before enabling Production for any merchant: UPI success, card success, failure, closed popup, and the webhook arriving.

**External requirements (merchant side):**
- A Cashfree Payment Gateway account. Production keys need completed KYC and PG activation.
- Production may need the store domain whitelisted under Developers → Whitelisting.
- Each merchant must enable the payment methods they want in Cashfree.

## 13. Merchant onboarding guide
1. In the Cashfree Merchant Dashboard, go to **Payment Gateway**. Choose Sandbox or Production, then open **Developers → API Keys** and copy the Client ID (App ID) and Client Secret.
2. In PostBus, go to **Integrations → Cashfree Payments → Connect Cashfree**. Pick the same environment, paste both values, and click **Connect account**. PostBus verifies them with Cashfree before saving.
3. Turn on **Payments enabled**. If Razorpay is also connected, choose the **Default online payment gateway**.
4. No webhook setup is needed: PostBus sends its notification URL with every order. Adding the URL in Cashfree → Developers → Webhooks is optional.
5. Place a Sandbox test order. It shows as **Paid** on the order page with the Cashfree payment ID. "Last webhook received" then fills in.
6. To go live, click **Update credentials / switch environment**, select Production, and paste the Production keys. Payments switch off when the account changes; turn them back on.

## 14. Final regression report
- SaaS billing, the platform Razorpay code, Shopify, India Post, and order creation: **no code changed**.
- Merchant Razorpay:
  - Code changed only to add a provider filter on the integration lookups and the sweep, and to export two helpers.
  - The Razorpay test suite passes 41/41 against the extended schema.
  - Fixed an existing bug: the Pay button stayed in the loading state when resume returned no session.
- Storefront order creation: the submit path now goes through the gateway router, and its suites pass.

### Known limits / follow-ups
- Refunds are not reflected automatically for Cashfree; refund webhooks are not handled. Merchants refund in the Cashfree Dashboard, and the order needs manual updating.
- If a Cashfree order expires (Cashfree's default expiry), resume shows "contact the store". PostBus does not create a replacement order.
- `components/storefront/checkout-form.tsx` is still untracked from another session's refactor; this change adds one prop to it.

---

## Build result (`POSTBUS_NEXT_DIST_DIR=.next-verify next build`, 2026-11-19)

**The production build failed.**

- Turbopack **compiled successfully in 3.5 min**.
- The type-check step then failed, so there is **no deployable build**.
- None of the failing files belong to this feature. They come from other uncommitted work in the tree:
  - `modules/orders/service.ts`
  - `modules/shopify/orders.ts`
  - `modules/shopify/dimensions.ts`
  - `modules/shipments/order-box.ts`
  - `modules/autopack/decide.ts`
  - `components/integrations/shopify-dimension-settings.tsx`
- There are **0 errors in any Cashfree or merchant-payment file**.

A clean build needs those other changes finished or set aside first.
