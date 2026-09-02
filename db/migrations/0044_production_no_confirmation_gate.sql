-- 0044_production_no_confirmation_gate.sql
--
-- Retire the confirmation gate on daily_production.
--
-- WHAT 0040 GOT WRONG
-- 0040 made an approved Field Report propose its day's production, then held
-- those rows out of billing and out of the owner's sheet until Phil clicked
-- "Confirm" on the tracker. That treated the Commodity Tracker as a second
-- approval step sitting on top of the CM's approval. It is not one. The tracker
-- REPORTS the approved field record; it does not decide what gets billed. The
-- CM approving the report is the approval, and the day's production follows
-- from it.
--
-- What the gate actually produced: every approved day since the proposer went
-- live read as zero production to the owner and to bill verification, because
-- an unclicked button is indistinguishable from no work having happened. That
-- is the exact failure 0040 was written to fix, reintroduced one layer up.
--
-- WHAT REPLACES IT
-- Nothing. Rows land confirmed. `source` and `proposal_basis` still record who
-- produced each figure and how it was reached, so the audit trail is intact and
-- the tracker still shows the reasoning behind an auto-filled number. Phil
-- corrects a wrong figure by typing over it, which is a correction rather than
-- an approval, and that correction becomes source = 'manual'.
--
-- Provenance now changes exactly one behaviour, in application code rather than
-- here: loadConfirmedHistory calibrates the proposer's daily rate from
-- 'manual' and 'backfill' rows only. Letting the proposer calibrate off its own
-- output would let one estimate justify the next.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- Every row still sitting unconfirmed is production from a Field Report a CM
-- already approved. It has been invisible to billing and to the owner's weekly
-- report since it was written. Bring it live.
--
-- confirmed_by is deliberately left null: no person reviewed these, and
-- stamping Phil's id would invent an audit record for a review that never
-- happened. Same reasoning as 0040's note on the backfilled rows.
update public.daily_production
   set confirmed_at = coalesce(updated_at, created_at, now())
 where confirmed_at is null;

-- The partial index existed to answer "what is waiting on Phil". Nothing waits
-- on Phil any more, so it indexes an empty set on every project forever.
drop index if exists public.daily_production_unconfirmed_idx;
