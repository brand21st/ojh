-- Team: member status and per-member feature switches, richer invites, and an activity log
-- that records who booked, packed, printed and manifested each order.

-- 1. Members ------------------------------------------------------------------------------

alter table public.organization_members
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists team text,
  add column if not exists title text,
  add column if not exists extra_permissions text[] not null default '{}',
  add column if not exists revoked_permissions text[] not null default '{}',
  add column if not exists invited_by uuid references auth.users (id) on delete set null,
  add column if not exists last_seen_at timestamptz;

alter table public.organization_members
  drop constraint if exists organization_members_status_check;
alter table public.organization_members
  add constraint organization_members_status_check check (status in ('ACTIVE', 'SUSPENDED'));

alter table public.organization_members
  drop constraint if exists organization_members_team_check;
alter table public.organization_members
  add constraint organization_members_team_check
  check (team is null or team in ('MANAGEMENT', 'FULFILLMENT', 'PACKING', 'SUPPORT', 'ACCOUNTS'));

comment on column public.organization_members.status is
  'SUSPENDED members keep their history but lose all access to the workspace.';
comment on column public.organization_members.extra_permissions is
  'Read-only and app-only permissions added on top of the role (see lib/permissions/rbac.ts).';
comment on column public.organization_members.revoked_permissions is
  'Features switched off for this member, from the ones their role includes.';

-- Suspended members lose access everywhere row security checks membership.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
  );
$$;

create or replace function public.has_org_role(org_id uuid, roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role = any(roles)
      and m.status = 'ACTIVE'
  );
$$;

-- 2. Invites ------------------------------------------------------------------------------

alter table public.organization_invites
  add column if not exists full_name text,
  add column if not exists team text,
  add column if not exists title text,
  add column if not exists extra_permissions text[] not null default '{}',
  add column if not exists revoked_permissions text[] not null default '{}',
  add column if not exists revoked_at timestamptz,
  add column if not exists accepted_by uuid references auth.users (id) on delete set null;

create index if not exists organization_invites_token_hash_idx
  on public.organization_invites (token_hash);

-- One open invite per email per workspace. Older duplicates are closed first so the index can build.
update public.organization_invites i
set revoked_at = now()
where i.accepted_at is null
  and i.revoked_at is null
  and exists (
    select 1 from public.organization_invites newer
    where newer.organization_id = i.organization_id
      and lower(newer.email) = lower(i.email)
      and newer.accepted_at is null
      and newer.revoked_at is null
      and newer.created_at > i.created_at
  );

create unique index if not exists organization_invites_open_email_uidx
  on public.organization_invites (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- 3. Packing ------------------------------------------------------------------------------

alter table public.orders
  add column if not exists packed_at timestamptz,
  add column if not exists packed_by uuid references auth.users (id) on delete set null;

create index if not exists orders_org_packed_idx
  on public.orders (organization_id, packed_at desc)
  where packed_at is not null;

-- 4. Activity log -------------------------------------------------------------------------

create table if not exists public.team_activity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('order.booked', 'order.packed', 'label.printed', 'manifest.created')),
  entity_type text not null,
  entity_id uuid not null,
  order_id uuid references public.orders (id) on delete set null,
  quantity integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

comment on table public.team_activity_events is
  'One row per thing a team member did (booked, packed, printed, manifested). Null actor = automation.';

-- Each entity counts once per action: re-downloads and retries do not inflate anyone's numbers.
create unique index if not exists team_activity_events_once_uidx
  on public.team_activity_events (organization_id, action, entity_id);
create index if not exists team_activity_events_org_time_idx
  on public.team_activity_events (organization_id, occurred_at desc);
create index if not exists team_activity_events_actor_time_idx
  on public.team_activity_events (organization_id, actor_id, occurred_at desc);

alter table public.team_activity_events enable row level security;

drop policy if exists team_activity_events_select on public.team_activity_events;
create policy team_activity_events_select on public.team_activity_events
  for select using (public.is_org_member(organization_id));
-- No insert/update/delete policies: rows are written only by the triggers and functions below.

-- Shipments remember who created them when the request carries a signed-in user.
create or replace function public.shipments_default_created_by()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_default_created_by on public.shipments;
create trigger shipments_default_created_by
  before insert on public.shipments
  for each row execute function public.shipments_default_created_by();

create or replace function public.team_activity_on_shipment_booked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.booked_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.booked_at is not null then
    return new;
  end if;
  insert into public.team_activity_events
    (organization_id, actor_id, action, entity_type, entity_id, order_id, occurred_at, metadata)
  values (
    new.organization_id,
    coalesce(new.created_by, auth.uid()),
    'order.booked',
    'shipment',
    new.id,
    new.order_id,
    new.booked_at,
    jsonb_build_object('barcode', new.barcode)
  )
  on conflict (organization_id, action, entity_id) do nothing;
  return new;
end;
$$;

drop trigger if exists team_activity_shipment_booked on public.shipments;
create trigger team_activity_shipment_booked
  after insert or update of booked_at on public.shipments
  for each row execute function public.team_activity_on_shipment_booked();

create or replace function public.team_activity_on_label_downloaded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
begin
  if new.downloaded_at is null or (old.downloaded_at is not null) then
    return new;
  end if;
  select s.order_id into v_order from public.shipments s where s.id = new.shipment_id;
  -- Counted per shipment: an India Post label and a packing label for one parcel are one print job.
  insert into public.team_activity_events
    (organization_id, actor_id, action, entity_type, entity_id, order_id, occurred_at)
  values (new.organization_id, auth.uid(), 'label.printed', 'shipment', new.shipment_id, v_order, new.downloaded_at)
  on conflict (organization_id, action, entity_id) do nothing;
  return new;
end;
$$;

drop trigger if exists team_activity_label_downloaded on public.labels;
create trigger team_activity_label_downloaded
  after update of downloaded_at on public.labels
  for each row execute function public.team_activity_on_label_downloaded();

create or replace function public.team_activity_on_manifest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.team_activity_events
    (organization_id, actor_id, action, entity_type, entity_id, quantity, occurred_at, metadata)
  values (
    new.organization_id,
    coalesce(new.created_by, auth.uid()),
    'manifest.created',
    'manifest',
    new.id,
    greatest(coalesce(new.shipment_count, 0), 0),
    new.created_at,
    jsonb_build_object('name', new.name)
  )
  on conflict (organization_id, action, entity_id)
  do update set quantity = excluded.quantity;
  return new;
end;
$$;

drop trigger if exists team_activity_manifest on public.manifests;
create trigger team_activity_manifest
  after insert or update of shipment_count on public.manifests
  for each row execute function public.team_activity_on_manifest();

-- 5. Packing scan -------------------------------------------------------------------------

-- Whether the signed-in user may use the packing station in this workspace. Mirrors
-- effectivePermissions() in lib/permissions/rbac.ts for the one permission it needs.
create or replace function public.member_can_pack(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
      and (
        m.role = 'OWNER'
        or 'packing.scan' = any(m.extra_permissions)
        or (
          m.role in ('ADMIN', 'MANAGER', 'OPERATOR', 'PACKER')
          and not ('packing.scan' = any(m.revoked_permissions))
        )
      )
  );
$$;

-- Marks one order packed from a scanned barcode, tracking number or order number.
-- Returns status PACKED, ALREADY_PACKED, NOT_FOUND or CANCELLED with the order's details.
create or replace function public.record_pack_scan(p_organization_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  v_bare text;
  v_order public.orders%rowtype;
  v_shipment record;
  v_packer_name text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.member_can_pack(p_organization_id) then
    raise exception 'You do not have access to the packing station' using errcode = '42501';
  end if;
  if length(v_code) < 3 or length(v_code) > 80 then
    return jsonb_build_object('status', 'NOT_FOUND', 'code', v_code);
  end if;
  v_bare := ltrim(v_code, '#');

  select s.id, s.order_id, s.barcode, s.status::text as status
    into v_shipment
  from public.shipments s
  where s.organization_id = p_organization_id
    and (upper(s.barcode) = v_code or upper(s.tracking_number) = v_code)
  order by s.created_at desc
  limit 1;

  if v_shipment.order_id is not null then
    select * into v_order from public.orders o
    where o.id = v_shipment.order_id and o.organization_id = p_organization_id
    for update;
  else
    select * into v_order from public.orders o
    where o.organization_id = p_organization_id
      and ltrim(upper(o.order_number), '#') = v_bare
    order by o.created_at desc
    limit 1
    for update;
    if v_order.id is not null then
      select s.id, s.order_id, s.barcode, s.status::text as status
        into v_shipment
      from public.shipments s
      where s.organization_id = p_organization_id and s.order_id = v_order.id
      order by s.created_at desc
      limit 1;
    end if;
  end if;

  if v_order.id is null then
    return jsonb_build_object('status', 'NOT_FOUND', 'code', v_code);
  end if;

  if v_order.status = 'CANCELLED' then
    return jsonb_build_object(
      'status', 'CANCELLED',
      'orderId', v_order.id,
      'orderNumber', v_order.order_number,
      'barcode', v_shipment.barcode
    );
  end if;

  if v_order.packed_at is not null then
    select coalesce(nullif(p.full_name, ''), p.email) into v_packer_name
    from public.profiles p where p.id = v_order.packed_by;
    return jsonb_build_object(
      'status', 'ALREADY_PACKED',
      'orderId', v_order.id,
      'orderNumber', v_order.order_number,
      'barcode', v_shipment.barcode,
      'shipmentStatus', v_shipment.status,
      'packedAt', v_order.packed_at,
      'packedBy', v_order.packed_by,
      'packedByName', v_packer_name
    );
  end if;

  update public.orders
    set packed_at = now(), packed_by = v_user
    where id = v_order.id
    returning * into v_order;

  insert into public.team_activity_events
    (organization_id, actor_id, action, entity_type, entity_id, order_id, metadata)
  values (
    p_organization_id, v_user, 'order.packed', 'order', v_order.id, v_order.id,
    jsonb_build_object('code', v_code, 'barcode', v_shipment.barcode)
  )
  on conflict (organization_id, action, entity_id) do nothing;

  return jsonb_build_object(
    'status', 'PACKED',
    'orderId', v_order.id,
    'orderNumber', v_order.order_number,
    'barcode', v_shipment.barcode,
    'shipmentStatus', v_shipment.status,
    'packedAt', v_order.packed_at,
    'packedBy', v_user
  );
end;
$$;

-- Undo a pack: the packer within 15 minutes of their own scan, or an owner, admin or manager anytime.
create or replace function public.undo_pack_scan(p_organization_id uuid, p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_order from public.orders
  where id = p_order_id and organization_id = p_organization_id
  for update;
  if v_order.id is null or v_order.packed_at is null then
    return false;
  end if;
  if not (
    public.has_org_role(p_organization_id, array['OWNER', 'ADMIN', 'MANAGER']::public.member_role[])
    or (
      public.member_can_pack(p_organization_id)
      and v_order.packed_by = v_user
      and v_order.packed_at > now() - interval '15 minutes'
    )
  ) then
    raise exception 'You cannot undo this pack' using errcode = '42501';
  end if;
  update public.orders set packed_at = null, packed_by = null where id = p_order_id;
  delete from public.team_activity_events
  where organization_id = p_organization_id and action = 'order.packed' and entity_id = p_order_id;
  return true;
end;
$$;

-- 6. Reporting ----------------------------------------------------------------------------

-- Daily counts per member and action, on India time. Row security limits it to the caller's workspaces.
create or replace function public.team_activity_summary(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (actor_id uuid, day date, action text, events bigint, quantity bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    e.actor_id,
    (e.occurred_at at time zone 'Asia/Kolkata')::date as day,
    e.action,
    count(*) as events,
    coalesce(sum(e.quantity), 0) as quantity
  from public.team_activity_events e
  where e.organization_id = p_organization_id
    and e.occurred_at >= p_from
    and e.occurred_at < p_to
  group by 1, 2, 3;
$$;

revoke all on function public.member_can_pack(uuid) from public, anon;
revoke all on function public.record_pack_scan(uuid, text) from public, anon;
revoke all on function public.undo_pack_scan(uuid, uuid) from public, anon;
revoke all on function public.team_activity_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.member_can_pack(uuid) to authenticated;
grant execute on function public.record_pack_scan(uuid, text) to authenticated;
grant execute on function public.undo_pack_scan(uuid, uuid) to authenticated;
grant execute on function public.team_activity_summary(uuid, timestamptz, timestamptz) to authenticated;
