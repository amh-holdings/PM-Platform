-- Subcontractor billing: SOV, pay applications, verification.
--
-- The platform already models AHC billing the OWNER (billing_lines ->
-- billing_entries -> pay_applications/pay_application_lines). This migration
-- is the mirror image on the BUY side: what each subcontractor is entitled to
-- under their executed schedule of values, what they actually billed, and what
-- the field record says they actually earned.
--
-- Four tables:
--   sub_sov_lines      the executed subcontract SOV, one row per line item.
--                      Also carries the mapping that makes verification
--                      possible: which schedule tasks / commodities prove the
--                      line, or that it is milestone / time / manual.
--   sub_pay_apps       one bill from one sub for one period, as received.
--   sub_pay_app_lines  the sub's G703 detail AS BILLED, plus what we verified
--                      and what we approved. Billed and approved are separate
--                      columns on purpose - a bill can be partially approved.
--   sub_pay_app_checks the result of every automated check, persisted so an
--                      approval decision can be reconstructed later.
--
-- Money convention: everything here is what AHC OWES. RLS mirrors the other
-- financial tables (phil / zarina / ahc_super). The Construction Manager gets
-- DB read via ahc_super/zarina and is restricted to the percent-only
-- verification view in the UI capability matrix, not at the row level.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run: additive DDL only, every policy uses DROP IF EXISTS.

-- ============================ SUB SOV LINES ============================

create table if not exists public.sub_sov_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,

  -- As printed on the executed SOV. item_number is the sub's own numbering
  -- ("1.01"), NOT our WBS - the two are related only through the mapping below.
  item_number text not null,
  section_code text,
  section_name text,
  description text not null,
  scheduled_value numeric(14,2) not null default 0,

  -- Unit-price lines. Null on lump-sum lines (Pyramid is entirely lump sum).
  -- When present, verification can compare installed quantity directly instead
  -- of inferring a percentage.
  quantity numeric(14,3),
  unit text,
  unit_cost numeric(14,4),

  is_change_order boolean not null default false,
  change_order_ref text,

  -- ---- Verification mapping ----
  -- How this line's real-world progress is proven. 'unmapped' means the line
  -- can be math-checked but NOT substantiated, and the engine reports it as
  -- unverifiable rather than silently passing it.
  --   schedule   linked_task_wbs_codes drive the percentage
  --   commodity  linked_commodity_ids drive the percentage from daily_production
  --   milestone  100% the moment milestone_task_wbs_code completes, else 0%
  --   on_site    100% once the sub has filed a field report on the job, else 0%.
  --              This is the mobilization rule: a mob line is fully earned when
  --              the crew hits site, and the first DPR is the platform's own
  --              record of that. Confirmed by Phil 2026-08-20.
  --   time       straight line across the linked tasks' date window
  --   manual     the CM enters the percentage each period with a note
  --   unmapped   no evidence source (default until the mapping is confirmed)
  verification_method text not null default 'unmapped'
    check (verification_method in
      ('schedule','commodity','milestone','on_site','time','manual','unmapped')),
  linked_task_wbs_codes text[] not null default '{}',
  linked_commodity_ids uuid[] not null default '{}',
  milestone_task_wbs_code text,
  mapping_notes text,
  mapping_confirmed_at timestamptz,
  mapping_confirmed_by uuid references public.profiles(id),

  sort_order integer,
  active boolean not null default true,
  created_at timestamptz default now(),
  unique (subcontractor_id, item_number)
);

create index if not exists sub_sov_lines_sub_idx
  on public.sub_sov_lines(subcontractor_id, sort_order);
create index if not exists sub_sov_lines_project_idx
  on public.sub_sov_lines(project_id);

comment on table public.sub_sov_lines is
  'Executed subcontract schedule of values, one row per line item, plus the mapping that lets a bill be verified against field evidence.';
comment on column public.sub_sov_lines.verification_method is
  'Evidence source for this line. Default unmapped: the line is math-checked but reported as unverifiable until a mapping is confirmed.';

-- ============================ SUB PAY APPS ============================

create table if not exists public.sub_pay_apps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,

  app_number integer not null,
  app_date date,
  -- period_start is nullable on purpose: subs bill "through <date>" as often
  -- as they bill a calendar month, and Pyramid's app 1 had no start date.
  period_start date,
  period_end date not null,

  retainage_pct numeric(5,2) not null default 0,
  payment_terms_days integer,
  due_date date,

  invoice_number text,
  invoice_date date,
  invoice_total numeric(14,2),

  -- ---- As billed by the sub (their G702 bottom block) ----
  billed_previous numeric(14,2) not null default 0,
  billed_this_period numeric(14,2) not null default 0,
  billed_to_date numeric(14,2) not null default 0,
  retainage_this_period numeric(14,2) not null default 0,
  retainage_to_date numeric(14,2) not null default 0,
  amount_due numeric(14,2) not null default 0,

  -- ---- As approved by AHC. Null until a decision is made. ----
  approved_this_period numeric(14,2),
  approved_retainage numeric(14,2),
  approved_amount_due numeric(14,2),

  status text not null default 'received'
    check (status in
      ('received','under_review','cm_recommended','approved','rejected','paid')),

  -- Compliance artifacts that ride with a progress payment.
  lien_waiver_received boolean not null default false,
  lien_waiver_amount numeric(14,2),
  lien_waiver_through_date date,
  source_document_path text,

  entered_by uuid references public.profiles(id),
  entered_at timestamptz default now(),
  cm_reviewed_by uuid references public.profiles(id),
  cm_reviewed_at timestamptz,
  cm_notes text,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  approval_notes text,
  paid_at date,
  notes text,
  created_at timestamptz default now(),
  unique (subcontractor_id, app_number)
);

create index if not exists sub_pay_apps_project_idx
  on public.sub_pay_apps(project_id, period_end desc);
create index if not exists sub_pay_apps_sub_idx
  on public.sub_pay_apps(subcontractor_id, app_number desc);
create index if not exists sub_pay_apps_status_idx
  on public.sub_pay_apps(project_id, status);

comment on table public.sub_pay_apps is
  'One subcontractor bill for one period, recorded as received. Billed totals are what the sub asked for; approved totals are what AHC agreed to pay.';

-- ========================= SUB PAY APP LINES =========================

create table if not exists public.sub_pay_app_lines (
  id uuid primary key default gen_random_uuid(),
  sub_pay_app_id uuid not null
    references public.sub_pay_apps(id) on delete cascade,
  sub_sov_line_id uuid references public.sub_sov_lines(id),

  -- Snapshotted from the SOV at entry so an approved bill stays readable even
  -- if the SOV is later revised by change order.
  item_number text not null,
  description text not null,
  scheduled_value numeric(14,2) not null default 0,

  -- ---- As billed: the sub's G703 columns D through I ----
  from_previous numeric(14,2) not null default 0,
  this_period numeric(14,2) not null default 0,
  materials_stored numeric(14,2) not null default 0,
  total_completed numeric(14,2) not null default 0,
  pct_billed numeric(9,6),
  balance_to_finish numeric(14,2),
  retainage_amount numeric(14,2) not null default 0,

  -- ---- As verified against field evidence ----
  verified_pct numeric(9,6),
  verified_amount numeric(14,2),
  verification_source text,
  verification_confidence text
    check (verification_confidence in ('high','medium','low','none')),
  verification_detail text,
  variance_amount numeric(14,2),
  variance_pct numeric(9,6),
  flag_level text
    check (flag_level in ('ok','review','flag','unverifiable')),

  -- ---- As approved. Null means no line-level decision yet. ----
  approved_this_period numeric(14,2),
  cm_note text,
  reviewer_note text,

  sort_order integer,
  created_at timestamptz default now()
);

create index if not exists sub_pay_app_lines_app_idx
  on public.sub_pay_app_lines(sub_pay_app_id, sort_order);
create index if not exists sub_pay_app_lines_sov_idx
  on public.sub_pay_app_lines(sub_sov_line_id);

comment on column public.sub_pay_app_lines.flag_level is
  'ok = billed within tolerance of verified. review = outside tolerance, needs a look. flag = materially overbilled. unverifiable = no evidence source, a human must decide.';

-- ========================= SUB PAY APP CHECKS =========================
-- Persisted so a past approval can be explained: which checks ran, what they
-- expected, what they found. Re-running a verification replaces the set.

create table if not exists public.sub_pay_app_checks (
  id uuid primary key default gen_random_uuid(),
  sub_pay_app_id uuid not null
    references public.sub_pay_apps(id) on delete cascade,
  check_key text not null,
  label text not null,
  severity text not null default 'error'
    check (severity in ('error','warning','info')),
  status text not null check (status in ('pass','warn','fail','skip')),
  expected numeric(14,2),
  actual numeric(14,2),
  delta numeric(14,2),
  message text,
  line_item_number text,
  ran_at timestamptz default now()
);

create index if not exists sub_pay_app_checks_app_idx
  on public.sub_pay_app_checks(sub_pay_app_id, severity);

-- ================================ RLS ================================
-- Same posture as pay_applications and cost_codes: the AHC roles get full
-- CRUD, everyone else gets nothing. Subs do not see the buy-side record.

alter table public.sub_sov_lines      enable row level security;
alter table public.sub_pay_apps       enable row level security;
alter table public.sub_pay_app_lines  enable row level security;
alter table public.sub_pay_app_checks enable row level security;

drop policy if exists "ahc_read_sub_sov_lines"       on public.sub_sov_lines;
drop policy if exists "ahc_write_sub_sov_lines"      on public.sub_sov_lines;
drop policy if exists "ahc_read_sub_pay_apps"        on public.sub_pay_apps;
drop policy if exists "ahc_write_sub_pay_apps"       on public.sub_pay_apps;
drop policy if exists "ahc_read_sub_pay_app_lines"   on public.sub_pay_app_lines;
drop policy if exists "ahc_write_sub_pay_app_lines"  on public.sub_pay_app_lines;
drop policy if exists "ahc_read_sub_pay_app_checks"  on public.sub_pay_app_checks;
drop policy if exists "ahc_write_sub_pay_app_checks" on public.sub_pay_app_checks;

create policy "ahc_read_sub_sov_lines" on public.sub_sov_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_sub_sov_lines" on public.sub_sov_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_read_sub_pay_apps" on public.sub_pay_apps
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_sub_pay_apps" on public.sub_pay_apps
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_read_sub_pay_app_lines" on public.sub_pay_app_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_sub_pay_app_lines" on public.sub_pay_app_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_read_sub_pay_app_checks" on public.sub_pay_app_checks
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_sub_pay_app_checks" on public.sub_pay_app_checks
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============================== ROLLUP VIEW ==============================
-- Billed-to-date and approved-to-date per subcontractor, for the Subs tab and
-- the cash-out projection. Only apps that are approved or paid count as
-- committed spend; a bill sitting in review is not money out the door.

create or replace view public.v_sub_billing_summary as
select
  s.id                      as subcontractor_id,
  s.project_id,
  s.company_name,
  s.contract_value,
  s.retainage_pct,
  coalesce(sov.sov_total, 0)        as sov_total,
  coalesce(sov.line_count, 0)       as sov_line_count,
  coalesce(sov.unmapped_lines, 0)   as unmapped_lines,
  coalesce(a.apps_received, 0)      as apps_received,
  coalesce(a.billed_to_date, 0)     as billed_to_date,
  coalesce(a.approved_to_date, 0)   as approved_to_date,
  coalesce(a.paid_to_date, 0)       as paid_to_date,
  coalesce(a.retainage_held, 0)     as retainage_held,
  case when coalesce(s.contract_value, 0) > 0
       then round(coalesce(a.approved_to_date, 0) / s.contract_value, 4)
       else null end                as pct_approved
from public.subcontractors s
left join (
  select subcontractor_id,
         sum(scheduled_value) as sov_total,
         count(*)             as line_count,
         count(*) filter (where verification_method = 'unmapped') as unmapped_lines
  from public.sub_sov_lines
  where active
  group by subcontractor_id
) sov on sov.subcontractor_id = s.id
left join (
  select subcontractor_id,
         count(*) as apps_received,
         max(billed_to_date) as billed_to_date,
         sum(coalesce(approved_this_period, 0))
           filter (where status in ('approved','paid')) as approved_to_date,
         sum(coalesce(approved_amount_due, amount_due))
           filter (where status = 'paid') as paid_to_date,
         sum(coalesce(approved_retainage, retainage_this_period))
           filter (where status in ('approved','paid')) as retainage_held
  from public.sub_pay_apps
  group by subcontractor_id
) a on a.subcontractor_id = s.id;
