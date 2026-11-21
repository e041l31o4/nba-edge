-- NBA EDGE admin controls: global maintenance mode and manual membership expiry
create table if not exists public.site_settings (
  id boolean primary key default true check (id),
  maintenance_mode boolean not null default false,
  maintenance_message text not null default 'NBA EDGE 正在進行數據維護，完成後將立即開放。',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

insert into public.site_settings (id) values (true)
on conflict (id) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists "site settings public read" on public.site_settings;
create policy "site settings public read"
  on public.site_settings for select to anon, authenticated
  using (true);

revoke all on public.site_settings from anon, authenticated;
grant select on public.site_settings to anon, authenticated;

create or replace function public.admin_set_maintenance_mode(
  p_enabled boolean,
  p_message text default 'NBA EDGE 正在進行數據維護，完成後將立即開放。'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  insert into public.site_settings (id, maintenance_mode, maintenance_message, updated_at, updated_by)
  values (
    true,
    coalesce(p_enabled, false),
    left(coalesce(nullif(trim(p_message), ''), 'NBA EDGE 正在進行數據維護，完成後將立即開放。'), 300),
    now(),
    auth.uid()
  )
  on conflict (id) do update
    set maintenance_mode = excluded.maintenance_mode,
        maintenance_message = excluded.maintenance_message,
        updated_at = now(),
        updated_by = auth.uid();
end;
$$;

create or replace function public.admin_expire_membership(p_email text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  if p_email is null or trim(p_email) = '' then
    raise exception 'Member email is required';
  end if;

  select p.id
    into v_user_id
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'Member account not found';
  end if;

  update public.membership_orders
  set status = 'expired'
  where user_id = v_user_id
    and status = 'paid'
    and expires_at > now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.admin_set_maintenance_mode(boolean, text) from public, anon;
revoke all on function public.admin_expire_membership(text) from public, anon;
grant execute on function public.admin_set_maintenance_mode(boolean, text) to authenticated;
grant execute on function public.admin_expire_membership(text) to authenticated;
