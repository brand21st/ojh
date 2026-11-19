-- Fast checkout for returning storefront buyers.
--
-- storefront_buyer_addresses  addresses a buyer chose to save, per store and WhatsApp number
-- storefront_buyer_devices    browsers allowed to see those addresses without a code
-- storefront_checkout_otps    WhatsApp codes that prove a new browser owns the number
--
-- Only the server (service role) reads these: a saved address is a home address,
-- so nothing here is exposed to anon or merchant sessions.

create table if not exists public.storefront_buyer_addresses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  customer_name text not null,
  line1 text not null,
  line2 text,
  city text not null,
  state text not null,
  pincode text not null check (pincode ~ '^[0-9]{6}$'),
  fingerprint text not null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone, fingerprint)
);
create index if not exists storefront_buyer_addresses_lookup
  on public.storefront_buyer_addresses (organization_id, phone, last_used_at desc);

create table if not exists public.storefront_buyer_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, phone, token_hash)
);

create table if not exists public.storefront_checkout_otps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  code_hash text not null,
  ip_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists storefront_checkout_otps_phone
  on public.storefront_checkout_otps (organization_id, phone, created_at desc);
create index if not exists storefront_checkout_otps_ip
  on public.storefront_checkout_otps (ip_hash, created_at desc);

alter table public.storefront_buyer_addresses enable row level security;
alter table public.storefront_buyer_devices enable row level security;
alter table public.storefront_checkout_otps enable row level security;

revoke all on public.storefront_buyer_addresses from anon, authenticated;
revoke all on public.storefront_buyer_devices from anon, authenticated;
revoke all on public.storefront_checkout_otps from anon, authenticated;
grant select, insert, update, delete on public.storefront_buyer_addresses to service_role;
grant select, insert, update, delete on public.storefront_buyer_devices to service_role;
grant select, insert, update, delete on public.storefront_checkout_otps to service_role;
