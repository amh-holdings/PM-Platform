-- Two additions from the 2026-11-02 BD review.
--
-- bd_contacts.status: a contact whose email bounced or who left the company
-- stays on file as history, but drops out of the pickers so nobody writes to
-- them again.
--
-- bd_stage_history: every client and bid stage change, written by trigger so
-- no path can skip it. The weekly review reads it. It starts empty; changes
-- before this migration are not reconstructed.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.bd_contacts
  add column if not exists status text not null default 'active';

alter table public.bd_contacts drop constraint if exists bd_contacts_status_check;
alter table public.bd_contacts add constraint bd_contacts_status_check
  check (status in ('active', 'bounced', 'left'));

create table if not exists public.bd_stage_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.bd_companies(id) on delete cascade,
  opportunity_id uuid references public.bd_opportunities(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists bd_stage_history_changed_idx on public.bd_stage_history (changed_at);

alter table public.bd_stage_history enable row level security;

drop policy if exists "bd_read_stage_history" on public.bd_stage_history;
create policy "bd_read_stage_history" on public.bd_stage_history
  for select to authenticated
  using (public.current_user_role() in ('phil', 'bd'));

-- Security definer because nobody holds an insert policy on the history.
create or replace function public.bd_log_company_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.relationship_stage is distinct from old.relationship_stage then
    insert into public.bd_stage_history (company_id, from_stage, to_stage, changed_by)
    values (new.id, old.relationship_stage, new.relationship_stage, auth.uid());
  end if;
  return new;
end;
$$;

create or replace function public.bd_log_opportunity_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.bd_stage_history (company_id, opportunity_id, from_stage, to_stage, changed_by)
    values (new.company_id, new.id, old.stage, new.stage, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists bd_companies_stage_history on public.bd_companies;
create trigger bd_companies_stage_history after update on public.bd_companies
  for each row execute function public.bd_log_company_stage();

drop trigger if exists bd_opportunities_stage_history on public.bd_opportunities;
create trigger bd_opportunities_stage_history after update on public.bd_opportunities
  for each row execute function public.bd_log_opportunity_stage();
