-- Removes the RFP workspace (0088), 2026-11-04.
--
-- Phil: "You can remove the RFP workspace if it's only a runbook. We already
-- have a draft in Notion." The runbook and the state rules live on the Notion
-- card "RFP and Proposal Process - Map for Automation" and in the Runbook
-- Library, so the app copy goes.
--
-- Drops the four 0088 tables and Zarina's read access to bd_opportunities
-- and bd_companies, which existed only for the workspace. BD access goes back
-- to exactly what 0074 set: Phil and bd.
--
-- The seeded DE, VA and MD state profiles go with bd_state_profiles. Their
-- content is on the Notion card and in the Jurisdictional Permitting Index.
--
-- The Retired stage (0089) is separate and stays.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx), only after
-- 0088 was applied. Safe to re-run, and safe if 0088 never ran.

drop policy if exists "zarina_read_opportunities" on public.bd_opportunities;
drop policy if exists "zarina_read_companies" on public.bd_companies;

drop table if exists public.rfp_bidder_docs;
drop table if exists public.rfp_bidders;
drop table if exists public.rfp_step_checks;
drop table if exists public.bd_state_profiles;
