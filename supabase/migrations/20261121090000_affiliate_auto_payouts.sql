-- Automatic RazorpayX partner payouts (no manual approval), instant partner approval,
-- and the partner email outbox. Automation is ON by default; the admin toggle only pauses it.
-- Local file. Do not apply remotely without separate authorization.

-- ---------- settings ----------
alter table public.affiliate_settings
  add column if not exists auto_payout_enabled boolean not null default true,
  add column if not exists auto_payout_day smallint not null default 5 check (auto_payout_day between 1 and 28);

-- ---------- partners are approved instantly (no manual review) ----------
alter table public.affiliate_profiles alter column status set default 'APPROVED';
with approved as (
  update public.affiliate_profiles set status='APPROVED', rejection_reason=null where status='PENDING' returning id
)
insert into public.affiliate_audit_logs(affiliate_id,action,details)
select id,'status',jsonb_build_object('status','APPROVED','reason','Automatic approval') from approved;

-- ---------- payout requests ----------
alter table public.affiliate_payout_requests
  add column if not exists origin text not null default 'PARTNER' check (origin in ('PARTNER','AUTO')),
  add column if not exists send_via text not null default 'MANUAL' check (send_via in ('MANUAL','RAZORPAYX')),
  add column if not exists hold_reason text,
  add column if not exists provider_payout_id text unique,
  add column if not exists provider_status text,
  add column if not exists utr text,
  add column if not exists failure_reason text,
  add column if not exists send_attempts integer not null default 0,
  add column if not exists sent_at timestamptz;

alter table public.affiliate_payout_requests drop constraint if exists affiliate_payout_requests_status_check;
alter table public.affiliate_payout_requests add constraint affiliate_payout_requests_status_check
  check (status in ('REQUESTED','APPROVED','PROCESSING','PAID','FAILED','REJECTED','REVIEW','RETURNED'));
create index if not exists affiliate_payout_send_queue on public.affiliate_payout_requests(status, send_via) where provider_payout_id is null;
create index if not exists affiliate_payout_processing on public.affiliate_payout_requests(sent_at) where status = 'PROCESSING';

-- RazorpayX contact / fund-account ids. Payout accounts are immutable, so ids live beside them.
create table if not exists public.affiliate_razorpay_accounts (
  account_id uuid primary key references public.affiliate_payout_accounts(id),
  contact_id text not null,
  fund_account_id text not null,
  created_at timestamptz not null default now()
);

-- ---------- email outbox ----------
create table if not exists public.affiliate_email_outbox (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliate_profiles(id),
  kind text not null,
  payload jsonb not null default '{}',
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease uuid,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_email_due on public.affiliate_email_outbox(next_attempt_at) where status in ('PENDING','SENDING');

alter table public.affiliate_razorpay_accounts enable row level security;
alter table public.affiliate_email_outbox enable row level security;
revoke all on public.affiliate_razorpay_accounts, public.affiliate_email_outbox from public, anon, authenticated;
grant all on public.affiliate_razorpay_accounts, public.affiliate_email_outbox to service_role;

-- ---------- safety gate ----------
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

-- ---------- request (replaced: decides send_via, then gates RazorpayX requests) ----------
create or replace function public.affiliate_request_payout(p_affiliate uuid,p_account uuid,p_amount bigint,p_key uuid) returns uuid
language plpgsql set search_path=public as $$
declare existing public.affiliate_payout_requests; result uuid; balance bigint; source record; remaining bigint; portion bigint;
  via text; gate text;
begin
 perform 1 from affiliate_profiles where id=p_affiliate and status='APPROVED' for update;
 if not found then raise exception 'Partner is not approved'; end if;
 select * into existing from affiliate_payout_requests where idempotency_key=p_key;
 if existing.id is not null then
  if existing.affiliate_id<>p_affiliate or existing.amount_paise<>p_amount or existing.account_id<>p_account then raise exception 'Idempotency conflict'; end if;
  return existing.id;
 end if;
 if not exists(select 1 from affiliate_payout_accounts where id=p_account and affiliate_id=p_affiliate) then raise exception 'Invalid payout account'; end if;
 if p_amount<(select minimum_payout_paise from affiliate_settings) then raise exception 'Below minimum payout'; end if;
 if exists(select 1 from affiliate_payout_requests where affiliate_id=p_affiliate and status in ('REQUESTED','APPROVED','PROCESSING','REVIEW')) then raise exception 'A payout is already in progress'; end if;
 balance:=(affiliate_balance(p_affiliate)->>'available')::bigint;
 if p_amount>balance then raise exception 'Insufficient available balance'; end if;
 if exists(select 1 from affiliate_commissions c join affiliate_processing q on q.payment_id=c.payment_id where c.affiliate_id=p_affiliate and (q.status not in ('RECONCILED','HOLD') or q.updated_at<now()-interval '25 hours')) then raise exception 'Reconciliation required'; end if;
 via:=case when (select auto_payout_enabled from affiliate_settings) then 'RAZORPAYX' else 'MANUAL' end;
 insert into affiliate_payout_requests(affiliate_id,account_id,amount_paise,idempotency_key,send_via) values(p_affiliate,p_account,p_amount,p_key,via) returning id into result;
 insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p_affiliate,result,'RESERVATION',-p_amount,'reserve:'||result);
 remaining:=p_amount;
 for source in select e.id,e.amount_paise-coalesce((select sum(x.amount_paise) from affiliate_payout_allocations x join affiliate_payout_requests r on r.id=x.payout_id where x.ledger_id=e.id and r.status not in ('REJECTED','RETURNED','FAILED')),0) as capacity
 from affiliate_ledger_entries e where e.affiliate_id=p_affiliate and e.kind in ('APPROVAL','ADJUSTMENT') and e.amount_paise>0 order by e.created_at,e.id loop
  portion:=least(remaining,source.capacity);
  if portion>0 then insert into affiliate_payout_allocations(payout_id,ledger_id,amount_paise) values(result,source.id,portion);remaining:=remaining-portion;end if;
  exit when remaining=0;
 end loop;
 if remaining<>0 then raise exception 'Allocation mismatch'; end if;
 insert into affiliate_audit_logs(affiliate_id,action,details) values(p_affiliate,'payout.requested',jsonb_build_object('payout',result,'amountPaise',p_amount));
 if via='RAZORPAYX' then
  gate:=affiliate_payout_gate(result);
  if gate='OK' then
   update affiliate_payout_requests set status='APPROVED' where id=result;
   insert into affiliate_audit_logs(affiliate_id,action,details) values(p_affiliate,'payout.auto_approved',jsonb_build_object('payout',result));
  else
   update affiliate_payout_requests set status='REVIEW',hold_reason=gate where id=result;
   insert into affiliate_audit_logs(affiliate_id,action,details) values(p_affiliate,'payout.held',jsonb_build_object('payout',result,'holdReason',gate));
  end if;
 end if;
 return result;
end $$;

-- ---------- monthly automatic requests ----------
create or replace function public.affiliate_auto_request_payouts(p_month date) returns integer
language plpgsql set search_path=public as $$
declare s public.affiliate_settings; partner record; acct uuid; available bigint; made integer:=0;
begin
 select * into s from affiliate_settings where id=true;
 if not s.auto_payout_enabled then return 0; end if;
 for partner in select id from affiliate_profiles where status='APPROVED' order by created_at loop
  select id into acct from affiliate_payout_accounts where affiliate_id=partner.id order by created_at desc, id desc limit 1;
  continue when acct is null;
  continue when exists(select 1 from affiliate_payout_requests where affiliate_id=partner.id and status in ('REQUESTED','APPROVED','PROCESSING','REVIEW'));
  continue when exists(select 1 from affiliate_payout_requests where idempotency_key=md5(partner.id::text||':'||to_char(p_month,'YYYY-MM'))::uuid);
  available:=(affiliate_balance(partner.id)->>'available')::bigint;
  continue when available<s.minimum_payout_paise;
  begin
   perform affiliate_request_payout(partner.id,acct,available,md5(partner.id::text||':'||to_char(p_month,'YYYY-MM'))::uuid);
   update affiliate_payout_requests set origin='AUTO' where idempotency_key=md5(partner.id::text||':'||to_char(p_month,'YYYY-MM'))::uuid;
   made:=made+1;
  exception when others then
   insert into affiliate_audit_logs(affiliate_id,action,details) values(partner.id,'payout.auto_skipped',jsonb_build_object('reason',left(sqlerrm,200)));
  end;
 end loop;
 return made;
end $$;

-- ---------- provider state ----------
create or replace function public.affiliate_mark_processing(p_id uuid,p_provider_id text,p_provider_status text) returns void
language plpgsql set search_path=public as $$
declare p public.affiliate_payout_requests;
begin
 select * into p from affiliate_payout_requests where id=p_id for update;
 if p.id is null then raise exception 'Payout not found'; end if;
 if p.provider_payout_id is not null then
  if p.provider_payout_id=p_provider_id then return; end if;
  raise exception 'Payout already linked to a different provider payout';
 end if;
 if p.status<>'APPROVED' or p.send_via<>'RAZORPAYX' then raise exception 'Payout is not ready to send'; end if;
 update affiliate_payout_requests set status='PROCESSING',provider_payout_id=p_provider_id,provider_status=p_provider_status,sent_at=now(),failure_reason=null where id=p_id;
 insert into affiliate_audit_logs(affiliate_id,action,details) values(p.affiliate_id,'payout.sent',jsonb_build_object('payout',p.id,'amountPaise',p.amount_paise));
end $$;

create or replace function public.affiliate_record_send_failure(p_id uuid,p_reason text,p_max_attempts integer default 3) returns text
language plpgsql set search_path=public as $$
declare p public.affiliate_payout_requests;
begin
 select * into p from affiliate_payout_requests where id=p_id for update;
 if p.id is null or p.status<>'APPROVED' or p.provider_payout_id is not null then return coalesce(p.status,'MISSING'); end if;
 update affiliate_payout_requests set send_attempts=send_attempts+1,failure_reason=left(p_reason,300) where id=p_id returning * into p;
 if p.send_attempts>=p_max_attempts then
  update affiliate_payout_requests set status='FAILED' where id=p_id;
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p.affiliate_id,p.id,'RELEASE',p.amount_paise,'FAILED:'||p.id) on conflict(idempotency_key) do nothing;
  insert into affiliate_audit_logs(affiliate_id,action,details) values(p.affiliate_id,'payout.FAILED',jsonb_build_object('payout',p.id,'amountPaise',p.amount_paise,'reason',left(p_reason,300)));
  return 'FAILED';
 end if;
 return 'APPROVED';
end $$;

-- Only Razorpay (signed webhook or its own API) reaches this. Every transition is idempotent.
create or replace function public.affiliate_provider_settle(p_provider_id text,p_event text,p_utr text,p_reason text) returns text
language plpgsql set search_path=public as $$
declare p public.affiliate_payout_requests; ev text:=lower(coalesce(p_event,''));
begin
 select * into p from affiliate_payout_requests where provider_payout_id=p_provider_id for update;
 if p.id is null then return 'UNKNOWN'; end if;
 update affiliate_payout_requests set provider_status=ev where id=p.id;
 if ev='processed' then
  if p.status='PAID' then return 'PAID'; end if;
  if p.status<>'PROCESSING' then return p.status; end if;
  update affiliate_payout_requests set status='PAID',utr=nullif(p_utr,''),settlement_reference=coalesce(nullif(p_utr,''),p_provider_id),settled_at=now() where id=p.id;
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p.affiliate_id,p.id,'PAYOUT',-p.amount_paise,'PAID:'||p.id) on conflict(idempotency_key) do nothing;
  insert into affiliate_audit_logs(affiliate_id,action,details) values(p.affiliate_id,'payout.PAID',jsonb_build_object('payout',p.id,'amountPaise',p.amount_paise,'utr',nullif(p_utr,'')));
  insert into affiliate_notifications(affiliate_id,message) values(p.affiliate_id,'Payout paid.');
  return 'PAID';
 elsif ev in ('failed','rejected','cancelled') or (ev='reversed' and p.status='PROCESSING') then
  if p.status in ('FAILED','RETURNED') then return p.status; end if;
  if p.status<>'PROCESSING' then return p.status; end if;
  update affiliate_payout_requests set status='FAILED',failure_reason=left(coalesce(nullif(p_reason,''),ev),300) where id=p.id;
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p.affiliate_id,p.id,'RELEASE',p.amount_paise,'FAILED:'||p.id) on conflict(idempotency_key) do nothing;
  insert into affiliate_audit_logs(affiliate_id,action,details) values(p.affiliate_id,'payout.FAILED',jsonb_build_object('payout',p.id,'amountPaise',p.amount_paise,'reason',left(coalesce(nullif(p_reason,''),ev),300)));
  return 'FAILED';
 elsif ev='reversed' and p.status='PAID' then
  update affiliate_payout_requests set status='RETURNED',failure_reason=left(coalesce(nullif(p_reason,''),'reversed'),300) where id=p.id;
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p.affiliate_id,p.id,'PAYOUT_RETURN',p.amount_paise,'return:'||p.id) on conflict(idempotency_key) do nothing;
  insert into affiliate_audit_logs(affiliate_id,action,details) values(p.affiliate_id,'payout.RETURNED',jsonb_build_object('payout',p.id,'amountPaise',p.amount_paise,'reason',coalesce(nullif(p_reason,''),'reversed')));
  return 'RETURNED';
 end if;
 return p.status;
end $$;

-- ---------- admin settle (replaced: no manual PAID for RazorpayX; FAILED/PROCESSING are final-ish) ----------
create or replace function public.affiliate_settle_payout(p_id uuid,p_action text,p_reference text,p_actor uuid,p_reason text) returns void
language plpgsql set search_path=public as $$
declare p public.affiliate_payout_requests; s text;
begin
 if not exists(select 1 from platform_admins where user_id=p_actor) then raise exception 'Admin required';end if;
 select * into p from affiliate_payout_requests where id=p_id;
 select status into s from affiliate_profiles where id=p.affiliate_id for update;
 select * into p from affiliate_payout_requests where id=p_id for update;
 if p.id is null then raise exception 'Payout not found'; end if;
 if p.send_via='RAZORPAYX' and p_action in ('PAID','RETURNED') then raise exception 'RazorpayX payouts are settled by Razorpay, not by hand'; end if;
 if p.status='PAID' and p_action='RETURNED' and length(p_reason)>=3 then
  update affiliate_payout_requests set status='RETURNED' where id=p.id;
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key) values(p.affiliate_id,p.id,'PAYOUT_RETURN',p.amount_paise,'return:'||p.id);
  insert into affiliate_audit_logs(affiliate_id,actor_id,action,details) values(p.affiliate_id,p_actor,'payout.RETURNED',jsonb_build_object('payout',p.id,'reason',p_reason,'amountPaise',p.amount_paise));
  return;
 end if;
 if p.status in ('PAID','REJECTED','RETURNED','FAILED','PROCESSING') then
  if p.status=p_action and (p_action<>'PAID' or p.settlement_reference=p_reference) then return; end if;
  raise exception 'Payout already finalized or in flight';
 end if;
 if p_action not in ('APPROVED','REJECTED','REVIEW','PAID') or length(p_reason)<3 then raise exception 'Invalid decision'; end if;
 if p_action in ('APPROVED','PAID') and (s<>'APPROVED' or (affiliate_balance(p.affiliate_id)->>'recoverable')::bigint>0) then raise exception 'Payout eligibility requires review'; end if;
 if p_action='PAID' and (p.status<>'APPROVED' or length(coalesce(p_reference,''))<3) then raise exception 'Approval and settlement reference required'; end if;
 if p_action in ('APPROVED','PAID') and exists(select 1 from affiliate_commissions c join affiliate_processing q on q.payment_id=c.payment_id where c.affiliate_id=p.affiliate_id and (q.status not in ('RECONCILED','HOLD') or q.updated_at<now()-interval '25 hours')) then raise exception 'Reconciliation required'; end if;
 update affiliate_payout_requests set status=p_action,
   hold_reason=case when p_action='APPROVED' then null else hold_reason end,
   settlement_reference=case when p_action='PAID' then p_reference else null end,
   settled_at=case when p_action='PAID' then now() else null end where id=p_id;
 if p_action in ('PAID','REJECTED') then
  insert into affiliate_ledger_entries(affiliate_id,payout_id,kind,amount_paise,idempotency_key)
   values(p.affiliate_id,p.id,case when p_action='PAID' then 'PAYOUT' else 'RELEASE' end,case when p_action='PAID' then -p.amount_paise else p.amount_paise end,p_action||':'||p.id);
 end if;
 insert into affiliate_audit_logs(affiliate_id,actor_id,action,details) values(p.affiliate_id,p_actor,'payout.'||p_action,jsonb_build_object('payout',p.id,'reason',p_reason,'amountPaise',p.amount_paise,'utr',case when p_action='PAID' then p_reference end));
 insert into affiliate_notifications(affiliate_id,message) values(p.affiliate_id,'Payout status: '||p_action);
end $$;

-- ---------- admin: automatic payout settings ----------
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

-- ---------- first cleared commission → audit (feeds the email trigger) ----------
create or replace function public.affiliate_first_clearance() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.kind='APPROVAL' and not exists(select 1 from affiliate_ledger_entries where affiliate_id=new.affiliate_id and kind='APPROVAL' and id<>new.id) then
  insert into affiliate_audit_logs(affiliate_id,action,details) values(new.affiliate_id,'commission.first_cleared',jsonb_build_object('amountPaise',new.amount_paise));
 end if;
 return new;
end $$;
drop trigger if exists affiliate_first_clearance on public.affiliate_ledger_entries;
create trigger affiliate_first_clearance after insert on public.affiliate_ledger_entries for each row execute function public.affiliate_first_clearance();

-- ---------- audit log → email outbox ----------
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
drop trigger if exists affiliate_audit_email on public.affiliate_audit_logs;
create trigger affiliate_audit_email after insert on public.affiliate_audit_logs for each row execute function public.affiliate_audit_email();

-- Leased claim so concurrent cron replicas never send the same email twice.
create or replace function public.affiliate_claim_emails(p_limit integer) returns table(id uuid,affiliate_id uuid,kind text,payload jsonb,attempts integer,lease uuid,email text,application jsonb)
language plpgsql security definer set search_path=public,auth as $$
#variable_conflict use_column
declare l uuid:=gen_random_uuid();
begin
 return query
 with due as (
   select o.id from affiliate_email_outbox o
   where (o.status='PENDING' or (o.status='SENDING' and o.next_attempt_at<now()-interval '10 minutes')) and o.next_attempt_at<=now()
   order by o.created_at limit greatest(1,least(p_limit,50)) for update skip locked
 ), claimed as (
   update affiliate_email_outbox o set status='SENDING',lease=l,attempts=o.attempts+1,next_attempt_at=now() from due where o.id=due.id
   returning o.id,o.affiliate_id,o.kind,o.payload,o.attempts,o.lease
 )
 select c.id,c.affiliate_id,c.kind,c.payload,c.attempts,c.lease,u.email::text,p.application
 from claimed c join affiliate_profiles p on p.id=c.affiliate_id join auth.users u on u.id=p.user_id;
end $$;

create or replace function public.affiliate_finish_email(p_id uuid,p_lease uuid,p_status text,p_error text) returns void
language sql set search_path=public as $$
 update affiliate_email_outbox set
   status=case when p_status='RETRY' and attempts>=5 then 'FAILED' when p_status='RETRY' then 'PENDING' else p_status end,
   next_attempt_at=case when p_status='RETRY' then now()+make_interval(mins=>15*attempts) else next_attempt_at end,
   sent_at=case when p_status='SENT' then now() else sent_at end,
   last_error=left(p_error,300), lease=null
 where id=p_id and lease=p_lease;
$$;

revoke all on function public.affiliate_payout_gate(uuid), public.affiliate_auto_request_payouts(date),
  public.affiliate_mark_processing(uuid,text,text), public.affiliate_record_send_failure(uuid,text,integer),
  public.affiliate_provider_settle(text,text,text,text), public.affiliate_admin_auto_settings(uuid,jsonb),
  public.affiliate_claim_emails(integer), public.affiliate_finish_email(uuid,uuid,text,text),
  public.affiliate_first_clearance(), public.affiliate_audit_email() from public, anon, authenticated;
grant execute on function public.affiliate_payout_gate(uuid), public.affiliate_auto_request_payouts(date),
  public.affiliate_mark_processing(uuid,text,text), public.affiliate_record_send_failure(uuid,text,integer),
  public.affiliate_provider_settle(text,text,text,text), public.affiliate_admin_auto_settings(uuid,jsonb),
  public.affiliate_claim_emails(integer), public.affiliate_finish_email(uuid,uuid,text,text) to service_role;
