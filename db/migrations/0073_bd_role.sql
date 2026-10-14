-- Business development role (Luke and Shannon).
--
-- Its own migration because Postgres will not let a new enum value be used in
-- the same transaction that adds it, and the SQL editor runs a paste as one
-- transaction. Apply this, then 0074.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter type public.user_role add value if not exists 'bd';
