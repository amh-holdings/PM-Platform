# Working on the PM Platform away from the Mac Mini

Claude Code on the web clones this repo into a throwaway cloud container. It can
read the whole codebase, edit it, run the test suites, build it, and push
branches. It cannot reach the Mac Mini, the Supabase database, or anything on
the local network.

That single fact decides everything below. GitHub is the only thing both sides
can see, so GitHub is the handoff.

---

## Part 1 - One-time setup on the Mac Mini

Do these once. After that, remote sessions work without any further prep.

### 1. Never leave work unpushed

A remote session clones from GitHub. Anything sitting uncommitted on the Mini is
invisible to it, and worse, it is the version that will conflict later.

```bash
cd ~/path/to/pm-platform
git status                      # should be clean
git log origin/main..HEAD       # should be empty
```

If either shows something, commit and push before starting a remote session.
Make this the last thing done at the Mini, not the first thing remembered later.

### 2. Decide about the `_*` local harnesses

`.gitignore` keeps `scripts/**/_*.mjs` and `scripts/**/_*.mts` local-only. Those
are the browser harnesses that measure real pages against real data, and they
are the strongest verification in this project. They will never exist in a
remote session. That is the right call, but it means a remote session cannot
reproduce that class of proof. Nothing to change here, just know it.

### 3. Optional - let remote sessions reach Supabase

Only if the loop above is too slow. Adding the Supabase values to the remote
environment lets a session query the live database and drive a real browser
against Sussexx and Sweet Springs, which closes the only real verification gap.

| Variable | Needed for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Any database read |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Any database read |
| `SUPABASE_SERVICE_ROLE_KEY` | Scripts that bypass RLS. Bypasses RLS, so think before adding it |
| `RELAY_URL` / `RELAY_SHARED_SECRET` | PO milestone extraction only. Points at the Mini, so it will not work remotely regardless |

The service role key bypasses row level security. Adding the first two is a
smaller decision than adding the third, and the first two cover reads.

Skip this entirely and the workflow still works. It just means visual and
data-dependent verification happens at the Mini.

### 4. Keep `db/migrations/` as the only apply path

Migrations are applied by hand in the Supabase SQL editor, by Phil. A remote
session writes the migration file and cannot run it. That stays true.

Check what is actually applied before assuming:

```bash
node scripts/verify-migrations-live.mjs
```

---

## Part 2 - Applying a change that came from a remote session

The pattern, every time:

```bash
cd ~/path/to/pm-platform
git fetch origin
git checkout <branch-name>
npm install                     # only if package.json changed
```

Then, in this order:

1. **Migration first, if the branch added one.** Open `db/migrations/`, find the
   new numbered file, paste it into the Supabase SQL editor for project
   `sksfyygufnnbzrmneccx`, run it. Every migration in this repo is idempotent,
   so a re-run is safe.
2. **Regenerate the types.** `npm run db:types`. A remote session hand-writes
   the type entries so the build passes in the cloud. The regenerated file is
   the real one. Diff it. If it differs from what was committed, the hand-write
   was wrong and that is worth knowing.
3. **Run the suites.** `npm run test:<name>` for whatever the branch touched.
4. **Run the app.** `npm run dev`, and look at the actual page against real
   project data. This is the step the cloud cannot do.
5. **Merge.** `git checkout main && git merge <branch-name> && git push`.

---

## Part 3 - What lands where

| Kind of change | Can a remote session finish it | Why |
|---|---|---|
| Pure logic: projection math, billing suggestions, pin sanity, report derivation | Yes | Covered by the `tsx` suites, which need no database |
| Refactors, dead code, type fixes, lint | Yes | `next build` and `next lint` run clean without the database |
| New UI, layout, components | Builds and typechecks, needs a look at the Mini | No real rows to render against |
| Anything measured against Sussexx or Sweet Springs data | No | Needs the database |
| Migrations | Written remotely, applied at the Mini | By design |

---

## Part 4 - Pending right now

`claude/po-line-items` adds line items to the purchase order form. It is pushed
and waiting.

| Step | Command or action |
|---|---|
| 1 | `git fetch origin && git checkout claude/po-line-items` |
| 2 | Apply `db/migrations/0050_procurement_order_lines.sql` in the Supabase SQL editor |
| 3 | `npm run db:types` and diff `src/lib/database.types.ts` |
| 4 | `npm run test:procurement-lines` - expect 43 passed, 0 failed |
| 5 | `npm run dev`, open a PO, add lines, confirm the total locks to the sum |
| 6 | Merge to `main` |

Note: `db/migrations/pending/CATCH-UP-2026-09-02.sql` and `0049` may or may not
be applied. `node scripts/verify-migrations-live.mjs` answers that rather than
guessing.
