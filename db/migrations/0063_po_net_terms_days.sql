-- Net terms as a number, not a phrase.
--
-- Zarina: "Can you separate the net terms instead? Like add a column for
-- specific net terms then the forcast will draw from that not just on a text
-- field."
--
-- Right. payment_terms_summary is prose off the paper PO: "20% Down Payment,
-- 10% Engineering, 40% Progress payment, 30% upon delivery". The forecast has
-- been reading a regex over it for "net NN", which works until somebody
-- writes "net 30 days from invoice receipt" in a sentence that also says
-- "within 30 days of commissioning", or writes no net at all and silently
-- gets same-day payment. A number that decides when money leaves the bank
-- should be a number.
--
-- The summary stays. It is the human record of what the PO actually says and
-- it is what the AI extraction reads. This column is only the machine answer
-- to one question: how many days after the trigger.
--
--   null  nothing stated, so the forecast falls back to reading the summary
--         exactly as it does today
--   0     stated, and it is zero. Paid on the trigger date, no delay
--   N     N days
--
-- Null and zero are deliberately different. Zero is an answer.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.procurement_orders
  add column if not exists net_terms_days integer;

alter table public.procurement_orders
  drop constraint if exists procurement_orders_net_terms_days_range;
alter table public.procurement_orders
  add constraint procurement_orders_net_terms_days_range
  check (net_terms_days is null or (net_terms_days >= 0 and net_terms_days <= 365));

comment on column public.procurement_orders.net_terms_days is
  'Days after the milestone trigger that payment is due. Null means not '
  'stated, and the forecast falls back to parsing payment_terms_summary. '
  'Zero means stated as zero. Backfilled from the summary by 0063.';

-- ---------------------------------------------------------------------------
-- Backfill, so nobody re-types what is already on record.
--
-- Zarina: "For the PO's that already been filled out correctly, can you just
-- separate them so I dont have to go through them one by one to change."
--
-- Same rule the app has used all along, moved into SQL: the whole run of
-- digits after "net", word-bounded so "Internet 30" does not match, and only
-- 1 to 365 so "Net 3000" stays unparsed rather than quietly becoming a date
-- most of a year out. Anything the regex cannot read is left null, which is
-- exactly what it was before, so nothing is guessed.
--
-- Only touches rows where the column is still null, so re-running this after
-- somebody has typed a real value does not overwrite them.
-- ---------------------------------------------------------------------------

update public.procurement_orders
set net_terms_days = (substring(payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer
where net_terms_days is null
  and payment_terms_summary ~* '\mnet\s*[0-9]+'
  and (substring(payment_terms_summary from '(?i)\mnet\s*([0-9]+)'))::integer between 1 and 365;

notify pgrst, 'reload schema';
