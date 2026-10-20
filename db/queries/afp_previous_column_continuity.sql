-- Does the Previous column on each AFP still tie to the one before it?
--
-- Zarina: "Is the previous column getting updated?"
--
-- SHORT ANSWER, from the code: it is computed fresh when an application is
-- CREATED, and never again. createPayApplication works out
-- work_completed_previous per line from the billing entries - anything
-- stamped onto another application, or dated before this period, that carries
-- billing evidence - and writes it into pay_application_lines as a snapshot.
-- Nothing recomputes it afterwards. There is no rebuild action.
--
-- So:
--   A NEW application picks up everything billed before it. Create AFP 14 and
--   its Previous will include AFP 12 and 13 on its own.
--   AN EXISTING application keeps the Previous it was born with. Edit a
--   billing entry in an earlier month and every AFP already created still
--   shows the old figure.
--
-- That second case is what this finds. On an AIA G703, Previous on
-- application N must equal to-date on application N-1. The subcontractor side
-- checks this on every bill and says "Previous billings tie to app 2". The
-- owner side has no such check, so it is a query.
--
-- READ ONLY.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste the whole file, Run.

-- ===========================================================================
-- 1. The chain, per application, every project.
-- ===========================================================================
with apps as (
  select
    pa.id,
    pa.project_id,
    p.name as project,
    pa.app_number,
    pa.status,
    pa.period_start,
    pa.period_end,
    coalesce(pa.previous_billings, 0) as previous_billings,
    -- total_completed is THIS PERIOD, not to date. See pay-app-lines.
    coalesce(pa.total_completed, 0)   as this_period,
    coalesce(pa.previous_billings, 0) + coalesce(pa.total_completed, 0) as to_date,
    row_number() over (
      partition by pa.project_id
      order by pa.period_end nulls first, pa.created_at
    ) as seq
  from public.pay_applications pa
  join public.projects p on p.id = pa.project_id
)
select
  a.project,
  a.app_number,
  a.status,
  a.period_start,
  a.period_end,
  prior.app_number                                  as prior_app,
  prior.to_date                                     as prior_to_date,
  a.previous_billings                               as this_app_previous,
  round(a.previous_billings - coalesce(prior.to_date, 0), 2) as gap,
  a.this_period,
  a.to_date,
  case
    when prior.id is null and abs(a.previous_billings) < 0.01
      then 'first application, nothing before it'
    when prior.id is null
      then 'FIRST application yet it carries previous billings - from work billed outside the platform?'
    when abs(a.previous_billings - prior.to_date) < 0.01
      then 'ties'
    when a.previous_billings > prior.to_date
      then 'OVERSTATED: Previous is more than the prior application ever reached'
    else 'UNDERSTATED: Previous is less than the prior application reached - work billed and then dropped'
  end as verdict
from apps a
left join apps prior
  on prior.project_id = a.project_id and prior.seq = a.seq - 1
order by a.project, a.seq;

-- A gap is not automatically wrong. An application billed outside the
-- platform and backfilled, or an entry corrected after the fact, both show
-- here. What it is telling you is that the two documents no longer agree, and
-- on a G703 that is the owner's first question.

-- ===========================================================================
-- 2. Same check per line, for any application the first section flagged.
-- ===========================================================================
-- Swap in the app number you want to look at.
with proj as (
  select id, name from public.projects where name ilike '%sweet%spring%' limit 1
),
ordered as (
  select pa.id, pa.app_number,
         row_number() over (order by pa.period_end nulls first, pa.created_at) as seq
  from public.pay_applications pa, proj
  where pa.project_id = proj.id
),
target as (select * from ordered where app_number ilike '%12%' limit 1),
prior  as (select o.* from ordered o, target t where o.seq = t.seq - 1)
select
  coalesce(cur.item_number, pre.item_number)        as item_number,
  coalesce(cur.description, pre.description)        as description,
  pre.total_completed_and_stored                    as prior_to_date,
  cur.work_completed_previous                       as this_app_previous,
  round(coalesce(cur.work_completed_previous,0) - coalesce(pre.total_completed_and_stored,0), 2) as gap,
  cur.work_completed_this_period                    as this_period
from (
  select pal.* from public.pay_application_lines pal, target t
  where pal.pay_application_id = t.id
) cur
full outer join (
  select pal.* from public.pay_application_lines pal, prior p
  where pal.pay_application_id = p.id
) pre on pre.item_number = cur.item_number
where abs(coalesce(cur.work_completed_previous,0) - coalesce(pre.total_completed_and_stored,0)) >= 0.01
order by 1;

-- Empty is the good answer: every line's Previous ties to the prior
-- application's to-date.

-- ===========================================================================
-- 3. Billing entries changed after the application that should carry them.
-- ===========================================================================
-- The mechanism behind an understated or overstated Previous: an entry whose
-- money moved after the snapshot was taken.
select
  p.name as project,
  bl.item_number,
  be.period_month,
  coalesce(nullif(be.actual_amount, 0), be.planned_amount) as amount,
  be.status,
  be.pay_application_id is not null as on_an_app,
  be.afp_number
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join public.projects p on p.id = bl.project_id
where be.pay_application_id is null
  and coalesce(nullif(be.actual_amount, 0), be.planned_amount) > 0
  and (be.afp_number is not null
       or coalesce(be.status, '') in ('on_pay_app', 'submitted', 'approved', 'paid'))
order by p.name, be.period_month, bl.item_number;

-- These count as PREVIOUS on the next application that gets created, because
-- they carry billing evidence, but they are on no application in the app.
-- Each one is money the next AFP will treat as already billed.
