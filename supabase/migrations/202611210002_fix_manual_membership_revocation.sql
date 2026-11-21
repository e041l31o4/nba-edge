-- Fix manual membership revocation: expire every paid order for the account,
-- including orders whose expiry timestamp is today or has just passed.
create or replace function public.admin_expire_membership(p_email text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  if p_email is null or trim(p_email) = '' then
    raise exception 'Member email is required';
  end if;

  select p.id
    into v_user_id
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'Member account not found';
  end if;

  update public.membership_orders
  set status = 'expired'
  where user_id = v_user_id
    and status = 'paid';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.admin_expire_membership(text) from public, anon;
grant execute on function public.admin_expire_membership(text) to authenticated;
