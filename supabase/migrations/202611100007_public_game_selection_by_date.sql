-- Per-date public game selection (two games per Taiwan calendar date)
create table if not exists public.public_game_access_by_date (
  game_date date primary key,
  game_ids text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.public_game_access_by_date enable row level security;
revoke all on public.public_game_access_by_date from anon, authenticated;
grant select on public.public_game_access_by_date to anon, authenticated;
grant insert, update, delete on public.public_game_access_by_date to authenticated;
drop policy if exists "public dated game selection readable" on public.public_game_access_by_date;
create policy "public dated game selection readable"
  on public.public_game_access_by_date for select to anon, authenticated using (true);
drop policy if exists "admin manages dated game selection" on public.public_game_access_by_date;
create policy "admin manages dated game selection"
  on public.public_game_access_by_date for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
