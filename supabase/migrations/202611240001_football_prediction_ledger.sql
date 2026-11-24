-- NBA EDGE: private UCL football prediction ledger with immutable 21:00 Taiwan lock.
alter table public.member_datasets
  drop constraint if exists member_datasets_dataset_key_check;

alter table public.member_datasets
  add constraint member_datasets_dataset_key_check check (
    dataset_key in (
      'odds','odds-history','team-form','injuries','rosters','team-metrics',
      'backtest','prediction-ledger','football-prediction-ledger'
    )
  );

create or replace function public.get_member_dataset(p_dataset_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.has_active_membership() then
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
  return v_payload;
end;
$$;
revoke all on function public.get_member_dataset(text) from public, anon;
grant execute on function public.get_member_dataset(text) to authenticated;

create or replace function public.admin_save_football_prediction(p_game_id text, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_payload jsonb;
  v_records jsonb;
  v_old jsonb;
  v_new jsonb;
  v_item jsonb;
  v_now timestamptz := now();
  v_lock timestamptz;
  v_found boolean := false;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_user and p.role = 'admin') then
    raise exception 'Administrator permission required' using errcode = '42501';
  end if;
  if p_game_id is null or length(trim(p_game_id)) = 0
     or p_record is null or p_record->>'gameId' <> p_game_id then
    raise exception 'Invalid football prediction payload' using errcode = '22023';
  end if;
  begin
    v_lock := (p_record->>'lockedAt')::timestamptz;
  exception when others then
    raise exception 'Invalid prediction lock time' using errcode = '22023';
  end;
  if v_lock is null then
    raise exception 'Prediction lock time is required' using errcode = '22023';
  end if;

  select d.payload into v_payload
  from public.member_datasets d
  where d.dataset_key = 'football-prediction-ledger'
  for update;
  v_records := coalesce(v_payload->'records', '[]'::jsonb);

  for v_item in select value from jsonb_array_elements(v_records)
  loop
    if v_item->>'gameId' = p_game_id then
      v_old := v_item;
      v_found := true;
      exit;
    end if;
  end loop;

  if v_found and v_old->>'lockedAt' is not null
     and v_now >= (v_old->>'lockedAt')::timestamptz then
    raise exception '本場足球預測已於台灣時間 21:00 鎖定，不允許修改' using errcode = '55000';
  end if;
  if not v_found and v_now >= v_lock then
    raise exception '已超過台灣時間 21:00 鎖定時間，不能補建或修改正式預測' using errcode = '55000';
  end if;

  v_new := p_record || jsonb_build_object(
    'stage','official',
    'analysisStatus','final',
    'updatedAt',v_now,
    'publishedAt',coalesce(v_old->'publishedAt',to_jsonb(v_now))
  );
  if v_found then
    v_new := jsonb_set(
      v_new,'{changeHistory}',
      coalesce(v_old->'changeHistory','[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'at',v_now,'reason','管理員於鎖定時間前更新足球預測',
        'previous',jsonb_build_object(
          'homeWin',v_old->'homeWin','draw',v_old->'draw','awayWin',v_old->'awayWin',
          'totalPick',v_old->'totalPick','correctScores',v_old->'correctScores'
        )
      )),true
    );
    v_records := (select coalesce(jsonb_agg(case when value->>'gameId'=p_game_id then v_new else value end),'[]'::jsonb) from jsonb_array_elements(v_records));
  else
    v_records := v_records || jsonb_build_array(v_new);
  end if;

  if v_payload is null then
    insert into public.member_datasets(dataset_key,payload,updated_at)
    values ('football-prediction-ledger',jsonb_build_object('records',v_records),v_now);
  else
    update public.member_datasets
    set payload=jsonb_set(v_payload,'{records}',v_records,true),updated_at=v_now
    where dataset_key='football-prediction-ledger';
  end if;
  return v_new;
end;
$$;
revoke all on function public.admin_save_football_prediction(text,jsonb) from public,anon;
grant execute on function public.admin_save_football_prediction(text,jsonb) to authenticated;
