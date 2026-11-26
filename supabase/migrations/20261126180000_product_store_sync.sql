-- Live product + stock sync between PostBus inventory and a merchant's connected Shopify / WooCommerce store.
--
-- product_store_sync_settings: one row per workspace + store; sync runs only while `enabled`.
-- product_store_links: which PostBus product mirrors which store variant, so deletes, SKU renames and
-- stock pushes find the right item without guessing. Both tables are written only by the server
-- (service role); members may read their own workspace's rows.

create table if not exists public.product_store_sync_settings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (source in ('shopify', 'woocommerce')),
  enabled boolean not null default false,
  last_event_at timestamptz,
  last_error text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, source)
);

create table if not exists public.product_store_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  source text not null check (source in ('shopify', 'woocommerce')),
  external_product_id text not null check (char_length(external_product_id) between 1 and 64),
  external_variant_id text not null check (char_length(external_variant_id) between 1 and 64),
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, source, external_variant_id),
  unique (organization_id, source, product_id)
);

create index if not exists product_store_links_external_product_idx
  on public.product_store_links (organization_id, source, external_product_id);

alter table public.product_store_sync_settings enable row level security;
alter table public.product_store_links enable row level security;

grant all on public.product_store_sync_settings to service_role;
grant all on public.product_store_links to service_role;
grant select on public.product_store_sync_settings to authenticated;
grant select on public.product_store_links to authenticated;

drop policy if exists product_store_sync_settings_member_select on public.product_store_sync_settings;
create policy product_store_sync_settings_member_select on public.product_store_sync_settings
  for select to authenticated using (public.is_org_member(organization_id));

drop policy if exists product_store_links_member_select on public.product_store_links;
create policy product_store_links_member_select on public.product_store_links
  for select to authenticated using (public.is_org_member(organization_id));
