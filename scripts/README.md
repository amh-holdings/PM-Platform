# PM Platform Scripts

Local Node scripts. Run from the `pm-platform/` directory.

## verify-setup

Quick health check: confirms the `project_documents` table, the `project-documents` Storage bucket, an AHC-tier profile, and the Sweet Springs project all exist.

```
npm run verify-setup
```

## bulk-import

Two-phase importer for getting a folder of starter documents into a project. Run scan first, classify the manifest, then apply.

### scan

Walks a folder, extracts text from PDFs / Word / text files, writes a manifest to `scripts/.import-manifest.json`. No DB or Storage writes happen yet.

```
npm run import:scan -- --project-id <uuid> --folder "/abs/path/to/folder"
```

Output: one line per file with extracted text length or a "skipped/failed" reason. The manifest contains everything needed for the apply step (paths, MIME types, full extracted text, content hashes).

After scanning, every entry in the manifest has `"category": null`. Fill those in with one of:

- `prime_contract`, `amendment`, `exhibit`, `subcontract`, `drawing`, `spec`, `submittal`, `rfi`, `daily_log`, `email`, `other`

You can either edit the JSON by hand or have Claude do the classification by reading the extracted text in each entry.

### apply

Reads the (now-classified) manifest, uploads each file to Supabase Storage, and inserts a row in `project_documents` with the extracted text. Dedupes by `(project_id, file_name, size_bytes)` so it's safe to re-run.

```
npm run import:apply -- --project-id <uuid>
```

Fails fast if any entry is missing a category or has an invalid one.

### Files (gitignored)

| File | What |
|---|---|
| `scripts/.import-manifest.json` | Last scan output. Contains absolute paths + extracted document text. Sensitive - never commit. |

### Phase 2 (later)

When we build the in-app text-extraction worker, the drag-drop uploader will set `text_status='pending'` and a worker will flip it to `'ready'` after extraction. The bulk-import script already sets `'ready'` (or `'skipped'`/`'failed'` with a reason) at import time.
