-- Storefront coupons: % / ₹ off, product or category scope, Buy X get Y, prepaid-only,
-- first-order-only, usage limits, one auto-apply coupon, and redemption + funnel tracking.
-- Orders have no discount column: the discount is allocated into line unit prices and
-- recorded in orders.metadata.storefront.coupon; redemptions keep the ledger.

create table if not exists public.storefront_coupons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{3,32}$'),
  title text check (title is null or char_length(title) <= 80),
  description text check (description is null or char_length(description) <= 160),
  discount_type text not null check (discount_type in ('PERCENT', 'FIXED', 'BUY_X_GET_Y')),
  -- PERCENT: percent off; FIXED: rupees off; BUY_X_GET_Y: percent off the "get" items (100 = free).
  value numeric(12,2) not null check (value > 0),
  max_discount numeric(12,2) check (max_discount is null or max_discount > 0),
  applies_to text not null default 'ALL' check (applies_to in ('ALL', 'PRODUCTS', 'CATEGORIES')),
  product_ids uuid[] not null default '{}',
  category_ids uuid[] not null default '{}',
  buy_quantity integer check (buy_quantity is null or buy_quantity between 1 and 20),
  get_quantity integer check (get_quantity is null or get_quantity between 1 and 20),
  min_order_amount numeric(12,2) check (min_order_amount is null or min_order_amount >= 0),
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  per_customer_limit integer check (per_customer_limit is null or per_customer_limit > 0),
  first_order_only boolean not null default false,
  prepaid_only boolean not null default false,
  auto_apply boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint storefront_coupons_percent_chk check (discount_type <> 'PERCENT' or value < 100),
  constraint storefront_coupons_bxgy_chk check (
    discount_type <> 'BUY_X_GET_Y' or (buy_quantity is not null and get_quantity is not null and value <= 100)
  ),
  constraint storefront_coupons_window_chk check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint storefront_coupons_scope_chk check (
    (applies_to <> 'PRODUCTS' or cardinality(product_ids) between 1 and 200)
    and (applies_to <> 'CATEGORIES' or cardinality(category_ids) between 1 and 50)
  )
);

create unique index if not exists storefront_coupons_org_code_uniq
  on public.storefront_coupons (organization_id, code);
-- One auto-apply coupon at a time keeps the store banner and checkout predictable.
create unique index if not exists storefront_coupons_one_auto_apply
  on public.storefront_coupons (organization_id)
  where auto_apply and status = 'ACTIVE';
create index if not exists storefront_coupons_org_status
  on public.storefront_coupons (organization_id, status, created_at desc);

create table if not exists public.storefront_coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  coupon_id uuid not null,
  order_id uuid references public.orders(id) on delete set null,
  code text not null,
  customer_phone text not null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  discount_amount numeric(12,2) not null check (discount_amount > 0),
  order_total numeric(12,2) not null check (order_total >= 0),
  payment_preference text check (payment_preference is null or payment_preference in ('PREPAID', 'COD')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, coupon_id) references public.storefront_coupons(organization_id, id) on delete cascade
);

create index if not exists storefront_coupon_redemptions_coupon
  on public.storefront_coupon_redemptions (organization_id, coupon_id, created_at desc);
create index if not exists storefront_coupon_redemptions_phone
  on public.storefront_coupon_redemptions (organization_id, coupon_id, customer_phone);
create index if not exists storefront_coupon_redemptions_org_time
  on public.storefront_coupon_redemptions (organization_id, created_at desc);

alter table public.storefront_coupons enable row level security;
alter table public.storefront_coupon_redemptions enable row level security;
drop policy if exists coupons_read on public.storefront_coupons;
create policy coupons_read on public.storefront_coupons
  for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists coupons_write on public.storefront_coupons;
create policy coupons_write on public.storefront_coupons
  for all to authenticated
  using (public.inventory_writer(organization_id))
  with check (public.inventory_writer(organization_id));
-- Redemptions are written only by the public checkout (service role); members read them.
drop policy if exists coupon_redemptions_read on public.storefront_coupon_redemptions;
create policy coupon_redemptions_read on public.storefront_coupon_redemptions
  for select to authenticated using (public.is_org_member(organization_id));

drop trigger if exists set_storefront_coupons_updated_at on public.storefront_coupons;
create trigger set_storefront_coupons_updated_at
  before update on public.storefront_coupons
  for each row execute function public.set_updated_at();

-- Funnel events: magic-link opens and successful applications at checkout.
alter table public.storefront_events add column if not exists coupon_id uuid;
alter table public.storefront_events drop constraint if exists storefront_events_coupon_fk;
alter table public.storefront_events
  add constraint storefront_events_coupon_fk
  foreign key (coupon_id) references public.storefront_coupons(id) on delete set null;
alter table public.storefront_events drop constraint if exists storefront_events_type_chk;
alter table public.storefront_events
  add constraint storefront_events_type_chk
  check (event_type in (
    'PRODUCT_VIEW',
    'PRODUCT_CLICK',
    'ADD_TO_CART',
    'CART_OPENED',
    'CHECKOUT_STARTED',
    'PURCHASE',
    'COVER_IMPRESSION',
    'COVER_CLICK',
    'COUPON_LINK_OPENED',
    'COUPON_APPLIED'
  ));
create index if not exists storefront_events_coupon_idx
  on public.storefront_events (organization_id, coupon_id, event_type, created_at desc)
  where coupon_id is not null;

-- Reserves one use of a coupon atomically. The coupon row lock serialises concurrent
-- checkouts so usage_limit and per_customer_limit can't be overrun.
create or replace function public.reserve_storefront_coupon(
  p_organization_id uuid,
  p_coupon_id uuid,
  p_customer_phone text,
  p_subtotal numeric,
  p_discount numeric,
  p_order_total numeric,
  p_payment_preference text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_coupon public.storefront_coupons%rowtype;
  v_used integer;
  v_id uuid;
begin
  select * into v_coupon
  from public.storefront_coupons
  where organization_id = p_organization_id and id = p_coupon_id
  for update;
  if not found or v_coupon.status <> 'ACTIVE' then
    raise exception 'COUPON_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if (v_coupon.starts_at is not null and v_coupon.starts_at > now())
     or (v_coupon.ends_at is not null and v_coupon.ends_at <= now()) then
    raise exception 'COUPON_EXPIRED' using errcode = 'P0001';
  end if;
  if v_coupon.usage_limit is not null then
    select count(*) into v_used from public.storefront_coupon_redemptions
    where organization_id = p_organization_id and coupon_id = p_coupon_id;
    if v_used >= v_coupon.usage_limit then
      raise exception 'COUPON_USAGE_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  if v_coupon.per_customer_limit is not null then
    select count(*) into v_used from public.storefront_coupon_redemptions
    where organization_id = p_organization_id and coupon_id = p_coupon_id and customer_phone = p_customer_phone;
    if v_used >= v_coupon.per_customer_limit then
      raise exception 'COUPON_CUSTOMER_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  insert into public.storefront_coupon_redemptions (
    organization_id, coupon_id, code, customer_phone, subtotal, discount_amount, order_total, payment_preference
  ) values (
    p_organization_id, p_coupon_id, v_coupon.code, p_customer_phone, p_subtotal, p_discount, p_order_total, p_payment_preference
  ) returning id into v_id;
  return v_id;
end $$;

-- Mini dashboard numbers for a time window, per coupon plus a daily series.
create or replace function public.storefront_coupon_stats(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with r as (
    select * from public.storefront_coupon_redemptions
    where organization_id = p_organization_id and created_at >= p_from and created_at < p_to
  ),
  e as (
    select coupon_id, event_type, count(*) as n
    from public.storefront_events
    where organization_id = p_organization_id and coupon_id is not null
      and created_at >= p_from and created_at < p_to
      and event_type in ('COUPON_LINK_OPENED', 'COUPON_APPLIED')
    group by coupon_id, event_type
  ),
  per as (
    select c.id,
      coalesce((select count(*) from r where r.coupon_id = c.id), 0) as redemptions,
      coalesce((select count(distinct customer_phone) from r where r.coupon_id = c.id), 0) as customers,
      coalesce((select sum(discount_amount) from r where r.coupon_id = c.id), 0) as discount,
      coalesce((select sum(order_total) from r where r.coupon_id = c.id), 0) as revenue,
      coalesce((select n from e where e.coupon_id = c.id and e.event_type = 'COUPON_LINK_OPENED'), 0) as link_opens,
      coalesce((select n from e where e.coupon_id = c.id and e.event_type = 'COUPON_APPLIED'), 0) as applies,
      (select count(*) from public.storefront_coupon_redemptions a
        where a.organization_id = p_organization_id and a.coupon_id = c.id) as lifetime_redemptions
    from public.storefront_coupons c
    where c.organization_id = p_organization_id
  ),
  days as (
    select date_trunc('day', created_at) as day, count(*) as redemptions,
      sum(discount_amount) as discount, sum(order_total) as revenue
    from r group by 1
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'redemptions', (select count(*) from r),
      'customers', (select count(distinct customer_phone) from r),
      'discount', coalesce((select sum(discount_amount) from r), 0),
      'revenue', coalesce((select sum(order_total) from r), 0),
      'linkOpens', coalesce((select sum(n) from e where event_type = 'COUPON_LINK_OPENED'), 0),
      'applies', coalesce((select sum(n) from e where event_type = 'COUPON_APPLIED'), 0)
    ),
    'coupons', coalesce((select jsonb_agg(jsonb_build_object(
      'couponId', id, 'redemptions', redemptions, 'customers', customers, 'discount', discount,
      'revenue', revenue, 'linkOpens', link_opens, 'applies', applies, 'lifetimeRedemptions', lifetime_redemptions
    )) from per), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'day', to_char(day, 'YYYY-MM-DD'), 'redemptions', redemptions, 'discount', discount, 'revenue', revenue
    ) order by day) from days), '[]'::jsonb)
  );
$$;

revoke all on function public.reserve_storefront_coupon(uuid, uuid, text, numeric, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.reserve_storefront_coupon(uuid, uuid, text, numeric, numeric, numeric, text) to service_role;
revoke all on function public.storefront_coupon_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.storefront_coupon_stats(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant select, insert, update, delete on public.storefront_coupons to authenticated, service_role;
grant select on public.storefront_coupon_redemptions to authenticated;
grant select, insert, update, delete on public.storefront_coupon_redemptions to service_role;
