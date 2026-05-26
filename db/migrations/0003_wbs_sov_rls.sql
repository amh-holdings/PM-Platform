-- Phase 1: WBS / SOV RLS
-- AHC team gets full CRUD. Subs see only their own line items (scoped later
-- once profiles.subcontractor_id is reliably populated).
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run: every policy uses DROP IF EXISTS + CREATE.

drop policy if exists "ahc_read_wbs"  on public.wbs_sov;
drop policy if exists "ahc_write_wbs" on public.wbs_sov;

create policy "ahc_read_wbs" on public.wbs_sov
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_wbs" on public.wbs_sov
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
