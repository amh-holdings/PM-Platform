# AHC PM Platform - Database

Source of truth for the live Supabase schema (project `sksfyygufnnbzrmneccx`).

## Files

| File | Purpose |
|---|---|
| `schema.sql` | Table definitions, enums, indexes, triggers |
| `policies.sql` | RLS policies for tables and storage |

Migrations going forward should be added as numbered files under `supabase/migrations/` once we set up the Supabase CLI workflow.

## Applying changes to the live DB

Numbered migration files under `migrations/` are the apply path. Each is idempotent (safe to re-run), and that is verified: all 51 replay cleanly against an already-migrated database.

### The runner (preferred)

`scripts/db/migrate.mjs` applies pending migrations over a direct Postgres
connection, so nothing has to be pasted into a dashboard. `supabase-js` cannot
do this - it speaks to PostgREST, which does not run DDL.

**One-time setup.** Add the Postgres connection string to `.env.local` as
`SUPABASE_DB_URL`. Supabase dashboard -> Connect -> Session pooler (preferred,
publicly trusted certificate) or Direct connection. This is a different
credential from `SUPABASE_SERVICE_ROLE_KEY`.

**One-time baseline.** The live database has migrations applied with no record
of them, so the runner must be told where it already is before it is allowed to
apply anything:

```
node scripts/db/migrate.mjs --baseline-through 0051            # dry run
node scripts/db/migrate.mjs --baseline-through 0051 --apply    # records, runs nothing
```

**Thereafter:**

```
npm run db:status    # what is pending, changes nothing
npm run db:migrate   # applies pending migrations
```

Each file runs in its own transaction, so a failure rolls back and records
nothing. A checksum is stored per file, so editing an already-applied migration
shows up as a warning. The run ends with `notify pgrst, 'reload schema'`,
without which a new table stays invisible to the app and looks exactly like a
migration that never ran.

### By hand (fallback)

1. Open the Supabase SQL Editor for project `sksfyygufnnbzrmneccx`.
2. Paste the contents of the next un-applied migration file and run it.

### Either way

3. Regenerate TypeScript types: `npm run db:types` from the `pm-platform/` directory.
4. Commit the regenerated `src/lib/database.types.ts`.

`schema.sql` and `policies.sql` remain the human-readable source of truth for the cumulative state.

## Storage buckets

Buckets aren't created via SQL. After running schema/policy changes that reference a new bucket, create it manually:

### `project-documents`

| Setting | Value |
|---|---|
| Bucket name | `project-documents` |
| Public | No (private) |
| File size limit | 50 MB (adjust later if drawings push past this) |
| Allowed MIME types | Leave empty (allow all - we'll validate at app layer) |

Once the bucket exists, the policies in `policies.sql` under "STORAGE: project-documents bucket" will gate access.

File path convention inside the bucket: `{project_id}/{document_id}/{file_name}`.

## Phase 1 status (2026-05-26)

| Table | Schema | Policies | Notes |
|---|---|---|---|
| `profiles` | Done | Done | Auto-created via trigger on auth signup |
| `projects` | Done | Done | AHC team CRUD, all authed can read |
| `project_documents` | Done | Done | AHC team CRUD only for now |
| `subcontractors` | Done | None | RLS on but no policies = no access |
| `wbs_sov` | Done | None | Same |
| `dprs`, `dpr_quantities` | Done | None | Same |
| `rfis`, `submittals` | Done | None | Same |
| `photos`, `comms_log` | Done | None | Same |
