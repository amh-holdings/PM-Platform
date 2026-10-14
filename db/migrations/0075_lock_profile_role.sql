-- Stop users from changing their own role.
--
-- policies.sql's "own_profile_update" lets any signed-in user update their own
-- profiles row, and its own comment says role escalation is not prevented. Any
-- user - a sub, or the new bd role - could set role = 'phil' from the browser
-- with the anon key and read everything. Found while adding the bd role,
-- 2026-10-09.
--
-- A trigger rather than a policy change: RLS `with check` cannot see the old
-- row, a trigger can. Only phil may change anyone's role; the service role
-- (scripts, auth.uid() is null) is unaffected.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create or replace function public.profiles_lock_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and public.current_user_role() is distinct from 'phil' then
    raise exception 'Only Phil can change a user''s role';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_lock_role on public.profiles;
create trigger profiles_lock_role before update on public.profiles
  for each row execute function public.profiles_lock_role();
