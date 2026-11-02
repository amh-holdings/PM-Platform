-- Account-level business development: relationship stage, next step and next
-- touch on every client, so the weekly AHC solar tracker (Luke's "Business
-- Development" tab) can live in the platform. Planned with Phil 2026-10-28.
--
-- 0074 tracks bids: a follow-up date per opportunity. Most of AHC's BD work is
-- earlier than a bid - intro emails, SOQs, prequal - and that lives on the
-- client. The stage list is the tracker's dropdown, so Luke and Shannon keep
-- the vocabulary they already use.
--
-- owner_name is a stopgap: Luke and Shannon have no logins yet, so owner_id
-- cannot point at them. When their accounts exist, backfill owner_id from
-- owner_name and drop the name.
--
-- Rule the database holds, like 0074's open-bid rule: an account still being
-- pursued always carries a next touch date.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.bd_companies
  add column if not exists relationship_stage text not null default 'not_contacted',
  add column if not exists tier text not null default 'prospect',
  add column if not exists owner_name text,
  add column if not exists next_step text,
  add column if not exists next_touch_date date;

alter table public.bd_companies drop constraint if exists bd_companies_relationship_stage_check;
alter table public.bd_companies add constraint bd_companies_relationship_stage_check
  check (relationship_stage in (
    'not_contacted', 'contacted', 'in_conversation', 'quals_sent',
    'meeting_held', 'bid_proposal', 'active_client', 'not_pursuing'
  ));

alter table public.bd_companies drop constraint if exists bd_companies_tier_check;
alter table public.bd_companies add constraint bd_companies_tier_check
  check (tier in ('active', 'prospect'));

-- The four clients created by the 2026 bid import predate these columns.
update public.bd_companies
  set next_touch_date = current_date
  where next_touch_date is null and relationship_stage <> 'not_pursuing';

alter table public.bd_companies drop constraint if exists bd_account_needs_next_touch;
alter table public.bd_companies add constraint bd_account_needs_next_touch
  check (relationship_stage = 'not_pursuing' or next_touch_date is not null);

create index if not exists bd_companies_next_touch_idx on public.bd_companies (next_touch_date);
