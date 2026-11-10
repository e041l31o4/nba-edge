-- NBA EDGE membership core
-- Apply with: supabase db push
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('member','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_twd integer not null check (price_twd >= 0),
  duration_days integer not null check (duration_days > 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.membership_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  plan_id uuid references public.membership_plans(id) on delete set null,
  plan_name text not null,
  amount_twd integer not null check (amount_twd >= 0),
  duration_days integer not null check (duration_days > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded','expired')),
  payment_provider text not null default 'manual',
  provider_trade_no text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists membership_orders_user_status_idx
  on public.membership_orders(user_id, status, expires_at desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$;

create or replace function public.has_active_membership()
returns boolean
language sql
stable
security definer
set search_path = ''
as $
  select
    public.is_admin()
    or exists (
      select 1 from public.membership_orders o
      where o.user_id = (select auth.uid())
        and o.status = 'paid'
        and o.expires_at > now()
    );
$;

alter table public.profiles enable row level security;
alter table public.membership_plans enable row level security;
alter table public.membership_orders enable row level security;

drop policy if exists "profile read self or admin" on public.profiles;
create policy "profile read self or admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

drop policy if exists "plans read authenticated" on public.membership_plans;
create policy "plans read authenticated" on public.membership_plans
  for select to authenticated
  using (active or public.is_admin());

drop policy if exists "orders read self or admin" on public.membership_orders;
create policy "orders read self or admin" on public.membership_orders
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "plans admin manage" on public.membership_plans;
create policy "plans admin manage" on public.membership_plans
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Orders are intentionally not client-insertable or client-updatable.
-- Create orders and mark them paid only from trusted Edge Functions/webhooks
-- using the Supabase service role after verifying the payment provider signature.

revoke all on public.profiles from anon;
revoke all on public.membership_orders from anon;
revoke all on public.membership_plans from anon;
grant select on public.profiles to authenticated;
grant select on public.membership_orders to authenticated;
grant select on public.membership_plans to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_active_membership() to authenticated;

-- Admin bootstrap is deliberately manual after the owner's first signup:
-- update public.profiles set role = 'admin' where lower(email) = lower('YOUR_ADMIN_EMAIL');
