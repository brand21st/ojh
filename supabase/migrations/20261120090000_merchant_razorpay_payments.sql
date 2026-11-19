-- Merchant storefront payments (Domain B).
--
-- Each merchant connects their OWN Razorpay account to accept online payments on their PostBus
-- storefront. This is fully separate from PostBus SaaS billing (Domain A: platform_settings,
-- payments, subscriptions, razorpay_webhook_events). Nothing here reads or writes those tables.
--
-- Credentials are AES-256-GCM encrypted by the app (lib/security/crypto.ts) before they reach the
-- database. The integrations and webhook-event tables are service-role only: browsers never read
-- them, even in encrypted form. Payment rows hold no secrets, so organization members may read
-- their own organization's rows.

create table if not exists public.merchant_payment_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'RAZORPAY' check (provider in ('RAZORPAY')),
  -- Non-guessable path segment for this integration's webhook URL. Rotated on every disconnect.
  webhook_token text not null unique check (webhook_token ~ '^[a-f0-9]{48}$'),
  encrypted_key_id text,
  encrypted_key_secret text,
  encrypted_webhook_secret text,
  -- sha256 of the Key ID. Lets payment attempts remember which Razorpay keys created them.
  key_fingerprint text check (key_fingerprint is null or key_fingerprint ~ '^[a-f0-9]{64}$'),
  -- Masked Key ID for display, e.g. rzp_test_••••Ab12. Never the full value.
  key_id_hint text,
  payment_mode text not null default 'TEST' check (payment_mode in ('TEST', 'LIVE')),
  connection_status text not null default 'NOT_CONNECTED'
    check (connection_status in ('NOT_CONNECTED', 'CONNECTED', 'VERIFICATION_FAILED', 'CONFIGURATION_REQUIRED')),
  enabled boolean not null default false,
  last_verified_at timestamptz,
  last_error text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider),
  -- Online checkout can only be switched on for a fully connected account.
  constraint merchant_payment_integrations_enabled_requires_connection
    check (not enabled or (connection_status = 'CONNECTED' and encrypted_key_id is not null
      and encrypted_key_secret is not null and encrypted_webhook_secret is not null))
);

create index if not exists merchant_payment_integrations_org_idx
  on public.merchant_payment_integrations (organization_id);

create table if not exists public.merchant_storefront_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null references public.merchant_payment_integrations(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  provider text not null default 'RAZORPAY' check (provider in ('RAZORPAY')),
  payment_mode text not null check (payment_mode in ('TEST', 'LIVE')),
  key_fingerprint text not null check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  -- FULL: prepaid order. COD_ADVANCE: advance on a cash-on-delivery order.
  payment_kind text not null check (payment_kind in ('FULL', 'COD_ADVANCE')),
  razorpay_order_id text not null unique,
  razorpay_payment_id text,
  amount_paise bigint not null check (amount_paise > 0),
  order_total_paise bigint not null check (order_total_paise >= amount_paise),
  currency text not null default 'INR' check (currency = 'INR'),
  payment_status text not null default 'CREATED'
    check (payment_status in ('CREATED', 'FAILED', 'AUTHORIZED', 'PAID', 'REFUNDED')),
  payment_method text,
  failure_reason text,
  -- sha256 of the bearer token the storefront got for this attempt. Never the token itself.
  checkout_token_hash text not null check (checkout_token_hash ~ '^[a-f0-9]{64}$'),
  needs_review boolean not null default false,
  review_reason text,
  -- Extra captured payments on the same Razorpay order (customer paid twice). Merchant must refund.
  extra_payment_ids text[] not null default '{}',
  last_reconciled_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One payment attempt per PostBus order. Retries reuse the same Razorpay order.
  unique (order_id)
);

create unique index if not exists merchant_storefront_payments_payment_uidx
  on public.merchant_storefront_payments (razorpay_payment_id)
  where razorpay_payment_id is not null;
create index if not exists merchant_storefront_payments_org_created_idx
  on public.merchant_storefront_payments (organization_id, created_at desc);
create index if not exists merchant_storefront_payments_open_idx
  on public.merchant_storefront_payments (payment_status, created_at)
  where payment_status in ('CREATED', 'FAILED', 'AUTHORIZED');

create table if not exists public.merchant_payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_integration_id uuid not null references public.merchant_payment_integrations(id) on delete cascade,
  provider_event_id text not null,
  event_type text not null,
  -- Identifiers only. The raw payload holds customer contact details, so it is not stored.
  razorpay_order_id text,
  razorpay_payment_id text,
  processing_status text not null default 'RECEIVED'
    check (processing_status in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
  processing_until timestamptz,
  attempts integer not null default 0,
  result text,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (payment_integration_id, provider_event_id)
);

create index if not exists merchant_payment_webhook_events_org_idx
  on public.merchant_payment_webhook_events (organization_id, received_at desc);

drop trigger if exists set_merchant_payment_integrations_updated_at on public.merchant_payment_integrations;
create trigger set_merchant_payment_integrations_updated_at
  before update on public.merchant_payment_integrations
  for each row execute function public.set_updated_at();

drop trigger if exists set_merchant_storefront_payments_updated_at on public.merchant_storefront_payments;
create trigger set_merchant_storefront_payments_updated_at
  before update on public.merchant_storefront_payments
  for each row execute function public.set_updated_at();

-- Tenant isolation ------------------------------------------------------------------------------

alter table public.merchant_payment_integrations enable row level security;
alter table public.merchant_storefront_payments enable row level security;
alter table public.merchant_payment_webhook_events enable row level security;

revoke all on public.merchant_payment_integrations from public, anon, authenticated;
revoke all on public.merchant_payment_webhook_events from public, anon, authenticated;
revoke all on public.merchant_storefront_payments from public, anon, authenticated;
grant all on public.merchant_payment_integrations to service_role;
grant all on public.merchant_payment_webhook_events to service_role;
grant all on public.merchant_storefront_payments to service_role;

-- Members may read their own organization's payment rows (no secrets). Writes stay server-side.
grant select on public.merchant_storefront_payments to authenticated;
drop policy if exists merchant_storefront_payments_member_select on public.merchant_storefront_payments;
create policy merchant_storefront_payments_member_select on public.merchant_storefront_payments
  for select to authenticated using (public.is_org_member(organization_id));

-- Payment state machine ------------------------------------------------------------------------
--
-- The only way a payment row (and its order) changes state. Runs in one transaction with row
-- locks, so the browser callback, webhooks and reconciliation can race safely and idempotently.
-- Amount and currency are checked against the server-stored attempt, never the caller.

create or replace function public.apply_merchant_storefront_payment(
  p_organization_id uuid,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
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
  if p_status not in ('AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED') then
    raise exception 'invalid_status';
  end if;
  if p_source not in ('CHECKOUT', 'WEBHOOK', 'RECONCILE') then
    raise exception 'invalid_source';
  end if;
  if coalesce(p_razorpay_payment_id, '') = '' then
    raise exception 'payment_id_required';
  end if;

  select * into pay
  from public.merchant_storefront_payments
  where organization_id = p_organization_id
    and razorpay_order_id = p_razorpay_order_id
  for update;

  -- Unknown order id, or an order owned by a different merchant: never touch anything.
  if pay.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_status in ('AUTHORIZED', 'PAID')
     and (p_amount_paise is distinct from pay.amount_paise or upper(coalesce(p_currency, '')) <> pay.currency) then
    update public.merchant_storefront_payments
    set needs_review = true,
        review_reason = 'Amount or currency mismatch on payment ' || p_razorpay_payment_id
    where id = pay.id;
    return jsonb_build_object('result', 'amount_mismatch', 'payment_id', pay.id);
  end if;

  if p_status = 'FAILED' then
    if pay.payment_status in ('CREATED', 'FAILED') then
      update public.merchant_storefront_payments
      set payment_status = 'FAILED',
          failure_reason = left(coalesce(p_failure_reason, 'Payment failed'), 300),
          payment_method = coalesce(p_method, payment_method)
      where id = pay.id;
      return jsonb_build_object('result', 'failed', 'payment_id', pay.id);
    end if;
    -- A failed retry never undoes an authorized or paid attempt.
    return jsonb_build_object('result', 'ignored', 'payment_id', pay.id, 'status', pay.payment_status);
  end if;

  if p_status = 'AUTHORIZED' then
    if pay.payment_status in ('CREATED', 'FAILED') then
      update public.merchant_storefront_payments
      set payment_status = 'AUTHORIZED',
          razorpay_payment_id = p_razorpay_payment_id,
          payment_method = coalesce(p_method, payment_method),
          failure_reason = null
      where id = pay.id;
      return jsonb_build_object('result', 'authorized', 'payment_id', pay.id);
    end if;
    return jsonb_build_object('result', 'ignored', 'payment_id', pay.id, 'status', pay.payment_status);
  end if;

  if p_status = 'REFUNDED' then
    if pay.payment_status = 'PAID' and pay.razorpay_payment_id = p_razorpay_payment_id then
      update public.merchant_storefront_payments
      set payment_status = 'REFUNDED', refunded_at = now_ts
      where id = pay.id;
      select * into ord from public.orders
      where id = pay.order_id and organization_id = p_organization_id
      for update;
      if ord.id is not null and ord.payment_status in ('PAID', 'PARTIAL')
         and ord.status not in ('BOOKED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED') then
        update public.orders
        set payment_status = 'REFUNDED',
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'storefront', coalesce(metadata -> 'storefront', '{}'::jsonb) || jsonb_build_object(
                'onlinePayment', coalesce(metadata #> '{storefront,onlinePayment}', '{}'::jsonb)
                  || jsonb_build_object('status', 'REFUNDED', 'refundedAt', now_ts)))
        where id = ord.id and organization_id = p_organization_id;
      else
        update public.merchant_storefront_payments
        set needs_review = true, review_reason = 'Refunded after the order moved to fulfilment'
        where id = pay.id;
      end if;
      return jsonb_build_object('result', 'refunded', 'payment_id', pay.id, 'order_id', pay.order_id);
    end if;
    return jsonb_build_object('result', 'ignored', 'payment_id', pay.id, 'status', pay.payment_status);
  end if;

  -- p_status = 'PAID'
  if pay.payment_status in ('PAID', 'REFUNDED') then
    if pay.razorpay_payment_id = p_razorpay_payment_id then
      return jsonb_build_object('result', 'already_paid', 'payment_id', pay.id, 'order_id', pay.order_id);
    end if;
    -- A second captured payment on the same order. Keep the first; flag the extra for refund.
    if not (p_razorpay_payment_id = any(pay.extra_payment_ids)) then
      update public.merchant_storefront_payments
      set extra_payment_ids = array_append(extra_payment_ids, p_razorpay_payment_id),
          needs_review = true,
          review_reason = 'Customer paid more than once. Refund the extra payment in Razorpay.'
      where id = pay.id;
    end if;
    return jsonb_build_object('result', 'duplicate_payment', 'payment_id', pay.id, 'order_id', pay.order_id);
  end if;

  update public.merchant_storefront_payments
  set payment_status = 'PAID',
      razorpay_payment_id = p_razorpay_payment_id,
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
    'provider', 'RAZORPAY',
    'status', 'PAID',
    'mode', pay.payment_mode,
    'kind', pay.payment_kind,
    'amount', paid_rupees,
    'razorpayOrderId', pay.razorpay_order_id,
    'razorpayPaymentId', p_razorpay_payment_id,
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
        then 'Payment received for a cancelled order. Refund it in Razorpay or reopen the order.'
        else 'Payment received after the order payment was already updated. Check the order.' end
  where id = pay.id;
  return jsonb_build_object('result', 'paid', 'payment_id', pay.id, 'order_id', ord.id, 'settled', false);
end;
$$;

revoke all on function public.apply_merchant_storefront_payment(uuid, text, text, text, bigint, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_merchant_storefront_payment(uuid, text, text, text, bigint, text, text, text, text)
  to service_role;
