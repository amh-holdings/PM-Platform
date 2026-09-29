-- What a SOV line is worth, scope by scope.
--
-- Zarina, on 6.03 Fencing/SWPPP: "Please update this recommended rules of
-- credit on what to bill to owner. Recommended rules of credit: SWPPP at 30%,
-- rest is fence."
--
-- 6.03 is one contract line over two unrelated scopes: permanent fencing, and
-- the erosion and sediment control that implements the SWPPP. The billing
-- recommendation weights a line's linked tasks by scheduled duration, which is
-- right when a line is one scope split across tasks and wrong here. Duration
-- says how long something takes, not what it is worth, and eight short ESC
-- tasks next to one long fencing task gave 6.03 a percent nobody could defend
-- to Dimension. Dimension rejected AFP 12 on exactly that and asked for a rule
-- of credit to measure future progress against.
--
-- The rule says what each scope is worth as a share of the line. Earned percent
-- becomes sum(weight x that scope's progress), which carries a sentence:
-- "SWPPP is 54% done and carries 30%, fencing has not started and carries 70%,
-- so the line has earned 16.2%."
--
-- Shape:
--   {"note": "...",
--    "components": [
--      {"name": "Fence", "weightPct": 70, "match": ["fencing installation"]},
--      {"name": "SWPPP", "weightPct": 30, "match": []}
--    ]}
--
-- Components claim tasks by name pattern rather than by a stored list of WBS
-- codes, because a stored list goes stale the moment the schedule gains a task
-- and it goes stale silently: the new task earns nothing and the line quietly
-- under-bills. Exactly one component carries an empty match and takes
-- everything the others did not, so no linked task can fall outside the rule.
--
-- Weights must sum to 100. The app refuses a rule that does not and falls back
-- to duration weighting rather than billing a percentage of a percentage.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.billing_lines
  add column if not exists rule_of_credit jsonb;

comment on column public.billing_lines.rule_of_credit is
  'How this line splits its value between the scopes inside it. Null means '
  'the recommendation weights linked tasks by scheduled duration, which is '
  'the behaviour every line had before 0065. See src/lib/rule-of-credit.ts.';

-- ---------------------------------------------------------------------------
-- Seed 6.03, the line this came from.
--
-- Fence names itself, SWPPP takes the remainder, and that direction is
-- deliberate. There is one permanent fencing task and eight ESC tasks, so
-- naming the one and sweeping the rest means a new basin or seeding activity
-- lands in SWPPP on its own. The pattern is "fencing installation" rather than
-- "fence" because "Silt/Rock Fence Install" is erosion control, and a looser
-- pattern would hand 70% of the line to a silt fence.
--
-- Only seeds a line that has none, so re-running never overwrites an edit.
-- ---------------------------------------------------------------------------

update public.billing_lines
set rule_of_credit = jsonb_build_object(
  'note', 'SWPPP 30%, fence the remainder. Set 2026-09-29.',
  'components', jsonb_build_array(
    jsonb_build_object('name', 'Fence',  'weightPct', 70, 'match', jsonb_build_array('fencing installation')),
    jsonb_build_object('name', 'SWPPP',  'weightPct', 30, 'match', jsonb_build_array())
  )
)
where item_number = '6.03'
  and rule_of_credit is null
  and description ilike '%swppp%';

notify pgrst, 'reload schema';
