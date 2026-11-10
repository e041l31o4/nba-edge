-- Allow authenticated users to attempt writes to the public-game selector.
-- RLS policy from migration 005 restricts all writes to public.is_admin().
grant insert, update, delete on public.public_game_access to authenticated;
