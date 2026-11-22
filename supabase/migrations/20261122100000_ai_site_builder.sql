-- AI Website Builder: the super admin picks the OpenRouter model (Gemini by default)
-- and how many AI credits one generation costs. Additive only.

alter table public.platform_settings
  add column if not exists openrouter_site_model text not null default 'google/gemini-2.5-flash';

alter table public.platform_settings
  add column if not exists ai_site_credit_cost integer not null default 20;

do $$ begin
  alter table public.platform_settings add constraint platform_settings_ai_site_credit_cost
    check (ai_site_credit_cost between 1 and 500);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.platform_settings add constraint platform_settings_openrouter_site_model
    check (openrouter_site_model ~ '^google/gemini-[A-Za-z0-9.:-]+$' and char_length(openrouter_site_model) <= 80);
exception when duplicate_object then null; end $$;

comment on column public.platform_settings.openrouter_site_model is
  'OpenRouter model for the merchant AI Website Builder (Gemini family). Set by the super admin.';
comment on column public.platform_settings.ai_site_credit_cost is
  'AI credits charged per successful AI website generation.';
