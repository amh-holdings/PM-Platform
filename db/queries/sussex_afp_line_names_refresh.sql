-- Why the G703 still says "Plan Set", and how to change it.
--
-- Zarina: "I am not seeing the changes."
--
-- The rename changed billing_lines. The page headed "Schedule of values
-- (G703)" does not read billing_lines - it reads pay_application_lines, which
-- carry their OWN copy of every description, written when the application was
-- created. That is the property I described as history being safe: renaming a
-- billing line never rewrites an AFP that has gone out.
--
-- Here it works against you. If you want AFP 1's G703 to read the new names,
-- the snapshot has to be updated too, and that IS rewriting a record of what
-- was sent. Descriptions only. No amount, percent, date or status moves.
--
-- Worth knowing before you decide: the app's AFP 1 never matched the pencil
-- copy anyway. The pencil copy carries one line, "1.01 Engineering services
-- and permitting under LNTP". The app carries the LNTP's own nine.
--
-- HOW TO RUN
--   Supabase SQL Editor. Run step 1, then 2, then decide on 3.

-- ===========================================================================
-- 1. Did the rename actually land on the billing lines?
-- ===========================================================================
select item_number, description, scheduled_value, notes
from public.billing_lines
where project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
  and item_number like '1.01.%'
order by item_number;

-- Expect Civil / Structural / Electrical names and a "Renamed from" note on
-- eight rows. If these still read "Plan Set", the update matched nothing and
-- step 3 is not your problem - come back to me with this result.

-- ===========================================================================
-- 2. What each AFP's frozen G703 says, against the line's name today.
-- ===========================================================================
select
  pa.app_number,
  pa.status,
  pal.item_number,
  pal.description                      as on_the_g703,
  bl.description                       as billing_line_now,
  pal.scheduled_value,
  pal.work_completed_this_period,
  case
    when bl.description is null then 'no billing line behind this row'
    when pal.description = bl.description then 'already matches'
    else 'STALE: the G703 still carries the old name'
  end as verdict
from public.pay_application_lines pal
join public.pay_applications pa on pa.id = pal.pay_application_id
left join public.billing_lines bl on bl.id = pal.billing_line_id
where pa.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
  and pal.item_number like '1.01.%'
order by pa.app_number, pal.item_number;

-- ===========================================================================
-- 3. Refresh the frozen names. Uncomment and run ONLY if you want the
--    already-created AFP to show the new wording.
-- ===========================================================================
-- Descriptions only. The join is on billing_line_id, so a row that is not
-- tied to a billing line is left alone rather than matched by item number and
-- guessed at.
-- begin;
--
-- update public.pay_application_lines pal
--    set description = bl.description
--   from public.billing_lines bl,
--        public.pay_applications pa
--  where bl.id = pal.billing_line_id
--    and pa.id = pal.pay_application_id
--    and pa.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--    and pal.item_number like '1.01.%'
--    and btrim(coalesce(bl.description, '')) <> ''
--    and pal.description is distinct from bl.description;
--
-- -- Say on the application itself that its wording was refreshed, so nobody
-- -- later wonders why the app and a PDF in Drive disagree.
-- update public.pay_applications pa
--    set notes = trim(both E'\n' from
--                  coalesce(pa.notes, '')
--                  || case when coalesce(pa.notes, '') = '' then '' else E'\n' end
--                  || 'LNTP line descriptions refreshed from the billing lines on '
--                  || to_char(current_date, 'YYYY-MM-DD')
--                  || '. Wording only - no amount changed.')
--  where pa.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--    and exists (
--      select 1 from public.pay_application_lines pal
--      where pal.pay_application_id = pa.id and pal.item_number like '1.01.%'
--    );
--
-- commit;

-- ===========================================================================
-- 4. Verify. Totals must be untouched.
-- ===========================================================================
-- select pa.app_number, pal.item_number, pal.description,
--        pal.scheduled_value, pal.work_completed_this_period
-- from public.pay_application_lines pal
-- join public.pay_applications pa on pa.id = pal.pay_application_id
-- where pa.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--   and pal.item_number like '1.01.%'
-- order by pa.app_number, pal.item_number;
--
-- select pa.app_number,
--        sum(pal.scheduled_value)             as sched,
--        sum(pal.work_completed_this_period)  as this_period
-- from public.pay_application_lines pal
-- join public.pay_applications pa on pa.id = pal.pay_application_id
-- where pa.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
-- group by pa.app_number;
