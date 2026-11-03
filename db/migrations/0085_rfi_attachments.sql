-- RFI attachments, 2026-11-03.
--
-- Zarina: "add option where we can add photo or we can mark up from the plan
-- sets". An RFI about pile embedment at the swale is a paragraph of text
-- trying to describe something a photo settles in one look, and the engineer's
-- first reply to a text-only RFI is usually a request for the photo.
--
-- ONE COLUMN, NOT A JOIN TABLE. A photo of a cracked pile cap belongs to the
-- RFI that asked about it and to nothing else. schedule_task_documents is a
-- join table because a drawing really does belong to several tasks; an RFI
-- photo does not, and a join table here would be a second thing to keep in
-- step for no gain.
--
-- The file still lands in project_documents, so it shows on the Documents
-- page like every other upload and nothing is hidden inside the RFI log.
--
-- on delete set null, not cascade: deleting an RFI should not silently delete
-- the site photo that went with it. The row stays in the library.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

alter table public.project_documents
  add column if not exists rfi_id uuid
    references public.rfis(id) on delete set null;

create index if not exists project_documents_rfi_idx
  on public.project_documents(rfi_id)
  where rfi_id is not null;

-- AFTER RUNNING, what is attached to each RFI:
--   select r.rfi_number, d.file_name, d.category, d.uploaded_at
--     from public.project_documents d
--     join public.rfis r on r.id = d.rfi_id
--    where d.project_id = '<project id>'
--    order by r.rfi_number, d.uploaded_at;
