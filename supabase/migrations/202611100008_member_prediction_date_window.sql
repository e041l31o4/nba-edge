-- Restrict paid members to historical predictions, today, and tomorrow.
-- Admins retain full access. Taiwan-local calendar dates are used so the window
-- advances automatically without manual changes.

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

  -- Do not expose future prediction records to paid members. Admins can audit
  -- the complete ledger. Keep all historical rows plus Taiwan today/tomorrow.
  if p_dataset_key = 'prediction-ledger' and not public.is_admin() then
    v_payload := jsonb_set(
      v_payload,
      '{records}',
      coalesce(
        (
          select jsonb_agg(r)
          from jsonb_array_elements(coalesce(v_payload->'records', '[]'::jsonb)) as r
          where ((r->>'date')::timestamptz at time zone 'Asia/Taipei')::date
            <= ((now() at time zone 'Asia/Taipei')::date + 1)
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
