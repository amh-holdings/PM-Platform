-- Diagnostic: re-apply the subcontractors RLS policies fresh, and add a
-- `whoami` RPC that the app (or the SQL editor) can call to see what the
-- DB thinks the current session is.
--
-- Apply via Supabase SQL Editor.
-- Safe to re-run.

-- Refresh subcontractors policies (drop + recreate is identical to migration
-- 0002 but ensures any stale state is replaced).
drop policy if exists "ahc_read_subcontractors"  on public.subcontractors;
drop policy if exists "ahc_write_subcontractors" on public.subcontractors;

create policy "ahc_read_subcontractors" on public.subcontractors
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_subcontractors" on public.subcontractors
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Debug RPC: returns the current auth state as the DB sees it.
create or replace function public.whoami()
returns jsonb
language sql
security invoker
stable
set search_path = public
as $$
  select jsonb_build_object(
    'auth_uid', auth.uid(),
    'auth_role', auth.role(),
    'session_user', session_user,
    'current_user_role', public.current_user_role(),
    'profile_exists', exists (select 1 from public.profiles where id = auth.uid()),
    'profile_role', (select role from public.profiles where id = auth.uid())
  );
$$;

grant execute on function public.whoami() to anon, authenticated;
