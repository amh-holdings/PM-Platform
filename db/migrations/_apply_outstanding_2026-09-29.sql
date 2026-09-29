-- Apply every outstanding migration, in order. Assembled 2026-09-29.
--
-- Zarina: "Please run all migratios."
--
-- Five migrations have been waiting, and running them one file at a time is
-- why. This is all five concatenated in dependency order, wrapped in one
-- transaction so either all of them land or none of them do.
--
-- Order matters in one place: 0064 backfills each payment milestone's net
-- terms from its purchase order's, which is the column 0063 adds. Run 0063
-- first or the backfill finds nothing to copy.
--
-- Every one of them is additive and safe to re-run. Columns use
-- "add column if not exists", constraints are dropped before being added,
-- and each backfill only touches rows still holding null, so a second run
-- never overwrites a value somebody has since typed.
--
-- Nothing here drops a column, drops a table, or deletes a row.
--
-- HOW TO RUN
--   Supabase SQL Editor: open the project, paste this whole file, Run.
--   Or from the repo on the Mac Mini, with SUPABASE_DB_URL in .env.local:
--     psql "$SUPABASE_DB_URL" -f db/migrations/_apply_outstanding_2026-09-29.sql
--
-- The verification queries at the bottom run after the commit. Read them.
--
-- This file is not itself a migration. It is a convenience wrapper, which is
-- why it carries no number. The five numbered files remain the record.

begin;

-- ==========================================================================
-- 0052_placed_in_service_date
-- Guaranteed Placed-in-Service Date on Exhibit H
-- ==========================================================================

-- 0052_placed_in_service_date.sql
--
-- Guaranteed Placed-in-Service Date on Exhibit H.
--
-- The owner's form carries three guaranteed dates, not two. Mechanical
-- Completion and Substantial Completion were modelled in 0046; Placed in
-- Service sits between them on the form and was missing, so a change order
-- that moves the PIS date had nowhere to say so and Phil filled that line of
-- Exhibit H by hand from a date the app did not hold.
--
-- Same shape as the other two, deliberately: the guaranteed date is a project
-- fact, the change order carries a delta in days, and the revised date is
-- derived rather than stored. Nothing about how the first two work changes.
--
-- Both columns are nullable with no default. A project that has no PIS date
-- and a change order that does not touch it read exactly as they do today, so
-- nothing is backfilled and no existing Exhibit H figure moves.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.projects
  add column if not exists guaranteed_placed_in_service_date date;

comment on column public.projects.guaranteed_placed_in_service_date is
  'Guaranteed Placed-in-Service Date from the agreement. Exhibit H adjusts it by a change order''s pis_completion_delta_days.';

alter table public.change_orders
  add column if not exists pis_completion_delta_days integer;

comment on column public.change_orders.pis_completion_delta_days is
  'Days this change order moves the Guaranteed Placed-in-Service Date. Positive pushes it out, negative pulls it in, null or 0 leaves it alone.';

-- ==========================================================================
-- 0054_billing_line_amendments
-- Allocate a change order's lines against contract SOV lines
-- ==========================================================================

-- 0054_billing_line_amendments.sql
--
-- WHICH CONTRACT LINE A CHANGE ORDER'S MONEY BELONGS TO
--
-- A change order does one of three things to the schedule of values, and the
-- app only modelled one of them:
--
--   1. Adds new scope, which gets its own SOV line. CO-05 (Piles, 15.00) and
--      CO-06 (Bond Premium, 16.00) are this. `billing_lines.change_order_id`
--      already says so, and it works.
--   2. Raises the price of scope the sheet ALREADY carries. CO-04 increases
--      POI Procurement; CO-02 adds cost to Mobilization and Fencing. Nothing
--      recorded this, so those contract lines kept their original scheduled
--      value and read as finished the moment that value was billed. POI 5.05
--      is $168,335.32 against a real scope of $235,793.63 once CO-04's
--      $67,458.31 is counted: 100% complete on the page, 71.4% in fact.
--   3. Moves no money at all. CO-03 is a completion-date change. It should
--      read as deliberate, not as a line somebody forgot to add.
--
-- This table records case 2: how much of a change order's SOV line belongs
-- against which contract line.
--
-- WHY AN AMOUNT, NOT JUST A POINTER
-- CO-02 touches Mobilization AND Fencing. A pointer can say which line, not
-- how much, so one row per (change order line, contract line) with the amount
-- on it. The owner's G703 keeps one line per change order while the app still
-- knows each contract line's true scope. Whatever is left unallocated on a
-- change order line is genuinely new scope, which is the right reading for
-- Piles and Bond Premium.
--
-- WHY NOT JUST RAISE THE CONTRACT LINE
-- Because $2,507,500.00 is what Dimension signed. Folding change orders into
-- the contract lines erases the executed SOV, breaks deriveContractValue's
-- agreement-versus-SOV check, and stops the live sheet reconciling with the
-- G703s already issued on AFP 1 through 12. Nothing here alters a scheduled
-- value, a billing entry or a pay application: this table only attributes.
--
-- Purely additive. With no rows, every page behaves exactly as it did before.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.billing_line_amendments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  -- The change order's own SOV line - the one carrying the CO money.
  amendment_line_id uuid references public.billing_lines(id) on delete cascade not null,
  -- The contract line whose scope that money increases.
  base_line_id uuid references public.billing_lines(id) on delete cascade not null,
  amount numeric(14,2) not null default 0,
  note text,
  created_at timestamptz default now(),
  -- One allocation per pair. Changing how much goes to a line is an update,
  -- not a second row, so a total can never be assembled from stale halves.
  unique (amendment_line_id, base_line_id),
  constraint billing_line_amendments_not_self
    check (amendment_line_id <> base_line_id)
);

create index if not exists billing_line_amendments_base_idx
  on public.billing_line_amendments(base_line_id);
create index if not exists billing_line_amendments_amendment_idx
  on public.billing_line_amendments(amendment_line_id);
create index if not exists billing_line_amendments_project_idx
  on public.billing_line_amendments(project_id);

alter table public.billing_line_amendments enable row level security;
drop policy if exists "ahc_read_billing_line_amendments"  on public.billing_line_amendments;
drop policy if exists "ahc_write_billing_line_amendments" on public.billing_line_amendments;

-- Same audience as billing_lines. An allocation is billing data.
create policy "ahc_read_billing_line_amendments" on public.billing_line_amendments
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_line_amendments" on public.billing_line_amendments
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- PostgREST answers from a cached copy of the schema, so a brand new table is
-- invisible to the app until that cache reloads. Supabase normally reloads it
-- on its own within a minute or so, but not always, and a stale cache looks
-- exactly like a migration that was never run: the change order page keeps
-- saying it needs 0054 and Link to a contract line stays greyed out. Asking
-- for the reload here means re-running this file is the fix.
notify pgrst, 'reload schema';

-- To check by hand that this worked:
--   select count(*) from public.billing_line_amendments;
-- Zero rows is the right answer. An error means the table is not there.

-- AFTER RUNNING, on Sweet Springs, allocate CO-04's line 14.00 against the
-- contract's POI Procurement line 5.05 from the change order page. Billing
-- should then read POI as $235,793.63 of current scope rather than
-- $168,335.32, and its percent complete should fall accordingly.

-- ==========================================================================
-- 0063_po_net_terms_days
-- Net terms as a number on the PO, backfilled from the summary text
-- ==========================================================================

-- Net terms as a number, not a phrase.
--
-- Zarina: "Can you separate the net terms instead? Like add a column for
-- specific net terms then the forcast will draw from that not just on a text
-- field."
--
-- Right. payment_terms_summary is prose off the paper PO: "20% Down Payment,
-- 10% Engineering, 40% Progress payment, 30% upon delivery". The forecast has
-- been reading a regex over it for "net NN", which works until somebody
-- writes "net 30 days from invoice receipt" in a sentence that also says
-- "within 30 days of commissioning", or writes no net at all and silently
-- gets same-day payment. A number that decides when money leaves the bank
-- should be a number.
--
-- The summary stays. It is the human record of what the PO actually says and
-- it is what the AI extraction reads. This column is only the machine answer
-- to one question: how many days after the trigger.
--
--   null  nothing stated, so the forecast falls back to reading the summary
--         exactly as it does today
--   0     stated, and it is zero. Paid on the trigger date, no delay
--   N     N days
--
-- Null and zero are deliberately different. Zero is an answer.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.procurement_orders
  add column if not exists net_terms_days integer;

alter table public.procurement_orders
  drop constraint if exists procurement_orders_net_terms_days_range;
alter table public.procurement_orders
  add constraint procurement_orders_net_terms_days_range
  check (net_terms_days is null or (net_terms_days >= 0 and net_terms_days <= 365));

comment on column public.procurement_orders.net_terms_days is
  'Days after the milestone trigger that payment is due. Null means not '
  'stated, and the forecast falls back to parsing payment_terms_summary. '
  'Zero means stated as zero. Backfilled from the summary by 0063.';

-- ---------------------------------------------------------------------------
-- Backfill, so nobody re-types what is already on record.
--
-- Zarina: "For the PO's that already been filled out correctly, can you just
-- separate them so I dont have to go through them one by one to change."
--
-- Same rule the app has used all along, moved into SQL: the whole run of
-- digits after "net", word-bounded so "Internet 30" does not match, and only
-- 1 to 365 so "Net 3000" stays unparsed rather than quietly becoming a date
-- most of a year out. Anything the regex cannot read is left null, which is
-- exactly what it was before, so nothing is guessed.
--
-- Only touches rows where the column is still null, so re-running this after
-- somebody has typed a real value does not overwrite them.
-- ---------------------------------------------------------------------------

update public.procurement_orders
set net_terms_days = (substring(payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
where net_terms_days is null
  and payment_terms_summary ~* '\mnet\s*[0-9]+'
  and (substring(payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365;

notify pgrst, 'reload schema';

-- ==========================================================================
-- 0064_milestone_net_terms_days
-- Net terms per payment milestone, backfilled from its order
-- ==========================================================================

-- Net terms belongs on the milestone, not on the order.
--
-- Zarina, looking at a PO whose summary reads "20% Down Payment, 10%
-- Engineering, 40% Progress payment, 30% upon delivery": "Instead of the
-- summary from the uploaded PO, can you just do it when adding a milestone?"
--
-- She is right, and 0063 put the number one level too high. One PO can carry
-- four milestones on four different clocks: a deposit due on signing with no
-- lag at all, engineering at Net 30, a progress payment at Net 45, delivery
-- at Net 30 from the packing slip. A single number on the order cannot say
-- that, so it either picks one and is wrong three times, or stays blank and
-- the forecast is back to reading prose.
--
-- The order-level column stays as the fallback and as what a fresh milestone
-- is seeded from. It is no longer typed anywhere: the form field moved onto
-- the milestone row, which is the row that actually pays.
--
--   null  not stated on this milestone, so the order's number is used, and
--         failing that the summary is parsed exactly as before
--   0     stated, and it is zero. Paid on the trigger date, no delay
--   N     N days after the trigger
--
-- Apply via Supabase SQL Editor. Safe to re-run. Run 0063 first.

alter table public.procurement_payments
  add column if not exists net_terms_days integer;

alter table public.procurement_payments
  drop constraint if exists procurement_payments_net_terms_days_range;
alter table public.procurement_payments
  add constraint procurement_payments_net_terms_days_range
  check (net_terms_days is null or (net_terms_days >= 0 and net_terms_days <= 365));

comment on column public.procurement_payments.net_terms_days is
  'Days after this milestone''s trigger that payment is due. Null falls back '
  'to procurement_orders.net_terms_days and then to parsing '
  'payment_terms_summary. Zero means stated as zero. Backfilled by 0064.';

-- ---------------------------------------------------------------------------
-- Backfill, so the column arrives already filled in.
--
-- "If a PO is uploaded it will just pre-fill the columns and I will just
-- recheck and save." Same idea for the POs already in the app: every
-- milestone inherits whatever its own order already knows, so the number is
-- visible on the row and can be corrected where it is wrong, rather than
-- being an empty column somebody has to work through.
--
-- Two sources, in order. The order's own column, which 0063 set. Then the
-- summary text, word-bounded so "Internet 30" does not match and capped at
-- 365 so "Net 3000" stays unparsed, in case 0063's backfill could not read a
-- summary that this one can reach the same way.
--
-- Only touches rows still null, so re-running never overwrites a real value.
-- ---------------------------------------------------------------------------

update public.procurement_payments p
set net_terms_days = coalesce(
  o.net_terms_days,
  case
    when o.payment_terms_summary ~* '\mnet\s*[0-9]+'
     and (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365
    then (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
  end
)
from public.procurement_orders o
where p.procurement_order_id = o.id
  and p.net_terms_days is null
  and coalesce(
    o.net_terms_days,
    case
      when o.payment_terms_summary ~* '\mnet\s*[0-9]+'
       and (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365
      then (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
    end
  ) is not null;

notify pgrst, 'reload schema';

-- ==========================================================================
-- 0065_billing_line_rule_of_credit
-- Rule of credit on a SOV line, seeding 6.03 at SWPPP 30 / fence 70
-- ==========================================================================

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

commit;

-- ---------------------------------------------------------------------------
-- Verification. Run these after the commit and read the answers.
--
-- Each one should return a row. A missing row means that migration did not
-- land, whatever the editor said.
-- ---------------------------------------------------------------------------

select 'projects.guaranteed_placed_in_service_date' as check, count(*) as found
  from information_schema.columns
 where table_schema = 'public' and table_name = 'projects'
   and column_name = 'guaranteed_placed_in_service_date'
union all
select 'change_orders.pis_completion_delta_days', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'change_orders'
   and column_name = 'pis_completion_delta_days'
union all
select 'billing_line_amendments table', count(*)
  from information_schema.tables
 where table_schema = 'public' and table_name = 'billing_line_amendments'
union all
select 'procurement_orders.net_terms_days', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'procurement_orders'
   and column_name = 'net_terms_days'
union all
select 'procurement_payments.net_terms_days', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'procurement_payments'
   and column_name = 'net_terms_days'
union all
select 'billing_lines.rule_of_credit', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'billing_lines'
   and column_name = 'rule_of_credit';

-- What the two net-terms backfills actually found. Zero on either is not an
-- error, it means no summary on that table held a readable "Net NN".
select 'POs with net terms set'         as backfill, count(*) as rows
  from public.procurement_orders where net_terms_days is not null
union all
select 'milestones with net terms set', count(*)
  from public.procurement_payments where net_terms_days is not null;

-- The 6.03 rule of credit, as it will now be read. Expect one row reading
-- Fence 70 / SWPPP 30. No row means the seed matched no line, and the
-- billing recommendation stays on duration weighting.
select item_number, description, rule_of_credit
  from public.billing_lines
 where rule_of_credit is not null;
