/**
 * Apply db/migrations/*.sql without opening the Supabase SQL editor.
 *
 * WHY THIS EXISTS
 * Every migration on this project has been pasted into the dashboard by hand.
 * That is how 0052, 0053 and 0054 all ended up written, reviewed, deployed and
 * inert at the same time: the code ships on merge, the schema does not, and
 * the gap is invisible until a page says it needs a migration.
 *
 * supabase-js cannot close that gap - it speaks to PostgREST, which does not
 * run DDL. This talks to Postgres directly.
 *
 * WHY A LEDGER, AND WHY BASELINE FIRST
 * The live database has 51 migrations applied and no record of any of them.
 * Pointing a runner at that and saying "apply everything" would replay four
 * months of schema changes against production. So the first run is
 * --baseline-through, which RECORDS files as applied without executing them.
 * You establish where the database already is, then only genuinely new files
 * ever run.
 *
 *   node scripts/db/migrate.mjs                      status, changes nothing
 *   node scripts/db/migrate.mjs --baseline-through 0051
 *   node scripts/db/migrate.mjs --apply              runs what is pending
 *
 * Each file runs inside its own transaction, so a file that fails halfway
 * leaves nothing behind and nothing recorded. Files are applied in filename
 * order. A checksum is stored so an edit to an already-applied file shows up
 * as a warning rather than silently diverging.
 *
 * SETUP, ONCE
 * Add the Postgres connection string to .env.local as SUPABASE_DB_URL. Get it
 * from the Supabase dashboard: Connect -> Direct connection (or Session
 * pooler). It is NOT the service role key, and it is NOT the anon key - it is
 * a postgresql:// URL containing the database password. .env.local is
 * gitignored; keep it there and nowhere else.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const baselineIdx = process.argv.indexOf("--baseline-through");
const BASELINE_THROUGH = baselineIdx === -1 ? null : process.argv[baselineIdx + 1];

const MIGRATIONS_DIR = "db/migrations";
const LEDGER = "public.schema_migrations_applied";

function loadEnv() {
  let raw = "";
  try {
    raw = readFileSync(".env.local", "utf8");
  } catch {
    // Fall through to process.env - CI has no .env.local.
  }
  const env = { ...process.env };
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const url = env.SUPABASE_DB_URL || env.DATABASE_URL;
if (!url) {
  console.error(
    [
      "No database URL.",
      "",
      "Add SUPABASE_DB_URL to .env.local. In the Supabase dashboard for project",
      "sksfyygufnnbzrmneccx: Connect -> Direct connection, copy the",
      "postgresql:// URL and put the database password in it.",
      "",
      "This is a different credential from SUPABASE_SERVICE_ROLE_KEY. The service",
      "role key talks to PostgREST, which cannot create tables.",
    ].join("\n"),
  );
  process.exit(1);
}

// Supabase serves a publicly trusted certificate, so verification stays on.
// PGSSLMODE=no-verify is the escape hatch for a network that intercepts TLS,
// and it has to be asked for rather than being the default.
const ssl =
  env.PGSSLMODE === "no-verify"
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const client = new pg.Client({ connectionString: url, ssl });
try {
  await client.connect();
} catch (err) {
  // Supabase's connection endpoints do not all present the same certificate
  // chain, and "self signed certificate" is an unhelpful place to be stranded
  // when the fix is one of two specific things.
  if (/self[- ]signed|unable to verify|certificate/i.test(err.message ?? "")) {
    console.error(
      [
        `TLS verification failed: ${err.message}`,
        "",
        "Two ways out, in order of preference:",
        "",
        "  1. Use the Session pooler URL instead of the direct one. Supabase",
        "     dashboard -> Connect -> Session pooler. It presents a publicly",
        "     trusted certificate, so verification keeps working.",
        "",
        "  2. PGSSLMODE=no-verify npm run db:migrate",
        "     Still encrypted, but the server's identity is not checked. Fine",
        "     on a trusted network, and not something to leave switched on.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.error(`Could not connect: ${err.message}`);
  process.exit(1);
}

await client.query(`
  create table if not exists ${LEDGER} (
    name        text primary key,
    checksum    text,
    applied_at  timestamptz not null default now(),
    baselined   boolean not null default false
  )
`);

const { rows: recorded } = await client.query(
  `select name, checksum, baselined from ${LEDGER}`,
);
const seen = new Map(recorded.map((r) => [r.name, r]));

const state = files.map((name) => {
  const body = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
  const digest = sha(body);
  const row = seen.get(name);
  return {
    name,
    body,
    digest,
    applied: Boolean(row),
    baselined: row?.baselined ?? false,
    drifted: Boolean(row) && row.checksum !== null && row.checksum !== digest,
  };
});

const pending = state.filter((m) => !m.applied);
const drifted = state.filter((m) => m.drifted);

console.log(`${files.length} migration files, ${state.length - pending.length} recorded, ${pending.length} pending\n`);

if (drifted.length) {
  console.log("CHANGED SINCE IT WAS APPLIED (not re-run, just flagged):");
  for (const m of drifted) console.log(`  ${m.name}`);
  console.log("");
}

/* ----------------------------------------------------------- baseline -- */
if (BASELINE_THROUGH) {
  // Compare the four-digit prefixes as NUMBERS. Lexical comparison of the
  // whole filename happens to be right for zero-padded names, but it is right
  // by accident, and getting this wrong means either replaying live schema or
  // silently skipping a migration.
  const seq = (n) => Number(String(n).slice(0, 4));
  const cut = seq(BASELINE_THROUGH);
  if (!Number.isInteger(cut)) {
    console.error(`--baseline-through wants a migration number like 0051, got "${BASELINE_THROUGH}".`);
    await client.end();
    process.exit(1);
  }
  const upTo = state.filter((m) => seq(m.name) <= cut);
  const toRecord = upTo.filter((m) => !m.applied);
  console.log(`Baseline through ${BASELINE_THROUGH}: recording ${toRecord.length} file(s) as applied WITHOUT running them.`);
  for (const m of toRecord) console.log(`  ${m.name}`);
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write the ledger.");
    await client.end();
    process.exit(0);
  }
  for (const m of toRecord) {
    await client.query(
      `insert into ${LEDGER} (name, checksum, baselined) values ($1, $2, true)
       on conflict (name) do nothing`,
      [m.name, m.digest],
    );
  }
  console.log(`\nRecorded ${toRecord.length}. Nothing was executed.`);
  await client.end();
  process.exit(0);
}

/* -------------------------------------------------------------- apply -- */
if (!pending.length) {
  console.log("Nothing pending. The database matches db/migrations.");
  await client.end();
  process.exit(0);
}

console.log("PENDING:");
for (const m of pending) console.log(`  ${m.name}`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to execute these.");
  console.log("If this database already has these applied by hand, run");
  console.log("--baseline-through <last applied> --apply first.");
  await client.end();
  process.exit(0);
}

console.log("");
let ran = 0;
for (const m of pending) {
  // create index concurrently cannot run inside a transaction. None of the
  // files use it today; this is here so the day one does, it fails loudly at
  // the top rather than halfway through.
  if (/concurrently/i.test(m.body)) {
    console.error(`REFUSED ${m.name}: contains CONCURRENTLY, which cannot run in a transaction. Apply this one by hand.`);
    break;
  }
  process.stdout.write(`  ${m.name} ... `);
  try {
    await client.query("begin");
    await client.query(m.body);
    await client.query(
      `insert into ${LEDGER} (name, checksum, baselined) values ($1, $2, false)`,
      [m.name, m.digest],
    );
    await client.query("commit");
    ran += 1;
    console.log("ok");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.log("FAILED");
    console.error(`\n${m.name} failed and was rolled back. Nothing after it ran.\n`);
    console.error(err.message);
    await client.end();
    process.exit(1);
  }
}

// PostgREST answers from a cached copy of the schema, so a new table stays
// invisible to the app until this fires. Without it, a successful migration
// still looks like one that never ran.
await client.query("notify pgrst, 'reload schema'");
console.log(`\nApplied ${ran}. PostgREST schema cache reload requested.`);

await client.end();
