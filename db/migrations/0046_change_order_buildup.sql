-- Change order cost buildup, per-line backup documents, and full workflow.
--
-- Three things this adds, driven by the Sweet Springs / Dimension Energy
-- "Exhibit H - Form of Change Order":
--
--   1. A real cost buildup. Today a CO carries a single lump cost_amount and
--      one blanket profit_pct. Now each CO has N cost lines (labor, material,
--      equipment, subcontractor, ...) with qty x unit cost and an optional
--      per-line markup that falls back to the CO default. The CO's
--      cost_amount / co_value become roll-ups of those lines.
--
--   2. Backup documentation attached to each cost line. A sub or vendor quote
--      hangs off the line it prices. Files live in the EXISTING private
--      'project-documents' bucket under a change-orders/<co_id>/ prefix, so
--      no new bucket has to be created in the Supabase dashboard - the
--      bucket-wide policies from migration 0001 already cover it.
--
--   3. The full workflow. draft -> internal_review -> submitted ->
--      approved | rejected (or void), every transition stamped in
--      change_order_events. Only an approved CO adds to contract value and
--      earns an SOV line on the next AFP.
--
-- Also adds the project-level fields Exhibit H needs but the schema never
-- held: the ORIGINAL contract price (projects.contract_value tracks the
-- current one), the agreement date, and the two guaranteed completion dates
-- the form adjusts.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ PROJECT: EXHIBIT H HEADER FIELDS ============

alter table public.projects
  add column if not exists agreement_date date,
  add column if not exists original_contract_value numeric(14,2),
  add column if not exists guaranteed_mechanical_completion_date date,
  add column if not exists guaranteed_substantial_completion_date date,
  add column if not exists contractor_legal_name text,
  add column if not exists contractor_signatory_name text,
  add column if not exists contractor_signatory_title text;

comment on column public.projects.original_contract_value is
  'Exhibit H line 1. The contract price at execution, before any CO. '
  'projects.contract_value is the CURRENT price and moves as COs are approved.';

-- ============ CHANGE ORDERS: WORKFLOW + FORM NARRATIVE ============

alter table public.change_orders
  add column if not exists date_of_change_order date,
  add column if not exists reason text,
  add column if not exists mech_completion_delta_days integer,
  add column if not exists subst_completion_delta_days integer,
  add column if not exists exhibit_e_impact text,
  add column if not exists capacity_ratio_impact text,
  add column if not exists design_basis_impact text,
  add column if not exists other_impacts text,
  add column if not exists bond_pct numeric(5,2),
  add column if not exists tax_pct numeric(5,2),
  add column if not exists internal_review_at date,
  add column if not exists rejected_at date,
  add column if not exists voided_at date,
  add column if not exists billing_line_id uuid
    references public.billing_lines(id) on delete set null;

comment on column public.change_orders.billing_line_id is
  'The single SOV line this CO owns once approved. One CO = one line on the '
  'G703, per AHC practice. Created automatically on approval.';

-- Existing rows predate the wider status vocabulary, so normalize before the
-- constraint lands.
--
-- Case first, and deliberately. ceo-report-financials.ts lowercases status
-- before comparing it, which means the live table may well hold 'Approved'.
-- A blunt "anything unrecognized becomes draft" would silently pull those COs
-- out of the contract value and off the SOV. So: trim and lowercase everything
-- first, and only then reset what is genuinely unknown.
update public.change_orders
   set status = lower(trim(status))
 where status is not null
   and status <> lower(trim(status));

update public.change_orders
   set status = 'draft'
 where status is null
    or status not in ('draft','internal_review','submitted','approved','rejected','void');

-- Say out loud whether anything was reset, so an unexpected status value is
-- noticed now rather than discovered as a missing change order later.
do $$
declare
  reset_count integer;
begin
  select count(*) into reset_count
    from public.change_orders
   where status = 'draft' and approved_at is not null;
  if reset_count > 0 then
    raise notice 'HEADS UP: % change order(s) are now draft but still carry an approved_at date. Check them.', reset_count;
  end if;
end $$;

alter table public.change_orders
  drop constraint if exists change_orders_status_check;
alter table public.change_orders
  add constraint change_orders_status_check
  check (status in ('draft','internal_review','submitted','approved','rejected','void'));

-- Legacy COs already point at their SOV line the other way round, through
-- billing_lines.change_order_id. Adopt that link so approving one of them
-- again updates the existing line instead of creating a second one. COs that
-- carry several lines from the old many-lines-per-CO model are left alone
-- rather than guessed at.
update public.change_orders co
   set billing_line_id = single.id
  from (
    -- array_agg rather than min(): Postgres has no min() for uuid. The
    -- having clause already restricts this to groups of exactly one row, so
    -- taking the first element is taking the only element.
    select change_order_id, (array_agg(id))[1] as id
      from public.billing_lines
     where change_order_id is not null
     group by change_order_id
    having count(*) = 1
  ) as single
 where co.id = single.change_order_id
   and co.billing_line_id is null;

-- ============ COST BUILDUP LINES ============

create table if not exists public.change_order_cost_lines (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid references public.change_orders(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  sort_order integer,
  category text not null default 'other',
  description text not null,
  vendor_name text,
  quantity numeric(14,4) not null default 1,
  unit text,
  unit_cost numeric(14,4) not null default 0,
  extended_cost numeric(16,4) generated always as (quantity * unit_cost) stored,
  -- null means "use the CO's profit_pct". A value here overrides it, which is
  -- how a 5% pass-through on a sub quote sits next to 10% on self-perform.
  markup_pct numeric(5,2),
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  notes text,
  created_at timestamptz default now()
);

create index if not exists co_cost_lines_co_idx
  on public.change_order_cost_lines(change_order_id, sort_order);
create index if not exists co_cost_lines_project_idx
  on public.change_order_cost_lines(project_id);

alter table public.change_order_cost_lines
  drop constraint if exists co_cost_lines_category_check;
alter table public.change_order_cost_lines
  add constraint co_cost_lines_category_check
  check (category in ('labor','material','equipment','subcontractor','freight','other'));

alter table public.change_order_cost_lines enable row level security;
drop policy if exists "ahc_read_co_cost_lines"  on public.change_order_cost_lines;
drop policy if exists "ahc_write_co_cost_lines" on public.change_order_cost_lines;
create policy "ahc_read_co_cost_lines" on public.change_order_cost_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_co_cost_lines" on public.change_order_cost_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ BACKUP DOCUMENTATION ============

create table if not exists public.change_order_attachments (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid references public.change_orders(id) on delete cascade not null,
  -- null = backup for the CO as a whole (owner directive, RFI, cover letter).
  -- set  = backup for one cost line (the quote that prices it).
  cost_line_id uuid references public.change_order_cost_lines(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade not null,
  kind text not null default 'quote',
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  description text,
  uploaded_by_id uuid references public.profiles(id),
  uploaded_at timestamptz default now()
);

create index if not exists co_attachments_co_idx
  on public.change_order_attachments(change_order_id);
create index if not exists co_attachments_line_idx
  on public.change_order_attachments(cost_line_id);

alter table public.change_order_attachments
  drop constraint if exists co_attachments_kind_check;
alter table public.change_order_attachments
  add constraint co_attachments_kind_check
  check (kind in ('quote','ticket','photo','rfi','directive','drawing','other'));

alter table public.change_order_attachments enable row level security;
drop policy if exists "ahc_read_co_attachments"  on public.change_order_attachments;
drop policy if exists "ahc_write_co_attachments" on public.change_order_attachments;
create policy "ahc_read_co_attachments" on public.change_order_attachments
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_co_attachments" on public.change_order_attachments
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- No new storage bucket. Files go to the private 'project-documents' bucket
-- created in migration 0001 under change-orders/<change_order_id>/<uuid>-<name>.
-- Its storage.objects policies are bucket-wide, so they already apply.

-- ============ WORKFLOW HISTORY ============

create table if not exists public.change_order_events (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid references public.change_orders(id) on delete cascade not null,
  from_status text,
  to_status text not null,
  note text,
  actor_id uuid references public.profiles(id),
  created_at timestamptz default now()
);

create index if not exists co_events_co_idx
  on public.change_order_events(change_order_id, created_at desc);

alter table public.change_order_events enable row level security;
drop policy if exists "ahc_read_co_events"  on public.change_order_events;
drop policy if exists "ahc_write_co_events" on public.change_order_events;
create policy "ahc_read_co_events" on public.change_order_events
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_co_events" on public.change_order_events
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
