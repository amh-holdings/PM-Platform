-- Phase 1: Document library
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run: every statement is idempotent (CREATE IF NOT EXISTS or
-- DROP + CREATE for policies).

-- ============ ENUMS ============

do $$ begin
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
exception when duplicate_object then null; end $$;

do $$ begin
  create type document_text_status as enum (
    'pending',
    'processing',
    'ready',
    'failed',
    'skipped'
  );
exception when duplicate_object then null; end $$;

-- ============ TABLE ============

create table if not exists public.project_documents (
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

create index if not exists project_documents_project_id_idx
  on public.project_documents(project_id);
create index if not exists project_documents_category_idx
  on public.project_documents(category);
create index if not exists project_documents_text_status_idx
  on public.project_documents(text_status);

alter table public.project_documents enable row level security;

-- ============ TABLE POLICIES ============

drop policy if exists "ahc_read_documents"  on public.project_documents;
drop policy if exists "ahc_write_documents" on public.project_documents;

create policy "ahc_read_documents" on public.project_documents
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_documents" on public.project_documents
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ STORAGE BUCKET POLICIES ============
-- The bucket itself must be created via the Supabase dashboard:
--   Name: project-documents
--   Public: No
--   File size limit: 50 MB
-- After it exists, these policies on storage.objects gate access.

drop policy if exists "ahc_read_document_objects"   on storage.objects;
drop policy if exists "ahc_write_document_objects"  on storage.objects;
drop policy if exists "ahc_update_document_objects" on storage.objects;
drop policy if exists "ahc_delete_document_objects" on storage.objects;

create policy "ahc_read_document_objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-documents'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );

create policy "ahc_write_document_objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-documents'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );

create policy "ahc_update_document_objects" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-documents'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  )
  with check (
    bucket_id = 'project-documents'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );

create policy "ahc_delete_document_objects" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-documents'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );
