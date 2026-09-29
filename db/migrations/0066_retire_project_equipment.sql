-- 0066_retire_project_equipment.sql
--
-- Lets the crew that owns a machine take it off their own list when it leaves
-- site, without letting them rename one out from under each other.
--
-- 0047 gave subs INSERT and nothing else, on the reasoning that a rename
-- reaches every foreman on the crew. Retiring is not a rename: it changes one
-- boolean, it is reversible, and it cannot alter what any filed report says.
-- More to the point, the person who knows a dozer left site is the foreman who
-- watched it go, not AHC. With UPDATE denied, a sub's retire matched zero rows
-- and PostgREST returned success for it - the machine vanished from the screen
-- and came back on the next load. That is the bug this fixes.
--
-- Done as a security definer function rather than an UPDATE policy because RLS
-- cannot say "you may change this column and no other": USING sees the old row
-- and WITH CHECK the new one, never both, so a policy permissive enough to let
-- a sub set active=false is permissive enough to let them rewrite the name.
-- The function is the narrow grant - it is the only thing a sub may do, and
-- all it can do is set active=false.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

create or replace function public.retire_project_equipment(p_equipment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_user_role();
  v_sub  uuid;
  v_rows integer;
begin
  select subcontractor_id into v_sub
  from public.project_equipment
  where id = p_equipment_id;

  if v_sub is null then
    raise exception 'That equipment no longer exists' using errcode = 'no_data_found';
  end if;

  if v_role in ('phil', 'zarina', 'ahc_super') then
    null;                                   -- AHC may retire anything
  elsif v_role in ('sub_pm', 'sub_foreman')
    and v_sub = public.current_user_subcontractor() then
    null;                                   -- a crew may retire its own iron
  else
    raise exception 'You cannot change this crew''s equipment list'
      using errcode = 'insufficient_privilege';
  end if;

  -- active=false only. Never the name, which is what 0047 was protecting.
  update public.project_equipment
  set active = false
  where id = p_equipment_id
    and active;

  get diagnostics v_rows = row_count;
  -- False means it was already retired. The caller treats that as done rather
  -- than as a failure: two foremen closing out the same machine on the same
  -- afternoon is a race, not a mistake.
  return v_rows > 0;
end;
$$;

revoke all on function public.retire_project_equipment(uuid) from public;
grant execute on function public.retire_project_equipment(uuid) to authenticated;

comment on function public.retire_project_equipment(uuid) is
  'Sets project_equipment.active = false for one machine. AHC may retire any; a sub_pm/sub_foreman may retire their own crew''s only. The narrow grant that replaces giving subs UPDATE on the table.';

notify pgrst, 'reload schema';
