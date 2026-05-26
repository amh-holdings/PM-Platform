-- Phase 1: Subcontractors RLS
-- AHC team gets full CRUD. Subs/owners/counsel will get scoped read access
-- in a future migration once we wire subcontractor_id onto profiles.
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run: every policy uses DROP IF EXISTS + CREATE.

drop policy if exists "ahc_read_subcontractors"  on public.subcontractors;
drop policy if exists "ahc_write_subcontractors" on public.subcontractors;

create policy "ahc_read_subcontractors" on public.subcontractors
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_subcontractors" on public.subcontractors
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
