-- Documents that belong to the owner side, 2026-11-11.
--
-- Phil: "Can you add option to set as invoice to Owner?" The Sub column on
-- the Documents page could say which subcontractor an invoice is from, and
-- nothing else, so our own pay applications to the owner (IBT's Pay App #03
-- to Dimension) sat as "Not assigned" next to the subs' bills.
--
-- owner_invoice marks the file as owner billing. pay_application_id, when
-- set, says which AFP it is. A document is a sub's or the owner's, never
-- both: the app clears one when it sets the other.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.project_documents
  add column if not exists owner_invoice boolean not null default false;

alter table public.project_documents
  add column if not exists pay_application_id uuid
    references public.pay_applications(id) on delete set null;

create index if not exists project_documents_pay_application_idx
  on public.project_documents(pay_application_id)
  where pay_application_id is not null;
