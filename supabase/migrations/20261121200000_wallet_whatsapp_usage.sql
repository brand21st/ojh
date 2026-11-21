-- Tenant wallet, phase 4: WhatsApp notices sent through the PostBus (platform)
-- VaChat account charge the merchant's wallet.
--
-- The notice's external_ref is the idempotency key. The price is held before
-- sending, charged when the provider reports delivered/read, and released on
-- failure, a non-billable report, or no confirmation within the hold window.
-- Merchants on their own WATI/VaChat, OTP and signup messages are not billed.
-- Nothing here charges anyone until Super Admin turns on
-- wallet_whatsapp_billing_enabled and sets per-category rates.

alter table public.platform_settings
  add column if not exists wallet_whatsapp_billing_enabled boolean not null default false,
  add column if not exists wallet_whatsapp_resume_hours integer not null default 24;

alter table public.platform_settings
  drop constraint if exists platform_settings_wallet_whatsapp_resume_chk;
alter table public.platform_settings
  add constraint platform_settings_wallet_whatsapp_resume_chk check (wallet_whatsapp_resume_hours between 0 and 168);

comment on column public.platform_settings.wallet_whatsapp_billing_enabled is
  'When true, notices sent through the platform VaChat account are charged to merchant wallets. Set the WhatsApp rates first.';
comment on column public.platform_settings.wallet_whatsapp_resume_hours is
  'Notices held for low balance are sent after a recharge only if they are younger than this.';

-- What a parked notice needs to be sent again after a recharge.
alter table public.vachat_notification_logs
  add column if not exists wallet_hold_payload jsonb;

create table if not exists public.whatsapp_usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  external_ref text not null,
  event text not null,
  category text not null default 'UTILITY',
  country_code text not null default '*',
  provider text not null default 'vachat',
  pricing_rule_id uuid references public.wallet_pricing_rules(id),
  hold_micros bigint,
  charge_micros bigint,
  status text not null,
  reject_reason text,
  free_allowance boolean not null default false,
  attempts integer not null default 0,
  reservation_id uuid references public.wallet_reservations(id) on delete set null,
  ledger_id uuid references public.wallet_ledger(id) on delete set null,
  provider_message_id text,
  whatsapp_message_id text,
  provider_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_usage_records_status_chk check (
    status in ('RESERVED', 'CHARGED', 'FREE', 'RELEASED', 'BLOCKED', 'UNCONFIRMED')
  ),
  constraint whatsapp_usage_records_category_chk check (
    category in ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE', 'OTHER')
  ),
  constraint whatsapp_usage_records_money_chk check (
    (hold_micros is null or hold_micros >= 0) and (charge_micros is null or charge_micros >= 0)
  ),
  constraint whatsapp_usage_records_ref_chk check (char_length(btrim(external_ref)) between 1 and 300),
  constraint whatsapp_usage_records_org_ref_uniq unique (organization_id, external_ref)
);

create index if not exists whatsapp_usage_records_org_created_idx
  on public.whatsapp_usage_records (organization_id, created_at desc);
create index if not exists whatsapp_usage_records_reserved_idx
  on public.whatsapp_usage_records (created_at)
  where status = 'RESERVED';

drop trigger if exists set_whatsapp_usage_records_updated_at on public.whatsapp_usage_records;
create trigger set_whatsapp_usage_records_updated_at before update on public.whatsapp_usage_records
  for each row execute function public.set_updated_at();

-- Free messages per calendar month (India time), global or per tenant.
-- The tenant row wins over the global one for the same category.
create table if not exists public.wallet_free_allowances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  whatsapp_category text not null,
  monthly_messages integer not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint wallet_free_allowances_category_chk check (
    whatsapp_category in ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE', 'OTHER')
  ),
  constraint wallet_free_allowances_qty_chk check (monthly_messages > 0),
  constraint wallet_free_allowances_window_chk check (effective_to is null or effective_to > effective_from)
);

-- Service conversations are free under Meta's pricing. Other categories have
-- no seeded rate on purpose: Super Admin enters the current rates.
insert into public.wallet_pricing_rules (service, whatsapp_category, per_unit_micros, effective_from, note)
select 'whatsapp', 'SERVICE', 0, '2026-01-01T00:00:00Z', 'Service conversations are free'
where not exists (
  select 1 from public.wallet_pricing_rules
  where service = 'whatsapp' and organization_id is null and whatsapp_category = 'SERVICE'
    and country_code = '*' and provider = '*'
);

create or replace function public.wallet_whatsapp_billing_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select wallet_whatsapp_billing_enabled from public.platform_settings where id = 1), false)
$$;

-- Holds the price of one notice before it is sent.
create or replace function public.wallet_whatsapp_reserve(
  p_org uuid,
  p_external_ref text,
  p_event text,
  p_category text default 'UTILITY',
  p_country_code text default '*',
  p_provider text default 'vachat',
  p_ttl_seconds integer default 259200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_pricing_rules;
  rec public.whatsapp_usage_records;
  v_ref text := nullif(btrim(coalesce(p_external_ref, '')), '');
  v_category text := upper(coalesce(nullif(p_category, ''), 'UTILITY'));
  v_country text := upper(coalesce(nullif(p_country_code, ''), '*'));
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_allowance integer;
  v_used integer;
  v_hold bigint;
  v_res jsonb;
begin
  if v_ref is null then
    raise exception 'external_ref required' using errcode = '22023';
  end if;
  if not public.wallet_whatsapp_billing_on() then
    return jsonb_build_object('status', 'BILLING_OFF');
  end if;
  w := public.wallet__lock(p_org);

  select * into rec from public.whatsapp_usage_records where organization_id = p_org and external_ref = v_ref for update;
  if found and rec.status in ('RESERVED', 'CHARGED', 'FREE') then
    return jsonb_build_object('status', 'DUPLICATE', 'recordId', rec.id, 'recordStatus', rec.status) || public.wallet__snapshot(w);
  end if;
  if not found then
    insert into public.whatsapp_usage_records (organization_id, wallet_id, external_ref, event, category, country_code, provider, status)
    values (p_org, w.id, v_ref, coalesce(p_event, 'notice'), v_category, v_country, lower(coalesce(p_provider, 'vachat')), 'BLOCKED')
    returning * into rec;
  end if;

  select a.monthly_messages into v_allowance
  from public.wallet_free_allowances a
  where (a.organization_id = p_org or a.organization_id is null)
    and a.whatsapp_category = v_category
    and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
  order by (a.organization_id is not null) desc, a.effective_from desc
  limit 1;
  if v_allowance is not null then
    select count(*) into v_used from public.whatsapp_usage_records
    where organization_id = p_org and category = v_category and free_allowance and created_at >= v_month_start;
    if v_used < v_allowance then
      update public.whatsapp_usage_records
      set status = 'FREE', free_allowance = true, charge_micros = 0, reject_reason = null, attempts = attempts + 1
      where id = rec.id;
      return jsonb_build_object('status', 'FREE', 'recordId', rec.id, 'freeAllowance', true) || public.wallet__snapshot(w);
    end if;
  end if;

  r := public.wallet_resolve_price('whatsapp', p_org, v_category, v_country, lower(coalesce(p_provider, 'vachat')), '*', '*', now());
  if r.id is null then
    -- No rate configured: never block a customer notice over missing configuration.
    update public.whatsapp_usage_records
    set status = 'FREE', charge_micros = 0, reject_reason = 'NO_PRICE', attempts = attempts + 1
    where id = rec.id;
    return jsonb_build_object('status', 'UNPRICED', 'recordId', rec.id) || public.wallet__snapshot(w);
  end if;
  v_hold := public.wallet_charge_micros(r.per_unit_micros, 0, 0, r.markup_bps, r.discount_bps, 1, 0, 0);
  if v_hold = 0 then
    update public.whatsapp_usage_records
    set status = 'FREE', charge_micros = 0, pricing_rule_id = r.id, reject_reason = null, attempts = attempts + 1
    where id = rec.id;
    return jsonb_build_object('status', 'FREE', 'recordId', rec.id) || public.wallet__snapshot(w);
  end if;

  -- Each attempt gets its own hold key, so a notice released earlier can be held again.
  v_res := public.wallet_reserve(p_org, 'whatsapp', v_hold, 'wa:' || rec.id::text || ':' || (rec.attempts + 1)::text,
    'whatsapp_usage', rec.id::text, r.id, p_ttl_seconds,
    jsonb_build_object('event', p_event, 'category', v_category, 'externalRef', v_ref));

  if v_res->>'status' = 'HELD' then
    update public.whatsapp_usage_records
    set status = 'RESERVED', reject_reason = null, hold_micros = v_hold, pricing_rule_id = r.id,
        reservation_id = (v_res->>'reservationId')::uuid, attempts = attempts + 1
    where id = rec.id;
    return jsonb_build_object('status', 'HELD', 'recordId', rec.id, 'holdMicros', v_hold::text) || public.wallet__snapshot(public.wallet__lock(p_org));
  end if;

  update public.whatsapp_usage_records
  set status = 'BLOCKED', reject_reason = v_res->>'status', hold_micros = v_hold, pricing_rule_id = r.id, attempts = attempts + 1
  where id = rec.id;
  return jsonb_build_object('status', v_res->>'status', 'recordId', rec.id, 'holdMicros', v_hold::text) || public.wallet__snapshot(w);
end;
$$;

-- Applies one provider status to a notice. Safe to call for every webhook,
-- including retries and out-of-order deliveries.
--   p_outcome: 'sent' | 'delivered' | 'read' | 'failed' | 'not_billable' | 'send_error'
create or replace function public.wallet_whatsapp_settle(
  p_org uuid,
  p_external_ref text,
  p_outcome text,
  p_category text default null,
  p_provider_message_id text default null,
  p_whatsapp_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  rec public.whatsapp_usage_records;
  r public.wallet_pricing_rules;
  v_outcome text := lower(coalesce(p_outcome, ''));
  v_category text := upper(nullif(btrim(coalesce(p_category, '')), ''));
  v_charge bigint;
  v_cap jsonb;
  v_debit jsonb;
begin
  w := public.wallet__lock(p_org);
  select * into rec from public.whatsapp_usage_records
  where organization_id = p_org and external_ref = btrim(coalesce(p_external_ref, '')) for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  update public.whatsapp_usage_records
  set provider_status = coalesce(nullif(v_outcome, ''), provider_status),
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      whatsapp_message_id = coalesce(p_whatsapp_message_id, whatsapp_message_id),
      category = case when v_category in ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE', 'OTHER') then v_category else category end
  where id = rec.id
  returning * into rec;

  if v_outcome in ('failed', 'not_billable', 'send_error') then
    if rec.status = 'RESERVED' then
      perform public.wallet_release(rec.reservation_id, v_outcome);
      update public.whatsapp_usage_records set status = 'RELEASED', reject_reason = v_outcome where id = rec.id;
      return jsonb_build_object('status', 'RELEASED', 'recordId', rec.id);
    end if;
    -- Already charged for a delivery: a later failure report does not undo a billed message.
    return jsonb_build_object('status', 'DUPLICATE', 'recordStatus', rec.status);
  end if;

  if v_outcome not in ('delivered', 'read') then
    return jsonb_build_object('status', 'PENDING', 'recordStatus', rec.status);
  end if;

  if rec.status in ('CHARGED', 'FREE', 'BLOCKED') then
    return jsonb_build_object('status', 'DUPLICATE', 'recordStatus', rec.status);
  end if;

  -- Price at the category the provider reported, never above what was held.
  if rec.status = 'RESERVED' then
    select * into r from public.wallet_pricing_rules where id = rec.pricing_rule_id;
    v_charge := rec.hold_micros;
    if v_category is not null then
      r := public.wallet_resolve_price('whatsapp', p_org, rec.category, rec.country_code, rec.provider, '*', '*', rec.created_at);
      if r.id is not null then
        v_charge := least(rec.hold_micros, public.wallet_charge_micros(r.per_unit_micros, 0, 0, r.markup_bps, r.discount_bps, 1, 0, 0));
      end if;
    end if;
    v_cap := public.wallet_capture(rec.reservation_id, v_charge, 'WhatsApp ' || replace(rec.event, '_', ' '),
      jsonb_build_object('externalRef', rec.external_ref, 'category', rec.category), r.id);
    if v_cap->>'status' in ('CAPTURED', 'RELEASED', 'DUPLICATE') then
      update public.whatsapp_usage_records
      set status = case when v_charge = 0 then 'FREE' else 'CHARGED' end, charge_micros = v_charge,
          ledger_id = nullif(v_cap->>'ledgerId', '')::uuid, pricing_rule_id = coalesce(r.id, pricing_rule_id)
      where id = rec.id;
      return jsonb_build_object('status', 'CHARGED', 'recordId', rec.id, 'chargeMicros', v_charge::text);
    end if;
    -- The hold expired before the delivery report arrived: fall through to a direct charge.
  end if;

  -- Delivered after its hold was released (late webhook): charge directly if the balance allows.
  select * into r from public.wallet_pricing_rules where id = rec.pricing_rule_id;
  if r.id is null then
    return jsonb_build_object('status', 'DUPLICATE', 'recordStatus', rec.status);
  end if;
  v_charge := coalesce(rec.hold_micros, public.wallet_charge_micros(r.per_unit_micros, 0, 0, r.markup_bps, r.discount_bps, 1, 0, 0));
  v_debit := public.wallet_debit(p_org, 'whatsapp', v_charge, 'wa:' || rec.id::text, 'whatsapp_usage', rec.id::text, r.id,
    'WhatsApp ' || replace(rec.event, '_', ' '), jsonb_build_object('externalRef', rec.external_ref, 'late', true));
  if v_debit->>'status' in ('CHARGED', 'DUPLICATE') then
    update public.whatsapp_usage_records
    set status = 'CHARGED', charge_micros = v_charge, ledger_id = (v_debit->>'ledgerId')::uuid
    where id = rec.id;
    return jsonb_build_object('status', 'CHARGED', 'recordId', rec.id, 'chargeMicros', v_charge::text, 'late', true);
  end if;
  update public.whatsapp_usage_records set reject_reason = 'late_delivery_' || lower(v_debit->>'status') where id = rec.id;
  return jsonb_build_object('status', 'UNPAID', 'recordId', rec.id, 'reason', v_debit->>'status');
end;
$$;

-- Notices whose hold ran out without a delivery report are not charged.
create or replace function public.wallet_whatsapp_expire(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    select u.id
    from public.whatsapp_usage_records u
    join public.wallet_reservations r on r.id = u.reservation_id
    where u.status = 'RESERVED' and r.status in ('EXPIRED', 'RELEASED')
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  )
  update public.whatsapp_usage_records u
  set status = 'UNCONFIRMED', reject_reason = 'no_delivery_report'
  from stale where u.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.whatsapp_usage_records enable row level security;
alter table public.wallet_free_allowances enable row level security;
drop policy if exists whatsapp_usage_records_tenant_select on public.whatsapp_usage_records;
create policy whatsapp_usage_records_tenant_select on public.whatsapp_usage_records
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
drop policy if exists wallet_free_allowances_admin_select on public.wallet_free_allowances;
create policy wallet_free_allowances_admin_select on public.wallet_free_allowances
  for select to authenticated using (public.is_platform_admin());
revoke all on public.whatsapp_usage_records, public.wallet_free_allowances from anon, authenticated;
grant select on public.whatsapp_usage_records, public.wallet_free_allowances to authenticated;
grant all on public.whatsapp_usage_records, public.wallet_free_allowances to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_whatsapp_billing_on()',
    'public.wallet_whatsapp_reserve(uuid, text, text, text, text, text, integer)',
    'public.wallet_whatsapp_settle(uuid, text, text, text, text, text)',
    'public.wallet_whatsapp_expire(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
