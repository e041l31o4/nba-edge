-- NBA EDGE membership preflight diagnostics
-- Run in Supabase SQL Editor. Read-only: this script does not modify data.

-- 1) Confirm the intended owner account exists and has admin role.
select
  id,
  email,
  role,
  (role = 'admin') as admin_ready
from public.profiles
where lower(email) = lower('ruoruo0923@yahoo.com.tw');

-- 2) Confirm all eight paid datasets are present.
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

-- 3) Confirm private dataset table has RLS enabled and browser roles have no table privileges.
select
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', 'public.member_datasets', 'SELECT') as anon_can_select,
  has_table_privilege('authenticated', 'public.member_datasets', 'SELECT') as authenticated_can_select,
  has_table_privilege('service_role', 'public.member_datasets', 'INSERT') as service_role_can_insert
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'member_datasets';

-- 4) Confirm member RPC exists and is executable by authenticated users.
select
  to_regprocedure('public.get_member_dataset(text)') is not null as dataset_rpc_exists,
  has_function_privilege('authenticated', 'public.get_member_dataset(text)', 'EXECUTE') as authenticated_can_call_rpc,
  has_function_privilege('anon', 'public.get_member_dataset(text)', 'EXECUTE') as anon_can_call_rpc;

-- 5) Confirm transfer approval hardening checks submitted transfer data.
select
  to_regprocedure('public.admin_approve_manual_order(uuid)') is not null as approval_rpc_exists,
  position('transfer_last5' in pg_get_functiondef('public.admin_approve_manual_order(uuid)'::regprocedure)) > 0 as checks_transfer_last5,
  position('submitted_at' in pg_get_functiondef('public.admin_approve_manual_order(uuid)'::regprocedure)) > 0 as checks_submitted_at;
