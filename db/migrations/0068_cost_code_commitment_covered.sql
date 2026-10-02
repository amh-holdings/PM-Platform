-- When a commitment is the source of truth for a cost code's scope.
--
-- THE BUG THIS FIXES
-- The cash flow counted Sweet Springs' bought-out scope twice. SSC S "Elec
-- Collect System" carried $507,501 of forecast AND Lumina's and Matthews'
-- subcontract SOVs carried the same work; SSC T "Main Components" carried
-- $674,772 AND the fifteen POs carried the same materials. Across seven codes
-- that is $2,497,074 of cost counted on both sides, which read on the
-- dashboard as a $1.9M loss on a job making about 8%.
--
-- WHY NOT cost_codes.subcontractor_id, WHICH ALREADY EXISTS
-- Because the relationship is not one-to-one and never was. SSC S is the
-- budget line for ALL electrical, which is two subcontracts (Lumina and
-- Matthews). SSC T is one line against sixteen purchase orders. A single
-- foreign key cannot say "this scope is bought out" when the buying happened
-- across several commitments, and bending the FK to point at whichever
-- commitment is largest would be a lie the next person has to unpick.
--
-- So the flag states the thing that is actually true: a commitment carries
-- this scope into the forecast, so do not also count the buildup line. The
-- buildup keeps its estimate, which is what makes budget-versus-committed
-- reporting possible - this changes the CASH FLOW only.
--
-- WHAT STAYS FALSE
-- Codes nothing else covers: AHC labour, general conditions, per diem, travel,
-- vehicles, communication, reimbursements, site facilities, bonds, insurance.
-- Also the engineering codes, because Pure Power and Kimley-Horn have no SOV
-- in the app - their cost exists ONLY in the buildup, and flagging them would
-- delete it from the forecast rather than relocate it.

alter table public.cost_codes
  add column if not exists commitment_covered boolean not null default false;

comment on column public.cost_codes.commitment_covered is
  'True when a subcontract SOV or purchase order already carries this scope into the cash-flow forecast. The code keeps its estimate for budget reporting; its cost_forecasts rows are excluded from the projection to stop the same money being counted twice. Set per code - see scripts/cashflow/set_commitment_covered.mts.';

create index if not exists cost_codes_commitment_covered_idx
  on public.cost_codes(project_id, commitment_covered);
