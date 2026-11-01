-- NBA EDGE cloud prediction ledger
-- Apply in Supabase SQL Editor. Predictions are immutable; settlements are separate rows.
create table if not exists public.nba_predictions (
  game_id text primary key,
  game_date timestamptz not null,
  home_team text not null,
  away_team text not null,
  home_win numeric not null check (home_win between 0 and 1),
  away_win numeric not null check (away_win between 0 and 1),
  projected_margin numeric not null,
  projected_total numeric not null,
  captured_at timestamptz not null default now(),
  model_version text not null default 'odds-blind-v4-walkforward-calibration',
  constraint nba_predictions_probability_sum check (abs(home_win + away_win - 1) < 0.001)
);
create table if not exists public.nba_settlements (
  game_id text primary key references public.nba_predictions(game_id) on delete restrict,
  actual_home integer not null check (actual_home >= 0),
  actual_away integer not null check (actual_away >= 0),
  settled_at timestamptz not null default now(),
  source text not null default 'official-scoreboard'
);
create index if not exists nba_predictions_game_date_idx on public.nba_predictions(game_date desc);
create index if not exists nba_settlements_settled_at_idx on public.nba_settlements(settled_at desc);
alter table public.nba_predictions enable row level security;
alter table public.nba_settlements enable row level security;
drop policy if exists "Public can read NBA predictions" on public.nba_predictions;
create policy "Public can read NBA predictions" on public.nba_predictions for select to anon, authenticated using (true);
drop policy if exists "Public can insert NBA predictions" on public.nba_predictions;
create policy "Public can insert NBA predictions" on public.nba_predictions for insert to anon, authenticated with check (
  game_date > now() and home_win between 0 and 1 and away_win between 0 and 1
  and abs(home_win + away_win - 1) < 0.001
);
drop policy if exists "Public can read NBA settlements" on public.nba_settlements;
create policy "Public can read NBA settlements" on public.nba_settlements for select to anon, authenticated using (true);
-- No public INSERT/UPDATE/DELETE policy on settlements. Only a trusted server process
-- using the service-role key may write final scores. Never expose that key in the browser.
