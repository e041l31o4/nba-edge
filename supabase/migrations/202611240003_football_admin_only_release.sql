-- NBA EDGE: football prediction page remains admin-only until explicitly released.
-- Safe default: false. Existing members do not gain access automatically.
create table if not exists public.football_access_settings (
  singleton boolean primary key default true check (singleton),
  members_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.football_access_settings(singleton,members_enabled)
values (true,false)
on conflict (singleton) do nothing;

alter table public.football_access_settings enable row level security;
revoke all on public.football_access_settings from anon, authenticated;

create or replace function public.get_football_member_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.members_enabled
    from public.football_access_settings s
    where s.singleton = true
  ),false);
$$;
revoke all on function public.get_football_member_access() from public,anon;
grant execute on function public.get_football_member_access() to authenticated;

create or replace function public.admin_set_football_member_access(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception 'Administrator permission required' using errcode = '42501';
  end if;
  update public.football_access_settings
  set members_enabled = coalesce(p_enabled,false),
      updated_at = now(),
      updated_by = auth.uid()
  where singleton = true;
  if not found then
    insert into public.football_access_settings(singleton,members_enabled,updated_at,updated_by)
    values (true,coalesce(p_enabled,false),now(),auth.uid());
  end if;
  return coalesce(p_enabled,false);
end;
$$;
revoke all on function public.admin_set_football_member_access(boolean) from public,anon;
grant execute on function public.admin_set_football_member_access(boolean) to authenticated;

-- Enforce the release switch server-side as well as hiding the page in the UI.
create or replace function public.get_member_dataset(p_dataset_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_is_admin boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select exists(
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ) into v_is_admin;

  if p_dataset_key = 'football-prediction-ledger'
     and not v_is_admin
     and not public.get_football_member_access() then
    raise exception 'Football page is currently private to administrators' using errcode = '42501';
  end if;

  if not public.has_active_membership() and not v_is_admin then
    raise exception 'Active membership required' using errcode = '42501';
  end if;
  if p_dataset_key not in (
    'odds','odds-history','team-form','injuries','rosters','team-metrics',
    'backtest','prediction-ledger','football-prediction-ledger'
  ) then
    raise exception 'Unknown dataset' using errcode = '22023';
  end if;

  select d.payload into v_payload
  from public.member_datasets d where d.dataset_key = p_dataset_key;
  if v_payload is null then
    raise exception 'Dataset not published yet' using errcode = 'P0002';
  end if;

  if p_dataset_key = 'football-prediction-ledger' and not v_is_admin then
    return jsonb_build_object(
      'records',
      coalesce((
        select jsonb_agg(record_value)
        from jsonb_array_elements(coalesce(v_payload->'records','[]'::jsonb)) as items(record_value)
        where (record_value->>'lockedAt')::timestamptz <= now()
          and (((record_value->>'date')::timestamptz at time zone 'Asia/Taipei')::date)
              <= ((now() at time zone 'Asia/Taipei')::date + 1)
      ),'[]'::jsonb)
    );
  end if;
  return v_payload;
end;
$$;
revoke all on function public.get_member_dataset(text) from public,anon;
grant execute on function public.get_member_dataset(text) to authenticated;
