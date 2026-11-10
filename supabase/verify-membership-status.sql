-- NBA EDGE membership verification (read-only)
-- Run in Supabase SQL Editor. This script does not create users, orders, or change data.

-- 1) Confirm the configured administrator profile exists.
select id, email, role
from public.profiles
where lower(email) = lower('ruoruo0923@yahoo.com.tw');

-- 2) Confirm the private datasets exist and show their latest publication times.
-- payload_size_bytes is metadata only; payload content is not returned.
select
  dataset_key,
  updated_at,
  octet_length(payload::text) as payload_size_bytes
from public.member_datasets
order by dataset_key;

-- 3) Confirm the browser roles cannot directly read the private dataset table.
select
  has_table_privilege('anon', 'public.member_datasets', 'SELECT') as anon_can_select_table,
  has_table_privilege('authenticated', 'public.member_datasets', 'SELECT') as authenticated_can_select_table,
  has_table_privilege('service_role', 'public.member_datasets', 'SELECT') as service_role_can_select_table;

-- Expected: false, false, true.

-- 4) Confirm RPC execution grants.
select
  has_function_privilege('anon', 'public.get_member_dataset(text)', 'EXECUTE') as anon_can_call_dataset_rpc,
  has_function_privilege('authenticated', 'public.get_member_dataset(text)', 'EXECUTE') as authenticated_can_call_dataset_rpc;

-- Expected: false, true.
-- Important: authenticated EXECUTE does not mean every authenticated user can read data.
-- get_member_dataset() separately requires auth.uid() and has_active_membership().

-- 5) Confirm the eight expected dataset keys are present.
with expected(dataset_key) as (
  values
    ('odds'),
    ('odds-history'),
    ('team-form'),
    ('injuries'),
    ('rosters'),
    ('team-metrics'),
    ('backtest'),
    ('prediction-ledger')
)
select
  e.dataset_key,
  (d.dataset_key is not null) as published,
  d.updated_at
from expected e
left join public.member_datasets d using (dataset_key)
order by e.dataset_key;

-- A complete initial sync should show published=true for all eight rows.
-- This script does not prove a user's actual access outcome; test with a separate
-- non-paying account in the website browser before enabling paid membership.
