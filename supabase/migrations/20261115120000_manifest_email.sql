-- Merchant India Post manifest email. Auto-send stays off until a workspace turns it on.
-- Workers write delivery rows with the service role. Members can read their own rows.

create table if not exists public.manifest_email_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  auto_send_enabled boolean not null default false,
  recipients text[] not null default '{}',
  office_overrides jsonb not null default '{}'::jsonb,
  reply_to text,
  cc_recipients text[] not null default '{}',
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.manifest_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  manifest_id uuid not null references public.manifests (id) on delete cascade,
  trigger_type text not null,
  manifest_closed_at timestamptz not null,
  merchant_name text not null,
  manifest_number text not null,
  manifest_date text not null,
  office_id text,
  office_name text,
  shipment_count integer not null,
  recipients jsonb not null,
  cc_recipients jsonb not null default '[]'::jsonb,
  reply_to text,
  recipient_hash text not null,
  subject text not null,
  template_version text not null,
  attachment_filename text not null,
  attachment_path text,
  attachment_checksum text,
  status text not null,
  smtp_phase text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  retryable boolean not null default false,
  last_error text,
  last_error_code text,
  smtp_message_id text,
  background_job_id uuid references public.background_jobs (id) on delete set null,
  idempotency_key text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint manifest_email_deliveries_trigger_chk check (trigger_type in ('AUTO', 'MANUAL')),
  constraint manifest_email_deliveries_status_chk check (
    status in ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'RETRYING', 'CANCELLED', 'UNKNOWN')
  ),
  constraint manifest_email_deliveries_phase_chk check (
    smtp_phase is null or smtp_phase in ('CONNECTING', 'SUBMITTED')
  ),
  constraint manifest_email_deliveries_idempotency_uidx unique (idempotency_key)
);

create index if not exists manifest_email_deliveries_manifest_idx
  on public.manifest_email_deliveries (organization_id, manifest_id, created_at desc);

drop trigger if exists set_manifest_email_settings_updated_at on public.manifest_email_settings;
create trigger set_manifest_email_settings_updated_at
  before update on public.manifest_email_settings
  for each row execute function public.set_updated_at();

drop trigger if exists set_manifest_email_deliveries_updated_at on public.manifest_email_deliveries;
create trigger set_manifest_email_deliveries_updated_at
  before update on public.manifest_email_deliveries
  for each row execute function public.set_updated_at();

alter table public.manifest_email_settings enable row level security;
alter table public.manifest_email_deliveries enable row level security;

drop policy if exists manifest_email_settings_select on public.manifest_email_settings;
create policy manifest_email_settings_select on public.manifest_email_settings
  for select using (public.is_org_member(organization_id));
drop policy if exists manifest_email_settings_write on public.manifest_email_settings;
create policy manifest_email_settings_write on public.manifest_email_settings
  for all
  using (public.has_org_role(organization_id, array['OWNER', 'ADMIN', 'MANAGER']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['OWNER', 'ADMIN', 'MANAGER']::public.member_role[]));

drop policy if exists manifest_email_deliveries_select on public.manifest_email_deliveries;
create policy manifest_email_deliveries_select on public.manifest_email_deliveries
  for select using (public.is_org_member(organization_id));
drop policy if exists manifest_email_deliveries_insert on public.manifest_email_deliveries;
create policy manifest_email_deliveries_insert on public.manifest_email_deliveries
  for insert with check (
    public.has_org_role(organization_id, array['OWNER', 'ADMIN', 'MANAGER', 'OPERATOR']::public.member_role[])
  );
drop policy if exists manifest_email_deliveries_update on public.manifest_email_deliveries;
create policy manifest_email_deliveries_update on public.manifest_email_deliveries
  for update
  using (public.has_org_role(organization_id, array['OWNER', 'ADMIN', 'MANAGER', 'OPERATOR']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['OWNER', 'ADMIN', 'MANAGER', 'OPERATOR']::public.member_role[]));

revoke all on public.manifest_email_settings from public, anon;
revoke all on public.manifest_email_deliveries from public, anon;
grant select, insert, update on public.manifest_email_settings to authenticated;
grant select, insert, update on public.manifest_email_deliveries to authenticated;
grant all on public.manifest_email_settings, public.manifest_email_deliveries to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'manifest-email',
  'manifest-email',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do nothing;

drop policy if exists manifest_email_storage_select on storage.objects;
create policy manifest_email_storage_select on storage.objects
  for select using (
    bucket_id = 'manifest-email'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

comment on table public.manifest_email_settings is
  'Per-workspace India Post manifest email recipients. auto_send_enabled defaults to false.';
comment on table public.manifest_email_deliveries is
  'One SMTP attempt history row per manifest email. SENT means the SMTP server accepted the message.';
