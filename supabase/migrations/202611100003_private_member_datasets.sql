-- NBA EDGE: private datasets for paid members
-- Apply once in Supabase SQL Editor after quick-setup.sql.
-- GitHub Actions will publish datasets using the service-role key stored as a GitHub secret.
-- Never put the service-role key in VITE_* variables or frontend code.

create table if not exists public.member_datasets (
  dataset_key text primary key check (
    dataset_key in (
      'odds',
      'odds-history',
      'team-form',
      'injuries',
      'rosters',
      'team-metrics',
      'backtest',
      'prediction-ledger'
    )
  ),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.member_datasets enable row level security;

-- No direct table access for browser clients. Only service_role can publish.
revoke all on public.member_datasets from anon, authenticated;
grant all on public.member_datasets to service_role;

create or replace function public.get_member_dataset(p_dataset_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.has_active_membership() then
    raise exception 'Active membership required' using errcode = '42501';
  end if;

  if p_dataset_key not in (
    'odds',
    'odds-history',
    'team-form',
    'injuries',
    'rosters',
    'team-metrics',
    'backtest',
    'prediction-ledger'
  ) then
    raise exception 'Unknown dataset' using errcode = '22023';
  end if;

  select d.payload into v_payload
  from public.member_datasets d
  where d.dataset_key = p_dataset_key;

  if v_payload is null then
    raise exception 'Dataset not published yet' using errcode = 'P0002';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.get_member_dataset(text) from public, anon;
grant execute on function public.get_member_dataset(text) to authenticated;
