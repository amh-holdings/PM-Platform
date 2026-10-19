-- Give Fernando Aguilar the same PM Platform access as Mark Wooley.
--
-- Zarina: "Grant Fernando access to Sweet Spring and Sussex projects." Then:
-- "Need his access to be similar to Mark's."
--
-- Fernando already has a login (faguilar@americanhelios.com, active since
-- 14 October). What he does not have is an AHC role: an account created
-- without scripts/create-cm-user.mjs gets role 'sub_foreman' from the
-- on_auth_user_created trigger, and every AHC-side RLS policy reads
-- current_user_role() in ('phil','zarina','ahc_super'). So he signs in fine
-- and sees almost nothing.
--
-- There is no per-project access in this app. Nothing is scoped to Sweet
-- Springs or Sussex. The role is the grant, and it covers every project.
--
-- This COPIES Mark's role rather than naming one, so "similar to Mark's" is
-- what actually happens even if Mark's role is not what anyone remembers.
--
-- It does not touch his password. He keeps the credentials he already has.
-- scripts/create-cm-user.mjs would reset them; this does not.
--
-- The 0075 profiles_lock_role trigger allows this: it only fires when
-- auth.uid() is not null, and the SQL Editor runs with no auth user.
--
-- Guarded. If either profile is missing, or more than one row matches, it
-- raises and nothing changes.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste this whole file, Run.

-- ===========================================================================
-- STEP 1 - before. Read this first.
-- ===========================================================================
select email, full_name, role, subcontractor_id, active
from public.profiles
where lower(email) in ('faguilar@americanhelios.com', 'mwooley@americanhelios.com')
order by email;

-- Expect two rows. Mark should read ahc_super. Fernando is the one to change.
-- If Fernando is missing entirely, STOP: the account is under another address
-- and this will not find it.

-- ===========================================================================
-- STEP 2 - match him to Mark.
-- ===========================================================================
begin;

do $$
declare
  mark_role public.user_role;
  n integer;
begin
  select count(*) into n
  from public.profiles
  where lower(email) = 'mwooley@americanhelios.com';
  if n <> 1 then
    raise exception 'Expected exactly 1 profile for Mark, found %. Nothing changed.', n;
  end if;

  select count(*) into n
  from public.profiles
  where lower(email) = 'faguilar@americanhelios.com';
  if n <> 1 then
    raise exception 'Expected exactly 1 profile for Fernando, found %. Nothing changed.', n;
  end if;

  select role into mark_role
  from public.profiles
  where lower(email) = 'mwooley@americanhelios.com';

  update public.profiles
     set role = mark_role,
         -- Cleared the way create-cm-user.mjs clears it. An AHC role is not
         -- scoped through a subcontractor, and a stale company link on an
         -- AHC account is a trap waiting for whoever reads it next.
         subcontractor_id = null,
         active = true,
         full_name = coalesce(nullif(trim(full_name), ''), 'Fernando Aguilar')
   where lower(email) = 'faguilar@americanhelios.com';

  raise notice 'Fernando Aguilar set to role %, matching Mark Wooley.', mark_role;
end $$;

commit;

-- ===========================================================================
-- STEP 3 - after. The two rows should now differ only by name and email.
-- ===========================================================================
select email, full_name, role, subcontractor_id, active
from public.profiles
where lower(email) in ('faguilar@americanhelios.com', 'mwooley@americanhelios.com')
order by email;

-- Everyone else holding that role, so nothing was granted by surprise.
select email, full_name, role
from public.profiles
where role in ('phil', 'zarina', 'ahc_super')
order by role, email;
