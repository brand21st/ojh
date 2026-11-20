-- Booking recovery selects shipments.created_by. The column was never created,
-- so that query failed on every recovery pass.

alter table public.shipments
  add column if not exists created_by uuid references auth.users (id) on delete set null;

comment on column public.shipments.created_by is
  'Account that created the shipment, when known. Null on rows created before this column existed.';

-- Dashboard realtime filters on organization_id. Replica identity is already FULL.
-- These tables were missing from the publication, which logs
-- "invalid column for filter organization_id".

do $$
begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.shipments;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.india_post_connections;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.india_post_contracts;
exception when duplicate_object then null;
end $$;
