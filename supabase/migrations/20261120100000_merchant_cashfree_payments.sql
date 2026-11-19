-- Merchant storefront payments (Domain B): Cashfree Payment Gateway + default gateway selection.
--
-- Extends 20261120090000_merchant_razorpay_payments.sql. Each merchant may connect their OWN
-- Razorpay and/or Cashfree account and choose which one takes storefront online payments. This
-- never reads or writes PostBus SaaS billing tables (platform_settings, payments, subscriptions,
-- razorpay_webhook_events). Only additive changes: nothing is dropped except CHECK constraints that
-- are re-created wider, and the Razorpay RPC apply_merchant_storefront_payment is left untouched.
--
-- Cashfree specifics:
--   * Credentials are the PG Client ID (App ID) and Client Secret, stored in the existing
--     encrypted_key_id / encrypted_key_secret columns. Cashfree signs webhooks with the Client
--     Secret, so there is no separate webhook secret.
--   * payment_mode TEST = Cashfree Sandbox, LIVE = Cashfree Production.
--   * Amounts stay in integer paise here; the app converts to rupees only for the Cashfree API.

-- Integrations -----------------------------------------------------------------------------------

alter table public.merchant_payment_integrations
  drop constraint if exists merchant_payment_integrations_provider_check;
alter table public.merchant_payment_integrations
  add constraint merchant_payment_integrations_provider_check check (provider in ('RAZORPAY', 'CASHFREE'));

alter table public.merchant_payment_integrations
  drop constraint if exists merchant_payment_integrations_enabled_requires_connection;
alter table public.merchant_payment_integrations
  add constraint merchant_payment_integrations_enabled_requires_connection
    check (not enabled or (connection_status = 'CONNECTED' and encrypted_key_id is not null
      and encrypted_key_secret is not null
      and (provider = 'CASHFREE' or encrypted_webhook_secret is not null)));

-- Last time a correctly signed webhook arrived. Lets the dashboard show that webhooks work.
alter table public.merchant_payment_integrations add column if not exists last_webhook_at timestamptz;

-- Default gateway --------------------------------------------------------------------------------
-- One row per organization. NULL default_provider means "not chosen yet": checkout then uses the
-- only enabled gateway, and refuses when two are enabled without a choice. PostBus never switches
-- gateways on its own when the chosen one becomes unavailable.

create table if not exists public.merchant_payment_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  default_provider text check (default_provider is null or default_provider in ('RAZORPAY', 'CASHFREE')),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_merchant_payment_settings_updated_at on public.merchant_payment_settings;
create trigger set_merchant_payment_settings_updated_at
  before update on public.merchant_payment_settings
  for each row execute function public.set_updated_at();

alter table public.merchant_payment_settings enable row level security;
revoke all on public.merchant_payment_settings from public, anon, authenticated;
grant all on public.merchant_payment_settings to service_role;

-- Payment attempts -------------------------------------------------------------------------------

alter table public.merchant_storefront_payments
  drop constraint if exists merchant_storefront_payments_provider_check;
alter table public.merchant_storefront_payments
  add constraint merchant_storefront_payments_provider_check check (provider in ('RAZORPAY', 'CASHFREE'));

alter table public.merchant_storefront_payments alter column razorpay_order_id drop not null;

-- Our order_id sent to Cashfree (unique per merchant account), Cashfree's own order id, and the
-- cf_payment_id of the attempt that decided the current state.
alter table public.merchant_storefront_payments add column if not exists cashfree_order_id text;
alter table public.merchant_storefront_payments add column if not exists cashfree_cf_order_id text;
alter table public.merchant_storefront_payments add column if not exists cashfree_payment_id text;

create unique index if not exists merchant_storefront_payments_cashfree_order_uidx
  on public.merchant_storefront_payments (organization_id, cashfree_order_id)
  where cashfree_order_id is not null;
create unique index if not exists merchant_storefront_payments_cashfree_payment_uidx
  on public.merchant_storefront_payments (organization_id, cashfree_payment_id)
  where cashfree_payment_id is not null and payment_status in ('PAID', 'REFUNDED');

alter table public.merchant_storefront_payments
  drop constraint if exists merchant_storefront_payments_provider_ids_check;
alter table public.merchant_storefront_payments
  add constraint merchant_storefront_payments_provider_ids_check
    check ((provider = 'RAZORPAY' and razorpay_order_id is not null and cashfree_order_id is null)
        or (provider = 'CASHFREE' and cashfree_order_id is not null and razorpay_order_id is null));

-- PROCESSING: the gateway reports a payment still pending at the bank (Cashfree PENDING).
-- CANCELLED: the customer left checkout (Cashfree USER_DROPPED / CANCELLED). Both are retryable.
alter table public.merchant_storefront_payments
  drop constraint if exists merchant_storefront_payments_payment_status_check;
alter table public.merchant_storefront_payments
  add constraint merchant_storefront_payments_payment_status_check
    check (payment_status in ('CREATED', 'FAILED', 'CANCELLED', 'PROCESSING', 'AUTHORIZED', 'PAID', 'REFUNDED'));

drop index if exists public.merchant_storefront_payments_open_idx;
create index if not exists merchant_storefront_payments_open_idx
  on public.merchant_storefront_payments (payment_status, created_at)
  where payment_status in ('CREATED', 'FAILED', 'CANCELLED', 'PROCESSING', 'AUTHORIZED');

-- Webhook events ---------------------------------------------------------------------------------

alter table public.merchant_payment_webhook_events
  add column if not exists provider text not null default 'RAZORPAY';
alter table public.merchant_payment_webhook_events
  drop constraint if exists merchant_payment_webhook_events_provider_check;
alter table public.merchant_payment_webhook_events
  add constraint merchant_payment_webhook_events_provider_check check (provider in ('RAZORPAY', 'CASHFREE'));
alter table public.merchant_payment_webhook_events add column if not exists provider_order_id text;
alter table public.merchant_payment_webhook_events add column if not exists provider_payment_id text;
-- sha256 of (timestamp + raw body). Identifies a delivery without storing customer details.
alter table public.merchant_payment_webhook_events add column if not exists payload_hash text
  check (payload_hash is null or payload_hash ~ '^[a-f0-9]{64}$');

-- Cashfree state machine -------------------------------------------------------------------------
--
-- The only way a Cashfree payment row (and its order) changes state. Same guarantees as the
-- Razorpay function: one transaction, row locks, amount/currency checked against the stored
-- attempt, idempotent, and a verified PAID is never undone by a late failure or drop.

create or replace function public.apply_merchant_cashfree_payment(
  p_organization_id uuid,
  p_cashfree_order_id text,
  p_cf_payment_id text,
  p_status text,
  p_amount_paise bigint,
  p_currency text,
  p_method text default null,
  p_failure_reason text default null,
  p_source text default 'CHECKOUT'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.merchant_storefront_payments;
  ord public.orders;
  now_ts timestamptz := now();
  paid_rupees numeric(12,2);
  total_rupees numeric(12,2);
  online jsonb;
begin
  if p_status not in ('PROCESSING', 'PAID', 'FAILED', 'CANCELLED') then
    raise exception 'invalid_status';
  end if;
  if p_source not in ('CHECKOUT', 'WEBHOOK', 'RECONCILE') then
    raise exception 'invalid_source';
  end if;
  if coalesce(p_cf_payment_id, '') = '' then
    raise exception 'payment_id_required';
  end if;

  select * into pay
  from public.merchant_storefront_payments
  where organization_id = p_organization_id
    and provider = 'CASHFREE'
    and cashfree_order_id = p_cashfree_order_id
  for update;

  -- Unknown order id, or an order owned by a different merchant: never touch anything.
  if pay.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_status in ('PROCESSING', 'PAID')
     and (p_amount_paise is distinct from pay.amount_paise or upper(coalesce(p_currency, '')) <> pay.currency) then
    update public.merchant_storefront_payments
    set needs_review = true,
        review_reason = 'Amount or currency mismatch on Cashfree payment ' || p_cf_payment_id
    where id = pay.id;
    return jsonb_build_object('result', 'amount_mismatch', 'payment_id', pay.id);
  end if;

  if p_status in ('FAILED', 'CANCELLED') then
    -- A retryable attempt ended. Never overrides PAID/REFUNDED, and only clears PROCESSING when it
    -- is the same Cashfree payment that was pending.
    if pay.payment_status in ('CREATED', 'FAILED', 'CANCELLED')
       or (pay.payment_status = 'PROCESSING' and pay.cashfree_payment_id = p_cf_payment_id) then
      update public.merchant_storefront_payments
      set payment_status = p_status,
          cashfree_payment_id = p_cf_payment_id,
          failure_reason = left(coalesce(p_failure_reason,
            case when p_status = 'CANCELLED' then 'Payment was cancelled' else 'Payment failed' end), 300),
          payment_method = coalesce(p_method, payment_method)
      where id = pay.id;
      return jsonb_build_object('result', lower(p_status), 'payment_id', pay.id);
    end if;
    return jsonb_build_object('result', 'ignored', 'payment_id', pay.id, 'status', pay.payment_status);
  end if;

  if p_status = 'PROCESSING' then
    if pay.payment_status in ('CREATED', 'FAILED', 'CANCELLED', 'PROCESSING') then
      update public.merchant_storefront_payments
      set payment_status = 'PROCESSING',
          cashfree_payment_id = p_cf_payment_id,
          payment_method = coalesce(p_method, payment_method),
          failure_reason = null
      where id = pay.id;
      return jsonb_build_object('result', 'processing', 'payment_id', pay.id);
    end if;
    return jsonb_build_object('result', 'ignored', 'payment_id', pay.id, 'status', pay.payment_status);
  end if;

  -- p_status = 'PAID'
  if pay.payment_status in ('PAID', 'REFUNDED') then
    if pay.cashfree_payment_id = p_cf_payment_id then
      return jsonb_build_object('result', 'already_paid', 'payment_id', pay.id, 'order_id', pay.order_id);
    end if;
    -- A second successful payment on the same order. Keep the first; flag the extra for refund.
    if not (p_cf_payment_id = any(pay.extra_payment_ids)) then
      update public.merchant_storefront_payments
      set extra_payment_ids = array_append(extra_payment_ids, p_cf_payment_id),
          needs_review = true,
          review_reason = 'Customer paid more than once. Refund the extra payment in Cashfree.'
      where id = pay.id;
    end if;
    return jsonb_build_object('result', 'duplicate_payment', 'payment_id', pay.id, 'order_id', pay.order_id);
  end if;

  update public.merchant_storefront_payments
  set payment_status = 'PAID',
      cashfree_payment_id = p_cf_payment_id,
      payment_method = coalesce(p_method, payment_method),
      failure_reason = null,
      paid_at = now_ts
  where id = pay.id;

  select * into ord from public.orders
  where id = pay.order_id and organization_id = p_organization_id
  for update;

  if ord.id is null then
    update public.merchant_storefront_payments
    set needs_review = true, review_reason = 'Paid order no longer exists'
    where id = pay.id;
    return jsonb_build_object('result', 'paid_order_missing', 'payment_id', pay.id);
  end if;

  paid_rupees := round(pay.amount_paise::numeric / 100, 2);
  total_rupees := round(pay.order_total_paise::numeric / 100, 2);
  online := jsonb_build_object(
    'provider', 'CASHFREE',
    'status', 'PAID',
    'mode', pay.payment_mode,
    'kind', pay.payment_kind,
    'amount', paid_rupees,
    'cashfreeOrderId', pay.cashfree_order_id,
    'cashfreePaymentId', p_cf_payment_id,
    'method', coalesce(p_method, pay.payment_method),
    'paidAt', now_ts,
    'verifiedBy', p_source
  );

  -- Settle only an order that is still waiting for payment. Anything else is left for the merchant.
  if ord.status = 'IMPORTED' and ord.payment_status = 'PENDING' then
    update public.orders
    set status = 'READY',
        payment_status = case when pay.payment_kind = 'FULL' then 'PAID'::public.payment_status else 'PARTIAL'::public.payment_status end,
        amount_paid = case when pay.payment_kind = 'FULL' then total_rupees else paid_rupees end,
        cod_amount = case when pay.payment_kind = 'FULL' then 0 else greatest(total_rupees - paid_rupees, 0) end,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'storefront', coalesce(metadata -> 'storefront', '{}'::jsonb)
            || jsonb_build_object('onlinePayment', online, 'customer_confirmed_at', now_ts),
          'whatsappLifecycle', coalesce(metadata -> 'whatsappLifecycle', '{}'::jsonb)
            || jsonb_build_object('customer_confirmed_at', now_ts, 'customer_confirmed_via', 'online_payment'))
    where id = ord.id and organization_id = p_organization_id;
    return jsonb_build_object('result', 'paid', 'payment_id', pay.id, 'order_id', ord.id, 'settled', true);
  end if;

  update public.orders
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'storefront', coalesce(metadata -> 'storefront', '{}'::jsonb) || jsonb_build_object('onlinePayment', online))
  where id = ord.id and organization_id = p_organization_id;
  update public.merchant_storefront_payments
  set needs_review = true,
      review_reason = case when ord.status = 'CANCELLED'
        then 'Payment received for a cancelled order. Refund it in Cashfree or reopen the order.'
        else 'Payment received after the order payment was already updated. Check the order.' end
  where id = pay.id;
  return jsonb_build_object('result', 'paid', 'payment_id', pay.id, 'order_id', ord.id, 'settled', false);
end;
$$;

revoke all on function public.apply_merchant_cashfree_payment(uuid, text, text, text, bigint, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_merchant_cashfree_payment(uuid, text, text, text, bigint, text, text, text, text)
  to service_role;
