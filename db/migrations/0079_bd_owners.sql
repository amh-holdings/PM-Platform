-- BD owners: a name, with an optional email. Planned with Phil 2026-11-02.
--
-- An owner does not need a login or an email. Where an owner has an email, it
-- is the link to a login: whoever signs in with that address is that owner, so
-- "my queue" works the day their account is created, with no backfill.
--
-- Replaces 0078's owner_name stopgap. Nothing has written owner_name (the code
-- that does was never deployed), so it is dropped without a copy.
--
-- owner_id on both tables stays until this code is deployed, because the
-- current deploy still reads it. Drop it in a later migration.
--
-- Apply AFTER 0078, via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create table if not exists public.bd_owners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text check (email is null or email like '%@%'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bd_owners_name_key on public.bd_owners (lower(name));
create unique index if not exists bd_owners_email_key on public.bd_owners (lower(email)) where email is not null;

drop trigger if exists bd_owners_updated_at on public.bd_owners;
create trigger bd_owners_updated_at before update on public.bd_owners
  for each row execute function public.bd_touch_updated_at();

alter table public.bd_owners enable row level security;

drop policy if exists "bd_all_owners" on public.bd_owners;
create policy "bd_all_owners" on public.bd_owners
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

insert into public.bd_owners (name, email) values
  ('Phil Horwitch', 'phil@amh.holdings'),
  ('Luke Maslonka', null),
  ('Shannon', null)
on conflict ((lower(name))) do nothing;

-- Anyone else already holding a BD record through a login.
insert into public.bd_owners (name, email)
select distinct coalesce(p.full_name, p.email), p.email
from public.profiles p
where p.email is not null
  and p.id in (
    select owner_id from public.bd_companies where owner_id is not null
    union
    select owner_id from public.bd_opportunities where owner_id is not null
  )
  and not exists (select 1 from public.bd_owners o where lower(o.email) = lower(p.email))
on conflict do nothing;

alter table public.bd_companies
  add column if not exists bd_owner_id uuid references public.bd_owners(id) on delete set null;
alter table public.bd_opportunities
  add column if not exists bd_owner_id uuid references public.bd_owners(id) on delete set null;

update public.bd_companies c
  set bd_owner_id = o.id
  from public.profiles p
  join public.bd_owners o on lower(o.email) = lower(p.email)
  where c.owner_id = p.id and c.bd_owner_id is null;

update public.bd_opportunities x
  set bd_owner_id = o.id
  from public.profiles p
  join public.bd_owners o on lower(o.email) = lower(p.email)
  where x.owner_id = p.id and x.bd_owner_id is null;

alter table public.bd_companies drop column if exists owner_name;

create index if not exists bd_companies_owner_idx on public.bd_companies (bd_owner_id);
create index if not exists bd_opportunities_owner_idx on public.bd_opportunities (bd_owner_id);
