-- Net terms belongs on the milestone, not on the order.
--
-- Zarina, looking at a PO whose summary reads "20% Down Payment, 10%
-- Engineering, 40% Progress payment, 30% upon delivery": "Instead of the
-- summary from the uploaded PO, can you just do it when adding a milestone?"
--
-- She is right, and 0063 put the number one level too high. One PO can carry
-- four milestones on four different clocks: a deposit due on signing with no
-- lag at all, engineering at Net 30, a progress payment at Net 45, delivery
-- at Net 30 from the packing slip. A single number on the order cannot say
-- that, so it either picks one and is wrong three times, or stays blank and
-- the forecast is back to reading prose.
--
-- The order-level column stays as the fallback and as what a fresh milestone
-- is seeded from. It is no longer typed anywhere: the form field moved onto
-- the milestone row, which is the row that actually pays.
--
--   null  not stated on this milestone, so the order's number is used, and
--         failing that the summary is parsed exactly as before
--   0     stated, and it is zero. Paid on the trigger date, no delay
--   N     N days after the trigger
--
-- Apply via Supabase SQL Editor. Safe to re-run. Run 0063 first.

alter table public.procurement_payments
  add column if not exists net_terms_days integer;

alter table public.procurement_payments
  drop constraint if exists procurement_payments_net_terms_days_range;
alter table public.procurement_payments
  add constraint procurement_payments_net_terms_days_range
  check (net_terms_days is null or (net_terms_days >= 0 and net_terms_days <= 365));

comment on column public.procurement_payments.net_terms_days is
  'Days after this milestone''s trigger that payment is due. Null falls back '
  'to procurement_orders.net_terms_days and then to parsing '
  'payment_terms_summary. Zero means stated as zero. Backfilled by 0064.';

-- ---------------------------------------------------------------------------
-- Backfill, so the column arrives already filled in.
--
-- "If a PO is uploaded it will just pre-fill the columns and I will just
-- recheck and save." Same idea for the POs already in the app: every
-- milestone inherits whatever its own order already knows, so the number is
-- visible on the row and can be corrected where it is wrong, rather than
-- being an empty column somebody has to work through.
--
-- Two sources, in order. The order's own column, which 0063 set. Then the
-- summary text, word-bounded so "Internet 30" does not match and capped at
-- 365 so "Net 3000" stays unparsed, in case 0063's backfill could not read a
-- summary that this one can reach the same way.
--
-- Only touches rows still null, so re-running never overwrites a real value.
-- ---------------------------------------------------------------------------

update public.procurement_payments p
set net_terms_days = coalesce(
  o.net_terms_days,
  case
    when o.payment_terms_summary ~* '\mnet\s*[0-9]+'
     and (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365
    then (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
  end
)
from public.procurement_orders o
where p.procurement_order_id = o.id
  and p.net_terms_days is null
  and coalesce(
    o.net_terms_days,
    case
      when o.payment_terms_summary ~* '\mnet\s*[0-9]+'
       and (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365
      then (substring(o.payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
    end
  ) is not null;

notify pgrst, 'reload schema';
