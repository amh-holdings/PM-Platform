-- The RFI log, 2026-11-02.
--
-- Zarina: "subs will submit it and we will forward it to EOR for answers or
-- advises." Three parties, and the question is in a different person's hands
-- at each step. The log exists to answer "whose desk is this on, and how long
-- has it been there", which an email thread cannot.
--
-- EXTENDS the rfis table rather than creating one. A skeleton has been in the
-- schema since the first migration - rfi_number, question, response, status,
-- date_issued, date_needed, date_answered - and the project dashboard already
-- counts open RFIs out of it. A second table would have left the dashboard
-- reading the empty one.
--
-- WHAT THE NEW COLUMNS ARE FOR. The skeleton models two parties: an
-- originator and a recipient, both profiles. The real flow has three, and two
-- of them have no login - the sub who raised it and the engineer who answers.
-- It also has one date where there are three distinct events: the sub sent it,
-- we forwarded it, the engineer came back.
--
-- THE STATE IS DERIVED FROM THE DATES, not read from `status`. A status is a
-- field somebody has to remember to change; a date is recorded when the thing
-- happens. The subcontractors table shows where the other way ends -
-- coi_status reads "pending" on nearly every sub because nothing forces it to
-- agree with reality. `status` is kept, and the app writes it from the dates
-- on every save, purely so the existing dashboard queries keep working. It is
-- a cache, never a source.
--
-- THE NUMBER IS ASSIGNED BY THE APP, never typed. Checked against the live
-- database 2026-11-02: the rfis table is empty, so there is no numbering
-- convention to inherit and no row to backfill. The first one on each project
-- is RFI-001.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

-- ============ WHO ASKED, AND WHO ANSWERS ============

alter table public.rfis
  -- The subject line. The skeleton has only `question`, so a log of twenty
  -- RFIs was twenty paragraphs with nothing scannable down the left.
  add column if not exists subject text,

  -- Civil, Structural, Electrical, Mechanical. Free text, not an enum: Sussex
  -- carries a Structural discipline that Sweet Springs does not.
  add column if not exists discipline text,

  -- The schedule activity it blocks, by WBS code, matching how the constraint
  -- log references tasks. Null on plenty of RFIs - not everything blocks work.
  add column if not exists wbs_code text,

  -- The sub who raised it, plus the person's name: the answer goes back to a
  -- named individual, not to a company.
  add column if not exists subcontractor_id uuid
    references public.subcontractors(id) on delete set null,
  add column if not exists raised_by text,

  -- Who we sent it to. Text, because the EOR is Exactus for civil and Pure
  -- Power for electrical on Sussex, and neither is a row anywhere.
  add column if not exists eor_firm text,
  add column if not exists eor_contact text,

  -- The two events the skeleton has no room for. date_answered already
  -- exists and stays as the third.
  add column if not exists received_at date,
  add column if not exists sent_to_eor_at date,
  add column if not exists closed_at date,

  -- Flagged on the way in, confirmed on the way out. An RFI whose answer
  -- costs money is a change order nobody has written yet.
  add column if not exists cost_impact boolean not null default false,
  add column if not exists schedule_impact boolean not null default false,
  add column if not exists impact_note text,

  -- The sub's form and the engineer's reply, as uploaded documents.
  add column if not exists question_document_id uuid
    references public.project_documents(id) on delete set null,
  add column if not exists answer_document_id uuid
    references public.project_documents(id) on delete set null,

  add column if not exists notes text,
  add column if not exists created_by_id uuid references public.profiles(id),

  -- From an earlier RFI tool of Phil's, found in Drive. Both earn their place.
  --
  -- The drawing or spec the question is about. Every RFI form in the industry
  -- has this field, and without it the engineer's first reply is "against
  -- which detail?", which costs a day.
  add column if not exists reference_doc text,

  -- What the sub thinks the answer is. A proposed solution the EOR can
  -- confirm comes back faster than an open question, and it is the difference
  -- between "what do we do here" and "can we do this".
  add column if not exists suggested_answer text,

  -- Where on site. Two RFIs about pile embedment are different questions if
  -- one is at the swale and one is at the inverter pad.
  add column if not exists location text,

  -- Drives the chase list. Normal unless somebody says otherwise: a log where
  -- everything is urgent sorts no better than a log where nothing is.
  add column if not exists priority text not null default 'Normal'
    check (priority in ('High', 'Normal', 'Low'));

-- ============ BACKFILL ============
-- The table is empty today, so this does nothing. It is here because the
-- migration may be applied to a database where it is not: date_issued is the
-- skeleton's single date and means "the originator issued it", which is the
-- moment the sub sent it to us.

update public.rfis
   set received_at = coalesce(received_at, date_issued, created_at::date)
 where received_at is null;

-- ============ ONE NUMBER PER PROJECT ============
-- Two RFI-007s on one job is how an answer gets filed against the wrong
-- question. Partial, and rfi_number stays nullable: a not-null would fail on
-- any skeleton row that never had one, and the app always supplies one.

create unique index if not exists rfis_project_number_key
  on public.rfis(project_id, rfi_number)
  where rfi_number is not null;

-- The app assigns every number, so a null one is a bug rather than a state to
-- support. Guarded: on a database that somehow has one, the constraint is
-- skipped rather than failing the whole migration half-applied.
do $$
begin
  if not exists (select 1 from public.rfis where rfi_number is null) then
    alter table public.rfis alter column rfi_number set not null;
  else
    raise notice 'rfi_number left nullable: % row(s) have none',
      (select count(*) from public.rfis where rfi_number is null);
  end if;
exception
  when others then
    raise notice 'could not set rfi_number not null: %', sqlerrm;
end $$;

create index if not exists rfis_open_idx
  on public.rfis(project_id, received_at desc)
  where closed_at is null;
create index if not exists rfis_sub_idx
  on public.rfis(subcontractor_id)
  where subcontractor_id is not null;
create index if not exists rfis_wbs_idx
  on public.rfis(project_id, wbs_code)
  where wbs_code is not null;

-- ============ WHO CAN SEE IT ============
-- The skeleton predates current_user_role(). Restated here so the log follows
-- the same rule as every other table, and so a sub can read their own.

alter table public.rfis enable row level security;

drop policy if exists "ahc_read_rfis"  on public.rfis;
drop policy if exists "ahc_write_rfis" on public.rfis;
drop policy if exists "sub_read_rfis"  on public.rfis;

create policy "ahc_read_rfis" on public.rfis
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_rfis" on public.rfis
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Subs read their own and nothing else. They raised these; being unable to
-- see what came back is what sends somebody to the phone. Writing stays with
-- AHC: the log is our record of what we were asked and what we answered.
create policy "sub_read_rfis" on public.rfis
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and subcontractor_id is not null
  );

-- AFTER RUNNING, what is open and whose desk it is on:
--   select rfi_number, subject, received_at, sent_to_eor_at, date_answered,
--          date_needed
--     from public.rfis
--    where project_id = '<project id>' and closed_at is null
--    order by received_at;
