-- Sussex: name the eight LNTP plan-set lines after their actual deliverables.
--
-- Zarina: "Can you rename the plan set lines to the actual deliverables."
--
-- 1.01.2 through 1.01.9 all read "Plan Set" on the G703. On a sheet going to
-- IBT that is eight identical rows and no way to tell which deliverable is
-- which. The names exist already: each line is tied to a plan-set schedule
-- task, and that task carries the real name. This copies it across rather
-- than inventing anything.
--
-- 1.01.1 Execution of LNTP is left alone. It is already named, and it is the
-- line AFP 1 billed.
--
-- HISTORY IS SAFE. pay_application_lines carry their own copy of the
-- description, written when the application was created, so renaming a
-- billing line never rewrites an AFP that has already gone out.
--
-- READ STEP 1 FIRST. The rename is only as good as the task names, and if
-- those are generic too this will not help - step 1 is where you find that
-- out, before anything is written.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste, run step 1, read it, then uncomment step 2.

-- ===========================================================================
-- 1. What each line is called now, and what it would be called.
-- ===========================================================================
with proj as (
  select id from public.projects where name ilike '%sussex%' limit 1
),
linked as (
  select
    bl.id,
    bl.item_number,
    bl.description                                   as current_name,
    bl.scheduled_value,
    bl.linked_task_wbs_codes,
    count(t.wbs_code)                                as task_count,
    min(t.task_name)                                 as task_name,
    string_agg(t.wbs_code || ' ' || t.task_name, ' | ' order by t.wbs_code) as all_tasks
  from public.billing_lines bl
  join proj on proj.id = bl.project_id
  left join public.schedule_tasks t
    on t.project_id = bl.project_id
   and t.wbs_code = any(coalesce(bl.linked_task_wbs_codes, array[]::text[]))
  where bl.item_number like '1.01.%'
  group by bl.id, bl.item_number, bl.description, bl.scheduled_value, bl.linked_task_wbs_codes
)
select
  item_number,
  current_name,
  scheduled_value,
  task_count,
  all_tasks,
  case
    when lower(btrim(current_name)) <> 'plan set'
      then 'skipped: not a Plan Set line'
    when task_count = 0
      then 'SKIPPED: no linked schedule task to take a name from'
    when task_count > 1
      then 'SKIPPED: more than one linked task, so the name is ambiguous'
    when btrim(coalesce(task_name, '')) = ''
      then 'SKIPPED: the linked task has no name'
    when lower(btrim(task_name)) = 'plan set'
      then 'SKIPPED: the task is called Plan Set too, so this gains nothing'
    else 'rename to: ' || task_name
  end as proposed
from linked
order by item_number;

-- Expect nine rows: 1.01.1 skipped, and eight carrying a proposed name.
--
-- If most of them come back SKIPPED, the schedule tasks are no better than
-- the SOV and the names have to come off the LNTP agreement instead. Step 3
-- at the bottom is the by-hand version for that case.

-- ===========================================================================
-- 2. Rename. Uncomment and run.
-- ===========================================================================
-- begin;
--
-- with proj as (
--   select id from public.projects where name ilike '%sussex%' limit 1
-- ),
-- linked as (
--   select bl.id,
--          min(t.task_name)  as task_name,
--          count(t.wbs_code) as task_count
--   from public.billing_lines bl
--   join proj on proj.id = bl.project_id
--   join public.schedule_tasks t
--     on t.project_id = bl.project_id
--    and t.wbs_code = any(coalesce(bl.linked_task_wbs_codes, array[]::text[]))
--   where bl.item_number like '1.01.%'
--     and lower(btrim(bl.description)) = 'plan set'
--   group by bl.id
-- )
-- update public.billing_lines bl
--    set description = linked.task_name,
--        -- The old name is kept, so a rename is reversible and anyone reading
--        -- the row later can see it was derived rather than typed.
--        notes = trim(both E'\n' from
--                  coalesce(bl.notes, '')
--                  || case when coalesce(bl.notes, '') = '' then '' else E'\n' end
--                  || 'Renamed from "Plan Set" to the linked schedule task name on '
--                  || to_char(current_date, 'YYYY-MM-DD') || '.')
--   from linked
--  where linked.id = bl.id
--    and linked.task_count = 1
--    and btrim(coalesce(linked.task_name, '')) <> ''
--    and lower(btrim(linked.task_name)) <> 'plan set';
--
-- commit;

-- ===========================================================================
-- 3. Verify, and the by-hand fallback.
-- ===========================================================================
-- select item_number, description, scheduled_value, notes
-- from public.billing_lines
-- where project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--   and item_number like '1.01.%'
-- order by item_number;
--
-- The nine must still total what they totalled before. Renaming touches no
-- money, so this is a sanity check on the statement above, not on the names.
-- select count(*) as lines, sum(scheduled_value) as lntp_total
-- from public.billing_lines
-- where project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--   and item_number like '1.01.%';
--
-- BY HAND, if the schedule tasks are no better than the SOV. Fill in the
-- names off the LNTP agreement and run this instead of step 2.
-- begin;
-- update public.billing_lines bl
--    set description = v.new_name
--   from (values
--     ('1.01.2', 'REPLACE ME'),
--     ('1.01.3', 'REPLACE ME'),
--     ('1.01.4', 'REPLACE ME'),
--     ('1.01.5', 'REPLACE ME'),
--     ('1.01.6', 'REPLACE ME'),
--     ('1.01.7', 'REPLACE ME'),
--     ('1.01.8', 'REPLACE ME'),
--     ('1.01.9', 'REPLACE ME')
--   ) as v(item_number, new_name)
--  where bl.project_id = (select id from public.projects where name ilike '%sussex%' limit 1)
--    and bl.item_number = v.item_number
--    and v.new_name <> 'REPLACE ME';
-- commit;
