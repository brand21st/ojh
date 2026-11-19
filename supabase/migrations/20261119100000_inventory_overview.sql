-- Inventory overview v2: one reconcilable snapshot for the Inventory > Overview tab.
--
-- Order classification (each order lands in exactly one bucket):
--   cancelled  status FAILED/CANCELLED, or payment_status FAILED
--   returned   any shipment in an RTO state
--   refunded   payment_status REFUNDED
--   sale       everything else
-- Money identity for sales: collected + cod_due + prepaid_due = order_value.
-- Stock figures cover active products only, so archived items never raise alerts.

create or replace function public.inventory_overview(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_prev_from timestamptz,
  p_prev_to timestamptz,
  p_bucket text default 'day'
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with orders_window as (
    select
      o.id,
      o.created_at,
      coalesce(o.total_amount, 0)::numeric as total,
      case
        when o.payment_status = 'PAID' then coalesce(o.total_amount, 0)
        else least(greatest(coalesce(o.amount_paid, 0), 0), coalesce(o.total_amount, 0))
      end::numeric as collected,
      o.payment_status::text as payment_status,
      case when o.created_at >= p_from and o.created_at <= p_to then 'current' else 'previous' end as period,
      case
        when o.status::text in ('FAILED', 'CANCELLED') or o.payment_status::text = 'FAILED' then 'cancelled'
        when exists (
          select 1 from public.shipments s
          where s.order_id = o.id
            and s.organization_id = p_organization_id
            and s.operational_status in ('RTO', 'RTO_IN_TRANSIT', 'RTO_DELIVERED')
        ) then 'returned'
        when o.payment_status::text = 'REFUNDED' then 'refunded'
        else 'sale'
      end as kind
    from public.orders o
    where o.organization_id = p_organization_id
      and (
        (o.created_at >= p_from and o.created_at <= p_to)
        or (o.created_at >= p_prev_from and o.created_at < least(p_prev_to, p_from))
      )
  ),
  lines as (
    select li.product_id, li.quantity, li.unit_price, o.id as order_id, o.period
    from public.order_line_items li
    join orders_window o on o.id = li.order_id and o.kind = 'sale'
    where li.organization_id = p_organization_id
      and li.product_id is not null
  ),
  periods as (
    select
      pr.period,
      count(*) filter (where o.kind = 'sale') as orders,
      coalesce(sum(o.total) filter (where o.kind = 'sale'), 0) as order_value,
      coalesce(sum(o.collected) filter (where o.kind = 'sale'), 0) as collected,
      coalesce(sum(o.total - o.collected) filter (where o.kind = 'sale' and o.payment_status in ('COD', 'PARTIAL')), 0) as cod_due,
      coalesce(sum(o.total - o.collected) filter (where o.kind = 'sale' and o.payment_status not in ('COD', 'PARTIAL')), 0) as prepaid_due,
      count(*) filter (where o.kind = 'returned') as returned,
      count(*) filter (where o.kind = 'cancelled') as cancelled,
      count(*) filter (where o.kind = 'refunded') as refunded,
      (select coalesce(sum(l.quantity), 0) from lines l where l.period = pr.period) as units
    from (values ('current'), ('previous')) as pr(period)
    left join orders_window o on o.period = pr.period
    group by pr.period
  ),
  stock as (
    select
      p.id, p.name, p.sku, p.active, p.price,
      coalesce(p.low_stock_threshold, 5) as threshold,
      coalesce(b.on_hand, 0) as on_hand
    from public.products p
    left join public.inventory_balances b
      on b.product_id = p.id and b.organization_id = p_organization_id
    where p.organization_id = p_organization_id
  ),
  velocity as (
    select li.product_id, sum(li.quantity) as units_30d
    from public.order_line_items li
    join public.orders o on o.id = li.order_id
    where li.organization_id = p_organization_id
      and o.organization_id = p_organization_id
      and o.created_at > p_to - interval '30 days'
      and o.created_at <= p_to
      and o.status::text not in ('FAILED', 'CANCELLED')
      and o.payment_status::text not in ('FAILED', 'REFUNDED')
      and li.product_id is not null
    group by li.product_id
  ),
  buckets as (
    select gs as bucket
    from generate_series(
      date_trunc(case when p_bucket = 'hour' then 'hour' else 'day' end, p_from at time zone 'Asia/Kolkata'),
      date_trunc(case when p_bucket = 'hour' then 'hour' else 'day' end, p_to at time zone 'Asia/Kolkata'),
      case when p_bucket = 'hour' then interval '1 hour' else interval '1 day' end
    ) gs
  ),
  series as (
    select
      b.bucket,
      count(o.id) as orders,
      coalesce(sum(o.total), 0) as order_value
    from buckets b
    left join orders_window o
      on o.kind = 'sale'
      and o.period = 'current'
      and date_trunc(case when p_bucket = 'hour' then 'hour' else 'day' end, o.created_at at time zone 'Asia/Kolkata') = b.bucket
    group by b.bucket
  ),
  top as (
    select
      l.product_id,
      count(distinct l.order_id) as orders,
      sum(l.quantity) as units,
      sum(l.quantity * l.unit_price) as revenue
    from lines l
    where l.period = 'current'
    group by l.product_id
    order by units desc, revenue desc, l.product_id
    limit 8
  )
  select jsonb_build_object(
    'catalog', (
      select jsonb_build_object(
        'totalProducts', count(*),
        'activeProducts', count(*) filter (where active),
        'stockUnits', coalesce(sum(greatest(on_hand, 0)) filter (where active), 0),
        'stockValue', coalesce(sum(greatest(on_hand, 0) * price) filter (where active), 0),
        'outOfStock', count(*) filter (where active and on_hand <= 0),
        'lowStock', count(*) filter (where active and on_hand > 0 and on_hand <= threshold)
      )
      from stock
    ),
    'current', (
      select jsonb_build_object('orders', orders, 'units', units, 'orderValue', order_value, 'collected', collected,
        'codDue', cod_due, 'prepaidDue', prepaid_due, 'returned', returned, 'cancelled', cancelled, 'refunded', refunded)
      from periods where period = 'current'
    ),
    'previous', (
      select jsonb_build_object('orders', orders, 'units', units, 'orderValue', order_value, 'collected', collected,
        'codDue', cod_due, 'prepaidDue', prepaid_due, 'returned', returned, 'cancelled', cancelled, 'refunded', refunded)
      from periods where period = 'previous'
    ),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', to_char(bucket, 'YYYY-MM-DD"T"HH24:MI:SS'), 'orders', orders, 'orderValue', order_value) order by bucket)
      from series
    ), '[]'::jsonb),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', t.product_id, 'name', coalesce(s.name, 'Deleted product'), 'sku', coalesce(s.sku, ''),
        'orders', t.orders, 'units', t.units, 'revenue', t.revenue,
        'onHand', coalesce(s.on_hand, 0), 'active', coalesce(s.active, false)
      ) order by t.units desc, t.revenue desc, t.product_id)
      from top t
      left join stock s on s.id = t.product_id
    ), '[]'::jsonb),
    'attention', coalesce((
      select jsonb_agg(row_data order by (row_data->>'onHand')::numeric, (row_data->>'units30d')::numeric desc, row_data->>'name')
      from (
        select jsonb_build_object(
          'productId', s.id, 'name', s.name, 'sku', s.sku, 'onHand', s.on_hand,
          'threshold', s.threshold, 'units30d', coalesce(v.units_30d, 0)
        ) as row_data
        from stock s
        left join velocity v on v.product_id = s.id
        where s.active and s.on_hand <= s.threshold
        order by s.on_hand, coalesce(v.units_30d, 0) desc, s.name
        limit 10
      ) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.inventory_overview(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.inventory_overview(uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) to authenticated, service_role;
