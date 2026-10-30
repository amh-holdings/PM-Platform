-- 0082_sub_bills_by_invoice.sql
-- Some subs, engineering firms mostly, send an invoice and no pay application.
-- For them a bill is the invoice put on the SOV line it covers, and the check
-- is that the invoice and the lines agree, not that a G702 ties to a G703.

alter table public.subcontractors
  add column if not exists bills_by_invoice boolean not null default false;

comment on column public.subcontractors.bills_by_invoice is
  'Sends an invoice only, no G702/G703. Each bill is the invoice put on the SOV line it covers.';
