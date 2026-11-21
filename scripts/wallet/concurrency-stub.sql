-- Minimal stand-ins for the tables and helpers the wallet migration depends on.
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at = now(); return new; end$$;
create table organizations(id uuid primary key, name text,
  ai_credits_balance integer not null default 500, ai_credits_purchased integer not null default 0,
  ai_credits_used integer not null default 0, updated_at timestamptz default now());
create table organization_members(organization_id uuid, user_id uuid);
create table platform_admins(user_id uuid, email text);
create table subscriptions(id uuid primary key, organization_id uuid);
create table platform_settings(id integer primary key default 1 check (id = 1), updated_at timestamptz default now());
insert into platform_settings(id) values (1);
create table payments(id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade, subscription_id uuid,
  amount_paise bigint not null default 0, currency text default 'INR',
  status text not null default 'PENDING' check (status in ('PENDING','CAPTURED','FAILED','REFUNDED')),
  razorpay_payment_id text, razorpay_order_id text, billing_cycle text, method text, failure_reason text,
  paid_at timestamptz, refunded_at timestamptz, created_at timestamptz default now(),
  payment_purpose text not null default 'subscription');
create function public.is_org_member(org_id uuid) returns boolean language sql stable security definer set search_path = public
  as $$select exists(select 1 from organization_members m where m.organization_id = org_id and m.user_id = auth.uid())$$;
create function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public
  as $$select exists(select 1 from platform_admins a where a.user_id = auth.uid())$$;
insert into organizations(id,name) values ('30000000-0000-4000-8000-000000000001','Merchant');
insert into platform_admins values ('10000000-0000-4000-8000-000000000001','admin@test');
