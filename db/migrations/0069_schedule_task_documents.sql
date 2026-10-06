-- 0069_schedule_task_documents.sql
--
-- Lets a document hang off the schedule task it governs.
--
-- project_documents today has project_id and a category and nothing else, so
-- the Lafayette County E&S approval letter and the task it unlocks
-- (5.1.2.5 Full Site Clearing, gated on 5.1.1.11 County Inspection) have no
-- connection in the database. Finding the letter means scrolling the library
-- and recognising the file name, which is the lookup that gets skipped when
-- somebody is trying to answer "are we allowed to clear yet".
--
-- A JOIN TABLE rather than a column, for two reasons:
--
--   Many to many. One drawing covers a dozen tasks. Sheet C-301 is Basin 1
--   grading AND Basin 1 final grading AND the pond conversion. A single
--   schedule_task_id on project_documents would force a copy of the file per
--   task, and then the library has four rows that are the same PDF.
--
--   It leaves project_documents alone. The file stays one row in the library,
--   in the project-documents bucket, under the existing RLS and the existing
--   text-extraction pipeline. This migration adds a pointer and nothing else -
--   same principle as subcontractors.document_id (0048) and
--   procurement_orders.document_id (0011).
--
-- Keyed on schedule_task_id, NOT wbs_code. This is the one place this codebase
-- deliberately departs from its neighbours: billing_lines.linked_task_wbs_codes
-- and cost codes both hold WBS codes as plain text, and every structural edit
-- carries a warning that they dangle (see SCHEDULE-EDITING.md). Indent,
-- outdent and the importer all renumber codes. A document link that broke on
-- an indent would be a link nobody could trust, and unlike a billing line
-- there is no reason to accept that: a task has a stable id, so use it.
--
-- on delete cascade on both sides. Deleting the task should not leave a link
-- to nothing, and deleting the PDF from the library should not leave a link to
-- a file that is gone. Neither cascade can reach the other table's ROW - only
-- this join row - so removing a drawing cannot delete a schedule task.
--
-- Apply via the Supabase SQL editor. Additive and safe to re-run.

create table if not exists public.schedule_task_documents (
  id uuid primary key default gen_random_uuid(),
  schedule_task_id uuid not null
    references public.schedule_tasks(id) on delete cascade,
  document_id uuid not null
    references public.project_documents(id) on delete cascade,
  -- Denormalised so RLS and the project-scoped reads do not have to join two
  -- tables to find out which project a link belongs to. Enforced by trigger
  -- below rather than trusted from the client.
  project_id uuid not null
    references public.projects(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  -- The same document attached twice to one task is not a second attachment.
  unique (schedule_task_id, document_id)
);

create index if not exists schedule_task_documents_task_idx
  on public.schedule_task_documents(schedule_task_id);
create index if not exists schedule_task_documents_doc_idx
  on public.schedule_task_documents(document_id);
create index if not exists schedule_task_documents_project_idx
  on public.schedule_task_documents(project_id);

-- project_id must be the task's own project, and the document must belong to
-- that same project. Without this a link could be written that joins a task on
-- one job to a drawing on another, and the project-scoped read would then show
-- a document from a different client's site.
create or replace function public.schedule_task_documents_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  task_project uuid;
  doc_project uuid;
begin
  select project_id into task_project
    from public.schedule_tasks where id = new.schedule_task_id;
  select project_id into doc_project
    from public.project_documents where id = new.document_id;

  if task_project is null then
    raise exception 'schedule task % does not exist', new.schedule_task_id;
  end if;
  if doc_project is null then
    raise exception 'document % does not exist', new.document_id;
  end if;
  if task_project <> doc_project then
    raise exception 'document belongs to project %, task belongs to project %',
      doc_project, task_project;
  end if;

  -- Authoritative, so the client cannot set it wrong.
  new.project_id := task_project;
  return new;
end;
$$;

drop trigger if exists schedule_task_documents_check_trg
  on public.schedule_task_documents;
create trigger schedule_task_documents_check_trg
  before insert or update on public.schedule_task_documents
  for each row execute function public.schedule_task_documents_check();

alter table public.schedule_task_documents enable row level security;

drop policy if exists "ahc_read_task_documents"  on public.schedule_task_documents;
drop policy if exists "ahc_write_task_documents" on public.schedule_task_documents;

-- Read and write follow the Schedule tab's own audience. Phil and the CM see
-- the schedule; subs do not (roles.ts `viewSchedule`), so there is no sub
-- policy here and a sub cannot read these rows at all. That is deliberate: the
-- documents a task governs include permits and contract exhibits, and the
-- library they come from is already closed to subs.
create policy "ahc_read_task_documents" on public.schedule_task_documents
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_task_documents" on public.schedule_task_documents
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

comment on table public.schedule_task_documents is
  'Documents attached to a schedule task. Many to many: one drawing covers many tasks. '
  'Keyed on schedule_task_id rather than wbs_code so indent, outdent and the importer cannot orphan a link.';
comment on column public.schedule_task_documents.project_id is
  'Denormalised from the task, set by trigger. Never trusted from the client.';
