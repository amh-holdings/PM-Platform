-- equipment_dedupe.sql
--
-- Clean up near-duplicate rows in a project's equipment catalog.
--
-- Migration 0047's unique index stops the SAME name being added twice for one
-- crew. It cannot stop "620 skidder", "620 tigercat" and "620 tigercat
-- skidder", which are three spellings of one machine and three distinct
-- strings. Sweet Springs accumulated a run of these because inline add is one
-- click and nobody could see the list while typing into it.
--
-- Two ways to do this. The app is usually the right one: the equipment picker
-- now puts an X on every line, so whoever knows the iron can clear the
-- duplicates in a couple of minutes and see what they are doing. This file is
-- for doing it in bulk, and for the one thing the X cannot do - repointing the
-- filed reports that already named the duplicate.
--
-- Read-only until you uncomment step 3. Run in the Supabase SQL Editor.

-- ============ STEP 1 - what is actually there ============
--
-- Every catalog entry with how often it has been reported. An entry with
-- times_reported = 0 is safe to retire outright: nothing points at it.

with project as (
  select id from public.projects where name ilike '%sweet springs%' limit 1
)
select
  s.company_name,
  pe.name,
  pe.active,
  count(de.id)                         as times_reported,
  min(d.report_date)                   as first_reported,
  max(d.report_date)                   as last_reported,
  pe.id                                as equipment_id
from public.project_equipment pe
join public.subcontractors s on s.id = pe.subcontractor_id
left join public.dpr_equipment de on de.equipment_id = pe.id
left join public.dprs d on d.id = de.dpr_id
where pe.project_id = (select id from project)
group by s.company_name, pe.id, pe.name, pe.active
order by s.company_name, lower(btrim(pe.name));

-- ============ STEP 2 - the merges to make ============
--
-- Fill this in from step 1, one row per duplicate: the spelling you are
-- keeping, then the spelling you are dropping. Both must belong to the SAME
-- crew - two subs owning a "620 skidder" each own their own machine, and the
-- join below enforces that rather than trusting the name.
--
-- The four below are the ones that are unambiguously one machine. The rest of
-- what Zarina's screenshot showed needs someone who knows the iron:
--
--   Develon 250 / Develon 250 WD / Develon 250 WL
--     WD and WL may be a real wheel dozer and wheel loader, or two typos of
--     one machine. Not guessable from here.
--   Devlon excavator / Devion excvator / Dodson excavator
--     All three are misspellings of Develon, but the catalog carries both a
--     235 and a 350 excavator and these do not say which.

-- ============ STEP 3 - apply it ============
--
-- Uncomment to run. Retires the dropped spellings and repoints the filed
-- reports that named them, in one transaction.
--
-- Historical equipment_name is deliberately NOT rewritten. It is what the
-- report says was on site (0047), and deriveEquipment in src/lib/weekly-report.ts
-- already groups spelling variants for the weekly rollup, so the typo does not
-- reach the owner either way.

-- begin;
--
-- create temporary table equip_merge on commit drop as
-- with project as (
--   select id from public.projects where name ilike '%sweet springs%' limit 1
-- ),
-- merges(keep_name, drop_name) as (values
--   ('620 tigercat skidder', '620 skidder'),
--   ('620 tigercat skidder', '620 tigercat'),
--   ('Cat 725 adt',          'Cat 725'),
--   ('CAT 730 ADT',          'Cat 730')
-- )
-- select k.id as keep_id, dd.id as drop_id, k.name as keep_name, dd.name as drop_name
-- from merges m
-- join public.project_equipment dd
--   on dd.project_id = (select id from project)
--  and lower(btrim(dd.name)) = lower(btrim(m.drop_name))
-- join public.project_equipment k
--   on k.project_id = dd.project_id
--  and k.subcontractor_id = dd.subcontractor_id   -- same crew, never across
--  and lower(btrim(k.name)) = lower(btrim(m.keep_name));
--
-- -- Did every pair resolve? A merge whose keeper or dropped row was not found
-- -- silently does nothing, so look at this before committing.
-- select * from equip_merge;
--
-- update public.dpr_equipment de
-- set equipment_id = m.keep_id
-- from equip_merge m
-- where de.equipment_id = m.drop_id;
--
-- update public.project_equipment pe
-- set active = false
-- where pe.id in (select drop_id from equip_merge);
--
-- commit;

-- ============ STEP 4 - anything unused and duplicated ============
--
-- Entries no report has ever named. Nothing points at them, so retiring these
-- costs nothing and is the safest half of the cleanup.

-- update public.project_equipment pe
-- set active = false
-- where pe.project_id = (select id from public.projects where name ilike '%sweet springs%' limit 1)
--   and pe.active
--   and not exists (select 1 from public.dpr_equipment de where de.equipment_id = pe.id);
