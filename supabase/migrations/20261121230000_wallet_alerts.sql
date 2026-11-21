-- Tenant wallet, phase 6: deliver low-balance alerts and let owners choose
-- their own alert levels.
--
-- wallet__post already opens one wallet_alerts row per threshold crossed and
-- clears it when the balance recovers. This claims the unsent ones for the
-- wallet cron, one message per wallet (the lowest level crossed).

-- Claims unsent alerts and returns who to tell. Marking them sent happens in
-- the same statement, so two cron runs never notify twice.
create or replace function public.wallet_claim_alerts(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  with picked as (
    select a.id, a.wallet_id
    from public.wallet_alerts a
    where a.status = 'OPEN' and a.notified_at is null
    order by a.fired_at
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
    for update skip locked
  ),
  marked as (
    update public.wallet_alerts a
    set notified_at = now()
    from picked
    where a.id = picked.id
    returning a.wallet_id, a.organization_id, a.threshold_micros
  ),
  per_wallet as (
    select m.wallet_id, m.organization_id, min(m.threshold_micros) as threshold_micros
    from marked m
    group by m.wallet_id, m.organization_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', p.organization_id,
    'organizationName', o.name,
    'thresholdMicros', p.threshold_micros::text,
    'balanceMicros', w.balance_micros::text,
    'availableMicros', (w.balance_micros + w.credit_limit_micros - w.reserved_micros)::text,
    'walletStatus', w.status,
    'ownerEmails', coalesce((
      select jsonb_agg(distinct pr.email)
      from public.organization_members om
      join public.profiles pr on pr.id = om.user_id
      where om.organization_id = p.organization_id
        and om.role = 'OWNER'
        and coalesce(btrim(pr.email), '') <> ''
    ), '[]'::jsonb)
  )), '[]'::jsonb)
  into v_result
  from per_wallet p
  join public.wallets w on w.id = p.wallet_id
  join public.organizations o on o.id = p.organization_id
  -- A wallet that recovered between the crossing and this run needs no message.
  where w.balance_micros < p.threshold_micros;
  return v_result;
end;
$$;

-- Replaces a wallet's alert levels and brings its open alerts in line:
-- levels no longer listed close, levels already crossed open.
create or replace function public.wallet_set_thresholds(p_org uuid, p_thresholds_micros bigint[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.wallets;
  v_levels bigint[];
begin
  select coalesce(array_agg(distinct t order by t desc), array[]::bigint[]) into v_levels
  from unnest(coalesce(p_thresholds_micros, array[]::bigint[])) t
  where t > 0;
  if array_length(v_levels, 1) > 5 then
    raise exception 'at most 5 alert levels' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_levels) t where t > 100000000000) then
    raise exception 'alert level too high' using errcode = '22023';
  end if;

  w := public.wallet__lock(p_org);
  update public.wallets set low_balance_thresholds_micros = v_levels where id = w.id returning * into w;
  update public.wallet_alerts
  set status = 'CLEARED', cleared_at = now()
  where wallet_id = w.id and status = 'OPEN' and not (threshold_micros = any (v_levels));
  perform public.wallet__evaluate_alerts(w);
  return jsonb_build_object('status', 'UPDATED', 'thresholdsMicros', to_jsonb(array(select t::text from unnest(v_levels) t)));
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_claim_alerts(integer)',
    'public.wallet_set_thresholds(uuid, bigint[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
