# AHC PM Platform - Database

Source of truth for the live Supabase schema (project `sksfyygufnnbzrmneccx`).

## Files

| File | Purpose |
|---|---|
| `schema.sql` | Table definitions, enums, indexes, triggers |
| `policies.sql` | RLS policies for tables and storage |

Migrations going forward should be added as numbered files under `supabase/migrations/` once we set up the Supabase CLI workflow.

## Applying changes to the live DB

Numbered migration files under `migrations/` are the apply path going forward. Each is idempotent (safe to re-run).

1. Open the Supabase SQL Editor for project `sksfyygufnnbzrmneccx`.
2. Paste the contents of the next un-applied migration file and run it.
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
