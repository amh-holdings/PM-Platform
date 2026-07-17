-- AHC Solar PM Platform
-- Database schema, Phase 1
--
-- Snapshot of the live schema as of 2026-05-20. This is the structure that
-- already exists in Supabase project sksfyygufnnbzrmneccx; do NOT re-run it
-- against that project (it would conflict). It's tracked here so the schema
-- is reproducible if we ever need to stand up a fresh project, and so RLS
-- policies in policies.sql have a referenceable counterpart.
--
-- Migrations going forward should be added as numbered files under
-- supabase/migrations/ once we set up the Supabase CLI workflow.

-- ============ USERS AND ROLES ============

create type user_role as enum (
  'phil',
  'zarina',
  'ahc_super',
  'sub_pm',
  'sub_foreman',
  'owner',
  'counsel'
);

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text unique not null,
  full_name text,
  phone text,
  role user_role not null default 'sub_foreman',
  subcontractor_id uuid,
  active boolean default true,
  created_at timestamptz default now()
);

-- ============ PROJECTS ============

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text,
  ahc_pm_id uuid references public.profiles(id),
  ahc_super_id uuid references public.profiles(id),
  ntp_date date,
  cod_date date,
  contract_value numeric(14,2),
  zip_code text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  timezone text,
  dc_capacity_mw numeric(10,3),
  module_watts numeric(8,2),
  status text default 'active',
  created_at timestamptz default now()
);

-- ============ SUBCONTRACTORS ============

create table public.subcontractors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  company_name text not null,
  trade text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contract_value numeric(14,2),
  retainage_pct numeric(5,2) default 10.00,
  coi_status text default 'pending',
  w9_status text default 'pending',
  payment_terms text default 'Net 30',
  active boolean default true,
  created_at timestamptz default now()
);

-- ============ WBS / SOV ============

create table public.wbs_sov (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  wbs_code text not null,
  description text not null,
  trade text,
  subcontractor_id uuid references public.subcontractors(id),
  unit text,
  quantity numeric(14,2),
  unit_cost numeric(14,2),
  contract_value numeric(14,2),
  pct_complete_sub numeric(5,2) default 0,
  pct_complete_ahc numeric(5,2) default 0,
  retainage_pct numeric(5,2) default 10.00,
  billed_to_date numeric(14,2) default 0,
  baseline_start date,
  baseline_finish date,
  forecast_start date,
  forecast_finish date,
  actual_start date,
  actual_finish date,
  is_critical_path boolean default false,
  float_days integer,
  created_at timestamptz default now()
);

-- ============ DPRs ============

create type dpr_status as enum ('draft','submitted','approved','returned');

create table public.dprs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  subcontractor_id uuid references public.subcontractors(id),
  foreman_id uuid references public.profiles(id),
  report_date date not null,
  weather_conditions text,
  temp_high numeric(5,2),
  temp_low numeric(5,2),
  crew_count integer,
  total_man_hours numeric(8,2),
  qc_rep_name text,
  work_narrative text,
  equipment_on_site jsonb,
  deliveries jsonb,
  toolbox_topic text,
  toolbox_attendees integer,
  safety_incident boolean default false,
  near_miss boolean default false,
  safety_narrative text,
  delays jsonb,
  status dpr_status default 'draft',
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz default now(),
  unique (project_id, subcontractor_id, report_date)
);

create table public.dpr_quantities (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade,
  wbs_sov_id uuid references public.wbs_sov(id),
  quantity_installed numeric(14,2),
  location_on_site text,
  notes text
);

-- ============ RFIs AND SUBMITTALS ============

create type rfi_status as enum ('open','answered','closed');

create table public.rfis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  rfi_number text,
  wbs_sov_id uuid references public.wbs_sov(id),
  originator_id uuid references public.profiles(id),
  recipient_id uuid references public.profiles(id),
  question text not null,
  response text,
  date_issued date default current_date,
  date_needed date,
  date_answered date,
  status rfi_status default 'open',
  created_at timestamptz default now()
);

create type submittal_status as enum ('pending','approved','approved_as_noted','revise_resubmit','rejected');

create table public.submittals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  spec_section text,
  item_description text not null,
  manufacturer text,
  submitted_by_id uuid references public.profiles(id),
  submitted_date date default current_date,
  reviewed_date date,
  status submittal_status default 'pending',
  notes text,
  file_url text,
  created_at timestamptz default now()
);

-- ============ PHOTOS ============

create type photo_type as enum ('progress','safety','delivery','issue','eod','other');

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  dpr_id uuid references public.dprs(id) on delete set null,
  wbs_sov_id uuid references public.wbs_sov(id),
  uploaded_by_id uuid references public.profiles(id),
  photo_type photo_type default 'progress',
  storage_path text not null,
  caption text,
  taken_at timestamptz,
  created_at timestamptz default now()
);

-- ============ COMMS LOG ============

create type comms_type as enum ('phone','email','meeting','site_visit','text','other');

create table public.comms_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  logged_by_id uuid references public.profiles(id),
  comm_type comms_type not null,
  comm_date timestamptz default now(),
  participants text,
  subject text,
  notes text not null,
  related_wbs_sov_id uuid references public.wbs_sov(id),
  related_rfi_id uuid references public.rfis(id),
  created_at timestamptz default now()
);

-- ============ COST CODES ============
-- AHC's internal cost categories, scoped per project. Example codes:
-- "SSC A-AHC Labor", "SSC B-General Conditions". Change orders are also
-- tracked here with is_change_order=true.

create table public.cost_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  code text not null,
  name text not null,
  description text,
  estimated_cost numeric(14,2),
  actual_cost numeric(14,2) default 0,
  is_change_order boolean default false,
  sort_order integer,
  created_at timestamptz default now(),
  unique (project_id, code)
);

create index cost_codes_project_id_idx on public.cost_codes(project_id);
create index cost_codes_sort_order_idx on public.cost_codes(project_id, sort_order);

-- ============ SCHEDULE TASKS ============
-- Hierarchical task structure for the project schedule. Imported from
-- Smartsheet or entered via the schedule UI. Hierarchy is captured both
-- via parent_wbs_code (closest ancestor in WBS dotted path) and level_code.

create table public.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  wbs_code text not null,
  task_name text not null,
  description text,
  phase text,
  assigned_to text,
  status text,
  duration_days integer,
  start_date date,
  end_date date,
  predecessors text,
  is_at_risk boolean default false,
  is_internal boolean default false,
  non_ahc_delay boolean default false,
  level_code integer,
  sort_order integer,
  parent_wbs_code text,
  source_row_id text,
  created_at timestamptz default now(),
  unique (project_id, wbs_code)
);

create index schedule_tasks_project_id_idx on public.schedule_tasks(project_id);
create index schedule_tasks_phase_idx on public.schedule_tasks(project_id, phase);
create index schedule_tasks_status_idx on public.schedule_tasks(project_id, status);
create index schedule_tasks_sort_idx on public.schedule_tasks(project_id, sort_order);

-- ============ PROJECT DOCUMENTS ============
-- Project-scoped document library. Phase 1 stores files in Supabase Storage
-- (bucket: project-documents) and tracks metadata + extracted text here so
-- the AI Q&A layer can query content without re-parsing PDFs on every call.

create type document_category as enum (
  'prime_contract',
  'amendment',
  'exhibit',
  'subcontract',
  'drawing',
  'spec',
  'submittal',
  'rfi',
  'daily_log',
  'email',
  'other'
);

create type document_text_status as enum (
  'pending',
  'processing',
  'ready',
  'failed',
  'skipped'
);

create table public.project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  uploaded_by_id uuid references public.profiles(id),
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  category document_category not null default 'other',
  description text,
  extracted_text text,
  text_status document_text_status not null default 'pending',
  text_error text,
  pages_count integer,
  uploaded_at timestamptz default now()
);

create index project_documents_project_id_idx on public.project_documents(project_id);
create index project_documents_category_idx on public.project_documents(category);
create index project_documents_text_status_idx on public.project_documents(text_status);

-- ============ ROW LEVEL SECURITY ============

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.subcontractors enable row level security;
alter table public.wbs_sov enable row level security;
alter table public.dprs enable row level security;
alter table public.dpr_quantities enable row level security;
alter table public.rfis enable row level security;
alter table public.submittals enable row level security;
alter table public.photos enable row level security;
alter table public.comms_log enable row level security;
alter table public.project_documents enable row level security;
alter table public.cost_codes enable row level security;
alter table public.schedule_tasks enable row level security;

-- Auto-create profile when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
