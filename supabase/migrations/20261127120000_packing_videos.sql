-- Packing videos (VMS): scan a barcode to start recording at the packing station,
-- scan it again to stop. The browser burns the date, time and barcode into every
-- frame and uploads the file to the VPS volume; this table indexes the files.
--
-- Billing: each saved video costs platform_settings.vms_price_micros (Rs 1) from the
-- tenant wallet, after vms_free_videos free ones per workspace. The charge goes
-- through wallet__lock + wallet__post (tenant wallet migration 20261121120000) as a
-- USAGE_VMS ledger entry, idempotent per video. A video saved while the wallet is
-- short is kept as UNPAID and charged on its next download.

alter table public.platform_settings
  add column if not exists vms_price_micros bigint not null default 1000000,
  add column if not exists vms_free_videos integer not null default 10,
  add column if not exists vms_retention_days integer not null default 35;

alter table public.platform_settings
  drop constraint if exists platform_settings_vms_chk;
alter table public.platform_settings
  add constraint platform_settings_vms_chk check (
    vms_price_micros >= 0 and vms_free_videos >= 0 and vms_retention_days between 1 and 730
  );

-- Let the wallet ledger carry packing video charges.
do $$
begin
  if to_regclass('public.wallet_ledger') is not null then
    alter table public.wallet_ledger drop constraint if exists wallet_ledger_service_chk;
    alter table public.wallet_ledger add constraint wallet_ledger_service_chk
      check (service is null or service in ('whatsapp', 'ai', 'vms'));
    alter table public.wallet_ledger drop constraint if exists wallet_ledger_type_sign_chk;
    alter table public.wallet_ledger add constraint wallet_ledger_type_sign_chk check (
      (entry_type in ('RECHARGE', 'PROMO_CREDIT', 'ADMIN_CREDIT', 'ADMIN_REFUND', 'USAGE_REVERSAL', 'MIGRATION_OPENING')
        and amount_micros > 0)
      or
      (entry_type in ('USAGE_WHATSAPP', 'USAGE_AI', 'USAGE_VMS', 'ADMIN_DEBIT', 'RECHARGE_REVERSAL')
        and amount_micros < 0)
    );
  end if;
end;
$$;

create table if not exists public.packing_videos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recorded_by uuid references auth.users(id) on delete set null,
  barcode text not null,
  order_id uuid references public.orders(id) on delete set null,
  shipment_id uuid references public.shipments(id) on delete set null,
  order_number text,
  tracking_number text,
  status text not null default 'RECORDING',
  billing_status text not null default 'PENDING',
  charge_micros bigint not null default 0,
  wallet_ledger_id uuid,
  mime_type text,
  size_bytes bigint,
  duration_ms integer,
  storage_path text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packing_videos_status_chk check (status in ('RECORDING', 'READY', 'FAILED', 'CANCELLED', 'EXPIRED')),
  constraint packing_videos_billing_chk check (billing_status in ('PENDING', 'FREE', 'CHARGED', 'UNPAID')),
  constraint packing_videos_barcode_chk check (char_length(barcode) between 3 and 80),
  constraint packing_videos_size_chk check (size_bytes is null or size_bytes >= 0),
  constraint packing_videos_mime_chk check (mime_type is null or mime_type in ('video/mp4', 'video/webm'))
);

create index if not exists packing_videos_org_created_idx
  on public.packing_videos (organization_id, created_at desc);
create index if not exists packing_videos_org_barcode_idx
  on public.packing_videos (organization_id, barcode);
create index if not exists packing_videos_org_tracking_idx
  on public.packing_videos (organization_id, tracking_number) where tracking_number is not null;
create index if not exists packing_videos_org_order_number_idx
  on public.packing_videos (organization_id, order_number) where order_number is not null;
create index if not exists packing_videos_order_idx
  on public.packing_videos (order_id) where order_id is not null;
create index if not exists packing_videos_expiry_idx
  on public.packing_videos (expires_at) where status = 'READY';
create index if not exists packing_videos_stale_idx
  on public.packing_videos (started_at) where status = 'RECORDING';

drop trigger if exists packing_videos_updated_at on public.packing_videos;
create trigger packing_videos_updated_at before update on public.packing_videos
  for each row execute function public.set_updated_at();

alter table public.packing_videos enable row level security;

drop policy if exists packing_videos_select on public.packing_videos;
create policy packing_videos_select on public.packing_videos
  for select using (public.is_org_member(organization_id));
-- No insert/update/delete policies: rows change only through the functions below.

-- Starts a recording for a scanned code. Matches the code to an order the same way
-- the packing station does; a code that matches nothing (a marketplace AWB, say)
-- is still recorded under the barcode alone. Refuses cancelled orders and a wallet
-- that cannot pay for the video.
create or replace function public.vms_start_recording(p_organization_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  v_bare text;
  v_order record;
  v_shipment record;
  v_price bigint;
  v_free integer;
  v_free_used integer;
  v_available bigint;
  v_video public.packing_videos;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.member_can_pack(p_organization_id) then
    raise exception 'You do not have access to the packing station' using errcode = '42501';
  end if;
  if length(v_code) < 3 or length(v_code) > 80 then
    return jsonb_build_object('status', 'INVALID_CODE', 'code', v_code);
  end if;
  v_bare := ltrim(v_code, '#');

  select s.id, s.order_id, coalesce(s.barcode, s.tracking_number) as tracking
    into v_shipment
  from public.shipments s
  where s.organization_id = p_organization_id
    and (upper(s.barcode) = v_code or upper(s.tracking_number) = v_code)
  order by s.created_at desc
  limit 1;

  if v_shipment.order_id is not null then
    select o.id, o.order_number, o.status::text as status into v_order
    from public.orders o
    where o.id = v_shipment.order_id and o.organization_id = p_organization_id;
  else
    select o.id, o.order_number, o.status::text as status into v_order
    from public.orders o
    where o.organization_id = p_organization_id
      and ltrim(upper(o.order_number), '#') = v_bare
    order by o.created_at desc
    limit 1;
    if v_order.id is not null then
      select s.id, s.order_id, coalesce(s.barcode, s.tracking_number) as tracking
        into v_shipment
      from public.shipments s
      where s.organization_id = p_organization_id and s.order_id = v_order.id
      order by s.created_at desc
      limit 1;
    end if;
  end if;

  if v_order.status = 'CANCELLED' then
    return jsonb_build_object('status', 'CANCELLED', 'code', v_code, 'orderId', v_order.id, 'orderNumber', v_order.order_number);
  end if;

  select ps.vms_price_micros, ps.vms_free_videos into v_price, v_free
  from public.platform_settings ps where ps.id = 1;
  v_price := coalesce(v_price, 1000000);
  v_free := coalesce(v_free, 10);

  select count(*) into v_free_used from public.packing_videos
  where organization_id = p_organization_id and billing_status = 'FREE';

  if v_free_used >= v_free and v_price > 0 then
    v_available := 0;
    if to_regclass('public.wallets') is not null then
      execute 'select coalesce(balance_micros + credit_limit_micros - reserved_micros, 0)
               from public.wallets where organization_id = $1 and status = ''ACTIVE'''
        into v_available using p_organization_id;
    end if;
    if coalesce(v_available, 0) < v_price then
      return jsonb_build_object(
        'status', 'NO_BALANCE',
        'code', v_code,
        'priceMicros', v_price::text,
        'availableMicros', coalesce(v_available, 0)::text
      );
    end if;
  end if;

  insert into public.packing_videos (
    organization_id, recorded_by, barcode, order_id, shipment_id, order_number, tracking_number
  ) values (
    p_organization_id, v_user, v_code, v_order.id, v_shipment.id, v_order.order_number, v_shipment.tracking
  )
  returning * into v_video;

  return jsonb_build_object(
    'status', 'RECORDING',
    'videoId', v_video.id,
    'code', v_code,
    'orderId', v_order.id,
    'orderNumber', v_order.order_number,
    'trackingNumber', v_shipment.tracking,
    'free', v_free_used < v_free,
    'freeRemaining', greatest(v_free - v_free_used, 0),
    'priceMicros', v_price::text
  );
end;
$$;

-- The recorder (or a manager) drops a recording that was never saved.
create or replace function public.vms_cancel_recording(p_video_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_video public.packing_videos;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_video from public.packing_videos where id = p_video_id for update;
  if not found or v_video.status <> 'RECORDING' then
    return false;
  end if;
  if not public.member_can_pack(v_video.organization_id) or v_video.recorded_by is distinct from v_user then
    raise exception 'Only the person recording can cancel this video' using errcode = '42501';
  end if;
  update public.packing_videos set status = 'CANCELLED', ended_at = now() where id = p_video_id;
  return true;
end;
$$;

-- Charges one saved video: free while the workspace has free videos left, otherwise
-- Rs 1 from the wallet. Safe to call again: a FREE or CHARGED video is left alone and
-- the wallet ledger key 'vms:<video id>' makes the debit idempotent.
create or replace function public.vms__charge(p_video_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_video public.packing_videos;
  v_price bigint;
  v_free integer;
  v_free_used integer;
  -- record, not wallets/wallet_ledger rowtypes, so this compiles before the wallet migration exists.
  w record;
  l record;
begin
  select * into v_video from public.packing_videos where id = p_video_id for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_video.billing_status in ('FREE', 'CHARGED') then
    return jsonb_build_object('status', v_video.billing_status, 'videoId', v_video.id);
  end if;
  if v_video.status <> 'READY' then
    return jsonb_build_object('status', 'NOT_READY', 'videoId', v_video.id);
  end if;

  select ps.vms_price_micros, ps.vms_free_videos into v_price, v_free
  from public.platform_settings ps where ps.id = 1;
  v_price := coalesce(v_price, 1000000);
  v_free := coalesce(v_free, 10);

  -- Locking the wallet serialises free-quota counting for the workspace.
  w := public.wallet__lock(v_video.organization_id);

  select count(*) into v_free_used from public.packing_videos
  where organization_id = v_video.organization_id and billing_status = 'FREE';

  if v_free_used < v_free or v_price = 0 then
    update public.packing_videos set billing_status = 'FREE', charge_micros = 0 where id = v_video.id;
    return jsonb_build_object('status', 'FREE', 'videoId', v_video.id);
  end if;

  select * into l from public.wallet_ledger where wallet_id = w.id and idempotency_key = 'vms:' || v_video.id::text;
  if found then
    update public.packing_videos
    set billing_status = 'CHARGED', charge_micros = -l.amount_micros, wallet_ledger_id = l.id
    where id = v_video.id;
    return jsonb_build_object('status', 'CHARGED', 'videoId', v_video.id, 'ledgerId', l.id);
  end if;

  if w.status = 'FROZEN' or w.balance_micros + w.credit_limit_micros - w.reserved_micros < v_price then
    update public.packing_videos set billing_status = 'UNPAID' where id = v_video.id;
    return jsonb_build_object(
      'status', 'UNPAID',
      'videoId', v_video.id,
      'priceMicros', v_price::text,
      'availableMicros', (w.balance_micros + w.credit_limit_micros - w.reserved_micros)::text
    );
  end if;

  l := public.wallet__post(
    w.id, 'USAGE_VMS', -v_price, 'vms:' || v_video.id::text,
    'vms', 'packing_video', v_video.id::text, null, null, v_video.recorded_by,
    left('Packing video ' || v_video.barcode, 200),
    jsonb_build_object('barcode', v_video.barcode, 'orderId', v_video.order_id)
  );
  update public.packing_videos
  set billing_status = 'CHARGED', charge_micros = v_price, wallet_ledger_id = l.id
  where id = v_video.id;
  return jsonb_build_object('status', 'CHARGED', 'videoId', v_video.id, 'ledgerId', l.id);
end;
$$;

-- Called by the server once the whole file is on disk. Marks the video saved, sets
-- its expiry from vms_retention_days and charges it.
create or replace function public.vms_finalize_video(
  p_video_id uuid,
  p_storage_path text,
  p_size_bytes bigint,
  p_duration_ms integer,
  p_mime_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_video public.packing_videos;
  v_days integer;
begin
  select * into v_video from public.packing_videos where id = p_video_id for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_video.status = 'READY' then
    return public.vms__charge(p_video_id);
  end if;
  if v_video.status <> 'RECORDING' then
    return jsonb_build_object('status', 'NOT_RECORDING', 'videoStatus', v_video.status);
  end if;

  select coalesce(ps.vms_retention_days, 35) into v_days from public.platform_settings ps where ps.id = 1;
  v_days := coalesce(v_days, 35);

  update public.packing_videos
  set status = 'READY',
      storage_path = p_storage_path,
      size_bytes = p_size_bytes,
      duration_ms = greatest(coalesce(p_duration_ms, 0), 0),
      mime_type = p_mime_type,
      ended_at = now(),
      expires_at = now() + make_interval(days => v_days)
  where id = p_video_id;

  return public.vms__charge(p_video_id);
end;
$$;

-- Retention: returns READY videos past expiry and recordings abandoned for 6 hours,
-- marking them EXPIRED / FAILED so the server can delete their files.
create or replace function public.vms_expire_videos(p_limit integer default 500)
returns table (id uuid, organization_id uuid, storage_path text, previous_status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select v.id, v.status
    from public.packing_videos v
    where (v.status = 'READY' and v.expires_at <= now())
       or (v.status = 'RECORDING' and v.started_at <= now() - interval '6 hours')
    order by v.created_at
    limit greatest(coalesce(p_limit, 500), 1)
    for update skip locked
  ),
  updated as (
    update public.packing_videos v
    set status = case when due.status = 'READY' then 'EXPIRED' else 'FAILED' end
    from due
    where v.id = due.id
    returning v.id, v.organization_id, v.storage_path, due.status as previous_status
  )
  select updated.id, updated.organization_id, updated.storage_path, updated.previous_status from updated;
end;
$$;

revoke all on function public.vms_start_recording(uuid, text) from public, anon;
revoke all on function public.vms_cancel_recording(uuid) from public, anon;
revoke all on function public.vms__charge(uuid) from public, anon, authenticated;
revoke all on function public.vms_finalize_video(uuid, text, bigint, integer, text) from public, anon, authenticated;
revoke all on function public.vms_expire_videos(integer) from public, anon, authenticated;
grant execute on function public.vms_start_recording(uuid, text) to authenticated;
grant execute on function public.vms_cancel_recording(uuid) to authenticated;
grant execute on function public.vms__charge(uuid) to service_role;
grant execute on function public.vms_finalize_video(uuid, text, bigint, integer, text) to service_role;
grant execute on function public.vms_expire_videos(integer) to service_role;
