-- Sussex CSG 1 - move AFP 2 from October 2026 to September 2026
--
-- AFP 2 was created against the October billing period by mistake. The work
-- and the dollars are September's. Nothing about the amounts changes here:
-- this moves the period the application is stamped with, and the period_month
-- on the billing entries that sit on it, back by exactly one month.
--
-- Shifting by `interval '1 month'` rather than writing literal dates keeps
-- whatever cutoff-day convention the application was created on. Oct 1 - Oct 31
-- becomes Sep 1 - Sep 30; an Oct 25 cutoff becomes Sep 25.
--
-- Run section 1 first and read it. Section 2 is the write and refuses to run
-- if the state does not match what section 1 showed.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).


-- ===========================================================================
-- SECTION 1 - REPORT ONLY. Run this first.
-- ===========================================================================

-- 1a. Every pay application on Sussex, so the periods either side of AFP 2
--     are visible before anything moves. Watch for an AFP 1 that already
--     covers September: two applications on the same period is the one
--     outcome this change must not produce.
select
  pa.app_number,
  pa.period_start,
  pa.period_end,
  pa.status,
  pa.total_completed,
  pa.previous_billings,
  pa.amount_due,
  pa.approved_at,
  pa.paid_at
from public.pay_applications pa
join public.projects p on p.id = pa.project_id
where p.name ilike '%sussex%'
order by pa.period_end nulls first, pa.created_at;


-- 1b. The billing entries stamped onto AFP 2. These are the rows whose
--     period_month moves. Expect 2 rows totalling $80,891.75.
select
  bl.item_number,
  bl.description,
  be.period_month,
  (be.period_month - interval '1 month')::date as period_month_after,
  be.planned_amount,
  be.actual_amount,
  be.afp_number,
  be.status,
  be.cash_in_month,
  case
    when be.cash_in_month is null then null
    else (be.cash_in_month - interval '1 month')::date
  end as cash_in_month_after
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join public.pay_applications pa on pa.id = be.pay_application_id
join public.projects p on p.id = pa.project_id
where p.name ilike '%sussex%'
  and pa.app_number = 'AFP 2'
order by bl.item_number;


-- 1c. Collision check. billing_entries carries unique (billing_line_id,
--     period_month), so if any of AFP 2's lines ALREADY has a September row
--     the move fails on that constraint. Zero rows here means it is clear.
select
  bl.item_number,
  bl.description,
  existing.period_month,
  existing.planned_amount,
  existing.actual_amount,
  existing.status,
  'BLOCKS THE MOVE - this line already has a row in the target month' as warning
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join public.pay_applications pa on pa.id = be.pay_application_id
join public.projects p on p.id = pa.project_id
join public.billing_entries existing
  on existing.billing_line_id = be.billing_line_id
 and existing.period_month = (be.period_month - interval '1 month')::date
where p.name ilike '%sussex%'
  and pa.app_number = 'AFP 2'
order by bl.item_number;


-- 1d. What the move does to AFP 2's Previous column, if it were recomputed.
--     An entry counts as previous when it is not on this app and its
--     period_month falls before the app's period. Pulling the period back to
--     September means any September entry NOT on AFP 2 stops qualifying.
--     The G703 is a frozen snapshot so nothing on the printed form changes by
--     itself, but these are the rows that would read differently on a rebuild.
select
  bl.item_number,
  bl.description,
  be.period_month,
  be.planned_amount,
  be.actual_amount,
  be.status,
  be.afp_number,
  'currently counts as previous on AFP 2, would not after the move' as effect
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join public.projects p on p.id = bl.project_id
join public.pay_applications pa
  on pa.project_id = p.id
 and pa.app_number = 'AFP 2'
where p.name ilike '%sussex%'
  and (be.pay_application_id is distinct from pa.id)
  and be.period_month >= (pa.period_start - interval '1 month')::date
  and be.period_month < pa.period_start
order by bl.item_number;


-- ===========================================================================
-- SECTION 2 - THE WRITE.
--
-- What is actually in the database, confirmed 2026-10-21:
--
--   1.01.2  2026-09-01  40,445.88  no AFP, status forecast
--   1.01.2  2026-10-01  40,445.88  on AFP 2, status approved
--   1.01.7  2026-09-01  40,445.87  no AFP, status forecast
--   1.01.7  2026-10-01  40,445.87  on AFP 2, status approved
--
-- The September pair are duplicates of the same design work, entered as
-- actuals but never attached to an application. They carry no billing
-- evidence, so v_project_billing_summary already excludes them and no
-- reported total is overstated today. They are inert clutter that shows on
-- the billing page as a stale prior forecast.
--
-- So the write removes the September duplicate and moves the October row,
-- the one AFP 2 actually bills, back into September.
--
-- A September row is removable only when it has no afp_number, no pay
-- application, a status outside the billed set, AND its amount is either zero
-- (a bare forecast) or matches the October row to the cent (a duplicate of
-- the same work). Anything else refuses and names the line, because a
-- September row holding a DIFFERENT billed amount is a second bill, and a
-- date change is the wrong fix for that.
-- ===========================================================================

do $$
declare
  v_project  uuid;
  v_app      uuid;
  v_start    date;
  v_end      date;
  v_matches  int;
  v_entries  int;
  v_absorbed int;
  v_blocked  text;
begin
  select count(*) into v_matches
  from public.projects p
  where p.name ilike '%sussex%';

  if v_matches <> 1 then
    raise exception
      '% projects match ''sussex'' - expected exactly one. Nothing changed.',
      v_matches;
  end if;

  select p.id into v_project
  from public.projects p
  where p.name ilike '%sussex%';

  select pa.id, pa.period_start, pa.period_end
    into v_app, v_start, v_end
  from public.pay_applications pa
  where pa.project_id = v_project
    and pa.app_number = 'AFP 2';

  if v_app is null then
    raise exception 'Sussex has no application numbered AFP 2';
  end if;

  -- Refuse if it is not sitting in October 2026, so a second run cannot walk
  -- the application back into August.
  if date_trunc('month', v_start) <> date '2026-10-01' then
    raise exception
      'AFP 2 period starts % - expected an October 2026 period. Nothing changed.',
      v_start;
  end if;

  -- Any September row that is neither a bare forecast nor an exact duplicate
  -- stops everything.
  select string_agg(bl.item_number || ' (' ||
           case
             when other.pay_application_id is not null then 'stamped on an application'
             when other.afp_number is not null then 'on ' || other.afp_number
             when coalesce(other.status, '') in ('on_pay_app','submitted','approved','paid')
               then 'status ' || other.status
             else 'holds ' || to_char(other.actual_amount, 'FM999,999,990.00') ||
                  ' against ' || to_char(coalesce(nullif(be.actual_amount, 0),
                                                  be.planned_amount, 0),
                                         'FM999,999,990.00') || ' on AFP 2'
           end || ')',
           ', ' order by bl.item_number)
    into v_blocked
  from public.billing_entries be
  join public.billing_entries other
    on other.billing_line_id = be.billing_line_id
   and other.period_month = (be.period_month - interval '1 month')::date
  join public.billing_lines bl on bl.id = be.billing_line_id
  where be.pay_application_id = v_app
    and (
      other.afp_number is not null
      or other.pay_application_id is not null
      or coalesce(other.status, '') in ('on_pay_app','submitted','approved','paid')
      or (
        abs(coalesce(other.actual_amount, 0)) > 0.005
        and abs(coalesce(other.actual_amount, 0)
                - coalesce(nullif(be.actual_amount, 0), be.planned_amount, 0)) > 0.005
      )
    );

  if v_blocked is not null then
    raise exception
      'September rows on % are not bare forecasts or exact duplicates. '
      'Resolve by hand. Nothing changed.',
      v_blocked;
  end if;

  -- Record what was removed on the row that survives, so the cleanup leaves a
  -- trail rather than a silent deletion.
  update public.billing_entries be
  set notes = trim(both from
        coalesce(be.notes || ' ', '') ||
        case
          when abs(coalesce(other.actual_amount, 0)) > 0.005
            then 'Removed a duplicate ' ||
                 to_char(other.period_month, 'YYYY-MM') || ' actual of ' ||
                 to_char(other.actual_amount, 'FM999,999,990.00') ||
                 ' for the same work.'
          else 'Absorbed the ' || to_char(other.period_month, 'YYYY-MM') ||
               ' forecast of ' ||
               to_char(coalesce(other.planned_amount, 0), 'FM999,999,990.00') || '.'
        end)
  from public.billing_entries other
  where be.pay_application_id = v_app
    and other.billing_line_id = be.billing_line_id
    and other.period_month = (be.period_month - interval '1 month')::date;

  with doomed as (
    select other.id
    from public.billing_entries be
    join public.billing_entries other
      on other.billing_line_id = be.billing_line_id
     and other.period_month = (be.period_month - interval '1 month')::date
    where be.pay_application_id = v_app
  )
  delete from public.billing_entries be
  using doomed d
  where be.id = d.id;

  get diagnostics v_absorbed = row_count;

  update public.billing_entries be
  set period_month = (be.period_month - interval '1 month')::date,
      cash_in_month = case
        when be.cash_in_month is null then null
        else (be.cash_in_month - interval '1 month')::date
      end,
      notes = trim(both from
        coalesce(be.notes || ' ', '') ||
        'Period corrected from ' || to_char(be.period_month, 'YYYY-MM') ||
        ' to ' || to_char((be.period_month - interval '1 month')::date, 'YYYY-MM') ||
        ' (AFP 2 was raised against the wrong month).')
  where be.pay_application_id = v_app;

  get diagnostics v_entries = row_count;

  update public.pay_applications pa
  set period_start = (pa.period_start - interval '1 month')::date,
      period_end   = (pa.period_end   - interval '1 month')::date
  where pa.id = v_app;

  raise notice
    'AFP 2 moved from % - % to % - %. % entries moved, % September rows removed.',
    v_start, v_end,
    (v_start - interval '1 month')::date,
    (v_end - interval '1 month')::date,
    v_entries, v_absorbed;
end $$;


-- ===========================================================================
-- SECTION 3 - CONFIRM. Run after section 2.
-- ===========================================================================

select
  pa.app_number,
  pa.period_start,
  pa.period_end,
  pa.status,
  pa.total_completed,
  pa.amount_due
from public.pay_applications pa
join public.projects p on p.id = pa.project_id
where p.name ilike '%sussex%'
order by pa.period_end nulls first, pa.created_at;

select
  bl.item_number,
  be.period_month,
  be.actual_amount,
  be.status,
  be.afp_number
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join public.pay_applications pa on pa.id = be.pay_application_id
join public.projects p on p.id = pa.project_id
where p.name ilike '%sussex%'
  and pa.app_number = 'AFP 2'
order by bl.item_number;
