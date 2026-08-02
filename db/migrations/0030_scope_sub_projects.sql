-- 0030_scope_sub_projects.sql
--
-- Tightens PROJECT visibility for subcontractor roles.
--
-- Before: the "authenticated_read_projects" policy used `using (true)`, so
-- every signed-in user - including a sub - could read every project row and
-- its contract_value. That leaked both the existence of other projects (e.g.
-- the internal "Test Project - Cash Flow") and every project's contract amount
-- to subcontractors. Verified: dennis@pyramid-excavation.com could read both
-- Sweet Springs Solar ($3,653,610.39) and the Test Project ($65,000).
--
-- After: sub_pm / sub_foreman may read ONLY projects where their company is
-- engaged, resolved via profiles.subcontractor_id -> subcontractors.project_id
-- (the same join used by the sub read policies in 0029). Every other role
-- (phil, zarina, ahc_super, owner, counsel) is unchanged and still reads all
-- projects. The separate write policy (ahc_write_projects) is untouched.
--
-- Idempotent: safe to re-run (DROP IF EXISTS + CREATE).

drop policy if exists "authenticated_read_projects" on public.projects;

create policy "authenticated_read_projects" on public.projects
  for select to authenticated
  using (
    case
      when public.current_user_role() in ('sub_pm', 'sub_foreman') then
        id in (
          select s.project_id
          from public.subcontractors s
          join public.profiles p on p.subcontractor_id = s.id
          where p.id = auth.uid()
        )
      else true
    end
  );
