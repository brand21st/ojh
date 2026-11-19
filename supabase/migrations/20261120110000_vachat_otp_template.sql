-- WhatsApp OTP (storefront checkout + login) template, chosen in Super Admin > Settings > VaChat.
-- Falls back to the VACHAT_OTP_TEMPLATE_NAME env var when null.
alter table public.platform_settings
  add column if not exists vachat_otp_template_name text,
  add column if not exists vachat_otp_template_language text;

comment on column public.platform_settings.vachat_otp_template_name is
  'Approved VaChat AUTHENTICATION template used for WhatsApp OTP codes. Null falls back to VACHAT_OTP_TEMPLATE_NAME.';
comment on column public.platform_settings.vachat_otp_template_language is
  'Language code of the OTP template (for example en or en_US). Null falls back to VACHAT_OTP_TEMPLATE_LANGUAGE or en.';
