-- Tenant wallet: GST tax invoices for recharges.
--
-- Numbers come from subscription_allocate_invoice_number, so subscription and
-- wallet invoices share one consecutive series per financial year. Supplier
-- identity comes from subscription_invoice_settings (Super Admin), the
-- customer from organization_billing_profiles. An issued invoice never changes.

alter table public.platform_settings
  add column if not exists wallet_invoice_sac text not null default '';

alter table public.platform_settings
  drop constraint if exists platform_settings_wallet_invoice_sac_chk;
alter table public.platform_settings
  add constraint platform_settings_wallet_invoice_sac_chk
    check (wallet_invoice_sac = '' or wallet_invoice_sac ~ '^[0-9]{4,8}$');

comment on column public.platform_settings.wallet_invoice_sac is
  'SAC code printed on wallet recharge invoices. Blank prints none; set it with your accountant.';

alter table public.wallet_recharge_orders
  add column if not exists supplier_state_code text,
  add column if not exists customer_state_code text;

alter table public.wallet_recharge_orders
  drop constraint if exists wallet_recharge_orders_state_codes_chk;
alter table public.wallet_recharge_orders
  add constraint wallet_recharge_orders_state_codes_chk check (
    (supplier_state_code is null or supplier_state_code ~ '^[0-9]{2}$')
    and (customer_state_code is null or customer_state_code ~ '^[0-9]{2}$')
  );

create table if not exists public.wallet_recharge_invoices (
  id uuid primary key default gen_random_uuid(),
  recharge_order_id uuid not null unique references public.wallet_recharge_orders(id),
  organization_id uuid not null references public.organizations(id),
  payment_id uuid references public.payments(id),
  invoice_number text not null unique,
  series text not null,
  status text not null default 'ISSUED',
  gross_paise bigint not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_tax_paise bigint not null,
  gst_rate_bps integer not null,
  place_of_supply text not null,
  supplier_state_code text,
  customer_state_code text,
  supplier_legal_name text not null,
  supplier_address text not null,
  supplier_gstin text not null,
  customer_legal_name text not null,
  customer_address text not null default '',
  customer_gstin text not null default '',
  sac text not null default '',
  description text not null,
  payment_reference text,
  paid_at timestamptz,
  issued_at timestamptz not null default now(),
  constraint wallet_recharge_invoices_status_chk check (status = 'ISSUED'),
  constraint wallet_recharge_invoices_amounts_chk check (
    gross_paise > 0 and taxable_paise > 0
    and cgst_paise >= 0 and sgst_paise >= 0 and igst_paise >= 0
    and taxable_paise + total_tax_paise = gross_paise
    and cgst_paise + sgst_paise + igst_paise = total_tax_paise
  ),
  constraint wallet_recharge_invoices_pos_chk check (place_of_supply in ('INTRA', 'INTER'))
);

create index if not exists wallet_recharge_invoices_org_issued_idx
  on public.wallet_recharge_invoices (organization_id, issued_at desc);

create or replace function public.wallet__guard_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Issued wallet tax invoices are immutable' using errcode = '42501';
end;
$$;

drop trigger if exists wallet_recharge_invoices_immutable on public.wallet_recharge_invoices;
create trigger wallet_recharge_invoices_immutable before update or delete on public.wallet_recharge_invoices
  for each row execute function public.wallet__guard_invoice();

-- Two-digit GST state code from a GSTIN, or null when it is not a valid shape.
create or replace function public.wallet__gstin_state(p_gstin text)
returns text
language sql
immutable
as $$
  select case
    when upper(btrim(coalesce(p_gstin, ''))) ~ '^[0-9]{2}[0-9A-Z]{13}$' then left(btrim(p_gstin), 2)
    else null
  end
$$;

-- Indian financial-year series for a moment, e.g. 2026-27, in India time.
create or replace function public.wallet__fy_series(p_at timestamptz, p_start_month integer default 4)
returns text
language sql
immutable
as $$
  select y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0')
  from (
    select case
      when extract(month from (p_at at time zone 'Asia/Kolkata'))::int >= coalesce(p_start_month, 4)
        then extract(year from (p_at at time zone 'Asia/Kolkata'))::int
      else extract(year from (p_at at time zone 'Asia/Kolkata'))::int - 1
    end as y
  ) s
$$;

-- The recharge order now decides place of supply from the two GSTINs:
-- same state is CGST + SGST, different states is IGST. Without both GSTINs it
-- uses the platform default.
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
  v_supplier_state text;
  v_customer_state text;
  v_place text;
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

  if to_regclass('public.subscription_invoice_settings') is not null then
    execute 'select public.wallet__gstin_state(gstin) from public.subscription_invoice_settings limit 1'
      into v_supplier_state;
  end if;
  if to_regclass('public.organization_billing_profiles') is not null then
    execute 'select public.wallet__gstin_state(gstin) from public.organization_billing_profiles where organization_id = $1'
      into v_customer_state using p_org;
  end if;
  v_place := case
    when v_supplier_state is not null and v_customer_state is not null then
      case when v_supplier_state = v_customer_state then 'INTRA' else 'INTER' end
    else coalesce(s.wallet_gst_place_of_supply, 'INTRA')
  end;

  q := public.wallet_quote_recharge(p_amount_paise, coalesce(s.wallet_gst_rate_bps, 1800), v_place);

  insert into public.payments (
    organization_id, amount_paise, currency, status, razorpay_order_id, billing_cycle, payment_purpose
  ) values (
    p_org, p_amount_paise, 'INR', 'PENDING', p_razorpay_order_id, 'wallet', 'wallet_recharge'
  )
  returning id into v_payment;

  insert into public.wallet_recharge_orders (
    wallet_id, organization_id, payment_id, razorpay_order_id, amount_paise, taxable_paise, tax_paise,
    credit_micros, gst_rate_bps, place_of_supply, cgst_paise, sgst_paise, igst_paise, created_by,
    supplier_state_code, customer_state_code
  ) values (
    w.id, p_org, v_payment, p_razorpay_order_id, p_amount_paise,
    (q->>'taxablePaise')::bigint, (q->>'taxPaise')::bigint, (q->>'creditMicros')::bigint,
    (q->>'gstRateBps')::integer, q->>'placeOfSupply',
    (q->>'cgstPaise')::bigint, (q->>'sgstPaise')::bigint, (q->>'igstPaise')::bigint,
    p_created_by, v_supplier_state, v_customer_state
  )
  returning id into v_order;

  return jsonb_build_object('status', 'CREATED', 'rechargeOrderId', v_order, 'paymentId', v_payment) || q;
end;
$$;

-- Issues the tax invoice for a paid recharge, once. Returns a reason instead
-- of an invoice while supplier or customer details are incomplete, so the
-- cron can try again after Super Admin or the merchant fills them in.
create or replace function public.wallet_issue_recharge_invoice(p_recharge_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.wallet_recharge_orders;
  inv public.wallet_recharge_invoices;
  v_supplier record;
  v_customer record;
  v_org_name text;
  v_sac text;
  v_series text;
  v_number text;
  v_customer_name text;
  v_customer_address text;
  v_customer_gstin text;
begin
  select * into o from public.wallet_recharge_orders where id = p_recharge_order_id for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select * into inv from public.wallet_recharge_invoices where recharge_order_id = o.id;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'invoiceNumber', inv.invoice_number, 'invoiceId', inv.id);
  end if;
  if o.status not in ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    return jsonb_build_object('status', 'NOT_PAID');
  end if;
  if to_regclass('public.subscription_invoice_settings') is null
    or to_regclass('public.organization_billing_profiles') is null then
    return jsonb_build_object('status', 'SUPPLIER_INCOMPLETE', 'reason', 'Invoice settings are not set up');
  end if;

  execute 'select legal_name, address, gstin, numbering_prefix, financial_year_start_month
           from public.subscription_invoice_settings limit 1' into v_supplier;
  if v_supplier is null
    or btrim(coalesce(v_supplier.legal_name, '')) = ''
    or btrim(coalesce(v_supplier.address, '')) = ''
    or public.wallet__gstin_state(v_supplier.gstin) is null then
    return jsonb_build_object('status', 'SUPPLIER_INCOMPLETE', 'reason', 'Supplier legal name, address or GSTIN is missing');
  end if;

  execute 'select legal_name, address, gstin from public.organization_billing_profiles where organization_id = $1'
    into v_customer using o.organization_id;
  select name into v_org_name from public.organizations where id = o.organization_id;

  v_customer_gstin := upper(btrim(coalesce(v_customer.gstin, '')));
  v_customer_name := coalesce(nullif(btrim(coalesce(v_customer.legal_name, '')), ''), btrim(coalesce(v_org_name, '')));
  v_customer_address := btrim(coalesce(v_customer.address, ''));
  if v_customer_name = '' then
    return jsonb_build_object('status', 'CUSTOMER_INCOMPLETE', 'reason', 'Customer name is missing');
  end if;
  if v_customer_gstin <> '' and public.wallet__gstin_state(v_customer_gstin) is null then
    return jsonb_build_object('status', 'CUSTOMER_INCOMPLETE', 'reason', 'Customer GSTIN is invalid');
  end if;
  -- A registered buyer, or any invoice above Rs 50,000, needs the buyer's address.
  if v_customer_address = '' and (v_customer_gstin <> '' or o.amount_paise > 5000000) then
    return jsonb_build_object('status', 'CUSTOMER_INCOMPLETE', 'reason', 'Customer billing address is missing');
  end if;

  select coalesce(wallet_invoice_sac, '') into v_sac from public.platform_settings where id = 1;
  v_series := public.wallet__fy_series(coalesce(o.paid_at, now()), coalesce(v_supplier.financial_year_start_month, 4));
  v_number := public.subscription_allocate_invoice_number(
    coalesce(nullif(v_supplier.numbering_prefix, ''), 'PB'),
    v_series
  );

  insert into public.wallet_recharge_invoices (
    recharge_order_id, organization_id, payment_id, invoice_number, series,
    gross_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_tax_paise, gst_rate_bps,
    place_of_supply, supplier_state_code, customer_state_code,
    supplier_legal_name, supplier_address, supplier_gstin,
    customer_legal_name, customer_address, customer_gstin,
    sac, description, payment_reference, paid_at
  ) values (
    o.id, o.organization_id, o.payment_id, v_number, v_series,
    o.amount_paise, o.taxable_paise, o.cgst_paise, o.sgst_paise, o.igst_paise, o.tax_paise, o.gst_rate_bps,
    o.place_of_supply, coalesce(o.supplier_state_code, public.wallet__gstin_state(v_supplier.gstin)),
    coalesce(o.customer_state_code, public.wallet__gstin_state(v_customer_gstin)),
    btrim(v_supplier.legal_name), btrim(v_supplier.address), upper(btrim(v_supplier.gstin)),
    v_customer_name, v_customer_address, v_customer_gstin,
    v_sac, 'PostBus prepaid wallet recharge', o.razorpay_payment_id, o.paid_at
  )
  returning * into inv;

  if to_regclass('public.billing_audit_logs') is not null then
    execute 'insert into public.billing_audit_logs(actor_type, action, target_type, target_id, organization_id, metadata)
             values ($1, $2, $3, $4, $5, $6)'
      using 'SYSTEM', 'wallet_invoice.issued', 'wallet_recharge_invoice', v_number, o.organization_id,
        jsonb_build_object('rechargeOrderId', o.id, 'paymentId', o.payment_id);
  end if;

  return jsonb_build_object('status', 'ISSUED', 'invoiceNumber', v_number, 'invoiceId', inv.id);
end;
$$;

-- Paid recharges still without an invoice, oldest first, for the wallet cron.
create or replace function public.wallet_recharges_missing_invoice(p_limit integer default 100)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.id
  from public.wallet_recharge_orders o
  left join public.wallet_recharge_invoices i on i.recharge_order_id = o.id
  where o.status in ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') and i.id is null
  order by o.paid_at nulls last, o.created_at
  limit greatest(1, least(coalesce(p_limit, 100), 1000))
$$;

alter table public.wallet_recharge_invoices enable row level security;
drop policy if exists wallet_recharge_invoices_tenant_select on public.wallet_recharge_invoices;
create policy wallet_recharge_invoices_tenant_select on public.wallet_recharge_invoices
  for select to authenticated using (public.is_org_member(organization_id) or public.is_platform_admin());
revoke all on public.wallet_recharge_invoices from anon, authenticated;
grant select on public.wallet_recharge_invoices to authenticated;
grant all on public.wallet_recharge_invoices to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet__guard_invoice()',
    'public.wallet__gstin_state(text)',
    'public.wallet__fy_series(timestamptz, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
  end loop;
  foreach fn in array array[
    'public.wallet_create_recharge_order(uuid, text, bigint, uuid)',
    'public.wallet_issue_recharge_invoice(uuid)',
    'public.wallet_recharges_missing_invoice(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
