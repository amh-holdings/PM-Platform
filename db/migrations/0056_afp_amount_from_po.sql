-- 0056: the amount a PO puts on the AFP is typed, not derived.
--
-- 0055 gave a purchase order two milestone schedules, one per party, so the
-- owner could be billed on different terms than the vendor is paid. It worked,
-- and it asked whoever raises the PO to write down a second agreement before
-- anything could be billed. That is a lot of setup for a number somebody
-- already knows when they assemble the AFP.
--
-- So the PO keeps one schedule, the vendor's, and an Add to AFP button on the
-- PO takes the amount directly. The typed figure lands on billing_entries as a
-- normal forecast row against the SOV line the PO is allocated to, and the
-- Bill this period panel shows it ready to tick like any other row.
--
-- Two columns carry that:
--
--   amount_is_manual  a person set this figure, so leave it alone. Procurement
--                     lines otherwise have their amount recomputed from PO
--                     payment milestones on every read, which would overwrite
--                     the typed number the moment the page reloaded.
--
--   source_procurement_order_id  which PO the figure came from, so the panel
--                     and any later audit can say where it originated.
--
-- Existing rows are not manual, which is what they have always been, so
-- nothing moves on the day this runs.

alter table public.billing_entries
  add column if not exists amount_is_manual boolean not null default false;

alter table public.billing_entries
  add column if not exists source_procurement_order_id uuid
    references public.procurement_orders(id) on delete set null;

comment on column public.billing_entries.amount_is_manual is
  'true = a person typed this amount (Add to AFP on a PO, or the amount box on the billing panel). Read paths must not recompute it.';
comment on column public.billing_entries.source_procurement_order_id is
  'The PO whose Add to AFP button produced this row, when that is where it came from.';

create index if not exists billing_entries_source_po_idx
  on public.billing_entries(source_procurement_order_id);
