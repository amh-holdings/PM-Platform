-- 0034_schedule_constraint_log.sql
--
-- The constraint log - the Last Planner System idea that a task is not "ready"
-- until everything blocking it has been cleared, and that the blockers are
-- tracked with an owner and a need-by date rather than remembered.
--
-- The app already knows about several kinds of blocker in isolation: a PO with
-- a delivery date linked to a task (0018), an inspection that has to pass
-- (0021/0024). What it has never had is one list answering "what is stopping
-- this task from starting" with a name against each line.
--
-- Need-by is the date the constraint must be CLEARED, not the date the task
-- starts. Those differ by whatever lead time the answer needs, and the gap is
-- where jobs are lost: a submittal approved the morning work is due to start
-- is a submittal that was late.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

create table if not exists public.schedule_constraints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,

  -- The task this blocks. Text rather than a foreign key, matching how the
  -- rest of the schedule references tasks: WBS codes are the stable handle and
  -- a constraint outliving a task re-import is a feature, not a leak.
  wbs_code text,

  category text not null check (category in (
    'Material',      -- not on site
    'Equipment',     -- crane, dozer, rig not available
    'Labor',         -- crew not available
    'Access',        -- cannot get to the work
    'Permit',        -- agency approval outstanding
    'Design',        -- drawing, detail or RFI answer outstanding
    'Submittal',     -- approval outstanding
    'Inspection',    -- has to pass before the next thing starts
    'Predecessor',   -- upstream work not complete
    'Weather',       -- ground conditions
    'Other'
  )),

  title text not null,
  description text,

  -- Free text, matching schedule_tasks.assigned_to. A constraint owner is
  -- often someone outside the app entirely - the county, a vendor, the owner's
  -- engineer - so requiring a profile row would push exactly the constraints
  -- that matter most out of the log.
  owner text,

  -- The date it has to be CLEARED by, which is upstream of the task start.
  need_by date,

  status text not null default 'open' check (status in (
    'open',
    'in_progress',
    'cleared',
    'wont_clear'   -- accepted as permanent; the plan has to change instead
  )),

  cleared_at timestamptz,
  cleared_by uuid references public.profiles(id),
  resolution text,

  -- Where this came from, so constraints seeded from procurement or QA/QC can
  -- be told apart from ones typed in a planning meeting, and so a seeded one
  -- can be reconciled against its source later.
  source text not null default 'manual' check (source in (
    'manual', 'procurement', 'inspection', 'rfi', 'submittal'
  )),
  source_id uuid,

  created_at timestamptz default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz default now()
);

-- The two queries that actually run: everything open on a project ordered by
-- need-by, and everything hanging off one task.
create index if not exists schedule_constraints_open_idx
  on public.schedule_constraints(project_id, status, need_by);

create index if not exists schedule_constraints_task_idx
  on public.schedule_constraints(project_id, wbs_code);

-- A constraint seeded from a source row must not be seeded twice when the
-- reconcile runs again.
create unique index if not exists schedule_constraints_source_uniq
  on public.schedule_constraints(project_id, source, source_id)
  where source_id is not null;

alter table public.schedule_constraints enable row level security;

drop policy if exists "ahc_read_constraints"   on public.schedule_constraints;
drop policy if exists "ahc_write_constraints"  on public.schedule_constraints;
drop policy if exists "sub_read_constraints"   on public.schedule_constraints;
drop policy if exists "sub_insert_constraints" on public.schedule_constraints;

create policy "ahc_read_constraints" on public.schedule_constraints
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_constraints" on public.schedule_constraints
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Subs read constraints on their own projects. The whole point of the log is
-- that the person doing the work can see what is in their way.
create policy "sub_read_constraints" on public.schedule_constraints
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- And subs can RAISE one. The foreman is the first to know the pipe is not on
-- site; making him phone it in so somebody else types it is how constraints go
-- unlogged. Raise only - clearing stays with AHC.
create policy "sub_insert_constraints" on public.schedule_constraints
  for insert to authenticated
  with check (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and status = 'open'
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

comment on table public.schedule_constraints is
  'Last Planner constraint log. A task is not ready to start until its open constraints are cleared.';
comment on column public.schedule_constraints.need_by is
  'Date the constraint must be CLEARED, which is upstream of the task start by whatever lead time the answer needs.';
