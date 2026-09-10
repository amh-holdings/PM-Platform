-- 0048_subcontractor_document.sql
--
-- Puts the executed subcontract on the subcontractor record.
--
-- Today the only way to find a sub's contract is to scroll the project
-- Documents library and recognize the file name, which is exactly the kind of
-- lookup that gets skipped when someone is trying to answer "what did we
-- actually agree to pay them" during a bill review.
--
-- This mirrors procurement_orders.document_id (0011) rather than inventing a
-- second attachment mechanism: the file is still one row in
-- project_documents, still in the project-documents bucket, still under the
-- existing RLS and the existing text-extraction pipeline. The only new thing
-- is a pointer, so the subcontract keeps showing up in the Documents library
-- under the "subcontract" category AND hangs off the sub.
--
-- One document per sub, deliberately. Amendments and exhibits belong in the
-- Documents library alongside it; this column answers "which file is THE
-- contract", and a list would blur that.
--
-- on delete set null, not cascade: deleting the PDF from the library should
-- unlink the sub, never delete the subcontractor row.
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table public.subcontractors
  add column if not exists document_id uuid
    references public.project_documents(id) on delete set null;

create index if not exists subcontractors_document_id_idx
  on public.subcontractors(document_id);

comment on column public.subcontractors.document_id is
  'The executed subcontract, as a row in project_documents. Set by the upload control on the Subcontractors page.';
