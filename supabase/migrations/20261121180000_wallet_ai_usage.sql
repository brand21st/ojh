-- Tenant wallet, phase 3: AI features charge the wallet.
--
-- Every AI operation writes one ai_usage_records row keyed by the caller's
-- idempotency key, so a retried operation is never charged twice. Prices come
-- from wallet_pricing_rules (service 'ai'): a fixed amount per operation plus
-- optional per-1k-token rates, per feature and model, with tenant overrides.
-- An organization is billed here only after wallet_migrate_ai_credits has run
-- for it; until then the legacy AI credit functions keep working unchanged.

create table if not exists public.ai_usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  feature text not null,
  model text not null default '*',
  provider text not null default 'openrouter',
  units bigint not null default 1,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  pricing_rule_id uuid references public.wallet_pricing_rules(id),
  hold_micros bigint,
  charge_micros bigint,
  status text not null,
  reject_reason text,
  idempotency_key text not null,
  reservation_id uuid references public.wallet_reservations(id) on delete set null,
  ledger_id uuid references public.wallet_ledger(id) on delete set null,
  parent_operation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_usage_records_status_chk check (
    status in ('RESERVED', 'CHARGED', 'FREE', 'RELEASED', 'REJECTED', 'ABANDONED')
  ),
  constraint ai_usage_records_counts_chk check (units >= 0 and input_tokens >= 0 and output_tokens >= 0),
  constraint ai_usage_records_money_chk check (
    (hold_micros is null or hold_micros >= 0) and (charge_micros is null or charge_micros >= 0)
  ),
  constraint ai_usage_records_feature_chk check (char_length(feature) between 1 and 80),
  constraint ai_usage_records_key_chk check (char_length(btrim(idempotency_key)) between 1 and 200),
  constraint ai_usage_records_org_key_uniq unique (organization_id, idempotency_key)
);

create index if not exists ai_usage_records_org_created_idx
  on public.ai_usage_records (organization_id, created_at desc);
create index if not exists ai_usage_records_feature_created_idx
  on public.ai_usage_records (feature, created_at desc);
create index if not exists ai_usage_records_reserved_idx
  on public.ai_usage_records (created_at)
  where status = 'RESERVED';

drop trigger if exists set_ai_usage_records_updated_at on public.ai_usage_records;
create trigger set_ai_usage_records_updated_at before update on public.ai_usage_records
  for each row execute function public.set_updated_at();

-- Today's AI credit prices, at Rs 0.20 per credit, so switching an organization
-- to the wallet does not change what anything costs. Super Admin can version
-- these later, including per-token rates.
insert into public.wallet_pricing_rules (service, ai_feature, per_unit_micros, effective_from, note)
select 'ai', feature, micros, '2026-01-01T00:00:00Z', 'Seeded from AI credit prices (Rs 0.20 per credit)'
from (values
  ('*', 200000::bigint),
  ('data_extraction', 200000::bigint),
  ('address_checker', 200000::bigint),
  ('address_validation', 200000::bigint),
  ('product_copy', 200000::bigint),
  ('cover_copy', 200000::bigint),
  ('prompt_enhance', 200000::bigint),
  ('order_error_explain', 200000::bigint),
  ('image_studio', 2000000::bigint),
  ('cover_studio', 2000000::bigint)
) as seed(feature, micros)
where not exists (
  select 1 from public.wallet_pricing_rules r
  where r.service = 'ai' and r.organization_id is null and r.ai_feature = seed.feature
    and r.ai_model = '*' and r.provider = '*'
);

-- Wallet billing applies to an organization once its credits have moved.
create or replace function public.wallet_ai_mode(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.wallets where organization_id = p_org and ai_credits_migrated_at is not null
  ) then 'wallet' else 'credits' end
$$;

-- Price of one operation before it runs, and whether the wallet can pay it.
create or replace function public.wallet_ai_quote(
  p_org uuid,
  p_feature text,
  p_model text default '*',
  p_units bigint default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q jsonb;
  w public.wallets;
begin
  q := public.wallet_quote('ai', p_org, '*', '*', '*', p_feature, coalesce(p_model, '*'),
    p_units, p_input_tokens, p_output_tokens, now());
  if q->>'status' <> 'OK' then
    return q;
  end if;
  select * into w from public.wallets where organization_id = p_org;
  return q || jsonb_build_object(
    'availableMicros', coalesce(w.balance_micros + w.credit_limit_micros - w.reserved_micros, 0)::text,
    'affordable', w.id is not null and w.status = 'ACTIVE'
      and w.balance_micros + w.credit_limit_micros - w.reserved_micros >= (q->>'chargeMicros')::bigint
  );
end;
$$;

-- Charges an AI operation that already ran. Once per key: a retry returns
-- DUPLICATE (or retries a charge that was refused for balance).
create or replace function public.wallet_ai_charge(
  p_org uuid,
  p_feature text,
  p_model text,
  p_idempotency_key text,
  p_units bigint default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_parent_operation_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_pricing_rules;
  rec public.ai_usage_records;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_charge bigint;
  v_debit jsonb;
begin
  if v_key is null then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  w := public.wallet__lock(p_org);

  select * into rec from public.ai_usage_records where organization_id = p_org and idempotency_key = v_key for update;
  if found and rec.status <> 'REJECTED' then
    return jsonb_build_object('status', 'DUPLICATE', 'recordId', rec.id, 'recordStatus', rec.status,
      'chargeMicros', coalesce(rec.charge_micros, 0)::text) || public.wallet__snapshot(w);
  end if;

  r := public.wallet_resolve_price('ai', p_org, '*', '*', '*', p_feature, coalesce(p_model, '*'), now());
  if r.id is null then
    v_charge := null;
  else
    v_charge := public.wallet_charge_micros(r.per_unit_micros, r.per_1k_input_tokens_micros, r.per_1k_output_tokens_micros,
      r.markup_bps, r.discount_bps, p_units, p_input_tokens, p_output_tokens);
  end if;

  if rec.id is null then
    insert into public.ai_usage_records (
      organization_id, wallet_id, feature, model, units, input_tokens, output_tokens, pricing_rule_id,
      charge_micros, status, idempotency_key, parent_operation_id, metadata
    ) values (
      p_org, w.id, p_feature, coalesce(p_model, '*'), coalesce(p_units, 1), coalesce(p_input_tokens, 0),
      coalesce(p_output_tokens, 0), r.id, v_charge, 'REJECTED', v_key, p_parent_operation_id, coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into rec;
  else
    update public.ai_usage_records
    set units = coalesce(p_units, 1), input_tokens = coalesce(p_input_tokens, 0), output_tokens = coalesce(p_output_tokens, 0),
        pricing_rule_id = r.id, charge_micros = v_charge, model = coalesce(p_model, '*')
    where id = rec.id
    returning * into rec;
  end if;

  if v_charge is null then
    update public.ai_usage_records set status = 'REJECTED', reject_reason = 'NO_PRICE' where id = rec.id;
    return jsonb_build_object('status', 'NO_PRICE', 'recordId', rec.id) || public.wallet__snapshot(w);
  end if;
  if v_charge = 0 then
    update public.ai_usage_records set status = 'FREE', reject_reason = null where id = rec.id;
    return jsonb_build_object('status', 'FREE', 'recordId', rec.id, 'chargeMicros', '0') || public.wallet__snapshot(w);
  end if;

  v_debit := public.wallet_debit(p_org, 'ai', v_charge, 'ai:' || v_key, 'ai_usage', rec.id::text, r.id,
    p_feature, jsonb_build_object('model', coalesce(p_model, '*'), 'inputTokens', p_input_tokens, 'outputTokens', p_output_tokens));

  if v_debit->>'status' in ('CHARGED', 'DUPLICATE') then
    update public.ai_usage_records
    set status = 'CHARGED', reject_reason = null, ledger_id = (v_debit->>'ledgerId')::uuid
    where id = rec.id;
    select * into w from public.wallets where id = w.id;
    return jsonb_build_object('status', 'CHARGED', 'recordId', rec.id, 'chargeMicros', v_charge::text,
      'ledgerId', v_debit->>'ledgerId') || public.wallet__snapshot(w);
  end if;

  update public.ai_usage_records set status = 'REJECTED', reject_reason = v_debit->>'status' where id = rec.id;
  return jsonb_build_object('status', v_debit->>'status', 'recordId', rec.id, 'chargeMicros', v_charge::text)
    || public.wallet__snapshot(w);
end;
$$;

-- Holds the price of a slow AI job (image generation) before it starts.
-- Token estimates size the hold; wallet_ai_settle charges the actual usage.
create or replace function public.wallet_ai_reserve(
  p_org uuid,
  p_feature text,
  p_model text,
  p_idempotency_key text,
  p_units bigint default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_ttl_seconds integer default 7200,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_pricing_rules;
  rec public.ai_usage_records;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hold bigint;
  v_res jsonb;
begin
  if v_key is null then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  w := public.wallet__lock(p_org);

  select * into rec from public.ai_usage_records where organization_id = p_org and idempotency_key = v_key for update;
  if found and rec.status <> 'REJECTED' then
    return jsonb_build_object('status', 'DUPLICATE', 'recordId', rec.id, 'recordStatus', rec.status) || public.wallet__snapshot(w);
  end if;

  r := public.wallet_resolve_price('ai', p_org, '*', '*', '*', p_feature, coalesce(p_model, '*'), now());
  if r.id is null then
    return jsonb_build_object('status', 'NO_PRICE') || public.wallet__snapshot(w);
  end if;
  v_hold := public.wallet_charge_micros(r.per_unit_micros, r.per_1k_input_tokens_micros, r.per_1k_output_tokens_micros,
    r.markup_bps, r.discount_bps, p_units, p_input_tokens, p_output_tokens);

  if rec.id is null then
    insert into public.ai_usage_records (
      organization_id, wallet_id, feature, model, units, input_tokens, output_tokens, pricing_rule_id,
      hold_micros, status, idempotency_key, metadata
    ) values (
      p_org, w.id, p_feature, coalesce(p_model, '*'), coalesce(p_units, 1), coalesce(p_input_tokens, 0),
      coalesce(p_output_tokens, 0), r.id, v_hold, 'REJECTED', v_key, coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into rec;
  end if;

  if v_hold = 0 then
    update public.ai_usage_records set status = 'FREE', charge_micros = 0, reject_reason = null where id = rec.id;
    return jsonb_build_object('status', 'FREE', 'recordId', rec.id) || public.wallet__snapshot(w);
  end if;

  v_res := public.wallet_reserve(p_org, 'ai', v_hold, 'ai:' || v_key, 'ai_usage', rec.id::text, r.id, p_ttl_seconds,
    jsonb_build_object('feature', p_feature, 'model', coalesce(p_model, '*')));
  if v_res->>'status' in ('HELD', 'DUPLICATE') then
    update public.ai_usage_records
    set status = 'RESERVED', reject_reason = null, hold_micros = v_hold, pricing_rule_id = r.id,
        reservation_id = (v_res->>'reservationId')::uuid
    where id = rec.id;
    return jsonb_build_object('status', 'HELD', 'recordId', rec.id, 'holdMicros', v_hold::text,
      'reservationId', v_res->>'reservationId') || public.wallet__snapshot(public.wallet__lock(p_org));
  end if;
  update public.ai_usage_records set status = 'REJECTED', reject_reason = v_res->>'status', hold_micros = v_hold where id = rec.id;
  return jsonb_build_object('status', v_res->>'status', 'recordId', rec.id, 'holdMicros', v_hold::text) || public.wallet__snapshot(w);
end;
$$;

-- Finishes a held AI job: on success charge the actual usage at the rule it
-- was quoted with (never more than the hold), on failure release the hold.
create or replace function public.wallet_ai_settle(
  p_org uuid,
  p_idempotency_key text,
  p_success boolean,
  p_input_tokens bigint default null,
  p_output_tokens bigint default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  r public.wallet_pricing_rules;
  rec public.ai_usage_records;
  v_actual bigint;
  v_charge bigint;
  v_cap jsonb;
begin
  w := public.wallet__lock(p_org);
  select * into rec from public.ai_usage_records
  where organization_id = p_org and idempotency_key = btrim(coalesce(p_idempotency_key, '')) for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if rec.status <> 'RESERVED' then
    return jsonb_build_object('status', 'DUPLICATE', 'recordStatus', rec.status, 'chargeMicros', coalesce(rec.charge_micros, 0)::text);
  end if;

  if not coalesce(p_success, false) then
    perform public.wallet_release(rec.reservation_id, left(coalesce(p_reason, 'ai_failed'), 200));
    update public.ai_usage_records set status = 'RELEASED', reject_reason = left(coalesce(p_reason, 'failed'), 200)
    where id = rec.id;
    return jsonb_build_object('status', 'RELEASED', 'recordId', rec.id);
  end if;

  select * into r from public.wallet_pricing_rules where id = rec.pricing_rule_id;
  v_actual := public.wallet_charge_micros(r.per_unit_micros, r.per_1k_input_tokens_micros, r.per_1k_output_tokens_micros,
    r.markup_bps, r.discount_bps, rec.units,
    coalesce(p_input_tokens, rec.input_tokens), coalesce(p_output_tokens, rec.output_tokens));
  v_charge := least(v_actual, coalesce(rec.hold_micros, 0));

  v_cap := public.wallet_capture(rec.reservation_id, v_charge, rec.feature,
    jsonb_build_object('model', rec.model, 'actualMicros', v_actual::text));
  if v_cap->>'status' not in ('CAPTURED', 'RELEASED', 'DUPLICATE') then
    update public.ai_usage_records set status = 'ABANDONED', reject_reason = v_cap->>'status' where id = rec.id;
    return jsonb_build_object('status', 'HOLD_LOST', 'recordId', rec.id, 'holdStatus', v_cap->>'status');
  end if;

  update public.ai_usage_records
  set status = case when v_charge = 0 then 'FREE' else 'CHARGED' end,
      charge_micros = v_charge,
      input_tokens = coalesce(p_input_tokens, input_tokens),
      output_tokens = coalesce(p_output_tokens, output_tokens),
      ledger_id = nullif(v_cap->>'ledgerId', '')::uuid,
      metadata = metadata || case when v_actual > v_charge
        then jsonb_build_object('underBilledMicros', (v_actual - v_charge)::text) else '{}'::jsonb end
  where id = rec.id;
  return jsonb_build_object('status', 'CHARGED', 'recordId', rec.id, 'chargeMicros', v_charge::text,
    'actualMicros', v_actual::text);
end;
$$;

-- Holds that expired before their job settled: free the record for reporting.
create or replace function public.wallet_ai_abandon_stale(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    select a.id
    from public.ai_usage_records a
    join public.wallet_reservations r on r.id = a.reservation_id
    where a.status = 'RESERVED' and r.status in ('EXPIRED', 'RELEASED')
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  )
  update public.ai_usage_records a
  set status = 'ABANDONED', reject_reason = 'hold_expired'
  from stale where a.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.ai_usage_records enable row level security;
drop policy if exists ai_usage_records_tenant_select on public.ai_usage_records;
create policy ai_usage_records_tenant_select on public.ai_usage_records
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
revoke all on public.ai_usage_records from anon, authenticated;
grant select on public.ai_usage_records to authenticated;
grant all on public.ai_usage_records to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_ai_mode(uuid)',
    'public.wallet_ai_quote(uuid, text, text, bigint, bigint, bigint)',
    'public.wallet_ai_charge(uuid, text, text, text, bigint, bigint, bigint, text, jsonb)',
    'public.wallet_ai_reserve(uuid, text, text, text, bigint, bigint, bigint, integer, jsonb)',
    'public.wallet_ai_settle(uuid, text, boolean, bigint, bigint, text)',
    'public.wallet_ai_abandon_stale(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
