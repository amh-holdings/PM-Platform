-- AHC Solar PM Platform - Row Level Security policies
-- Phase 1, applied 2026-05-20.
--
-- This file is the single source of truth for RLS policies. Re-run against
-- the live database whenever it changes; every statement is idempotent
-- (DROP IF EXISTS + CREATE). Eventually this moves into supabase/migrations/.
--
-- Role tiers (from public.user_role enum):
--   phil               - founder, full admin
--   zarina             - ops admin (read-all + write dashboards/docs)
--   ahc_super          - AHC field super (read-all + write DPRs)
--   sub_pm/sub_foreman - subcontractor staff (scope still TBD)
--   owner              - developer/owner portal (read-only their projects)
--   counsel            - legal review (read-only)

-- ============================================================================
-- HELPER FUNCTION
-- ============================================================================
-- Returns the calling user's role. `security definer` lets it read profiles
-- without being filtered by the profiles RLS policies (which would otherwise
-- deadlock - profiles policies use this function which queries profiles).

create or replace function public.current_user_role()
returns public.user_role
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ============================================================================
-- PROFILES
-- ============================================================================
drop policy if exists "own_profile_read"      on public.profiles;
drop policy if exists "ahc_read_all_profiles" on public.profiles;
drop policy if exists "own_profile_update"    on public.profiles;
drop policy if exists "phil_writes_profiles"  on public.profiles;

-- Any user can read their own profile (lets the app show the email in nav).
create policy "own_profile_read" on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- AHC team can read every profile (needed for PM/Super assignment selects).
create policy "ahc_read_all_profiles" on public.profiles
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Users can update their own row (basic profile info).
-- NOTE: role escalation is NOT prevented here - guarded at the app layer for
-- now. Add a `with check (role = OLD.role)` clause when we wire profile edit.
create policy "own_profile_update" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Only phil can write to any profile (promoting users, etc).
create policy "phil_writes_profiles" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'phil')
  with check (public.current_user_role() = 'phil');

-- ============================================================================
-- PROJECTS
-- ============================================================================
drop policy if exists "authenticated_read_projects" on public.projects;
drop policy if exists "ahc_write_projects"          on public.projects;

-- Phase 1: every authenticated user can read any project.
-- Tighten later via subcontractor membership join when subs start signing in.
create policy "authenticated_read_projects" on public.projects
  for select to authenticated
  using (true);

-- AHC team owns project CRUD.
create policy "ahc_write_projects" on public.projects
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============================================================================
-- TODO (Day 3+): subcontractors, wbs_sov, dprs, dpr_quantities, rfis,
-- submittals, photos, comms_log. All currently RLS-on with no policies, so
-- they reject all access. Their policies land alongside the features that
-- need them.
-- ============================================================================
