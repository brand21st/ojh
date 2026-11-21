-- Tenant wallet, phase 5: Super Admin read models and the remaining admin
-- actions (credit limit, free allowances, resolving reconciliation issues).
-- Every function is service_role only and takes the acting admin's user id,
-- which it checks against platform_admins.

create or replace function public.wallet__assert_admin(p_admin uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_admin is null or not exists (select 1 from public.platform_admins where user_id = p_admin) then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
end;
$$;

-- Platform-wide numbers for the top of the Wallet Management page.
create or replace function public.wallet_admin_totals()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with month as (
    select date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' as start
  ),
  ledger as (
    select
      coalesce(-sum(l.amount_micros) filter (where l.service = 'whatsapp' and l.entry_type in ('USAGE_WHATSAPP', 'USAGE_REVERSAL')), 0) as wa,
      coalesce(-sum(l.amount_micros) filter (where l.service = 'ai' and l.entry_type in ('USAGE_AI', 'USAGE_REVERSAL')), 0) as ai,
      coalesce(sum(l.amount_micros) filter (where l.entry_type = 'RECHARGE'), 0) as recharged
    from public.wallet_ledger l, month
    where l.created_at >= month.start
  )
  select jsonb_build_object(
    'wallets', (select count(*) from public.wallets),
    'frozen', (select count(*) from public.wallets where status = 'FROZEN'),
    'lowBalance', (select count(distinct wallet_id) from public.wallet_alerts where status = 'OPEN'),
    'totalBalanceMicros', (select coalesce(sum(balance_micros), 0) from public.wallets)::text,
    'totalReservedMicros', (select coalesce(sum(reserved_micros), 0) from public.wallets)::text,
    'lifetimeRechargedMicros', (select coalesce(sum(lifetime_recharged_micros), 0) from public.wallets)::text,
    'monthRechargedMicros', (select recharged from ledger)::text,
    'monthWhatsappMicros', (select wa from ledger)::text,
    'monthAiMicros', (select ai from ledger)::text,
    'openReconciliationIssues', (select count(*) from public.wallet_reconciliation_issues where resolved_at is null),
    'paidRechargesWithoutInvoice', (
      select count(*) from public.wallet_recharge_orders o
      where o.status in ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED')
        and to_regclass('public.wallet_recharge_invoices') is not null
        and not exists (select 1 from public.wallet_recharge_invoices i where i.recharge_order_id = o.id)
    ),
    'pendingAiMigrations', (select count(*) from public.wallets where ai_credits_migrated_at is null)
  )
$$;

-- One page of tenant wallets with the columns Super Admin asked for.
create or replace function public.wallet_admin_list(
  p_search text default null,
  p_status text default null,
  p_sort text default 'balance_asc',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows jsonb;
  v_total bigint;
begin
  with base as (
    select w.*, o.name as organization_name,
      exists (select 1 from public.wallet_alerts a where a.wallet_id = w.id and a.status = 'OPEN') as low_balance,
      exists (select 1 from public.wallet_reconciliation_issues r where r.wallet_id = w.id and r.resolved_at is null) as mismatch
    from public.wallets w
    join public.organizations o on o.id = w.organization_id
    where (v_search is null
        or o.name ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
        or w.organization_id::text = v_search)
      and (p_status is null or p_status = ''
        or (p_status = 'FROZEN' and w.status = 'FROZEN')
        or (p_status = 'ACTIVE' and w.status = 'ACTIVE')
        or (p_status = 'LOW' and exists (select 1 from public.wallet_alerts a where a.wallet_id = w.id and a.status = 'OPEN'))
        or (p_status = 'NOT_MIGRATED' and w.ai_credits_migrated_at is null))
  )
  select count(*) into v_total from base;

  with base as (
    select w.*, o.name as organization_name,
      exists (select 1 from public.wallet_alerts a where a.wallet_id = w.id and a.status = 'OPEN') as low_balance,
      exists (select 1 from public.wallet_reconciliation_issues r where r.wallet_id = w.id and r.resolved_at is null) as mismatch
    from public.wallets w
    join public.organizations o on o.id = w.organization_id
    where (v_search is null
        or o.name ilike '%' || replace(replace(v_search, '%', '\%'), '_', '\_') || '%'
        or w.organization_id::text = v_search)
      and (p_status is null or p_status = ''
        or (p_status = 'FROZEN' and w.status = 'FROZEN')
        or (p_status = 'ACTIVE' and w.status = 'ACTIVE')
        or (p_status = 'LOW' and exists (select 1 from public.wallet_alerts a where a.wallet_id = w.id and a.status = 'OPEN'))
        or (p_status = 'NOT_MIGRATED' and w.ai_credits_migrated_at is null))
  ),
  ordered as (
    select b.*, row_number() over (order by
      case when p_sort = 'balance_asc' then b.balance_micros end asc,
      case when p_sort = 'balance_desc' then b.balance_micros end desc,
      case when p_sort = 'recharged_desc' then b.lifetime_recharged_micros end desc,
      case when p_sort = 'whatsapp_desc' then b.lifetime_whatsapp_micros end desc,
      case when p_sort = 'ai_desc' then b.lifetime_ai_micros end desc,
      case when p_sort = 'last_recharge_desc' then b.last_recharged_at end desc nulls last,
      case when p_sort = 'name_asc' then b.organization_name end asc,
      b.organization_id) as ord
    from base b
  ),
  page as (
    select * from ordered
    order by ord
    limit v_limit offset greatest(coalesce(p_offset, 0), 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', b.organization_id,
    'organizationName', b.organization_name,
    'walletStatus', b.status,
    'balanceMicros', b.balance_micros::text,
    'reservedMicros', b.reserved_micros::text,
    'creditLimitMicros', b.credit_limit_micros::text,
    'lifetimeRechargedMicros', b.lifetime_recharged_micros::text,
    'lifetimeWhatsappMicros', b.lifetime_whatsapp_micros::text,
    'lifetimeAiMicros', b.lifetime_ai_micros::text,
    'lifetimePromoMicros', b.lifetime_promo_micros::text,
    'lastRechargedAt', b.last_recharged_at,
    'aiCreditsMigratedAt', b.ai_credits_migrated_at,
    'lowBalance', b.low_balance,
    'mismatch', b.mismatch
  ) order by b.ord), '[]'::jsonb) into v_rows
  from page b;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

-- Lets a tenant run below zero by up to this amount. 0 means prepaid only.
create or replace function public.wallet_set_credit_limit(
  p_org uuid,
  p_limit_micros bigint,
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
  v_old bigint;
begin
  perform public.wallet__assert_admin(p_admin_user_id);
  if p_limit_micros is null or p_limit_micros < 0 then
    raise exception 'credit limit must be zero or more' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'reason must be at least 10 characters' using errcode = '22023';
  end if;
  w := public.wallet__lock(p_org);
  v_old := w.credit_limit_micros;
  if w.balance_micros + p_limit_micros < w.reserved_micros and w.status = 'ACTIVE' then
    return jsonb_build_object('status', 'BELOW_HOLDS') || public.wallet__snapshot(w);
  end if;
  update public.wallets set credit_limit_micros = p_limit_micros, version = version + 1 where id = w.id returning * into w;
  insert into public.wallet_status_events (wallet_id, organization_id, from_status, to_status, reason, admin_user_id)
  values (w.id, w.organization_id, w.status, w.status,
    left(btrim(p_reason), 400) || ' [credit limit ' || v_old::text || ' -> ' || p_limit_micros::text || ' micros]', p_admin_user_id);
  return jsonb_build_object('status', 'UPDATED', 'previousLimitMicros', v_old::text) || public.wallet__snapshot(w);
end;
$$;

-- Adds a free-allowance version; the open one for the same tenant and category closes.
create or replace function public.wallet_set_free_allowance(
  p_org uuid,
  p_category text,
  p_monthly_messages integer,
  p_note text,
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text := upper(coalesce(p_category, ''));
  v_id uuid;
  v_now timestamptz := clock_timestamp();
  v_last timestamptz;
begin
  perform public.wallet__assert_admin(p_admin_user_id);
  perform pg_advisory_xact_lock(hashtext('wallet_free_allowances'));
  -- Each version starts strictly after the previous one, even within one clock tick.
  select max(effective_from) into v_last from public.wallet_free_allowances
  where organization_id is not distinct from p_org and whatsapp_category = v_category;
  if v_last is not null and v_now <= v_last then
    v_now := v_last + interval '1 microsecond';
  end if;
  update public.wallet_free_allowances
  set effective_to = v_now
  where organization_id is not distinct from p_org and whatsapp_category = v_category and effective_to is null;
  if coalesce(p_monthly_messages, 0) > 0 then
    insert into public.wallet_free_allowances (organization_id, whatsapp_category, monthly_messages, effective_from, note, created_by)
    values (p_org, v_category, p_monthly_messages, v_now, nullif(btrim(coalesce(p_note, '')), ''), p_admin_user_id)
    returning id into v_id;
  end if;
  return jsonb_build_object('status', case when v_id is null then 'REMOVED' else 'OK' end, 'allowanceId', v_id);
end;
$$;

create or replace function public.wallet_resolve_reconciliation_issue(
  p_issue_id uuid,
  p_note text,
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.wallet__assert_admin(p_admin_user_id);
  if char_length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'note must be at least 10 characters' using errcode = '22023';
  end if;
  update public.wallet_reconciliation_issues
  set resolved_at = now(), note = btrim(p_note) || ' (by ' || p_admin_user_id::text || ')'
  where id = p_issue_id and resolved_at is null;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  return jsonb_build_object('status', 'RESOLVED');
end;
$$;

do $$
declare
  fn text;
begin
  execute 'revoke all on function public.wallet__assert_admin(uuid) from public, anon, authenticated, service_role';
  foreach fn in array array[
    'public.wallet_admin_totals()',
    'public.wallet_admin_list(text, text, text, integer, integer)',
    'public.wallet_set_credit_limit(uuid, bigint, text, uuid)',
    'public.wallet_set_free_allowance(uuid, text, integer, text, uuid)',
    'public.wallet_resolve_reconciliation_issue(uuid, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
