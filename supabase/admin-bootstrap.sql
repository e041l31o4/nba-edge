-- Run this in Supabase SQL Editor AFTER signing up with this email:
update public.profiles
set role = 'admin', updated_at = now()
where lower(email) = lower('ruoruo0923@yahoo.com.tw');

-- Confirm exactly one account was promoted:
select id, email, role from public.profiles
where lower(email) = lower('ruoruo0923@yahoo.com.tw');
