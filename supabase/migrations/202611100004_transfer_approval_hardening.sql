-- NBA EDGE: require transfer details before admin approval.
-- Apply this migration to an existing Supabase project after 202611100002_manual_transfer_workflow.sql.
-- Safe to run more than once.

create or replace function public.admin_approve_manual_order(p_order_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.membership_orders%rowtype;
  v_base timestamptz;
  v_expiry timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into v_order
  from public.membership_orders
  where id = p_order_id
  for update;

  if not found or v_order.status <> 'pending' then
    raise exception 'Pending order not found';
  end if;

  if v_order.transfer_last5 is null or v_order.submitted_at is null then
    raise exception 'Member has not submitted transfer details';
  end if;

  select greatest(now(), coalesce(max(o.expires_at), now()))
    into v_base
  from public.membership_orders o
  where o.user_id = v_order.user_id
    and o.status = 'paid'
    and o.expires_at > now();

  v_expiry := v_base + make_interval(days => v_order.duration_days);

  update public.membership_orders
  set status = 'paid',
      paid_at = now(),
      expires_at = v_expiry,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_order_id;

  return v_expiry;
end;
$$;

revoke all on function public.admin_approve_manual_order(uuid) from public, anon;
grant execute on function public.admin_approve_manual_order(uuid) to authenticated;
