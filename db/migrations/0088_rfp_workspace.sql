-- The RFP workspace, 2026-11-03.
--
-- Phil: "build this as a runbook and build it in the app." The process is the
-- AHC RFP Process on the Notion card "RFP and Proposal Process - Map for
-- Automation", built from the Sweet Springs, Standard Solar and Sussex CSG 1
-- RFPs. The goal on that card is that the next bid runs through Zarina with
-- Phil doing only a final review. So everything here is readable and writable
-- by Zarina as well as Phil and the bd users.
--
-- Four tables, all hanging off a bd_opportunity:
--
--   bd_state_profiles  One row per US state. Everything that changes by state
--                      (wage law, licensing, contractor bonds, sales tax, lien
--                      forms, stormwater) is set once here and read by every
--                      bid in that state. No phase of the runbook hardcodes a
--                      state. Seeded with what the Sussex and Sweet Springs
--                      bids taught us.
--   rfp_step_checks    Which runbook steps are done on which opportunity. The
--                      steps themselves live in src/lib/rfp.ts so the runbook
--                      text ships with the code and stays one definition.
--   rfp_bidders        The bid status tracker: one row per firm per package.
--   rfp_bidder_docs    Which required documents each bidder has sent. The
--                      document list lives in src/lib/rfp.ts.
--
-- ACCESS. Zarina's DB role is `zarina`, which the BD tables (0074) do not
-- admit. She gets the four new tables, plus READ on bd_opportunities and
-- bd_companies so the workspace can show which job and which client it is.
-- She does not get bd_bids, so our submitted price and margin stay with Phil
-- and BD.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

-- ============ STATE PROFILES ============

create table if not exists public.bd_state_profiles (
  id uuid primary key default gen_random_uuid(),
  state text not null check (state ~ '^[A-Z]{2}$'),
  labor text,
  wage_determinations text,
  licensing text,
  contractor_bond_tax text,
  sales_tax text,
  lien_waivers text,
  stormwater text,
  codes text,
  other_reviews text,
  engineering text,
  notes text,
  verified_on date,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bd_state_profiles_state_key on public.bd_state_profiles (state);

-- ============ RUNBOOK STEP CHECKS ============
-- A row means the step is done. Unchecking deletes the row.

create table if not exists public.rfp_step_checks (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.bd_opportunities(id) on delete cascade,
  step_key text not null,
  checked_by uuid references public.profiles(id) on delete set null,
  checked_at timestamptz not null default now()
);

create unique index if not exists rfp_step_checks_once on public.rfp_step_checks (opportunity_id, step_key);

-- ============ BIDDERS ============

create table if not exists public.rfp_bidders (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.bd_opportunities(id) on delete cascade,
  firm text not null,
  package text not null
    check (package in ('civil', 'mechanical', 'electrical', 'medium_voltage', 'commissioning',
                       'tracker_piles', 'electrical_equipment', 'scada', 'met_station',
                       'engineering', 'other')),
  kind text not null default 'sub' check (kind in ('sub', 'supplier')),
  contact_name text,
  contact_email text,
  status text not null default 'invited'
    check (status in ('invited', 'confirmed', 'at_risk', 'received', 'carried', 'declined')),
  invited_on date,
  intent_on date,
  last_contact_on date,
  bid_total numeric(14,2) check (bid_total is null or bid_total >= 0),
  validity_date date,
  wage_basis text,
  bond_treatment text,
  license_verified_on date,
  license_note text,
  decline_reason text
    check (decline_reason in ('capacity', 'schedule', 'footprint', 'license', 'wage',
                              'bonding', 'scope', 'unknown')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The runbook says ask why on every decline. The database holds that rule.
  constraint rfp_declined_needs_reason
    check (status <> 'declined' or decline_reason is not null)
);

create index if not exists rfp_bidders_opportunity_idx on public.rfp_bidders (opportunity_id, package);

-- ============ BIDDER DOCUMENTS ============
-- A row means the document is in the vendor folder. Email is not the record.

create table if not exists public.rfp_bidder_docs (
  id uuid primary key default gen_random_uuid(),
  bidder_id uuid not null references public.rfp_bidders(id) on delete cascade,
  doc_key text not null,
  received_on date not null default current_date,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists rfp_bidder_docs_once on public.rfp_bidder_docs (bidder_id, doc_key);

-- ============ updated_at ============
-- bd_touch_updated_at() comes from 0074.

drop trigger if exists bd_state_profiles_updated_at on public.bd_state_profiles;
create trigger bd_state_profiles_updated_at before update on public.bd_state_profiles
  for each row execute function public.bd_touch_updated_at();

drop trigger if exists rfp_bidders_updated_at on public.rfp_bidders;
create trigger rfp_bidders_updated_at before update on public.rfp_bidders
  for each row execute function public.bd_touch_updated_at();

-- ============ RLS ============

alter table public.bd_state_profiles enable row level security;
alter table public.rfp_step_checks   enable row level security;
alter table public.rfp_bidders       enable row level security;
alter table public.rfp_bidder_docs   enable row level security;

drop policy if exists "rfp_all_state_profiles" on public.bd_state_profiles;
create policy "rfp_all_state_profiles" on public.bd_state_profiles
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd', 'zarina'))
  with check (public.current_user_role() in ('phil', 'bd', 'zarina'));

drop policy if exists "rfp_all_step_checks" on public.rfp_step_checks;
create policy "rfp_all_step_checks" on public.rfp_step_checks
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd', 'zarina'))
  with check (public.current_user_role() in ('phil', 'bd', 'zarina'));

drop policy if exists "rfp_all_bidders" on public.rfp_bidders;
create policy "rfp_all_bidders" on public.rfp_bidders
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd', 'zarina'))
  with check (public.current_user_role() in ('phil', 'bd', 'zarina'));

drop policy if exists "rfp_all_bidder_docs" on public.rfp_bidder_docs;
create policy "rfp_all_bidder_docs" on public.rfp_bidder_docs
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd', 'zarina'))
  with check (public.current_user_role() in ('phil', 'bd', 'zarina'));

-- Zarina reads which job and which client. Read only, and not bd_bids.
drop policy if exists "zarina_read_opportunities" on public.bd_opportunities;
create policy "zarina_read_opportunities" on public.bd_opportunities
  for select to authenticated
  using (public.current_user_role() = 'zarina');

drop policy if exists "zarina_read_companies" on public.bd_companies;
create policy "zarina_read_companies" on public.bd_companies
  for select to authenticated
  using (public.current_user_role() = 'zarina');

-- ============ SEED: what the bids taught us ============
-- Insert only. A profile already edited in the app is never overwritten.

insert into public.bd_state_profiles
  (state, labor, wage_determinations, licensing, contractor_bond_tax, sales_tax,
   lien_waivers, stormwater, codes, other_reviews, engineering, notes)
values
  ('DE',
   'IRA: Davis-Bacon and 15% registered apprenticeship at all tiers on projects 1 MWac and over.',
   'Sussex County: Heavy DE20260012, Building DE20260009. Fence carries the Ironworker scale, which runs high.',
   'Delaware business license for AHC and every sub, required with the bid. Customer-owned medium voltage needs a Delaware licensed electrician (Title 24 Section 1419). No reciprocity with Virginia: Matthews could not license before mobilization and dropped out 10/29/26.',
   '6% surety or cash bond from out-of-state contractors on contracts over $20,000 (30 Del. C. 375), posted before mobilization. Division of Revenue Form 5060. Gross receipts tax.',
   null,
   'Lien waivers and sworn payment statement on Delaware forms. The Sussex templates were New York law and had to be rewritten.',
   'Conservation District sediment and stormwater plan (3-step review, 3 to 6 months) with performance and warranty security. DNREC Notice of Intent and Tax Ditch approval.',
   '2023 NEC (effective 1/1/2026). 2021 IBC in Sussex County.',
   'Office of the State Fire Marshal site plan before the county building permit. DelDOT entrance permit.',
   'Out-of-state engineer of record needs a Delaware PE license and a firm Certificate of Authorization.',
   'Built from Sussex CSG 1. See the Jurisdictional Permitting Index, Sussex County.'),
  ('VA',
   'IRA: Davis-Bacon and 15% registered apprenticeship on projects 1 MWac and over. Under 1 MWac is exempt, so ask for an alternate price without it (Sweet Springs). Prevailing wage per locality.',
   null,
   'Copy of the Virginia contractor license, not just the number, plus the Virginia Business Registration Certificate. Orange County: a Virginia licensed electrical contractor pulls the trades permit tied to our building permit. Licensing an out-of-state electrician took about 3 months (Lumina, Texas to Virginia).',
   null,
   'Project exemption certificate goes to vendors with the PO (Sweet Spring Solar, LLC). The TVIG/AHC exemption was denied twice. Track any tax subs add to invoices.',
   null,
   'VAR10 Construction General Permit through DEQ. Name the operator of record before mobilization. Chesapeake Bay Watershed sites inspect every 4 business days.',
   '2021 VCC/IBC, 2020 NEC, 2021 IFC (Orange County).',
   'VDOT Land Use Permit for work next to a state road.',
   null,
   'Built from Sweet Springs. See the Jurisdictional Permitting Index, Orange County.'),
  ('MD',
   'Maryland prevailing wage runs materially above Virginia rates. It was the largest cost driver in the VA/MD portfolio bid.',
   null,
   'License numbers by state requested on the Standard Solar qualification form.',
   null, null, null, null, null, null, null,
   'Thin. Livingston (Prince George''s County) was the only Maryland site and was dropped 10/29/26. Build this out before the next Maryland bid.')
on conflict (state) do nothing;
