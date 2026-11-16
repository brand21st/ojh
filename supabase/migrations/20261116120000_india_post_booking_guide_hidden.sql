alter table public.profiles
  add column if not exists india_post_booking_guide_hidden_at timestamptz;
