-- 0029_sub_read_schedule_and_subs.sql
--
-- Fixes: a subcontractor (sub_pm / sub_foreman) could not file a Field Report
-- because the "WBS / work item" and "Subcontractor filing this report"
-- dropdowns were empty. Those dropdowns read from public.schedule_tasks and
-- public.subcontractors, whose SELECT policies only allowed phil/zarina/ahc_super.
-- The sub roles were granted read/write on dprs + inspections (0009/0014/0021)
-- but never granted read on the two lists those pins depend on.
--
-- This migration adds SELECT-only policies for the sub roles, scoped so a sub
-- only sees data for projects where they are actually engaged (via
-- profiles.subcontractor_id -> subcontractors.project_id). RLS policies are
-- additive/permissive, so existing CM/AHC access is unchanged.

-- Subs can read schedule tasks (the WBS list) for their own project(s).
drop policy if exists "sub_read_schedule" on public.schedule_tasks;
create policy "sub_read_schedule" on public.schedule_tasks
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- Subs can read only their OWN subcontractor row (so the "filing this report"
-- dropdown resolves to their company, without exposing other subs on the job).
drop policy if exists "sub_read_own_subcontractor" on public.subcontractors;
create policy "sub_read_own_subcontractor" on public.subcontractors
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and id in (
      select subcontractor_id
      from public.profiles
      where id = auth.uid()
    )
  );
