-- NBA EDGE: admin-selected public games
-- Run once in Supabase SQL Editor after membership migrations.
create table if not exists public.public_game_access (
  id boolean primary key default true check (id),
  game_ids text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.public_game_access enable row level security;
revoke all on public.public_game_access from anon, authenticated;
grant select on public.public_game_access to anon, authenticated;
drop policy if exists "public game selection readable" on public.public_game_access;
create policy "public game selection readable"
  on public.public_game_access for select to anon, authenticated using (true);
drop policy if exists "admin manages public game selection" on public.public_game_access;
create policy "admin manages public game selection"
  on public.public_game_access for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
insert into public.public_game_access (id, game_ids)
values (true, '{}')
on conflict (id) do nothing;
