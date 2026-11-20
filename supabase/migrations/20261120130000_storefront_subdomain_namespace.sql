-- Merchant storefronts move to {slug}.postbus.in, the same host namespace as tracking pages.
-- Uniqueness inside each table already exists:
--   customer_order_links: unique (lower(public_workspace)) where status = 'ACTIVE'
--   tracking_pages:       unique (subdomain)
-- This adds the cross-table rule: a label may be a store slug of one merchant and a tracking
-- subdomain of the SAME merchant, never of two different merchants.
--
-- Existing data is not rewritten. Two legacy cross-merchant overlaps (both tracking pages in DRAFT)
-- stay as they are; the app serves the store on such hosts and refuses to publish those pages.
-- The triggers only fire when a row's label/status/org changes, so untouched rows are unaffected.
--
-- Rollback: drop the two triggers and two functions below. No data changes to revert.

create or replace function public.assert_store_slug_host_free()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  label text := lower(new.public_workspace);
begin
  if new.status <> 'ACTIVE' or label is null or label = '' then
    return new;
  end if;
  -- Re-saving an unchanged row (including the grandfathered overlaps) is always allowed.
  if tg_op = 'UPDATE' and lower(old.public_workspace) is not distinct from label
     and old.status = new.status and old.organization_id = new.organization_id then
    return new;
  end if;
  -- Serialise claims on this label across both tables (closes the check-then-write race).
  perform pg_advisory_xact_lock(hashtext('postbus-public-host:' || label));
  if exists (
    select 1 from public.tracking_pages t
    where t.subdomain = label and t.organization_id <> new.organization_id
  ) then
    raise exception 'store address % is already used by another merchant', label
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_order_links_public_host_guard on public.customer_order_links;
create trigger customer_order_links_public_host_guard
  before insert or update of public_workspace, status, organization_id on public.customer_order_links
  for each row execute function public.assert_store_slug_host_free();

create or replace function public.assert_tracking_subdomain_host_free()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  label text := lower(new.subdomain);
begin
  if label is null or label = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.subdomain is not distinct from new.subdomain
     and old.organization_id = new.organization_id then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('postbus-public-host:' || label));
  if exists (
    select 1 from public.customer_order_links l
    where l.status = 'ACTIVE'
      and lower(l.public_workspace) = label
      and l.organization_id <> new.organization_id
  ) then
    raise exception 'subdomain % is already used by another merchant''s store', label
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists tracking_pages_public_host_guard on public.tracking_pages;
create trigger tracking_pages_public_host_guard
  before insert or update of subdomain, organization_id on public.tracking_pages
  for each row execute function public.assert_tracking_subdomain_host_free();

revoke all on function public.assert_store_slug_host_free() from public, anon, authenticated;
revoke all on function public.assert_tracking_subdomain_host_free() from public, anon, authenticated;
