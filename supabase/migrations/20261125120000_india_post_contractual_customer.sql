-- Signup: "Are you an India Post contractual customer?" Yes / No.

alter table public.profiles
  add column if not exists india_post_contractual_customer boolean;

comment on column public.profiles.india_post_contractual_customer is
  'Yes/No from Create account: merchant already has an India Post contractual Customer ID. Null for accounts created before this question.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contractual text;
begin
  contractual := lower(btrim(coalesce(new.raw_user_meta_data->>'india_post_contractual_customer', '')));
  insert into public.profiles (id, email, full_name, whatsapp_number, pincode, city, india_post_contractual_customer)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    nullif(new.raw_user_meta_data->>'whatsapp_number', ''),
    nullif(new.raw_user_meta_data->>'pincode', ''),
    nullif(btrim(new.raw_user_meta_data->>'city'), ''),
    case
      when contractual in ('true', 't', '1', 'yes') then true
      when contractual in ('false', 'f', '0', 'no') then false
      else null
    end
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        whatsapp_number = coalesce(public.profiles.whatsapp_number, excluded.whatsapp_number),
        pincode = coalesce(public.profiles.pincode, excluded.pincode),
        city = coalesce(public.profiles.city, excluded.city),
        india_post_contractual_customer = coalesce(
          public.profiles.india_post_contractual_customer,
          excluded.india_post_contractual_customer
        );
  return new;
end;
$$;

create or replace view public.admin_abandoned_signups as
select
  u.id,
  u.email,
  u.created_at,
  nullif(u.raw_user_meta_data->>'full_name', '') as full_name,
  nullif(u.raw_user_meta_data->>'whatsapp_number', '') as whatsapp_number,
  nullif(u.raw_user_meta_data->>'pincode', '') as pincode,
  nullif(btrim(u.raw_user_meta_data->>'city'), '') as city,
  case
    when lower(btrim(coalesce(u.raw_user_meta_data->>'india_post_contractual_customer', ''))) in ('true', 't', '1', 'yes') then true
    when lower(btrim(coalesce(u.raw_user_meta_data->>'india_post_contractual_customer', ''))) in ('false', 'f', '0', 'no') then false
    else null
  end as india_post_contractual_customer
from auth.users u
where u.email_confirmed_at is null
  and u.phone_confirmed_at is null;

revoke all on public.admin_abandoned_signups from public, anon, authenticated;
grant select on public.admin_abandoned_signups to service_role;
