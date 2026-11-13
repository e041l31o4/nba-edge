-- Public preview data for exactly the games selected by the admin.
-- Public callers can only read the teams and market data associated with a game id
-- that is present in public_game_access_by_date for the requested Taiwan date.
create or replace function public.get_public_game_analysis(
  p_game_date date,
  p_game_id text,
  p_home_team_id text,
  p_away_team_id text,
  p_home_abbr text,
  p_away_abbr text,
  p_home_name text,
  p_away_name text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_form jsonb;
  v_injuries jsonb;
  v_rosters jsonb;
  v_metrics jsonb;
  v_odds jsonb;
  v_odds_history jsonb;
  v_backtest jsonb;
  v_abbrs text[];
  v_form_teams jsonb;
  v_roster_teams jsonb;
  v_metric_teams jsonb;
  v_injury_players jsonb;
  v_odds_games jsonb;
  v_history jsonb;
  v_calibrator jsonb;
  v_market_backtest jsonb;
begin
  if p_game_id is null or not exists (
    select 1 from public.public_game_access_by_date a
    where a.game_date = p_game_date and p_game_id = any(a.game_ids)
  ) then
    raise exception 'This game is not publicly selected' using errcode = '42501';
  end if;

  v_abbrs := array[upper(coalesce(p_home_abbr,'')), upper(coalesce(p_away_abbr,''))];
  select payload into v_form from public.member_datasets where dataset_key = 'team-form';
  select payload into v_injuries from public.member_datasets where dataset_key = 'injuries';
  select payload into v_rosters from public.member_datasets where dataset_key = 'rosters';
  select payload into v_metrics from public.member_datasets where dataset_key = 'team-metrics';
  select payload into v_odds from public.member_datasets where dataset_key = 'odds';
  select payload into v_odds_history from public.member_datasets where dataset_key = 'odds-history';
  select payload into v_backtest from public.member_datasets where dataset_key = 'backtest';

  select coalesce(jsonb_object_agg(x.key, x.value), '{}'::jsonb) into v_form_teams
  from jsonb_each(coalesce(v_form->'teams', '{}'::jsonb)) x
  where x.key in (coalesce(p_home_team_id,''), coalesce(p_away_team_id,''))
     or upper(coalesce(x.value->>'abbreviation','')) = any(v_abbrs);

  select coalesce(jsonb_object_agg(x.key, x.value), '{}'::jsonb) into v_roster_teams
  from jsonb_each(coalesce(v_rosters->'teams', '{}'::jsonb)) x
  where upper(x.key) = any(v_abbrs);

  select coalesce(jsonb_object_agg(x.key, x.value), '{}'::jsonb) into v_metric_teams
  from jsonb_each(coalesce(v_metrics->'teams', '{}'::jsonb)) x
  where upper(x.key) = any(v_abbrs)
     or upper(coalesce(x.value->>'abbreviation','')) = any(v_abbrs);

  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_injury_players
  from jsonb_array_elements(coalesce(v_injuries->'players', '[]'::jsonb)) x
  where upper(coalesce(x.value->>'team','')) = any(v_abbrs);

  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_odds_games
  from jsonb_array_elements(coalesce(v_odds->'games', '[]'::jsonb)) x
  where lower(coalesce(x.value->>'home_team','')) = lower(coalesce(p_home_name,''))
    and lower(coalesce(x.value->>'away_team','')) = lower(coalesce(p_away_name,''));

  select coalesce(jsonb_agg(x.value), '[]'::jsonb) into v_history
  from jsonb_array_elements(coalesce(v_odds_history, '[]'::jsonb)) x
  where x.value->>'gameId' = p_game_id;

  select coalesce(jsonb_agg(jsonb_build_object('season', x.value->'season', 'calibrator', x.value->'calibrator')), '[]'::jsonb)
    into v_calibrator
  from jsonb_array_elements(coalesce(v_backtest->'seasonResults', '[]'::jsonb)) x;

  v_market_backtest := v_backtest->'marketBacktest';

  return jsonb_build_object(
    'teamForm', case when v_form is null then null else jsonb_set(v_form, '{teams}', v_form_teams, true) end,
    'injuryData', case when v_injuries is null then null else jsonb_set(v_injuries, '{players}', v_injury_players, true) end,
    'rosterData', case when v_rosters is null then null else jsonb_set(v_rosters, '{teams}', v_roster_teams, true) end,
    'teamMetrics', case when v_metrics is null then null else jsonb_set(v_metrics, '{teams}', v_metric_teams, true) end,
    'odds', case when v_odds is null then null else jsonb_set(v_odds, '{games}', v_odds_games, true) end,
    'oddsHistory', v_history,
    'calibrator', (select x.value->'calibrator' from jsonb_array_elements(v_calibrator) x where x.value->'calibrator' is not null order by x.value->>'season' desc limit 1),
    'marketBacktest', v_market_backtest
  );
end;
$$;

revoke all on function public.get_public_game_analysis(date, text, text, text, text, text, text, text) from public;
grant execute on function public.get_public_game_analysis(date, text, text, text, text, text, text, text) to anon, authenticated;
