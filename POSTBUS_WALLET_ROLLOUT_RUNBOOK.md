# PostBus Wallet: Rollout and Cutover Runbook

Branch `feat/tenant-wallet` (worktree `D:\postbus-wallet`), cut from `db76c90`. Nothing in this branch has been applied to any database or deployed. Each stage below can be stopped or rolled back on its own. Follow them in order, **on staging first**, and move to production only after the staging checks pass.

> `.env.local` in the main checkout points at **production** Supabase. Run migrations and data-changing checks only against staging (`.env.staging.local`) until Stage 5.

---

## 0. What ships

| # | Migration | Effect when applied |
|---|---|---|
| 1 | `20261121120000_tenant_wallet.sql` | Wallet tables and functions. Creates an **empty** wallet for every existing tenant. Charges nothing. |
| 2 | `20261121140000_wallet_recharge.sql` | Recharge orders with GST split; dashboard read models |
| 3 | `20261121160000_wallet_recharge_invoices.sql` | Recharge tax invoices (shares the subscription invoice number series) |
| 4 | `20261121180000_wallet_ai_usage.sql` | AI usage records; seeds AI prices at ₹0.20 per credit. AI stays on credits until each tenant is moved. |
| 5 | `20261121200000_wallet_whatsapp_usage.sql` | WhatsApp usage records; billing **off** (`wallet_whatsapp_billing_enabled = false`) |
| 6 | `20261121220000_wallet_admin.sql` | Super Admin read models and actions |
| 7 | `20261121230000_wallet_alerts.sql` | Alert claiming and per-wallet alert levels |

**Prerequisites:** the existing migrations up to `20261121090000` (in particular `20261017140000_subscription_tax_invoices`, `20261027150000_organization_billing_profiles`, `20261019120000_paid_addons_ai_accountant`, the AI credit migrations and `20261004210000_vachat_notification_logs`). Production has previously been missing some billing tables (PGRST205). **Check before Stage 1:**

```sql
select to_regclass('public.subscription_invoice_settings'), to_regclass('public.organization_billing_profiles'),
       to_regclass('public.billing_audit_logs'), to_regclass('public.ai_credit_ledger'), to_regclass('public.vachat_notification_logs');
```

Every value must be non-null.

**Environment variables**

| Variable | Needed for | Notes |
|---|---|---|
| `WALLET_ENABLED=true` | Stage 2 onward | Shows the Wallet page, sidebar item and API. Off: everything behaves exactly as today. |
| `CRON_SECRET` | Stage 2 | Already used by other cron routes |
| `ADMIN_ACCOUNT_ACTION_PIN` | Stage 2 | **Must be set.** Without it the code falls back to a PIN written in the source. |
| `WALLET_EMAIL_ENABLED=true`, `WALLET_SMTP_*` (or the existing `MANIFEST_SMTP_*`), `WALLET_SMTP_FROM_NAME` | Stage 6 | Outside production, email only goes to `WALLET_EMAIL_TEST_RECIPIENT` |

---

## 1. Apply migrations (inert)

1. Back up the database (see the existing backup runbook).
2. Apply migrations 1–7 in order.
3. Verify:
   ```sql
   select count(*) = (select count(*) from organizations) from wallets;       -- every tenant has a wallet
   select sum(balance_micros) from wallets;                                    -- 0
   select wallet_reconcile(null);                                              -- 0
   select wallet_whatsapp_billing_on();                                        -- false
   ```
4. **Expected effect: none.** `WALLET_ENABLED` is still off. AI keeps using credits, and WhatsApp isn't billed.

**Rollback:** nothing reads the new tables while the flag is off, so leave them. To remove them anyway, drop the wallet tables and functions. No existing table changed shape apart from added columns (`platform_settings.wallet_*`, `vachat_notification_logs.wallet_hold_payload`) and the widened `payments_payment_purpose_check`.

## 2. Recharges on (staging, then production)

1. In Super Admin → System Settings (existing tax-invoice settings), fill in the **supplier legal name, address and GSTIN**. Recharge invoices wait until these exist.
2. In Super Admin → Wallet Management → Settings, check the recharge limits, presets, GST rate (18%) and place of supply. Ask your accountant for the **SAC code** and set it.
3. In the Razorpay dashboard (platform account), make sure the webhook sends **`payment.captured`, `payment.failed`, `order.paid` and `refund.processed`**. The existing endpoint `/api/webhooks/razorpay` already routes wallet orders.
4. Schedule `POST /api/cron/wallet` **every 5 minutes**, with header `Authorization: Bearer $CRON_SECRET` (or `x-cron-secret`). It frees expired holds, recovers missed recharges, reconciles balances, issues waiting invoices, resends held WhatsApp notices and sends alerts. The billing cron is known not to run in production, so this needs its own schedule.
5. Set `WALLET_ENABLED=true` and deploy.
6. **Staging checks** (Razorpay test mode, test card or UPI):
   - [ ] Wallet page and sidebar item show. Recharge ₹100 → ₹84.75 credited, GST ₹15.25 shown.
   - [ ] Close the Razorpay window after paying (simulates a lost callback). The balance appears within 5 minutes via webhook or cron.
   - [ ] Send the same webhook twice: one credit only (`select count(*) from wallet_ledger where entry_type='RECHARGE'`).
   - [ ] Failed payment shows "Failed", no credit.
   - [ ] Invoice PDF downloads from Recharges and the number continues the subscription series.
   - [ ] Super Admin refund of ₹50 → Razorpay refund → wallet reduced by the net share after `refund.processed`.
   - [ ] Super Admin promo credit, manual debit, freeze/unfreeze, each in `billing_audit_logs`.
   - [ ] `select wallet_reconcile(null)` → 0.

**Rollback:** set `WALLET_ENABLED=false` and redeploy. Recharged balances stay in the ledger and are not lost. Hiding the page doesn't refund anyone, so decide refunds separately.

## 3. AI billing: pilot tenant, then everyone

1. Super Admin → Wallet Management → open a pilot tenant → Controls → **Move AI credits to wallet**. Their credits convert at ₹0.20 each (500 credits → ₹100), and their AI features now charge the wallet at the seeded prices.
2. **Checks:**
   - [ ] WhatsApp paste, product copy, address validation, Image Studio still work. Each charge shows in the wallet with feature, model and tokens (`ai_usage_records`).
   - [ ] With a near-empty wallet, AI is refused with a recharge message, and shipping keeps working.
   - [ ] The old credit pack checkout is refused for this tenant.
3. Then Checks → **Move up to 500 tenants**. Repeat until "pending" is 0. Tenants with an Image Studio job in flight are skipped until it finishes.
4. Settings → turn on **Welcome credit for new tenants** (₹100). New sign-ups then get ₹100 wallet credit instead of 500 AI credits.

**Rollback:** not reversible per tenant once moved. If AI billing misbehaves, set `WALLET_ENABLED=false`. Wallet functions are then skipped and the AI-credit code runs again, but moved tenants have 0 legacy credits, so grant them credits through the existing AI credit admin if needed.

## 4. WhatsApp billing

1. Get the current **Meta per-message rates for India** (Utility, Marketing, Authentication) and VaChat's per-message fee, if any.
2. Pricing → add a rate per category, country IN, plus the PostBus markup. Service stays ₹0. Optionally add free monthly messages.
3. **Ask VaChat** whether status webhooks forward Meta's `pricing` block (`billable`, `category`). Without it, every notice is priced as UTILITY and non-billable messages can't be detected.
4. Settings → **Charge WhatsApp notices to wallets** → on. It's refused until a Utility rate exists.
5. **Checks:**
   - [ ] A booked notice holds the rate, then is charged on `delivered`.
   - [ ] A failed send releases the hold.
   - [ ] With a low wallet, the notice isn't sent and shows as `held_balance` in Super Admin VaChat logs. After a recharge, it goes out if it's under 24 hours old.
   - [ ] Merchants on their own WATI or VaChat are never charged.

**Rollback:** turn the switch off. Holds already taken are released by the cron when they expire (72 hours), or charged if delivered.

## 5. Production

Repeat stages 1–4 on production, one stage per day. Watch for these log events: `wallet.reconcile_mismatch`, `wallet.recharge_amount_mismatch`, `wallet.webhook_*`, `wallet.whatsapp_unpriced`, `wallet.ai_charge_refused`, `wallet.frozen_after_refund`. The Checks tab should show 0 open mismatches every day.

## 6. Email alerts

Set `WALLET_EMAIL_ENABLED=true` and the SMTP variables. Owners then get an email when their balance crosses an alert level. In-app alerts work from Stage 2 without email.

---

## Open questions for your accountant

- **GST timing:** this build taxes a recharge when it's bought (advance received). Some treat prepaid wallet balances as taxable when used.
- **Refunds:** a refund doesn't issue a **GST credit note** yet. The invoice stays as issued and the refunded amount is printed on it.
- **Invoices:** recharge invoice PDFs are unsigned (GST Rule 46 asks for a signature or digital signature). The SAC code is blank until set.
- **AI Accountant:** it books recharges as "platform fees". Strictly, an unspent wallet balance is a prepaid asset.

## Known limits

- Quick AI calls check affordability before the model call and charge after it. Two simultaneous calls on a nearly empty wallet can both run; the second charge is refused and logged.
- AI screens still say "AI credits". For wallet tenants the number shown is the balance ÷ ₹0.20.
- Auto-recharge (Razorpay mandates) isn't built. It needs explicit tenant consent and a separate phase.
- There's no end-to-end Razorpay test-mode run yet: there was no staging database (Docker isn't installed). Stage 2's checklist is that test.
