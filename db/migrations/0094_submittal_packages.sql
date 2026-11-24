-- Submittal packages: cover + documents merged, saved to Drive, 2026-11-24.
--
-- "If I upload a submittal in that exhibit s, it will automatically fill in
-- the cover page and merge them together and save it to the right folder in
-- drive." Each revision keeps the PDF that went out (a Documents row,
-- category submittal); the submittal keeps the merged package and where it
-- landed in Drive. The project keeps the Drive folder its submittals go to.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.project_deliverable_revisions
  add column if not exists document_id uuid references public.project_documents(id) on delete set null;

alter table public.project_submittals
  add column if not exists package_document_id uuid references public.project_documents(id) on delete set null,
  add column if not exists drive_file_id text,
  add column if not exists drive_url text,
  add column if not exists package_built_at timestamptz;

alter table public.projects add column if not exists submittal_drive_folder_id text;
