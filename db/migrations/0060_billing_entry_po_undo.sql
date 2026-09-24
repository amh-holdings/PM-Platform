-- Undoing an Add to AFP without destroying what was there before it.
--
-- Zarina: "I already added this to AFP. should say added and I would not be
-- able to add again unless I undo. So once add, there should be an undo
-- button."
--
-- Taking a PO back off a line is easy while other POs remain: drop that
-- contribution, re-sum the rest. The hard case is the last one, because the
-- billing_entries row underneath may have existed before anybody typed
-- anything - an imported cash-flow forecast that staging wrote over. Deleting
-- it would be a fresh way to lose a figure silently, which is the whole class
-- of bug this work has been closing.
--
-- So each contribution records what it displaced. Undo restores it.
--
-- Apply via Supabase SQL Editor, after 0059. Safe to re-run.

alter table public.billing_entry_po_amounts
  add column if not exists created_entry boolean not null default false;

alter table public.billing_entry_po_amounts
  add column if not exists prior_planned_amount numeric(14,2);

comment on column public.billing_entry_po_amounts.created_entry is
  'This staging created the billing_entries row. Undoing the last contribution deletes it.';
comment on column public.billing_entry_po_amounts.prior_planned_amount is
  'What the entry carried before this staging displaced it. Restored on undo when this was the only contribution.';

notify pgrst, 'reload schema';
