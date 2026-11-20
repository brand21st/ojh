# Partner program: automatic RazorpayX payouts, partner emails, partner dashboard redesign

Date: 2026-11-21 · Branch: fix/auth-session-stability · Builds on 544748d (admin dashboard)

## Intent

PostBus partners refer merchants and earn commission on their subscription payments. Payouts are
manual today: an admin transfers money outside the app and types in the bank reference. Partners
get no email and see a plain dashboard. The goal is to finish the partner side:

1. **Automatic payouts through RazorpayX (UPI)**, with safety caps (user's choice).
2. **Emails to partners** at the moments that matter.
3. **A redesigned `/partner/*` dashboard** that makes the balance, the next payout and its status
   obvious.

RazorpayX is already activated on the user's Razorpay account.

## Goals

- Pay partners on a fixed monthly day with no human step when every safety check passes.
- Hold anything risky for one-click admin approval. Approval still sends the money through RazorpayX.
- Confirm "paid" from Razorpay itself (webhook, plus a polling fallback). No UTRs typed by hand.
- Keep the ledger exactly balanced. Every rupee leaving goes through the existing
  RESERVATION → PAYOUT / RELEASE / PAYOUT_RETURN entries.
- Email partners when: the application is received, they're approved / rejected / suspended,
  their first commission clears, a payout is sent, a payout is paid (with UTR), and a payout fails or
  is returned.
- The partner can see: cleared balance, on-hold balance, next payout date and amount, payout
  history with live status and UTR, and their UPI payout account.

## Non-goals

- Bank-account (IMPS/NEFT) payouts. UPI only, as today. The schema leaves room for more later.
- TDS deduction or tax documents (Section 194H). The admin is responsible. Flagged as an open risk below.
- Partner-facing in-app notification centre redesign. Emails plus existing notifications are enough.
- Merchant-run affiliate programs.

## Anti-goals (failure even if it "works")

- Paying a partner twice, or paying money the ledger doesn't show as cleared.
- Any money leaving while `POSTBUS_AFFILIATE_PAYOUTS_ENABLED`, the auto-payout setting, or the
  RazorpayX config is off.
- Marking a payout PAID from anything other than Razorpay's signed webhook or Razorpay's own API
  response.
- Emails that leak another partner's data, or emails sent from production during local testing.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | **Auto with safety caps** *(chosen by user)* | Scheduled payouts go out automatically below a per-partner cap and a daily total cap. A new UPI ID, a risk flag, or going over a cap holds the payout for one-click approval. Hands-off for normal cases; bad cases wait for a person. |
| B | Fully automatic | No human step at all. A bug or fraudulent referral pays real money before anyone looks. |
| C | Admin approves each batch; RazorpayX sends | Safest, but someone has to click every month. |

## Design

### Payout lifecycle

```
REQUESTED ──gate OK──► APPROVED ──RazorpayX create──► PROCESSING ──webhook processed──► PAID (UTR)
    │                     ▲                               │
    └─gate fails─► REVIEW ┘ (admin one-click approve)     ├─failed/rejected/cancelled──► FAILED (RELEASE to balance)
                     └─admin reject──► REJECTED            └─reversed after paid──────────► RETURNED (PAYOUT_RETURN)
```

- **Creation:** the monthly auto run on the payout day (IST) creates one request per eligible partner.
  Partners can also still request a payout themselves. Both go through the same gate.
- **Idempotency:** auto requests use the deterministic key uuid-v5(partner, `YYYY-MM`), so a partner
  gets at most one auto payout per month. The RazorpayX call sends `X-Payout-Idempotency: <request id>`,
  so retries after a crash can't create a second transfer.
- **`send_via`** is fixed on each request when it's created: `RAZORPAYX` if automation is on, otherwise
  `MANUAL`. Admins can't hand-mark a RAZORPAYX payout PAID, and the engine never sends a MANUAL one.
  This rules out double-paying something an admin already transferred by hand.

### Safety gate (SQL `affiliate_payout_gate`)

A payout goes straight to APPROVED only if **all** of these hold. Otherwise it goes to REVIEW with a `hold_reason`:

- the partner is APPROVED, has nothing recoverable, and reconciliation is clean (existing checks)
- amount ≤ `auto_payout_max_paise` (per partner, default ₹10,000)
- today's RazorpayX total (PROCESSING + PAID) + amount ≤ `auto_payout_daily_cap_paise` (default ₹50,000)
- the payout UPI account was added more than `new_account_hold_hours` ago (default 72h)
- no `risk.identity_overlap` audit flag on the partner
- this isn't the partner's first-ever payout (first payout always held: a person sees each new
  partner once)

### Database (one additive migration `20261121090000_affiliate_auto_payouts.sql`)

- `affiliate_settings` gains: `auto_payout_enabled` (default **false**), `auto_payout_day` (1–28,
  default 5), `auto_payout_max_paise`, `auto_payout_daily_cap_paise`, `new_account_hold_hours`.
  The `settings` admin action is extended to save them.
- `affiliate_payout_requests` gains: `origin` (PARTNER|AUTO), `send_via` (MANUAL|RAZORPAYX),
  `hold_reason`, `provider_payout_id` (unique), `provider_status`, `utr`, `failure_reason`, `sent_at`.
  The status check adds `PROCESSING` and `FAILED`.
- New `affiliate_razorpay_accounts(account_id pk → affiliate_payout_accounts, contact_id, fund_account_id)`.
  Payout accounts are immutable by trigger, so the RazorpayX IDs live beside them.
- New `affiliate_email_outbox(id, affiliate_id, kind, payload, idempotency_key unique, status,
  attempts, next_attempt_at, sent_at, last_error)`.
- New functions (service_role only, all audited):
  `affiliate_payout_gate`, `affiliate_auto_request_payouts(p_month)`, `affiliate_mark_processing`,
  `affiliate_provider_settle(p_id, p_event, p_provider_id, p_utr, p_reason)`, and
  `affiliate_claim_emails`.
- `affiliate_settle_payout` is replaced so that it refuses manual PAID on RAZORPAYX payouts, and so
  that admin APPROVED on a REVIEW payout queues it for sending.
- An **audit-log trigger** enqueues emails. Every lifecycle event already writes an audit row, so one
  trigger maps `action` → email kind. Nothing is missed and no call sites change.

### Server code

- `modules/affiliates/razorpayx.ts`: a small client for contacts, `vpa` fund accounts, payouts and
  fetching a payout. It uses `RAZORPAYX_KEY_ID/SECRET` (falling back to the platform Razorpay keys) and
  `RAZORPAYX_ACCOUNT_NUMBER`. The secret is never logged.
- `modules/affiliates/payout-engine.ts`: `runPayoutEngine(db)`. Steps: (1) on/after the payout day,
  create the month's auto requests; (2) send APPROVED RAZORPAYX requests, creating the contact and fund
  account the first time; (3) poll PROCESSING payouts older than 30 min. This is bounded per run and
  serialized by a row lease.
- `app/api/webhooks/razorpayx/route.ts`: verifies `x-razorpay-signature` with
  `RAZORPAYX_WEBHOOK_SECRET` and maps `payout.processed|failed|rejected|reversed|updated` to
  `affiliate_provider_settle`.
- `modules/affiliates/emails.ts`: sends from the outbox through the existing nodemailer setup. It uses
  `AFFILIATE_SMTP_*` and falls back to `MANIFEST_SMTP_*`, with branded HTML and text templates.
  Status emails respect the partner's `notify` choice; money emails always send. It's gated by
  `AFFILIATE_EMAIL_ENABLED`, and staging refuses to send unless `AFFILIATE_EMAIL_TEST_RECIPIENT`
  redirects every message.
- The existing billing cron calls the engine and the email sender in their own try blocks, like the
  affiliate sweep today.
- The `/api/partner/*` API gains `payouts/overview` (balance, next payout date and estimate,
  gate rules in plain words) and returns UTR/status on payout rows.

### Partner UI (`/partner/*`)

Visual direction comes from the ui-ux-pro-max design system for a fintech/SaaS partner dashboard,
mapped onto the app's existing tokens (brand rose, `ink`, `muted`, `card`, `border`) so it matches
the merchant dashboard.

- **Shell:** clear left nav (Overview, Links, Referrals, Earnings, Payouts, Profile, Help) with a
  mobile bottom sheet. Pending/rejected states get a full-page status card instead of empty pages.
- **Overview:** an earnings hero (cleared balance, on hold, lifetime paid), a "Next payout: 5 Dec ·
  ≈ ₹4,250 to UPI ••••3210" card with a progress bar toward the minimum, a performance chart
  (clicks → signups → paid), a top-links list and a recent-activity feed.
- **Payouts:** UPI account setup/change (with the "new accounts are held 72h" rule shown), a timeline of
  payouts with status chips (Scheduled, Processing, Paid + UTR copy button, Failed + reason, On
  hold), and plain-language payout rules.
- **Earnings** (renamed from commissions): status chips and a release date for on-hold earnings.
- **Links/Referrals/Profile:** restyled. The profile gains an email-preferences toggle.
- Accessibility: 44px targets, visible focus, labelled controls, no colour-only status, reduced motion.

### Admin dashboard additions

- Program settings: an "Automatic payouts" section (on/off, day, per-partner cap, daily cap, new
  account hold).
- Payouts tab: PROCESSING/FAILED filters, hold reason, "Approve & send" for RAZORPAYX holds, UTR shown.
- Health tab: email outbox failures.

## Configuration (new env)

```
POSTBUS_AFFILIATE_PAYOUTS_ENABLED=true      # existing master switch
RAZORPAYX_ACCOUNT_NUMBER=                    # RazorpayX current account number
RAZORPAYX_KEY_ID= / RAZORPAYX_KEY_SECRET=    # optional; default to RAZORPAY_KEY_*
RAZORPAYX_WEBHOOK_SECRET=                    # webhook at /api/webhooks/razorpayx
AFFILIATE_EMAIL_ENABLED=true
AFFILIATE_SMTP_* (optional, falls back to MANIFEST_SMTP_*)
AFFILIATE_EMAIL_TEST_RECIPIENT=              # staging: all mail goes here
```

Then the admin turns on **Automatic payouts** in Program settings. It starts off.

## Verification

- PGlite `*.pg.test.ts` for the migration: the gate, idempotent monthly creation, provider settle
  transitions, ledger balance after each path, refusing manual PAID on RAZORPAYX, and email enqueue.
- Unit tests: the RazorpayX client (mocked fetch, idempotency header), webhook signature and mapping, the
  engine's step ordering and its env/flag gating, email templates and recipient redirect.
- happy-dom render tests for the partner overview and payouts pages.
- No browser run with real data until Docker/local Supabase is available. **Nothing is applied to
  production and no real payout is attempted by me.** The user applies the migration and runs a
  ₹1 test payout themselves.

## Open risks / left to the builder

- **TDS (194H):** commissions above ₹15,000/yr may need tax deducted at source. Not handled. The admin
  must review before going live at scale.
- The RazorpayX account must have enough balance. A low balance makes the payout fail, which shows as
  FAILED with the money back in the partner's balance and an email sent.
- Builder's calls: exact email copy, chart library (reuse whatever the portal uses today), the
  30-minute poll interval, and the lease length.
