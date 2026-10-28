-- 0080_email_updates.sql
--
-- Every change the email automation makes or wants to make, one row each.
--
-- Phil wants Sussex kept current from email: a permit issued, a page turn
-- held, a sub's pay app received. Email is untrusted input, so nothing it
-- carries reaches a project record without a row here first. A row holds the
-- source email, the record it matched, what it changes, and what the record
-- looked like before - so every change can be traced back and undone.
--
-- Two ways in:
--   auto_applied = true   the sweep already made the change (status 'applied')
--                         and Zarina or Phil can undo it.
--   auto_applied = false  the sweep proposes it (status 'proposed') and
--                         Zarina or Phil approves or rejects it.
-- requires_phil marks the carve-outs only Phil decides: percent complete,
-- owner disputes, change orders.
--
-- Only phil and zarina read or write. Proposals go to the two of them, not to
-- the site team. The sweep writes with the service role, which RLS does not
-- apply to.
--
-- Apply via the runner (npm run db:migrate) or the Supabase SQL Editor.
-- Safe to re-run.

create table if not exists public.email_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  kind text not null,
  status text not null default 'proposed',
  auto_applied boolean not null default false,
  requires_phil boolean not null default false,
  summary text not null,
  target_table text,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  undo_data jsonb,
  match_reason text,
  source_message_id text not null,
  source_url text,
  source_from text,
  source_subject text,
  source_received_at timestamptz,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  undone_by uuid references public.profiles(id),
  undone_at timestamptz,
  created_at timestamptz default now(),
  constraint email_updates_status_chk
    check (status in ('proposed', 'approved', 'applied', 'rejected', 'undone')),
  constraint email_updates_kind_chk
    check (kind in (
      'schedule_complete', 'schedule_constraint', 'sub_pay_app', 'compliance_doc',
      'afp_status', 'afp_paid', 'inspection_result', 'change_order',
      'percent_complete', 'owner_dispute', 'unmatched'
    ))
);

-- The same email never lands the same change on the same record twice, so a
-- sweep that re-reads its inbox is harmless.
create unique index if not exists email_updates_once_idx
  on public.email_updates (
    project_id, source_message_id, kind,
    coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists email_updates_project_status_idx
  on public.email_updates (project_id, status);

alter table public.email_updates enable row level security;
drop policy if exists "ahc_read_email_updates"  on public.email_updates;
drop policy if exists "ahc_write_email_updates" on public.email_updates;
create policy "ahc_read_email_updates" on public.email_updates
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina'));
create policy "ahc_write_email_updates" on public.email_updates
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina'))
  with check (public.current_user_role() in ('phil','zarina'));

notify pgrst, 'reload schema';
