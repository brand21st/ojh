-- Store Builder: draft / publish / restore for the storefront layout.
-- Additive only. A store with published_layout = null renders exactly as before.

alter table public.storefront_settings add column if not exists business_category text;
alter table public.storefront_settings add column if not exists draft_layout jsonb;
alter table public.storefront_settings add column if not exists published_layout jsonb;
alter table public.storefront_settings add column if not exists draft_updated_at timestamptz;
alter table public.storefront_settings add column if not exists published_at timestamptz;

do $$ begin
  alter table public.storefront_settings add constraint storefront_business_category_chk
    check (business_category is null or business_category ~ '^[a-z-]{2,30}$');
exception when duplicate_object then null; end $$;

comment on column public.storefront_settings.draft_layout is
  'Store Builder working copy (layout + footer + featured ids). Never read by the public store.';
comment on column public.storefront_settings.published_layout is
  'Layout the public store renders. Null = legacy layout from the classic columns.';

create table if not exists public.storefront_layout_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null default 'published',
  snapshot jsonb not null,
  published_by uuid,
  published_at timestamptz not null default now(),
  constraint storefront_layout_versions_label_chk check (label in ('published', 'before-store-builder', 'reverted-to-classic'))
);

create index if not exists storefront_layout_versions_org_idx
  on public.storefront_layout_versions (organization_id, published_at desc);

alter table public.storefront_layout_versions enable row level security;

drop policy if exists storefront_layout_versions_select on public.storefront_layout_versions;
create policy storefront_layout_versions_select on public.storefront_layout_versions
  for select using (public.is_org_member(organization_id));
-- Rows are written only by publish_storefront_layout (runs as the caller, so this policy applies).
drop policy if exists storefront_layout_versions_insert on public.storefront_layout_versions;
create policy storefront_layout_versions_insert on public.storefront_layout_versions
  for insert with check (public.inventory_writer(organization_id));
drop policy if exists storefront_layout_versions_delete on public.storefront_layout_versions;
create policy storefront_layout_versions_delete on public.storefront_layout_versions
  for delete using (public.inventory_writer(organization_id));

/*
 * Publishes in one transaction:
 *  1. on first publish, snapshots the pre-Store-Builder live state so it can be restored;
 *  2. writes the branding the classic readers use (accent, theme, footer, featured ids);
 *  3. sets published_layout (null = back to the classic layout);
 *  4. records the published snapshot and keeps the newest 20.
 * Security invoker: RLS (inventory_writer) decides who may publish. Optimistic check on
 * draft_updated_at stops publishing a draft someone else changed since it was loaded.
 */
create or replace function public.publish_storefront_layout(
  p_organization_id uuid,
  p_layout jsonb,
  p_accent_color text,
  p_theme jsonb,
  p_footer jsonb,
  p_featured_product_ids uuid[],
  p_expected_draft_updated_at timestamptz
) returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_row public.storefront_settings%rowtype;
  now_ts timestamptz := now();
begin
  if not public.inventory_writer(p_organization_id) then
    raise exception 'Not allowed to publish this store' using errcode = '42501';
  end if;
  if p_accent_color is not null and p_accent_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Invalid accent colour' using errcode = '22023';
  end if;

  insert into public.storefront_settings (organization_id) values (p_organization_id)
    on conflict (organization_id) do nothing;
  select * into current_row from public.storefront_settings
    where organization_id = p_organization_id for update;

  if p_expected_draft_updated_at is not null
     and current_row.draft_updated_at is not null
     and date_trunc('milliseconds', current_row.draft_updated_at) <> date_trunc('milliseconds', p_expected_draft_updated_at) then
    raise exception 'The draft changed since you opened it. Reload and try again.' using errcode = '40001';
  end if;

  if not exists (select 1 from public.storefront_layout_versions where organization_id = p_organization_id) then
    insert into public.storefront_layout_versions (organization_id, label, snapshot, published_by, published_at)
    values (
      p_organization_id,
      'before-store-builder',
      jsonb_build_object(
        'layout', current_row.published_layout,
        'accentColor', current_row.accent_color,
        'theme', current_row.theme,
        'footer', current_row.footer,
        'featuredProductIds', to_jsonb(coalesce(current_row.featured_product_ids, '{}'::uuid[]))
      ),
      auth.uid(),
      coalesce(current_row.published_at, current_row.updated_at, now_ts) - interval '1 millisecond'
    );
  end if;

  update public.storefront_settings set
    published_layout = p_layout,
    accent_color = coalesce(p_accent_color, accent_color),
    theme = coalesce(p_theme, theme),
    footer = coalesce(p_footer, footer),
    featured_product_ids = coalesce(p_featured_product_ids, featured_product_ids),
    published_at = now_ts
  where organization_id = p_organization_id;

  insert into public.storefront_layout_versions (organization_id, label, snapshot, published_by, published_at)
  values (
    p_organization_id,
    case when p_layout is null then 'reverted-to-classic' else 'published' end,
    jsonb_build_object(
      'layout', p_layout,
      'accentColor', coalesce(p_accent_color, current_row.accent_color),
      'theme', coalesce(p_theme, current_row.theme),
      'footer', coalesce(p_footer, current_row.footer),
      'featuredProductIds', to_jsonb(coalesce(p_featured_product_ids, current_row.featured_product_ids, '{}'::uuid[]))
    ),
    auth.uid(),
    now_ts
  );

  delete from public.storefront_layout_versions
  where organization_id = p_organization_id
    and label <> 'before-store-builder'
    and id not in (
      select id from public.storefront_layout_versions
      where organization_id = p_organization_id and label <> 'before-store-builder'
      order by published_at desc limit 20
    );

  return now_ts;
end $$;

revoke all on function public.publish_storefront_layout(uuid, jsonb, text, jsonb, jsonb, uuid[], timestamptz) from public, anon;
grant execute on function public.publish_storefront_layout(uuid, jsonb, text, jsonb, jsonb, uuid[], timestamptz) to authenticated, service_role;
