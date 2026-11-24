-- UCL result settlement is separate from frozen pre-match predictions.
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
