-- NBA EDGE UCL FOOTBALL ONE-TIME SETUP
-- Paste this entire file into Supabase SQL Editor and run once.
-- It creates the private football prediction ledger, admin publishing RPC,
-- server-derived Taiwan 21:00 lock, member release-window filtering,
-- and immutable result-settlement RPC.

-- NBA EDGE: private UCL football prediction ledger with immutable 21:00 Taiwan lock.
-- Football page release switch: default closed; only admins can change it.
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
as $
  select coalesce((
    select s.members_enabled
    from public.football_access_settings s
    where s.singleton = true
  ),false);
$;
revoke all on function public.get_football_member_access() from public,anon;
grant execute on function public.get_football_member_access() to authenticated;

create or replace function public.admin_set_football_member_access(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $
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
$;
revoke all on function public.admin_set_football_member_access(boolean) from public,anon;
grant execute on function public.admin_set_football_member_access(boolean) to authenticated;

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
  v_is_admin boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    into v_is_admin;
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
$;
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
  v_match_date date;
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

  if p_record->'moneylinePick'->>'side' not in ('home','draw','away')
     or p_record->'totalPick'->>'side' not in ('over','under')
     or jsonb_typeof(p_record->'correctScores') <> 'array'
     or jsonb_array_length(coalesce(p_record->'correctScores','[]'::jsonb)) = 0 then
    raise exception 'Invalid football market recommendations' using errcode = '22023';
  end if;
  if coalesce((p_record#>>'{sportsLotteryOdds,home}')::numeric,0) <= 1
     or coalesce((p_record#>>'{sportsLotteryOdds,draw}')::numeric,0) <= 1
     or coalesce((p_record#>>'{sportsLotteryOdds,away}')::numeric,0) <= 1
     or coalesce((p_record#>>'{sportsLotteryOdds,over}')::numeric,0) <= 1
     or coalesce((p_record#>>'{sportsLotteryOdds,under}')::numeric,0) <= 1
     or coalesce((p_record#>>'{sportsLotteryOdds,totalLine}')::numeric,0) <= 0 then
    raise exception '官方運彩五項賠率與大小球盤口均須有效填寫' using errcode = '22023';
  end if;
  begin
    v_match_date := ((p_record->>'date')::timestamptz at time zone 'Asia/Taipei')::date;
  exception when others then
    raise exception 'Invalid match date' using errcode = '22023';
  end;
  if v_match_date is null then
    raise exception 'Match date is required' using errcode = '22023';
  end if;
  -- Derive the lock on the server: 21:00 Taiwan time on the calendar day
  -- before the match's Taiwan-local kickoff date. Never trust a client lock.
  v_lock := (((v_match_date - 1)::timestamp + time '21:00') at time zone 'Asia/Taipei');
  if (p_record->>'lockedAt')::timestamptz is distinct from v_lock then
    raise exception 'Prediction lock timestamp does not match the official Taiwan-time lock' using errcode = '22023';
  end if;
  if v_now >= v_lock then
    raise exception '已超過台灣時間 21:00 鎖定時間，不能新增或修改正式預測' using errcode = '55000';
  end if;

  insert into public.member_datasets(dataset_key,payload,updated_at)
  values ('football-prediction-ledger',jsonb_build_object('records','[]'::jsonb),v_now)
  on conflict (dataset_key) do nothing;
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

  v_new := p_record || jsonb_build_object(
    'lockedAt',v_lock,
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


-- UCL result settlement is separate from frozen pre-match predictions.
insert into public.member_datasets(dataset_key,payload,updated_at)
values ('football-prediction-ledger',jsonb_build_object('records','[]'::jsonb),now())
on conflict (dataset_key) do nothing;

create or replace function public.admin_settle_football_prediction(
  p_game_id text,
  p_home_goals integer,
  p_away_goals integer
)
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
  v_settlement jsonb;
  v_total integer;
  v_line numeric;
  v_total_side text;
  v_winner_side text;
  v_pick_side text;
  v_correct_score text;
  v_found boolean := false;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_user and p.role = 'admin') then
    raise exception 'Administrator permission required' using errcode = '42501';
  end if;
  if p_game_id is null or length(trim(p_game_id)) = 0
     or p_home_goals is null or p_away_goals is null
     or p_home_goals < 0 or p_away_goals < 0 then
    raise exception 'Invalid final score' using errcode = '22023';
  end if;

  select d.payload into v_payload
  from public.member_datasets d
  where d.dataset_key = 'football-prediction-ledger'
  for update;
  if v_payload is null then
    raise exception 'Football prediction ledger is not initialized' using errcode = 'P0002';
  end if;
  v_records := coalesce(v_payload->'records','[]'::jsonb);
  for v_item in select value from jsonb_array_elements(v_records)
  loop
    if v_item->>'gameId'=p_game_id then v_old:=v_item;v_found:=true;exit;end if;
  end loop;
  if not v_found then
    raise exception 'Official football prediction not found' using errcode = 'P0002';
  end if;
  if v_old->>'stage' <> 'official' then
    raise exception 'Only frozen official predictions can be settled' using errcode = '55000';
  end if;
  if now() < (v_old->>'date')::timestamptz then
    raise exception 'Match kickoff has not occurred yet' using errcode = '55000';
  end if;
  if v_old->>'settledAt' is not null then
    if (v_old->>'actualHome')::integer=p_home_goals and (v_old->>'actualAway')::integer=p_away_goals then
      return v_old;
    end if;
    raise exception 'This match has already been settled; frozen settlement cannot be overwritten' using errcode = '55000';
  end if;

  v_total := p_home_goals+p_away_goals;
  v_line := (v_old->'totalPick'->>'line')::numeric;
  v_total_side := lower(v_old->'totalPick'->>'side');
  v_pick_side := lower(v_old->'moneylinePick'->>'side');
  v_winner_side := case when p_home_goals>p_away_goals then 'home' when p_home_goals<p_away_goals then 'away' else 'draw' end;
  v_correct_score := coalesce(v_old->'correctScores'->0->>'score','');
  v_settlement := jsonb_build_object(
    'moneyline',case when v_pick_side=v_winner_side then 'win' else 'loss' end,
    'total',case when v_total=v_line then 'push' when (v_total_side='over' and v_total>v_line) or (v_total_side='under' and v_total<v_line) then 'win' else 'loss' end,
    'correctScore',case when replace(v_correct_score,':','-')=p_home_goals::text||'-'||p_away_goals::text then 'win' else 'loss' end
  );
  v_new := v_old || jsonb_build_object(
    'actualHome',p_home_goals,
    'actualAway',p_away_goals,
    'settledAt',now(),
    'settlement',v_settlement
  );
  v_records := (select coalesce(jsonb_agg(case when value->>'gameId'=p_game_id then v_new else value end),'[]'::jsonb) from jsonb_array_elements(v_records));
  update public.member_datasets
  set payload=jsonb_set(v_payload,'{records}',v_records,true),updated_at=now()
  where dataset_key='football-prediction-ledger';
  return v_new;
end;
$$;
revoke all on function public.admin_settle_football_prediction(text,integer,integer) from public,anon;
grant execute on function public.admin_settle_football_prediction(text,integer,integer) to authenticated;
