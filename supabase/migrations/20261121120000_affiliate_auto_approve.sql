-- Instant partner approval and automatic RazorpayX payouts with no manual hold.
-- The earlier auto-payout migration is already applied; this replaces the gate,
-- the admin settings function, and the welcome-email mapping.

create or replace function public.affiliate_payout_gate(p_id uuid) returns text
language plpgsql stable set search_path=public as $$
declare r public.affiliate_payout_requests;
begin
  -- No manual approval: only a partner who is not approved, or who owes a refund recovery, is held.
  select * into r from affiliate_payout_requests where id=p_id;
  if r.id is null then return 'NOT_ELIGIBLE'; end if;
  if not exists(select 1 from affiliate_profiles where id=r.affiliate_id and status='APPROVED')
     or (affiliate_balance(r.affiliate_id)->>'recoverable')::bigint>0 then return 'NOT_ELIGIBLE'; end if;
  return 'OK';
end $$;

create or replace function public.affiliate_admin_auto_settings(p_actor uuid,p_data jsonb) returns void
language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from platform_admins where user_id=p_actor) then raise exception 'Admin required'; end if;
 if length(coalesce(p_data->>'reason',''))<3 then raise exception 'Reason required'; end if;
 update affiliate_settings set
   auto_payout_enabled=(p_data->>'autoPayoutEnabled')::boolean,
   auto_payout_day=(p_data->>'autoPayoutDay')::smallint
 where id=true;
 insert into affiliate_audit_logs(affiliate_id,actor_id,action,details) values(null,p_actor,'settings.auto_payout',p_data-'pin');
end $$;

create or replace function public.affiliate_audit_email() returns trigger
language plpgsql security definer set search_path=public as $$
declare k text;
begin
 if new.affiliate_id is null then return new; end if;
 k:=case new.action
   when 'application.submitted' then case when exists(select 1 from affiliate_profiles where id=new.affiliate_id and status='APPROVED') then 'status_approved' else 'application_received' end
   when 'status' then 'status_'||lower(coalesce(new.details->>'status',''))
   when 'commission.first_cleared' then 'first_commission'
   when 'payout.sent' then 'payout_sent'
   when 'payout.PAID' then 'payout_paid'
   when 'payout.FAILED' then 'payout_failed'
   when 'payout.RETURNED' then 'payout_returned'
   else null end;
 if k is null or k='status_' then return new; end if;
 insert into affiliate_email_outbox(affiliate_id,kind,payload,idempotency_key)
   values(new.affiliate_id,k,new.details,'audit:'||new.id) on conflict(idempotency_key) do nothing;
 return new;
end $$;

alter table public.affiliate_settings alter column auto_payout_enabled set default true;
update public.affiliate_settings set auto_payout_enabled = true where id = true;

alter table public.affiliate_profiles alter column status set default 'APPROVED';

with approved as (
  update public.affiliate_profiles set status='APPROVED', rejection_reason=null where status='PENDING' returning id
)
insert into public.affiliate_audit_logs(affiliate_id,action,details)
select id,'status',jsonb_build_object('status','APPROVED','reason','Automatic approval') from approved;

update public.affiliate_payout_requests
set status = 'APPROVED', hold_reason = null
where status = 'REVIEW' and public.affiliate_payout_gate(id) = 'OK';
