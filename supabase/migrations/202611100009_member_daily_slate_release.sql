-- Release every prediction for a Taiwan-local game date together, 24 hours
-- before the earliest scheduled game on that date. Admins retain full access.

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

  -- For members, reveal all records belonging to a game date only when that
  -- date's earliest game starts within the next 24 hours. This releases the
  -- entire daily slate at once instead of unlocking games one by one.
  if p_dataset_key = 'prediction-ledger' and not public.is_admin() then
    v_payload := jsonb_set(
      v_payload,
      '{records}',
      coalesce(
        (
          select jsonb_agg(r)
          from jsonb_array_elements(coalesce(v_payload->'records', '[]'::jsonb)) as r
          where (
            select min((r2->>'date')::timestamptz)
            from jsonb_array_elements(coalesce(v_payload->'records', '[]'::jsonb)) as r2
            where ((r2->>'date')::timestamptz at time zone 'Asia/Taipei')::date
              = ((r->>'date')::timestamptz at time zone 'Asia/Taipei')::date
          ) <= now() + interval '24 hours'
        ),
        '[]'::jsonb
      ),
      true
    );
  end if;

  return v_payload;
end;
$$;

revoke all on function public.get_member_dataset(text) from public, anon;
grant execute on function public.get_member_dataset(text) to authenticated;
