-- Tenant wallet, phase 1: one prepaid INR wallet per organization.
--
-- Money is bigint micro-rupees (1 rupee = 1,000,000; 1 paisa = 10,000), so
-- fractional-paisa WhatsApp rates are exact. Every balance change goes through
-- wallet__post, which locks the wallet row, writes one immutable ledger entry
-- and updates the balance in the same transaction. Tenants can read their own
-- rows; every write is a security-definer function granted to service_role only.
--
-- Subscription payments are untouched. The old AI credit columns stay until
-- wallet_migrate_ai_credits moves an organization's credits across.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

alter table public.platform_settings
  add column if not exists wallet_recharge_min_paise bigint not null default 10000,
  add column if not exists wallet_recharge_max_paise bigint not null default 5000000,
  add column if not exists wallet_recharge_presets_paise bigint[] not null
    default array[10000, 25000, 50000, 100000, 200000]::bigint[],
  add column if not exists wallet_signup_promo_enabled boolean not null default false,
  add column if not exists wallet_signup_promo_micros bigint not null default 100000000,
  add column if not exists wallet_ai_credit_rate_micros bigint not null default 200000,
  add column if not exists wallet_default_thresholds_micros bigint[] not null
    default array[100000000, 50000000, 20000000]::bigint[];

alter table public.platform_settings
  drop constraint if exists platform_settings_wallet_recharge_range;
alter table public.platform_settings
  add constraint platform_settings_wallet_recharge_range
    check (wallet_recharge_min_paise >= 100 and wallet_recharge_max_paise >= wallet_recharge_min_paise);
alter table public.platform_settings
  drop constraint if exists platform_settings_wallet_amounts_nonnegative;
alter table public.platform_settings
  add constraint platform_settings_wallet_amounts_nonnegative
    check (wallet_signup_promo_micros >= 0 and wallet_ai_credit_rate_micros >= 0);

comment on column public.platform_settings.wallet_signup_promo_enabled is
  'When true, a new organization gets wallet_signup_promo_micros as PROMO_CREDIT and starts with 0 AI credits. Turn on at wallet cutover.';
comment on column public.platform_settings.wallet_ai_credit_rate_micros is
  'Value of one legacy AI credit when wallet_migrate_ai_credits converts it (200000 = Rs 0.20).';

alter table public.payments
  drop constraint if exists payments_payment_purpose_check;
alter table public.payments
  add constraint payments_payment_purpose_check
  check (payment_purpose in ('subscription', 'ai_credits', 'addon', 'wallet_recharge'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  status text not null default 'ACTIVE',
  balance_micros bigint not null default 0,
  reserved_micros bigint not null default 0,
  credit_limit_micros bigint not null default 0,
  low_balance_thresholds_micros bigint[] not null
    default array[100000000, 50000000, 20000000]::bigint[],
  lifetime_recharged_micros bigint not null default 0,
  lifetime_whatsapp_micros bigint not null default 0,
  lifetime_ai_micros bigint not null default 0,
  lifetime_promo_micros bigint not null default 0,
  lifetime_refunded_micros bigint not null default 0,
  last_recharged_at timestamptz,
  ai_credits_migrated_at timestamptz,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallets_status_chk check (status in ('ACTIVE', 'FROZEN')),
  constraint wallets_reserved_nonnegative check (reserved_micros >= 0),
  constraint wallets_credit_limit_nonnegative check (credit_limit_micros >= 0),
  -- An active wallet can never spend past its balance plus agreed credit.
  -- Only a recharge reversal may push it below, and that freezes the wallet.
  constraint wallets_available_chk check (
    status = 'FROZEN' or balance_micros + credit_limit_micros >= reserved_micros
  )
);

comment on table public.wallets is
  'One prepaid INR wallet per organization. balance_micros always equals the sum of wallet_ledger.amount_micros.';

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entry_type text not null,
  service text,
  amount_micros bigint not null,
  balance_after_micros bigint not null,
  idempotency_key text not null,
  reference_type text,
  reference_id text,
  reservation_id uuid,
  pricing_rule_id uuid,
  actor_user_id uuid,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint wallet_ledger_amount_nonzero check (amount_micros <> 0),
  constraint wallet_ledger_key_chk check (char_length(btrim(idempotency_key)) between 1 and 200),
  constraint wallet_ledger_service_chk check (service is null or service in ('whatsapp', 'ai')),
  constraint wallet_ledger_type_sign_chk check (
    (entry_type in ('RECHARGE', 'PROMO_CREDIT', 'ADMIN_CREDIT', 'ADMIN_REFUND', 'USAGE_REVERSAL', 'MIGRATION_OPENING')
      and amount_micros > 0)
    or
    (entry_type in ('USAGE_WHATSAPP', 'USAGE_AI', 'ADMIN_DEBIT', 'RECHARGE_REVERSAL')
      and amount_micros < 0)
  ),
  constraint wallet_ledger_wallet_key_uniq unique (wallet_id, idempotency_key)
);

create index if not exists wallet_ledger_org_created_idx
  on public.wallet_ledger (organization_id, created_at desc);
create index if not exists wallet_ledger_org_type_created_idx
  on public.wallet_ledger (organization_id, entry_type, created_at desc);
create index if not exists wallet_ledger_reference_idx
  on public.wallet_ledger (reference_type, reference_id)
  where reference_id is not null;

create table if not exists public.wallet_reservations (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  service text not null,
  amount_micros bigint not null,
  captured_micros bigint,
  status text not null default 'HELD',
  idempotency_key text not null,
  reference_type text,
  reference_id text,
  pricing_rule_id uuid,
  ledger_id uuid references public.wallet_ledger(id) on delete set null,
  release_reason text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallet_reservations_service_chk check (service in ('whatsapp', 'ai')),
  constraint wallet_reservations_amount_chk check (amount_micros > 0),
  constraint wallet_reservations_status_chk check (status in ('HELD', 'CAPTURED', 'RELEASED', 'EXPIRED')),
  constraint wallet_reservations_captured_chk check (
    captured_micros is null or (captured_micros >= 0 and captured_micros <= amount_micros)
  ),
  constraint wallet_reservations_key_chk check (char_length(btrim(idempotency_key)) between 1 and 200),
  constraint wallet_reservations_wallet_key_uniq unique (wallet_id, idempotency_key)
);

create index if not exists wallet_reservations_held_expiry_idx
  on public.wallet_reservations (expires_at)
  where status = 'HELD';
create index if not exists wallet_reservations_org_created_idx
  on public.wallet_reservations (organization_id, created_at desc);

create table if not exists public.wallet_recharge_orders (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid unique references public.payments(id) on delete set null,
  razorpay_order_id text not null unique,
  razorpay_payment_id text unique,
  amount_paise bigint not null,
  taxable_paise bigint not null,
  tax_paise bigint not null,
  credit_micros bigint not null,
  refunded_paise bigint not null default 0,
  reversed_micros bigint not null default 0,
  status text not null default 'CREATED',
  method text,
  failure_reason text,
  created_by uuid,
  ledger_id uuid references public.wallet_ledger(id) on delete set null,
  paid_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallet_recharge_orders_amount_chk check (amount_paise >= 100),
  constraint wallet_recharge_orders_tax_split_chk check (
    taxable_paise > 0 and tax_paise >= 0 and taxable_paise + tax_paise = amount_paise
  ),
  constraint wallet_recharge_orders_credit_chk check (credit_micros = taxable_paise * 10000),
  constraint wallet_recharge_orders_refund_chk check (refunded_paise between 0 and amount_paise),
  constraint wallet_recharge_orders_reversed_chk check (reversed_micros between 0 and credit_micros),
  constraint wallet_recharge_orders_status_chk check (
    status in ('CREATED', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED')
  )
);

create index if not exists wallet_recharge_orders_org_created_idx
  on public.wallet_recharge_orders (organization_id, created_at desc);
create index if not exists wallet_recharge_orders_open_idx
  on public.wallet_recharge_orders (created_at)
  where status in ('CREATED', 'FAILED');

create table if not exists public.wallet_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  service text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  whatsapp_category text not null default '*',
  country_code text not null default '*',
  provider text not null default '*',
  ai_feature text not null default '*',
  ai_model text not null default '*',
  per_unit_micros bigint not null default 0,
  per_1k_input_tokens_micros bigint not null default 0,
  per_1k_output_tokens_micros bigint not null default 0,
  markup_bps integer not null default 0,
  discount_bps integer not null default 0,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  superseded_by uuid references public.wallet_pricing_rules(id) on delete set null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint wallet_pricing_rules_service_chk check (service in ('whatsapp', 'ai')),
  constraint wallet_pricing_rules_category_chk check (
    whatsapp_category in ('*', 'MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE', 'OTHER')
  ),
  constraint wallet_pricing_rules_country_chk check (country_code = '*' or country_code ~ '^[A-Z]{2}$'),
  constraint wallet_pricing_rules_text_chk check (
    char_length(provider) between 1 and 60
    and char_length(ai_feature) between 1 and 80
    and char_length(ai_model) between 1 and 160
  ),
  constraint wallet_pricing_rules_shape_chk check (
    (service = 'whatsapp' and ai_feature = '*' and ai_model = '*'
      and per_1k_input_tokens_micros = 0 and per_1k_output_tokens_micros = 0)
    or
    (service = 'ai' and whatsapp_category = '*' and country_code = '*')
  ),
  constraint wallet_pricing_rules_amounts_chk check (
    per_unit_micros >= 0 and per_1k_input_tokens_micros >= 0 and per_1k_output_tokens_micros >= 0
  ),
  constraint wallet_pricing_rules_bps_chk check (
    markup_bps between 0 and 100000 and discount_bps between 0 and 10000
  ),
  constraint wallet_pricing_rules_window_chk check (effective_to is null or effective_to > effective_from)
);

-- At most one open-ended rule per key; wallet_set_pricing_rule closes the old one.
create unique index if not exists wallet_pricing_rules_open_key_uidx
  on public.wallet_pricing_rules (
    service,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    whatsapp_category, country_code, provider, ai_feature, ai_model
  )
  where effective_to is null;

create index if not exists wallet_pricing_rules_lookup_idx
  on public.wallet_pricing_rules (service, whatsapp_category, ai_feature, effective_from desc);

create table if not exists public.wallet_adjustments (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,
  amount_micros bigint not null,
  reason text not null,
  admin_user_id uuid not null,
  admin_email text,
  idempotency_key text not null unique,
  ledger_id uuid references public.wallet_ledger(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint wallet_adjustments_kind_chk check (kind in ('PROMO', 'REFUND', 'MANUAL_CREDIT', 'MANUAL_DEBIT')),
  constraint wallet_adjustments_amount_chk check (amount_micros > 0),
  constraint wallet_adjustments_reason_chk check (char_length(btrim(reason)) between 10 and 500)
);

create index if not exists wallet_adjustments_org_created_idx
  on public.wallet_adjustments (organization_id, created_at desc);

create table if not exists public.wallet_alerts (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  threshold_micros bigint not null,
  balance_micros_at_fire bigint not null,
  status text not null default 'OPEN',
  notified_at timestamptz,
  fired_at timestamptz not null default now(),
  cleared_at timestamptz,
  constraint wallet_alerts_status_chk check (status in ('OPEN', 'CLEARED'))
);

create unique index if not exists wallet_alerts_open_uidx
  on public.wallet_alerts (wallet_id, threshold_micros)
  where status = 'OPEN';
create index if not exists wallet_alerts_unnotified_idx
  on public.wallet_alerts (fired_at)
  where status = 'OPEN' and notified_at is null;

create table if not exists public.wallet_reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  balance_micros bigint not null,
  ledger_sum_micros bigint not null,
  reserved_micros bigint not null,
  held_sum_micros bigint not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  note text
);

create unique index if not exists wallet_reconciliation_issues_open_uidx
  on public.wallet_reconciliation_issues (wallet_id)
  where resolved_at is null;

create table if not exists public.wallet_status_events (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  reason text not null,
  admin_user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint wallet_status_events_reason_chk check (char_length(btrim(reason)) between 10 and 500)
);

create index if not exists wallet_status_events_org_created_idx
  on public.wallet_status_events (organization_id, created_at desc);

-- updated_at
drop trigger if exists set_wallets_updated_at on public.wallets;
create trigger set_wallets_updated_at before update on public.wallets
  for each row execute function public.set_updated_at();
drop trigger if exists set_wallet_reservations_updated_at on public.wallet_reservations;
create trigger set_wallet_reservations_updated_at before update on public.wallet_reservations
  for each row execute function public.set_updated_at();
drop trigger if exists set_wallet_recharge_orders_updated_at on public.wallet_recharge_orders;
create trigger set_wallet_recharge_orders_updated_at before update on public.wallet_recharge_orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------

-- Ledger and adjustment rows never change. A delete is allowed only when the
-- owning organization is already gone (on delete cascade).
create or replace function public.wallet__guard_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are immutable', tg_table_name using errcode = '42501';
  end if;
  if exists (select 1 from public.organizations where id = old.organization_id) then
    raise exception '% rows are immutable', tg_table_name using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists wallet_ledger_immutable on public.wallet_ledger;
create trigger wallet_ledger_immutable before update or delete on public.wallet_ledger
  for each row execute function public.wallet__guard_immutable();
drop trigger if exists wallet_adjustments_immutable on public.wallet_adjustments;
create trigger wallet_adjustments_immutable before update or delete on public.wallet_adjustments
  for each row execute function public.wallet__guard_immutable();
drop trigger if exists wallet_status_events_immutable on public.wallet_status_events;
create trigger wallet_status_events_immutable before update or delete on public.wallet_status_events
  for each row execute function public.wallet__guard_immutable();

-- Pricing rules are versioned: the only change allowed is closing a rule.
create or replace function public.wallet__guard_pricing_rule()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.organization_id is not null
      and not exists (select 1 from public.organizations where id = old.organization_id) then
      return old;
    end if;
    raise exception 'wallet_pricing_rules rows are never deleted' using errcode = '42501';
  end if;
  -- Allowed: set effective_to once, and set superseded_by once. Nothing else.
  if (to_jsonb(new) - 'effective_to' - 'superseded_by') <> (to_jsonb(old) - 'effective_to' - 'superseded_by')
    or (old.effective_to is not null and new.effective_to is distinct from old.effective_to)
    or new.effective_to is null
    or (old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by) then
    raise exception 'a pricing rule can only be closed, not edited' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_pricing_rules_versioned on public.wallet_pricing_rules;
create trigger wallet_pricing_rules_versioned before update or delete on public.wallet_pricing_rules
  for each row execute function public.wallet__guard_pricing_rule();

-- Balances change only inside wallet__post / wallet__hold, which set this flag.
create or replace function public.wallet__guard_balance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.balance_micros is distinct from old.balance_micros
      or new.reserved_micros is distinct from old.reserved_micros)
    and coalesce(current_setting('postbus.wallet_posting', true), '') <> '1' then
    raise exception 'wallet balances change only through wallet functions' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists wallets_balance_guard on public.wallets;
create trigger wallets_balance_guard before update on public.wallets
  for each row execute function public.wallet__guard_balance();

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted to any API role)
-- ---------------------------------------------------------------------------

create or replace function public.wallet__lock(p_org uuid)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
begin
  if p_org is null then
    raise exception 'organization required' using errcode = '22023';
  end if;
  select * into w from public.wallets where organization_id = p_org for update;
  if found then
    return w;
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  insert into public.wallets (organization_id, low_balance_thresholds_micros)
  values (
    p_org,
    coalesce(
      (select wallet_default_thresholds_micros from public.platform_settings where id = 1),
      array[100000000, 50000000, 20000000]::bigint[]
    )
  )
  on conflict (organization_id) do nothing;
  select * into w from public.wallets where organization_id = p_org for update;
  return w;
end;
$$;

create or replace function public.wallet__evaluate_alerts(w public.wallets)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t bigint;
begin
  foreach t in array coalesce(w.low_balance_thresholds_micros, array[]::bigint[]) loop
    if w.balance_micros < t then
      insert into public.wallet_alerts (wallet_id, organization_id, threshold_micros, balance_micros_at_fire)
      values (w.id, w.organization_id, t, w.balance_micros)
      on conflict (wallet_id, threshold_micros) where status = 'OPEN' do nothing;
    else
      update public.wallet_alerts
      set status = 'CLEARED', cleared_at = now()
      where wallet_id = w.id and threshold_micros = t and status = 'OPEN';
    end if;
  end loop;
end;
$$;

-- Moves the reserved counter. Caller holds the wallet lock.
create or replace function public.wallet__hold(p_wallet_id uuid, p_delta bigint)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
begin
  perform set_config('postbus.wallet_posting', '1', true);
  update public.wallets
  set reserved_micros = reserved_micros + p_delta,
      version = version + 1
  where id = p_wallet_id
  returning * into w;
  perform set_config('postbus.wallet_posting', '0', true);
  return w;
end;
$$;

-- The one place a balance changes. Caller holds the wallet lock and has
-- already checked funds; the wallets_available_chk constraint is the backstop.
create or replace function public.wallet__post(
  p_wallet_id uuid,
  p_entry_type text,
  p_amount bigint,
  p_key text,
  p_service text default null,
  p_reference_type text default null,
  p_reference_id text default null,
  p_reservation_id uuid default null,
  p_pricing_rule_id uuid default null,
  p_actor uuid default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_reserved_delta bigint default 0,
  p_freeze_if_short boolean default false
)
returns public.wallet_ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  l public.wallet_ledger;
begin
  perform set_config('postbus.wallet_posting', '1', true);
  update public.wallets
  set balance_micros = balance_micros + p_amount,
      reserved_micros = reserved_micros + p_reserved_delta,
      lifetime_recharged_micros = lifetime_recharged_micros
        + case when p_entry_type = 'RECHARGE' then p_amount else 0 end,
      lifetime_whatsapp_micros = lifetime_whatsapp_micros
        + case
            when p_entry_type = 'USAGE_WHATSAPP' then -p_amount
            when p_entry_type = 'USAGE_REVERSAL' and p_service = 'whatsapp' then -p_amount
            else 0
          end,
      lifetime_ai_micros = lifetime_ai_micros
        + case
            when p_entry_type = 'USAGE_AI' then -p_amount
            when p_entry_type = 'USAGE_REVERSAL' and p_service = 'ai' then -p_amount
            else 0
          end,
      lifetime_promo_micros = lifetime_promo_micros
        + case when p_entry_type = 'PROMO_CREDIT' then p_amount else 0 end,
      lifetime_refunded_micros = lifetime_refunded_micros
        + case when p_entry_type = 'RECHARGE_REVERSAL' then -p_amount else 0 end,
      last_recharged_at = case when p_entry_type = 'RECHARGE' then now() else last_recharged_at end,
      status = case
        when p_freeze_if_short
          and balance_micros + p_amount + credit_limit_micros < reserved_micros + p_reserved_delta
          then 'FROZEN'
        else status
      end,
      version = version + 1
  where id = p_wallet_id
  returning * into w;
  perform set_config('postbus.wallet_posting', '0', true);

  if w.id is null then
    raise exception 'wallet not found' using errcode = 'P0002';
  end if;

  insert into public.wallet_ledger (
    wallet_id, organization_id, entry_type, service, amount_micros, balance_after_micros,
    idempotency_key, reference_type, reference_id, reservation_id, pricing_rule_id,
    actor_user_id, description, metadata
  ) values (
    w.id, w.organization_id, p_entry_type, p_service, p_amount, w.balance_micros,
    p_key, p_reference_type, p_reference_id, p_reservation_id, p_pricing_rule_id,
    p_actor, p_description, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into l;

  perform public.wallet__evaluate_alerts(w);
  return l;
end;
$$;

create or replace function public.wallet__snapshot(w public.wallets)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'walletId', w.id,
    'organizationId', w.organization_id,
    'walletStatus', w.status,
    'balanceMicros', w.balance_micros::text,
    'reservedMicros', w.reserved_micros::text,
    'availableMicros', (w.balance_micros + w.credit_limit_micros - w.reserved_micros)::text
  )
$$;

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------

-- Charge = base + ceil(markup), minus floor(discount). Integer-only, rounding
-- to whole micro-rupees. Mirrored by modules/wallet/pricing.ts.
create or replace function public.wallet_charge_micros(
  p_per_unit bigint,
  p_per_1k_in bigint,
  p_per_1k_out bigint,
  p_markup_bps integer,
  p_discount_bps integer,
  p_units bigint default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0
)
returns bigint
language plpgsql
immutable
as $$
declare
  v_base bigint;
  v_marked bigint;
begin
  if coalesce(p_units, 0) < 0 or coalesce(p_input_tokens, 0) < 0 or coalesce(p_output_tokens, 0) < 0 then
    raise exception 'usage cannot be negative' using errcode = '22023';
  end if;
  v_base := coalesce(p_per_unit, 0) * coalesce(p_units, 0)
    + (coalesce(p_input_tokens, 0) * coalesce(p_per_1k_in, 0) + 999) / 1000
    + (coalesce(p_output_tokens, 0) * coalesce(p_per_1k_out, 0) + 999) / 1000;
  v_marked := v_base + (v_base * coalesce(p_markup_bps, 0) + 9999) / 10000;
  return v_marked - (v_marked * coalesce(p_discount_bps, 0)) / 10000;
end;
$$;

-- Most specific rule wins: tenant override, then exact category/country/
-- provider/feature/model over '*'. Effective at p_at.
create or replace function public.wallet_resolve_price(
  p_service text,
  p_org uuid default null,
  p_whatsapp_category text default '*',
  p_country_code text default '*',
  p_provider text default '*',
  p_ai_feature text default '*',
  p_ai_model text default '*',
  p_at timestamptz default now()
)
returns public.wallet_pricing_rules
language sql
stable
security definer
set search_path = public
as $$
  select r.*
  from public.wallet_pricing_rules r
  where r.service = p_service
    and (r.organization_id is null or r.organization_id = p_org)
    and r.whatsapp_category in ('*', coalesce(upper(p_whatsapp_category), '*'))
    and r.country_code in ('*', coalesce(upper(p_country_code), '*'))
    and r.provider in ('*', coalesce(lower(p_provider), '*'))
    and r.ai_feature in ('*', coalesce(p_ai_feature, '*'))
    and r.ai_model in ('*', coalesce(p_ai_model, '*'))
    and r.effective_from <= p_at
    and (r.effective_to is null or r.effective_to > p_at)
  order by
    (r.organization_id is not null) desc,
    (r.whatsapp_category <> '*') desc,
    (r.ai_model <> '*') desc,
    (r.ai_feature <> '*') desc,
    (r.country_code <> '*') desc,
    (r.provider <> '*') desc,
    r.effective_from desc
  limit 1
$$;

create or replace function public.wallet_quote(
  p_service text,
  p_org uuid default null,
  p_whatsapp_category text default '*',
  p_country_code text default '*',
  p_provider text default '*',
  p_ai_feature text default '*',
  p_ai_model text default '*',
  p_units bigint default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.wallet_pricing_rules;
begin
  r := public.wallet_resolve_price(
    p_service, p_org, p_whatsapp_category, p_country_code, p_provider, p_ai_feature, p_ai_model, p_at
  );
  if r.id is null then
    return jsonb_build_object('status', 'NO_PRICE');
  end if;
  return jsonb_build_object(
    'status', 'OK',
    'pricingRuleId', r.id,
    'chargeMicros', public.wallet_charge_micros(
      r.per_unit_micros, r.per_1k_input_tokens_micros, r.per_1k_output_tokens_micros,
      r.markup_bps, r.discount_bps, p_units, p_input_tokens, p_output_tokens
    )::text
  );
end;
$$;

-- Adds a new version. The open rule with the same key is closed at the new
-- rule's effective_from, so past charges keep the rule they were priced with.
create or replace function public.wallet_set_pricing_rule(p_rule jsonb, p_admin_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new public.wallet_pricing_rules;
  v_old public.wallet_pricing_rules;
  v_service text := p_rule->>'service';
  v_org uuid := nullif(p_rule->>'organizationId', '')::uuid;
  v_category text := upper(coalesce(nullif(p_rule->>'whatsappCategory', ''), '*'));
  v_country text := upper(coalesce(nullif(p_rule->>'countryCode', ''), '*'));
  v_provider text := lower(coalesce(nullif(p_rule->>'provider', ''), '*'));
  v_feature text := coalesce(nullif(p_rule->>'aiFeature', ''), '*');
  v_model text := coalesce(nullif(p_rule->>'aiModel', ''), '*');
  v_from timestamptz := coalesce(nullif(p_rule->>'effectiveFrom', '')::timestamptz, now());
begin
  if p_admin_user_id is null
    or not exists (select 1 from public.platform_admins where user_id = p_admin_user_id) then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('wallet_pricing_rules'));

  select * into v_old
  from public.wallet_pricing_rules
  where service = v_service
    and organization_id is not distinct from v_org
    and whatsapp_category = v_category
    and country_code = v_country
    and provider = v_provider
    and ai_feature = v_feature
    and ai_model = v_model
    and effective_to is null
  for update;

  if v_old.id is not null and v_from <= v_old.effective_from then
    return jsonb_build_object('status', 'EFFECTIVE_FROM_TOO_EARLY', 'currentRuleId', v_old.id);
  end if;

  if v_old.id is not null then
    update public.wallet_pricing_rules set effective_to = v_from where id = v_old.id;
  end if;

  insert into public.wallet_pricing_rules (
    service, organization_id, whatsapp_category, country_code, provider, ai_feature, ai_model,
    per_unit_micros, per_1k_input_tokens_micros, per_1k_output_tokens_micros,
    markup_bps, discount_bps, effective_from, note, created_by
  ) values (
    v_service, v_org, v_category, v_country, v_provider, v_feature, v_model,
    coalesce((p_rule->>'perUnitMicros')::bigint, 0),
    coalesce((p_rule->>'per1kInputTokensMicros')::bigint, 0),
    coalesce((p_rule->>'per1kOutputTokensMicros')::bigint, 0),
    coalesce((p_rule->>'markupBps')::integer, 0),
    coalesce((p_rule->>'discountBps')::integer, 0),
    v_from,
    nullif(btrim(coalesce(p_rule->>'note', '')), ''),
    p_admin_user_id
  )
  returning * into v_new;

  if v_old.id is not null then
    update public.wallet_pricing_rules set superseded_by = v_new.id where id = v_old.id;
  end if;

  return jsonb_build_object('status', 'OK', 'ruleId', v_new.id, 'supersededRuleId', v_old.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Holds and charges
-- ---------------------------------------------------------------------------

create or replace function public.wallet_reserve(
  p_org uuid,
  p_service text,
  p_amount_micros bigint,
  p_idempotency_key text,
  p_reference_type text default null,
  p_reference_id text default null,
  p_pricing_rule_id uuid default null,
  p_ttl_seconds integer default 86400,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_reservations;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_key is null then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  if coalesce(p_amount_micros, 0) <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  if p_service not in ('whatsapp', 'ai') then
    raise exception 'unknown service' using errcode = '22023';
  end if;

  w := public.wallet__lock(p_org);

  select * into r from public.wallet_reservations where wallet_id = w.id and idempotency_key = v_key;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'reservationId', r.id, 'reservationStatus', r.status)
      || public.wallet__snapshot(w);
  end if;

  if w.status = 'FROZEN' then
    return jsonb_build_object('status', 'WALLET_FROZEN') || public.wallet__snapshot(w);
  end if;
  if w.balance_micros + w.credit_limit_micros - w.reserved_micros < p_amount_micros then
    return jsonb_build_object('status', 'INSUFFICIENT_BALANCE', 'requiredMicros', p_amount_micros::text)
      || public.wallet__snapshot(w);
  end if;

  insert into public.wallet_reservations (
    wallet_id, organization_id, service, amount_micros, idempotency_key,
    reference_type, reference_id, pricing_rule_id, metadata, expires_at
  ) values (
    w.id, w.organization_id, p_service, p_amount_micros, v_key,
    p_reference_type, p_reference_id, p_pricing_rule_id, coalesce(p_metadata, '{}'::jsonb),
    now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 86400), 604800)))
  )
  returning * into r;

  w := public.wallet__hold(w.id, p_amount_micros);
  return jsonb_build_object('status', 'HELD', 'reservationId', r.id) || public.wallet__snapshot(w);
end;
$$;

-- Charges up to the held amount (AI settles to actual tokens) and frees the rest.
create or replace function public.wallet_capture(
  p_reservation_id uuid,
  p_amount_micros bigint,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_pricing_rule_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_reservations;
  l public.wallet_ledger;
  v_org uuid;
begin
  select organization_id into v_org from public.wallet_reservations where id = p_reservation_id;
  if v_org is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  w := public.wallet__lock(v_org);
  select * into r from public.wallet_reservations where id = p_reservation_id for update;

  if r.status = 'CAPTURED' then
    return jsonb_build_object('status', 'DUPLICATE', 'ledgerId', r.ledger_id,
      'capturedMicros', r.captured_micros::text) || public.wallet__snapshot(w);
  end if;
  if r.status <> 'HELD' then
    return jsonb_build_object('status', 'NOT_HELD', 'reservationStatus', r.status) || public.wallet__snapshot(w);
  end if;
  if p_amount_micros is null or p_amount_micros < 0 then
    raise exception 'capture amount must be zero or more' using errcode = '22023';
  end if;
  if p_amount_micros > r.amount_micros then
    return jsonb_build_object('status', 'EXCEEDS_HOLD', 'heldMicros', r.amount_micros::text)
      || public.wallet__snapshot(w);
  end if;

  if p_amount_micros = 0 then
    w := public.wallet__hold(w.id, -r.amount_micros);
    update public.wallet_reservations
    set status = 'RELEASED', captured_micros = 0, release_reason = 'zero_charge', settled_at = now()
    where id = r.id;
    return jsonb_build_object('status', 'RELEASED') || public.wallet__snapshot(w);
  end if;

  l := public.wallet__post(
    w.id,
    case when r.service = 'whatsapp' then 'USAGE_WHATSAPP' else 'USAGE_AI' end,
    -p_amount_micros,
    'capture:' || r.id::text,
    r.service,
    r.reference_type,
    r.reference_id,
    r.id,
    coalesce(p_pricing_rule_id, r.pricing_rule_id),
    null,
    p_description,
    coalesce(r.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    -r.amount_micros
  );

  update public.wallet_reservations
  set status = 'CAPTURED', captured_micros = p_amount_micros, ledger_id = l.id, settled_at = now(),
      pricing_rule_id = coalesce(p_pricing_rule_id, pricing_rule_id)
  where id = r.id;

  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'CAPTURED', 'ledgerId', l.id, 'capturedMicros', p_amount_micros::text)
    || public.wallet__snapshot(w);
end;
$$;

create or replace function public.wallet_release(p_reservation_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_reservations;
  v_org uuid;
begin
  select organization_id into v_org from public.wallet_reservations where id = p_reservation_id;
  if v_org is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  w := public.wallet__lock(v_org);
  select * into r from public.wallet_reservations where id = p_reservation_id for update;

  if r.status in ('RELEASED', 'EXPIRED') then
    return jsonb_build_object('status', 'DUPLICATE', 'reservationStatus', r.status) || public.wallet__snapshot(w);
  end if;
  if r.status = 'CAPTURED' then
    return jsonb_build_object('status', 'ALREADY_CAPTURED', 'ledgerId', r.ledger_id) || public.wallet__snapshot(w);
  end if;

  w := public.wallet__hold(w.id, -r.amount_micros);
  update public.wallet_reservations
  set status = 'RELEASED', release_reason = left(coalesce(p_reason, 'released'), 200), settled_at = now()
  where id = r.id;
  return jsonb_build_object('status', 'RELEASED') || public.wallet__snapshot(w);
end;
$$;

-- An immediate charge for usage that is already verified (reserve + capture in one step).
create or replace function public.wallet_debit(
  p_org uuid,
  p_service text,
  p_amount_micros bigint,
  p_idempotency_key text,
  p_reference_type text default null,
  p_reference_id text default null,
  p_pricing_rule_id uuid default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  l public.wallet_ledger;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_key is null then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  if coalesce(p_amount_micros, 0) <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  if p_service not in ('whatsapp', 'ai') then
    raise exception 'unknown service' using errcode = '22023';
  end if;

  w := public.wallet__lock(p_org);
  select * into l from public.wallet_ledger where wallet_id = w.id and idempotency_key = 'debit:' || v_key;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'ledgerId', l.id) || public.wallet__snapshot(w);
  end if;
  if w.status = 'FROZEN' then
    return jsonb_build_object('status', 'WALLET_FROZEN') || public.wallet__snapshot(w);
  end if;
  if w.balance_micros + w.credit_limit_micros - w.reserved_micros < p_amount_micros then
    return jsonb_build_object('status', 'INSUFFICIENT_BALANCE', 'requiredMicros', p_amount_micros::text)
      || public.wallet__snapshot(w);
  end if;

  l := public.wallet__post(
    w.id,
    case when p_service = 'whatsapp' then 'USAGE_WHATSAPP' else 'USAGE_AI' end,
    -p_amount_micros,
    'debit:' || v_key,
    p_service, p_reference_type, p_reference_id, null, p_pricing_rule_id, null,
    p_description, p_metadata
  );
  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'CHARGED', 'ledgerId', l.id) || public.wallet__snapshot(w);
end;
$$;

-- Credits back a usage charge that turned out not to be billable.
create or replace function public.wallet_reverse_usage(
  p_ledger_id uuid,
  p_reason text,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  src public.wallet_ledger;
  l public.wallet_ledger;
begin
  select * into src from public.wallet_ledger where id = p_ledger_id;
  if not found or src.entry_type not in ('USAGE_WHATSAPP', 'USAGE_AI') then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  w := public.wallet__lock(src.organization_id);
  select * into l from public.wallet_ledger
  where wallet_id = w.id and idempotency_key = 'reverse:' || src.id::text;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'ledgerId', l.id) || public.wallet__snapshot(w);
  end if;
  l := public.wallet__post(
    w.id, 'USAGE_REVERSAL', -src.amount_micros, 'reverse:' || src.id::text,
    src.service, src.reference_type, src.reference_id, src.reservation_id, src.pricing_rule_id,
    p_actor, left(coalesce(p_reason, 'Usage reversed'), 200),
    jsonb_build_object('reversedLedgerId', src.id)
  );
  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'REVERSED', 'ledgerId', l.id) || public.wallet__snapshot(w);
end;
$$;

create or replace function public.wallet_expire_reservations(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  w public.wallets;
  r public.wallet_reservations;
  v_count integer := 0;
begin
  for rec in
    select id, organization_id from public.wallet_reservations
    where status = 'HELD' and expires_at <= now()
    order by expires_at
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    w := public.wallet__lock(rec.organization_id);
    select * into r from public.wallet_reservations where id = rec.id for update;
    if r.status = 'HELD' and r.expires_at <= now() then
      w := public.wallet__hold(w.id, -r.amount_micros);
      update public.wallet_reservations
      set status = 'EXPIRED', release_reason = 'expired', settled_at = now()
      where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recharges
-- ---------------------------------------------------------------------------

-- Called from the verified checkout callback and from the webhook; whichever
-- arrives first credits, the other gets DUPLICATE.
create or replace function public.wallet_fulfill_recharge(
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_amount_paise bigint,
  p_method text default null,
  p_expected_org uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.wallet_recharge_orders;
  w public.wallets;
  l public.wallet_ledger;
  v_org uuid;
begin
  select organization_id into v_org from public.wallet_recharge_orders where razorpay_order_id = p_razorpay_order_id;
  if v_org is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if p_expected_org is not null and p_expected_org <> v_org then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;

  w := public.wallet__lock(v_org);
  select * into o from public.wallet_recharge_orders where razorpay_order_id = p_razorpay_order_id for update;

  if o.status in ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    return jsonb_build_object('status', 'DUPLICATE', 'rechargeOrderId', o.id, 'ledgerId', o.ledger_id)
      || public.wallet__snapshot(w);
  end if;
  if p_amount_paise is distinct from o.amount_paise then
    return jsonb_build_object('status', 'AMOUNT_MISMATCH', 'rechargeOrderId', o.id);
  end if;
  if nullif(btrim(coalesce(p_razorpay_payment_id, '')), '') is null then
    raise exception 'razorpay payment id required' using errcode = '22023';
  end if;

  l := public.wallet__post(
    w.id, 'RECHARGE', o.credit_micros, 'recharge:' || o.id::text,
    null, 'wallet_recharge_order', o.id::text, null, null, o.created_by,
    'Wallet recharge',
    jsonb_build_object(
      'razorpayOrderId', o.razorpay_order_id,
      'razorpayPaymentId', p_razorpay_payment_id,
      'amountPaise', o.amount_paise,
      'taxPaise', o.tax_paise
    )
  );

  update public.wallet_recharge_orders
  set status = 'PAID', razorpay_payment_id = p_razorpay_payment_id, method = coalesce(p_method, method),
      paid_at = now(), failure_reason = null, ledger_id = l.id
  where id = o.id;

  if o.payment_id is not null then
    update public.payments
    set status = 'CAPTURED', razorpay_payment_id = p_razorpay_payment_id, method = coalesce(p_method, method),
        paid_at = coalesce(paid_at, now()), failure_reason = null
    where id = o.payment_id and status <> 'CAPTURED';
  end if;

  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'CREDITED', 'rechargeOrderId', o.id, 'ledgerId', l.id,
    'creditMicros', o.credit_micros::text) || public.wallet__snapshot(w);
end;
$$;

create or replace function public.wallet_mark_recharge_failed(p_razorpay_order_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.wallet_recharge_orders;
begin
  update public.wallet_recharge_orders
  set status = 'FAILED', failure_reason = left(coalesce(p_reason, 'Payment failed'), 300), last_checked_at = now()
  where razorpay_order_id = p_razorpay_order_id and status = 'CREATED'
  returning * into o;
  if o.id is null then
    return jsonb_build_object('status', 'UNCHANGED');
  end if;
  if o.payment_id is not null then
    update public.payments
    set status = 'FAILED', failure_reason = left(coalesce(p_reason, 'Payment failed'), 300)
    where id = o.payment_id and status = 'PENDING';
  end if;
  return jsonb_build_object('status', 'FAILED', 'rechargeOrderId', o.id);
end;
$$;

-- A Razorpay refund takes back the matching share of the credit. The share is
-- computed on the running refund total so partial refunds never drift. If the
-- tenant already spent the money, the balance goes negative and the wallet freezes.
create or replace function public.wallet_reverse_recharge(
  p_razorpay_payment_id text,
  p_refund_id text,
  p_refund_paise bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.wallet_recharge_orders;
  w public.wallets;
  l public.wallet_ledger;
  v_org uuid;
  v_total bigint;
  v_target bigint;
  v_reverse bigint;
  v_key text := 'refund:' || coalesce(nullif(btrim(p_refund_id), ''), '');
begin
  if v_key = 'refund:' then
    raise exception 'refund id required' using errcode = '22023';
  end if;
  if coalesce(p_refund_paise, 0) <= 0 then
    raise exception 'refund amount must be positive' using errcode = '22023';
  end if;

  select organization_id into v_org from public.wallet_recharge_orders where razorpay_payment_id = p_razorpay_payment_id;
  if v_org is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  w := public.wallet__lock(v_org);
  select * into o from public.wallet_recharge_orders where razorpay_payment_id = p_razorpay_payment_id for update;

  if exists (select 1 from public.wallet_ledger where wallet_id = w.id and idempotency_key = v_key) then
    return jsonb_build_object('status', 'DUPLICATE', 'rechargeOrderId', o.id) || public.wallet__snapshot(w);
  end if;
  if o.status not in ('PAID', 'PARTIALLY_REFUNDED') then
    return jsonb_build_object('status', 'NOT_PAID', 'rechargeStatus', o.status);
  end if;

  v_total := least(o.amount_paise, o.refunded_paise + p_refund_paise);
  v_target := case when v_total = o.amount_paise then o.credit_micros
                   else (o.credit_micros * v_total) / o.amount_paise end;
  v_reverse := v_target - o.reversed_micros;

  if v_reverse > 0 then
    l := public.wallet__post(
      w.id, 'RECHARGE_REVERSAL', -v_reverse, v_key,
      null, 'wallet_recharge_order', o.id::text, null, null, null,
      'Recharge refunded',
      jsonb_build_object('razorpayRefundId', p_refund_id, 'refundPaise', p_refund_paise),
      0, true
    );
  end if;

  update public.wallet_recharge_orders
  set refunded_paise = v_total,
      reversed_micros = v_target,
      status = case when v_total = amount_paise then 'REFUNDED' else 'PARTIALLY_REFUNDED' end
  where id = o.id;

  if v_total = o.amount_paise and o.payment_id is not null then
    update public.payments set status = 'REFUNDED', refunded_at = coalesce(refunded_at, now())
    where id = o.payment_id;
  end if;

  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'REVERSED', 'reversedMicros', greatest(v_reverse, 0)::text,
    'frozen', w.status = 'FROZEN') || public.wallet__snapshot(w);
end;
$$;

-- ---------------------------------------------------------------------------
-- Super Admin
-- ---------------------------------------------------------------------------

create or replace function public.wallet_admin_adjust(
  p_org uuid,
  p_kind text,
  p_amount_micros bigint,
  p_reason text,
  p_admin_user_id uuid,
  p_admin_email text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  l public.wallet_ledger;
  a public.wallet_adjustments;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_type text;
  v_amount bigint;
begin
  if p_admin_user_id is null
    or not exists (select 1 from public.platform_admins where user_id = p_admin_user_id) then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  if coalesce(p_amount_micros, 0) <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'reason must be at least 10 characters' using errcode = '22023';
  end if;

  v_type := case p_kind
    when 'PROMO' then 'PROMO_CREDIT'
    when 'REFUND' then 'ADMIN_REFUND'
    when 'MANUAL_CREDIT' then 'ADMIN_CREDIT'
    when 'MANUAL_DEBIT' then 'ADMIN_DEBIT'
  end;
  if v_type is null then
    raise exception 'unknown adjustment kind' using errcode = '22023';
  end if;
  v_amount := case when p_kind = 'MANUAL_DEBIT' then -p_amount_micros else p_amount_micros end;

  w := public.wallet__lock(p_org);

  select * into a from public.wallet_adjustments where idempotency_key = v_key;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'adjustmentId', a.id, 'ledgerId', a.ledger_id)
      || public.wallet__snapshot(w);
  end if;

  if p_kind = 'MANUAL_DEBIT'
    and w.balance_micros + w.credit_limit_micros - w.reserved_micros < p_amount_micros then
    return jsonb_build_object('status', 'INSUFFICIENT_BALANCE') || public.wallet__snapshot(w);
  end if;

  l := public.wallet__post(
    w.id, v_type, v_amount, 'adjust:' || v_key,
    null, 'wallet_adjustment', null, null, null, p_admin_user_id,
    btrim(p_reason), jsonb_build_object('kind', p_kind)
  );

  insert into public.wallet_adjustments (
    wallet_id, organization_id, kind, amount_micros, reason, admin_user_id, admin_email, idempotency_key, ledger_id
  ) values (
    w.id, w.organization_id, p_kind, p_amount_micros, btrim(p_reason), p_admin_user_id,
    nullif(btrim(coalesce(p_admin_email, '')), ''), v_key, l.id
  )
  returning * into a;

  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'ADJUSTED', 'adjustmentId', a.id, 'ledgerId', l.id)
    || public.wallet__snapshot(w);
end;
$$;

-- Freezes or unfreezes a wallet. A wallet can only be unfrozen once its
-- balance covers its holds again (for example after a recharge or credit).
create or replace function public.wallet_set_status(
  p_org uuid,
  p_status text,
  p_reason text,
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  v_from text;
begin
  if p_admin_user_id is null
    or not exists (select 1 from public.platform_admins where user_id = p_admin_user_id) then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if p_status not in ('ACTIVE', 'FROZEN') then
    raise exception 'unknown wallet status' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'reason must be at least 10 characters' using errcode = '22023';
  end if;

  w := public.wallet__lock(p_org);
  v_from := w.status;
  if v_from = p_status then
    return jsonb_build_object('status', 'UNCHANGED') || public.wallet__snapshot(w);
  end if;
  if p_status = 'ACTIVE' and w.balance_micros + w.credit_limit_micros < w.reserved_micros then
    return jsonb_build_object('status', 'BALANCE_SHORT') || public.wallet__snapshot(w);
  end if;

  update public.wallets set status = p_status, version = version + 1 where id = w.id returning * into w;
  insert into public.wallet_status_events (wallet_id, organization_id, from_status, to_status, reason, admin_user_id)
  values (w.id, w.organization_id, v_from, p_status, btrim(p_reason), p_admin_user_id);
  return jsonb_build_object('status', 'UPDATED') || public.wallet__snapshot(w);
end;
$$;

-- Records every wallet whose balance or hold total disagrees with its rows.
-- It never changes a balance; a person resolves each issue.
create or replace function public.wallet_reconcile(p_org uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_count integer := 0;
begin
  for rec in
    select w.id, w.organization_id, w.balance_micros, w.reserved_micros,
      coalesce((select sum(l.amount_micros) from public.wallet_ledger l where l.wallet_id = w.id), 0)::bigint as ledger_sum,
      coalesce((select sum(r.amount_micros) from public.wallet_reservations r
        where r.wallet_id = w.id and r.status = 'HELD'), 0)::bigint as held_sum
    from public.wallets w
    where p_org is null or w.organization_id = p_org
  loop
    if rec.balance_micros <> rec.ledger_sum or rec.reserved_micros <> rec.held_sum then
      v_count := v_count + 1;
      insert into public.wallet_reconciliation_issues (
        wallet_id, organization_id, balance_micros, ledger_sum_micros, reserved_micros, held_sum_micros
      ) values (
        rec.id, rec.organization_id, rec.balance_micros, rec.ledger_sum, rec.reserved_micros, rec.held_sum
      )
      on conflict (wallet_id) where resolved_at is null do update
      set balance_micros = excluded.balance_micros,
          ledger_sum_micros = excluded.ledger_sum_micros,
          reserved_micros = excluded.reserved_micros,
          held_sum_micros = excluded.held_sum_micros,
          detected_at = now();
    end if;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- New tenants and the AI credit cutover
-- ---------------------------------------------------------------------------

create or replace function public.wallet__org_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce((select wallet_signup_promo_enabled from public.platform_settings where id = 1), false) then
    new.ai_credits_balance := 0;
  end if;
  return new;
end;
$$;

create or replace function public.wallet__org_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  v_enabled boolean;
  v_promo bigint;
begin
  w := public.wallet__lock(new.id);
  select wallet_signup_promo_enabled, wallet_signup_promo_micros into v_enabled, v_promo
  from public.platform_settings where id = 1;
  if coalesce(v_enabled, false) then
    -- New tenants have no legacy credits to move.
    update public.wallets set ai_credits_migrated_at = now() where id = w.id;
    if coalesce(v_promo, 0) > 0 then
      perform public.wallet__post(
        w.id, 'PROMO_CREDIT', v_promo, 'signup_promo',
        null, 'signup', null, null, null, null, 'Welcome credit'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_wallet_before_insert on public.organizations;
create trigger organizations_wallet_before_insert before insert on public.organizations
  for each row execute function public.wallet__org_before_insert();
drop trigger if exists organizations_wallet_after_insert on public.organizations;
create trigger organizations_wallet_after_insert after insert on public.organizations
  for each row execute function public.wallet__org_after_insert();

-- Moves one organization's legacy AI credits into its wallet, exactly once.
-- Refuses while an AI image job still holds credits, because releasing that
-- hold later would put credits back into the old balance.
create or replace function public.wallet_migrate_ai_credits(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  v_credits integer;
  v_rate bigint;
  v_micros bigint;
begin
  select coalesce(ai_credits_balance, 0) into v_credits
  from public.organizations where id = p_org for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  w := public.wallet__lock(p_org);
  if w.ai_credits_migrated_at is not null then
    return jsonb_build_object('status', 'DUPLICATE') || public.wallet__snapshot(w);
  end if;
  if exists (
    select 1 from public.ai_credit_ledger where organization_id = p_org and status = 'RESERVED'
  ) then
    return jsonb_build_object('status', 'RESERVATIONS_PENDING');
  end if;

  v_rate := coalesce((select wallet_ai_credit_rate_micros from public.platform_settings where id = 1), 200000);
  v_micros := v_credits::bigint * v_rate;

  if v_credits > 0 then
    update public.organizations set ai_credits_balance = 0, updated_at = now() where id = p_org;
    insert into public.ai_credit_ledger (
      organization_id, type, reason_code, delta, balance_after, status, idempotency_key, metadata
    ) values (
      p_org, 'MIGRATED_TO_WALLET', 'MIGRATED_TO_WALLET', -v_credits, 0, 'POSTED', 'wallet-migration',
      jsonb_build_object('rateMicros', v_rate, 'walletMicros', v_micros)
    );
  end if;

  if v_micros > 0 then
    perform public.wallet__post(
      w.id, 'MIGRATION_OPENING', v_micros, 'migration:ai_credits',
      'ai', 'ai_credits', p_org::text, null, null, null,
      'AI credits moved to wallet',
      jsonb_build_object('credits', v_credits, 'rateMicros', v_rate)
    );
  end if;

  update public.wallets set ai_credits_migrated_at = now() where id = w.id;
  select * into w from public.wallets where id = w.id;
  return jsonb_build_object('status', 'MIGRATED', 'credits', v_credits, 'creditedMicros', v_micros::text)
    || public.wallet__snapshot(w);
end;
$$;

create or replace function public.wallet_migrate_all_ai_credits(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_result jsonb;
  v_migrated integer := 0;
  v_pending integer := 0;
begin
  for rec in
    select o.id from public.organizations o
    left join public.wallets w on w.organization_id = o.id
    where w.ai_credits_migrated_at is null
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    v_result := public.wallet_migrate_ai_credits(rec.id);
    if v_result->>'status' = 'MIGRATED' then
      v_migrated := v_migrated + 1;
    elsif v_result->>'status' = 'RESERVATIONS_PENDING' then
      v_pending := v_pending + 1;
    end if;
  end loop;
  return jsonb_build_object('migrated', v_migrated, 'pending', v_pending);
end;
$$;

-- Every existing organization gets an empty wallet now. Credits move at cutover.
insert into public.wallets (organization_id)
select o.id from public.organizations o
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.wallet_reservations enable row level security;
alter table public.wallet_recharge_orders enable row level security;
alter table public.wallet_pricing_rules enable row level security;
alter table public.wallet_adjustments enable row level security;
alter table public.wallet_alerts enable row level security;
alter table public.wallet_reconciliation_issues enable row level security;
alter table public.wallet_status_events enable row level security;

drop policy if exists wallets_tenant_select on public.wallets;
create policy wallets_tenant_select on public.wallets
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_ledger_tenant_select on public.wallet_ledger;
create policy wallet_ledger_tenant_select on public.wallet_ledger
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_reservations_tenant_select on public.wallet_reservations;
create policy wallet_reservations_tenant_select on public.wallet_reservations
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_recharge_orders_tenant_select on public.wallet_recharge_orders;
create policy wallet_recharge_orders_tenant_select on public.wallet_recharge_orders
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_alerts_tenant_select on public.wallet_alerts;
create policy wallet_alerts_tenant_select on public.wallet_alerts
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_pricing_rules_admin_select on public.wallet_pricing_rules;
create policy wallet_pricing_rules_admin_select on public.wallet_pricing_rules
  for select to authenticated using (public.is_platform_admin());
drop policy if exists wallet_adjustments_admin_select on public.wallet_adjustments;
create policy wallet_adjustments_admin_select on public.wallet_adjustments
  for select to authenticated using (public.is_platform_admin());
drop policy if exists wallet_reconciliation_issues_admin_select on public.wallet_reconciliation_issues;
create policy wallet_reconciliation_issues_admin_select on public.wallet_reconciliation_issues
  for select to authenticated using (public.is_platform_admin());

drop policy if exists wallet_status_events_admin_select on public.wallet_status_events;
create policy wallet_status_events_admin_select on public.wallet_status_events
  for select to authenticated using (public.is_platform_admin());

-- Supabase grants table privileges to API roles by default; take writes away
-- so RLS is not the only thing between a client and a balance.
revoke all on public.wallets, public.wallet_ledger, public.wallet_reservations,
  public.wallet_recharge_orders, public.wallet_pricing_rules, public.wallet_adjustments,
  public.wallet_alerts, public.wallet_reconciliation_issues, public.wallet_status_events
  from anon, authenticated;
grant select on public.wallets, public.wallet_ledger, public.wallet_reservations,
  public.wallet_recharge_orders, public.wallet_pricing_rules, public.wallet_adjustments,
  public.wallet_alerts, public.wallet_reconciliation_issues, public.wallet_status_events
  to authenticated;
grant all on public.wallets, public.wallet_ledger, public.wallet_reservations,
  public.wallet_recharge_orders, public.wallet_pricing_rules, public.wallet_adjustments,
  public.wallet_alerts, public.wallet_reconciliation_issues, public.wallet_status_events
  to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet__guard_immutable()',
    'public.wallet__guard_pricing_rule()',
    'public.wallet__guard_balance()',
    'public.wallet__lock(uuid)',
    'public.wallet__evaluate_alerts(public.wallets)',
    'public.wallet__hold(uuid, bigint)',
    'public.wallet__post(uuid, text, bigint, text, text, text, text, uuid, uuid, uuid, text, jsonb, bigint, boolean)',
    'public.wallet__snapshot(public.wallets)',
    'public.wallet__org_before_insert()',
    'public.wallet__org_after_insert()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
  end loop;

  foreach fn in array array[
    'public.wallet_charge_micros(bigint, bigint, bigint, integer, integer, bigint, bigint, bigint)',
    'public.wallet_resolve_price(text, uuid, text, text, text, text, text, timestamptz)',
    'public.wallet_quote(text, uuid, text, text, text, text, text, bigint, bigint, bigint, timestamptz)',
    'public.wallet_set_pricing_rule(jsonb, uuid)',
    'public.wallet_reserve(uuid, text, bigint, text, text, text, uuid, integer, jsonb)',
    'public.wallet_capture(uuid, bigint, text, jsonb, uuid)',
    'public.wallet_release(uuid, text)',
    'public.wallet_debit(uuid, text, bigint, text, text, text, uuid, text, jsonb)',
    'public.wallet_reverse_usage(uuid, text, uuid)',
    'public.wallet_expire_reservations(integer)',
    'public.wallet_fulfill_recharge(text, text, bigint, text, uuid)',
    'public.wallet_mark_recharge_failed(text, text)',
    'public.wallet_reverse_recharge(text, text, bigint)',
    'public.wallet_admin_adjust(uuid, text, bigint, text, uuid, text, text)',
    'public.wallet_set_status(uuid, text, text, uuid)',
    'public.wallet_reconcile(uuid)',
    'public.wallet_migrate_ai_credits(uuid)',
    'public.wallet_migrate_all_ai_credits(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
