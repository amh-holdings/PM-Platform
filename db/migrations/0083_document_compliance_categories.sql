-- Compliance and financial document categories, 2026-11-02.
--
-- Zarina: "add dropdown for Financial Documents like COI, w-9 for each
-- subcontractor". The categories exist nowhere today, so a certificate of
-- insurance goes in as Other and is found by remembering the file name.
--
-- The subcontractors table already carries coi_status and w9_status, set by
-- hand on the sub form. Both read "pending" on nearly every sub, which is what
-- a status field does when nothing forces it to agree with reality. These
-- columns let the document itself carry the answer: which sub it belongs to,
-- and when it stops being valid.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.
--
-- AFTER RUNNING: regenerate the TypeScript types (npm run db:types). The enum
-- values are added to src/lib/database.types.ts by hand in the same commit so
-- the app compiles before the migration lands, and regenerating will produce
-- the same list.

-- ============ ENUM VALUES ============
-- Postgres cannot use a new enum value in the same transaction that adds it,
-- so these run on their own rather than inside a do block.

alter type public.document_category add value if not exists 'coi';
alter type public.document_category add value if not exists 'w9';
alter type public.document_category add value if not exists 'bond';
alter type public.document_category add value if not exists 'lien_waiver';
alter type public.document_category add value if not exists 'invoice';

-- ============ WHO THE DOCUMENT BELONGS TO ============
-- Nullable: most documents are the project's, not a sub's. on delete set null
-- rather than cascade - removing a sub from the project should not silently
-- delete their signed W-9.

alter table public.project_documents
  add column if not exists subcontractor_id uuid
    references public.subcontractors(id) on delete set null;

create index if not exists project_documents_subcontractor_idx
  on public.project_documents(subcontractor_id)
  where subcontractor_id is not null;

-- ============ WHEN IT STOPS BEING VALID ============
-- A COI expires. A W-9 does not, so this stays null on most rows and an
-- expiry check has to treat null as "does not expire", never as "expired".

alter table public.project_documents
  add column if not exists valid_until date;

create index if not exists project_documents_valid_until_idx
  on public.project_documents(valid_until)
  where valid_until is not null;

-- AFTER RUNNING, to see what is on file per sub:
--   select s.company_name, d.category, d.file_name, d.valid_until
--     from public.project_documents d
--     join public.subcontractors s on s.id = d.subcontractor_id
--    where d.project_id = '<project id>'
--    order by s.company_name, d.category;
