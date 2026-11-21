-- Tenant wallet, phase 2: recharge orders with a GST-inclusive split, and the
-- read models behind the merchant Wallet page.
--
-- A recharge price includes GST. The wallet is credited the taxable value;
-- the GST part is recorded per order (rate, CGST/SGST/IGST) for the tax invoice.

alter table public.platform_settings
  add column if not exists wallet_gst_rate_bps integer not null default 1800,
  add column if not exists wallet_gst_place_of_supply text not null default 'INTRA';

alter table public.platform_settings
  drop constraint if exists platform_settings_wallet_gst_chk;
alter table public.platform_settings
  add constraint platform_settings_wallet_gst_chk
    check (wallet_gst_rate_bps between 0 and 9999 and wallet_gst_place_of_supply in ('INTRA', 'INTER'));

comment on column public.platform_settings.wallet_gst_rate_bps is
  'GST included in a wallet recharge price, in basis points (1800 = 18%). Each order keeps the rate it was sold at.';

alter table public.wallet_recharge_orders
  add column if not exists gst_rate_bps integer not null default 0,
  add column if not exists place_of_supply text not null default 'INTRA',
  add column if not exists cgst_paise bigint not null default 0,
  add column if not exists sgst_paise bigint not null default 0,
  add column if not exists igst_paise bigint not null default 0;

alter table public.wallet_recharge_orders
  drop constraint if exists wallet_recharge_orders_gst_chk;
alter table public.wallet_recharge_orders
  add constraint wallet_recharge_orders_gst_chk check (
    gst_rate_bps between 0 and 9999
    and place_of_supply in ('INTRA', 'INTER')
    and cgst_paise >= 0 and sgst_paise >= 0 and igst_paise >= 0
    and cgst_paise + sgst_paise + igst_paise = tax_paise
    and (place_of_supply = 'INTER' or igst_paise = 0)
    and (place_of_supply = 'INTRA' or (cgst_paise = 0 and sgst_paise = 0))
  );

-- Same rounding as modules/billing/inclusive-tax.ts splitInclusiveTax, and
-- mirrored by modules/wallet/recharge-quote.ts.
create or replace function public.wallet_quote_recharge(
  p_amount_paise bigint,
  p_rate_bps integer,
  p_place text default 'INTRA'
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_divisor bigint;
  v_taxable bigint;
  v_tax bigint;
  v_cgst bigint := 0;
  v_sgst bigint := 0;
  v_igst bigint := 0;
begin
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;
  if p_rate_bps is null or p_rate_bps < 0 or p_rate_bps > 9999 then
    raise exception 'gst rate out of range' using errcode = '22023';
  end if;
  v_divisor := 10000 + p_rate_bps;
  v_taxable := (p_amount_paise * 10000 + v_divisor / 2) / v_divisor;
  v_tax := p_amount_paise - v_taxable;
  if p_place = 'INTER' then
    v_igst := v_tax;
  else
    v_cgst := v_tax / 2;
    v_sgst := v_tax - v_cgst;
  end if;
  return jsonb_build_object(
    'amountPaise', p_amount_paise,
    'taxablePaise', v_taxable,
    'taxPaise', v_tax,
    'cgstPaise', v_cgst,
    'sgstPaise', v_sgst,
    'igstPaise', v_igst,
    'gstRateBps', p_rate_bps,
    'placeOfSupply', case when p_place = 'INTER' then 'INTER' else 'INTRA' end,
    'creditMicros', (v_taxable * 10000)::text
  );
end;
$$;

-- Writes the payments row and the recharge order together, after the server
-- has created the Razorpay order. The amount limits and GST rate are read
-- here, so a client can never pick its own split.
create or replace function public.wallet_create_recharge_order(
  p_org uuid,
  p_razorpay_order_id text,
  p_amount_paise bigint,
  p_created_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.platform_settings;
  w public.wallets;
  q jsonb;
  v_payment uuid;
  v_order uuid;
begin
  if nullif(btrim(coalesce(p_razorpay_order_id, '')), '') is null then
    raise exception 'razorpay order id required' using errcode = '22023';
  end if;
  select * into s from public.platform_settings where id = 1;
  if p_amount_paise is null
    or p_amount_paise < coalesce(s.wallet_recharge_min_paise, 10000)
    or p_amount_paise > coalesce(s.wallet_recharge_max_paise, 5000000) then
    return jsonb_build_object(
      'status', 'AMOUNT_OUT_OF_RANGE',
      'minPaise', coalesce(s.wallet_recharge_min_paise, 10000),
      'maxPaise', coalesce(s.wallet_recharge_max_paise, 5000000)
    );
  end if;

  w := public.wallet__lock(p_org);
  if exists (select 1 from public.wallet_recharge_orders where razorpay_order_id = p_razorpay_order_id) then
    return jsonb_build_object('status', 'DUPLICATE');
  end if;

  q := public.wallet_quote_recharge(
    p_amount_paise,
    coalesce(s.wallet_gst_rate_bps, 1800),
    coalesce(s.wallet_gst_place_of_supply, 'INTRA')
  );

  insert into public.payments (
    organization_id, amount_paise, currency, status, razorpay_order_id, billing_cycle, payment_purpose
  ) values (
    p_org, p_amount_paise, 'INR', 'PENDING', p_razorpay_order_id, 'wallet', 'wallet_recharge'
  )
  returning id into v_payment;

  insert into public.wallet_recharge_orders (
    wallet_id, organization_id, payment_id, razorpay_order_id, amount_paise, taxable_paise, tax_paise,
    credit_micros, gst_rate_bps, place_of_supply, cgst_paise, sgst_paise, igst_paise, created_by
  ) values (
    w.id, p_org, v_payment, p_razorpay_order_id, p_amount_paise,
    (q->>'taxablePaise')::bigint, (q->>'taxPaise')::bigint, (q->>'creditMicros')::bigint,
    (q->>'gstRateBps')::integer, q->>'placeOfSupply',
    (q->>'cgstPaise')::bigint, (q->>'sgstPaise')::bigint, (q->>'igstPaise')::bigint,
    p_created_by
  )
  returning id into v_order;

  return jsonb_build_object('status', 'CREATED', 'rechargeOrderId', v_order, 'paymentId', v_payment) || q;
end;
$$;

-- Month boundaries are India time: merchants read "this month" in IST.
create or replace function public.wallet_summary(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w public.wallets;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_month_whatsapp bigint;
  v_month_ai bigint;
  v_month_recharged bigint;
  v_lowest_alert bigint;
begin
  select * into w from public.wallets where organization_id = p_org;
  if not found then
    return jsonb_build_object('status', 'NO_WALLET');
  end if;

  select
    coalesce(-sum(amount_micros) filter (where service = 'whatsapp' and entry_type in ('USAGE_WHATSAPP', 'USAGE_REVERSAL')), 0),
    coalesce(-sum(amount_micros) filter (where service = 'ai' and entry_type in ('USAGE_AI', 'USAGE_REVERSAL')), 0),
    coalesce(sum(amount_micros) filter (where entry_type = 'RECHARGE'), 0)
  into v_month_whatsapp, v_month_ai, v_month_recharged
  from public.wallet_ledger
  where wallet_id = w.id and created_at >= v_month_start;

  select min(threshold_micros) into v_lowest_alert
  from public.wallet_alerts where wallet_id = w.id and status = 'OPEN';

  return jsonb_build_object(
    'status', 'OK',
    'walletStatus', w.status,
    'balanceMicros', w.balance_micros::text,
    'reservedMicros', w.reserved_micros::text,
    'availableMicros', (w.balance_micros + w.credit_limit_micros - w.reserved_micros)::text,
    'lifetimeRechargedMicros', w.lifetime_recharged_micros::text,
    'lifetimeWhatsappMicros', w.lifetime_whatsapp_micros::text,
    'lifetimeAiMicros', w.lifetime_ai_micros::text,
    'lifetimePromoMicros', w.lifetime_promo_micros::text,
    'monthWhatsappMicros', v_month_whatsapp::text,
    'monthAiMicros', v_month_ai::text,
    'monthSpendMicros', (v_month_whatsapp + v_month_ai)::text,
    'monthRechargedMicros', v_month_recharged::text,
    'monthStart', v_month_start,
    'lastRechargedAt', w.last_recharged_at,
    'lowestOpenAlertMicros', case when v_lowest_alert is null then null else v_lowest_alert::text end,
    'thresholdsMicros', to_jsonb(array(select t::text from unnest(w.low_balance_thresholds_micros) t))
  );
end;
$$;

create or replace function public.wallet_usage_daily(p_org uuid, p_days integer default 30)
returns table (day date, whatsapp_micros bigint, ai_micros bigint, recharged_micros bigint)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select greatest(1, least(coalesce(p_days, 30), 366)) as n,
      (now() at time zone 'Asia/Kolkata')::date as today
  ),
  days as (
    select (b.today - g)::date as day
    from bounds b, generate_series(0, (select n - 1 from bounds)) g
  ),
  agg as (
    select (l.created_at at time zone 'Asia/Kolkata')::date as day,
      coalesce(-sum(l.amount_micros) filter (where l.service = 'whatsapp' and l.entry_type in ('USAGE_WHATSAPP', 'USAGE_REVERSAL')), 0)::bigint as whatsapp_micros,
      coalesce(-sum(l.amount_micros) filter (where l.service = 'ai' and l.entry_type in ('USAGE_AI', 'USAGE_REVERSAL')), 0)::bigint as ai_micros,
      coalesce(sum(l.amount_micros) filter (where l.entry_type = 'RECHARGE'), 0)::bigint as recharged_micros
    from public.wallet_ledger l
    where l.organization_id = p_org
      and l.created_at >= ((select today from bounds) - (select n - 1 from bounds)) at time zone 'Asia/Kolkata'
    group by 1
  )
  select d.day, coalesce(a.whatsapp_micros, 0), coalesce(a.ai_micros, 0), coalesce(a.recharged_micros, 0)
  from days d left join agg a on a.day = d.day
  order by d.day
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_quote_recharge(bigint, integer, text)',
    'public.wallet_create_recharge_order(uuid, text, bigint, uuid)',
    'public.wallet_summary(uuid)',
    'public.wallet_usage_daily(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
