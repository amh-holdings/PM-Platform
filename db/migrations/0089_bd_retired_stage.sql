-- Retired: a closed stage for a site the client dropped from a portfolio,
-- 2026-11-04.
--
-- Phil: "I need to mark Livingston as retired." Standard Solar took
-- Livingston (Prince George's County, MD) out of the VA/MD portfolio on
-- 10/29/26 and added Llama Rd, VA. None of the existing closed stages fit:
--   lost    - we lost it to someone. We did not.
--   no_bid  - we passed. We did not.
--   dead    - the client cancelled the job. The portfolio went on without it.
-- Retired is closed, never counts in the win rate, and needs no follow-up.
--
-- Also marks Livingston Solar retired as of 10/29/26, so it leaves the open
-- pipeline and the RFPs list without a manual step. Only touches it while it
-- is still open; a stage someone already set by hand is left alone.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Idempotent - safe to re-run.

-- The stage check from 0074 was declared inline, so its name was generated.
-- Drop every check on bd_opportunities that lists the stages, whatever it is
-- called, then add both back with 'retired' in them.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.bd_opportunities'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%no_bid%'
  loop
    execute format('alter table public.bd_opportunities drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.bd_opportunities add constraint bd_opportunities_stage_check
  check (stage in ('lead', 'bidding', 'submitted', 'shortlist', 'won', 'lost', 'no_bid', 'dead', 'retired'));

alter table public.bd_opportunities add constraint bd_open_needs_follow_up
  check (stage in ('won', 'lost', 'no_bid', 'dead', 'retired') or next_follow_up_date is not null);

-- Livingston. bd_lost_needs_reason does not mention no_bid, so it survived
-- the loop above untouched.
update public.bd_opportunities
set stage = 'retired',
    outcome_date = '2026-10-29',
    outcome_notes = coalesce(nullif(outcome_notes, '') || E'\n', '')
      || 'Retired 10/29/26: Standard Solar dropped Livingston from the VA/MD portfolio and added Llama Rd, VA.'
where name = 'Livingston Solar'
  and stage in ('lead', 'bidding', 'submitted', 'shortlist');
