-- NBA EDGE manual bank-transfer membership workflow
-- Apply after 202611100001_membership_core.sql.

alter table public.membership_orders
  add column if not exists transfer_last5 text,
  add column if not exists transfer_note text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id);

create table if not exists public.membership_payment_settings (
  id boolean primary key default true check (id),
  bank_name text not null default '',
  bank_code text not null default '',
  account_name text not null default '',
  account_number text not null default '',
  payment_note text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.membership_payment_settings (id) values (true)
on conflict (id) do nothing;

alter table public.membership_payment_settings enable row level security;
drop policy if exists "payment instructions read authenticated" on public.membership_payment_settings;
create policy "payment instructions read authenticated"
  on public.membership_payment_settings for select to authenticated using (true);
drop policy if exists "payment instructions admin manage" on public.membership_payment_settings;
create policy "payment instructions admin manage"
  on public.membership_payment_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.membership_payment_settings to authenticated;
grant insert, update, delete on public.membership_payment_settings to authenticated;

create or replace function public.create_manual_membership_order(p_plan_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.membership_plans%rowtype;
  v_order_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_plan from public.membership_plans where id = p_plan_id and active = true;
  if not found then raise exception 'Membership plan is unavailable'; end if;
  insert into public.membership_orders (user_id, plan_id, plan_name, amount_twd, duration_days, status, payment_provider)
  values (v_user_id, v_plan.id, v_plan.name, v_plan.price_twd, v_plan.duration_days, 'pending', 'manual')
  returning id into v_order_id;
  return v_order_id;
end;
$$;

create or replace function public.submit_manual_transfer(p_order_id uuid, p_transfer_last5 text, p_transfer_note text default '')
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_transfer_last5 is null or p_transfer_last5 !~ '^[0-9]{5}$' then
    raise exception 'Please enter the last 5 digits of the transfer account';
  end if;
  update public.membership_orders
  set transfer_last5 = p_transfer_last5,
      transfer_note = left(coalesce(p_transfer_note, ''), 500),
      submitted_at = now()
  where id = p_order_id and user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Pending order not found'; end if;
end;
$$;

create or replace function public.admin_approve_manual_order(p_order_id uuid)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.membership_orders%rowtype;
  v_base timestamptz;
  v_expiry timestamptz;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  select * into v_order from public.membership_orders where id = p_order_id for update;
  if not found or v_order.status <> 'pending' then raise exception 'Pending order not found'; end if;
  select greatest(now(), coalesce(max(o.expires_at), now())) into v_base
  from public.membership_orders o
  where o.user_id = v_order.user_id and o.status = 'paid' and o.expires_at > now();
  v_expiry := v_base + make_interval(days => v_order.duration_days);
  update public.membership_orders
  set status = 'paid', paid_at = now(), expires_at = v_expiry, reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_order_id;
  return v_expiry;
end;
$$;

revoke all on function public.create_manual_membership_order(uuid) from public, anon;
revoke all on function public.submit_manual_transfer(uuid, text, text) from public, anon;
revoke all on function public.admin_approve_manual_order(uuid) from public, anon;
grant execute on function public.create_manual_membership_order(uuid) to authenticated;
grant execute on function public.submit_manual_transfer(uuid, text, text) to authenticated;
grant execute on function public.admin_approve_manual_order(uuid) to authenticated;

revoke insert, update, delete on public.membership_orders from anon, authenticated;
