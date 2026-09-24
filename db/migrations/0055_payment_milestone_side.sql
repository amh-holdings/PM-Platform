-- 0055: one purchase order, two payment schedules.
--
-- procurement_payments has been doing two jobs at once. It is the vendor's
-- payment terms, which drive cash out on the forecast. It is also what
-- estimateProcurementProgress treats as earned, which drives what the owner
-- can be billed on the AFP.
--
-- Those are two agreements with two different parties and no reason to match.
-- PO-022 is the case in point: the vendor gets 50% deposit and 50% on
-- delivery, while the owner is billed 50% of the PO total the moment the PO
-- goes out, whatever the vendor terms say.
--
-- So every milestone row now names its side. Existing rows are vendor rows,
-- which is what they have always been, so nothing moves on the day this runs.
--
-- Read paths treat a missing or unknown side as 'vendor', so the app behaves
-- exactly as it does today until owner rows are actually added, PO by PO.

alter table public.procurement_payments
  add column if not exists side text not null default 'vendor';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'procurement_payments_side_check'
  ) then
    alter table public.procurement_payments
      add constraint procurement_payments_side_check
      check (side in ('vendor', 'owner'));
  end if;
end $$;

comment on column public.procurement_payments.side is
  'vendor = what we pay the supplier, drives cash out. owner = what we bill the owner through the AFP. Independent of each other.';

-- Both sides are read per PO and filtered by side on every page that touches
-- them, so the index carries the column.
create index if not exists procurement_payments_order_side_idx
  on public.procurement_payments(procurement_order_id, side);
