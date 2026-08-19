// Commodity production tracking - known-answer test harness.
//
// Runs entirely locally against embedded Postgres (pglite, WASM). NEVER touches
// the hosted Supabase project. Two layers, mirroring scripts/qaqc/run-tests.ts:
//   1. Integration: applies db/migrations/0035_commodity_tracking.sql into a real
//      Postgres and exercises the constraints and RLS scoping that the daily
//      production deliverable depends on.
//   2. Unit: the pure list/validation logic in src/lib/commodities.ts.
//
// Run: npx tsx scripts/commodity/run-tests.ts
//
// RLS note: pglite's bootstrap user is a superuser and bypasses RLS. We create a
// non-superuser `authenticated` role and SET ROLE to it (mirroring Supabase's
// `to authenticated` policies). auth.uid() is stubbed to read a session GUC.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  COMMODITIES,
  COMMODITY_KEY_ORDER,
  commodityByKey,
  commoditiesByCategory,
  isValidDailyValue,
} from "@/lib/commodities";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "0035_commodity_tracking.sql",
  // 0036 corrects the ownership model: daily production is AHC's deliverable to
  // the owner, filed by Phil, NOT something the subcontractor enters.
  "0036_daily_production_phil_only.sql",
].map((f) => join(__dirname, "..", "..", "db", "migrations", f));

// ---- tiny test runner ----
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function expectBlocked(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, "expected the operation to be blocked, but it succeeded");
  } catch {
    check(name, true);
  }
}

// Known-answer fixed UUIDs.
const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const SUB_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SUB_B = "bbbbbbbb-0000-0000-0000-000000000002";
const PHIL = "d0000000-0000-0000-0000-000000000001";
const MARK = "d0000000-0000-0000-0000-000000000002";
const FM_A = "d0000000-0000-0000-0000-00000000000a";
const FM_B = "d0000000-0000-0000-0000-00000000000b";
const OWNER = "d0000000-0000-0000-0000-00000000000c";
const TASK_1 = "e0000000-0000-0000-0000-000000000001";

async function main() {
  const db = new PGlite();

  // ---------- setup: minimal Supabase-shaped schema ----------
  await db.exec(`
    create schema if not exists auth;

    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_uid', true), '')::uuid
    $$;

    create type user_role as enum
      ('phil','zarina','ahc_super','sub_pm','sub_foreman','owner','counsel');

    create table public.profiles (
      id uuid primary key,
      email text unique not null,
      role user_role not null default 'sub_foreman',
      subcontractor_id uuid,
      active boolean default true
    );
    create table public.projects (
      id uuid primary key default gen_random_uuid(),
      name text not null
    );
    create table public.subcontractors (
      id uuid primary key default gen_random_uuid(),
      project_id uuid references public.projects(id) on delete cascade,
      company_name text not null
    );
    create table public.schedule_tasks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid references public.projects(id) on delete cascade,
      wbs_code text,
      task_name text
    );
    create table public.dprs (
      id uuid primary key default gen_random_uuid(),
      project_id uuid references public.projects(id) on delete cascade,
      report_date date
    );

    create or replace function public.current_user_role() returns public.user_role
      language sql security definer stable set search_path = public as $$
      select role from public.profiles where id = auth.uid();
    $$;

    create role authenticated;
    grant usage on schema public, auth to authenticated;
  `);

  // ---------- apply the real migration ----------
  const migrationSql = MIGRATIONS.map((f) => readFileSync(f, "utf8"));
  for (const sql of migrationSql) await db.exec(sql);
  check("INT-01 migrations 0035 + 0036 apply cleanly into Postgres", true);

  // Re-running must be a no-op, not an error. Every migration in this repo is
  // pasted by hand into the SQL editor, so a double-paste has to be harmless.
  for (const sql of migrationSql) await db.exec(sql);
  check("INT-02 migrations are idempotent (applied twice)", true);

  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `);

  // ---------- seed ----------
  await db.exec(`
    insert into public.projects (id, name) values
      ('${P1}', 'MOCK - Commodity Test Project'),
      ('${P2}', 'MOCK - Other Project');
    insert into public.subcontractors (id, project_id, company_name) values
      ('${SUB_A}', '${P1}', 'Sub A Civil'),
      ('${SUB_B}', '${P2}', 'Sub B Elsewhere');
    insert into public.profiles (id, email, role, subcontractor_id) values
      ('${PHIL}', 'phil@amh.holdings', 'phil', null),
      ('${MARK}', 'mark@ahc.com',      'ahc_super', null),
      ('${FM_A}', 'fa@suba.com',       'sub_foreman', '${SUB_A}'),
      ('${FM_B}', 'fb@subb.com',       'sub_foreman', '${SUB_B}'),
      ('${OWNER}','owner@dev.com',     'owner', null);
    insert into public.schedule_tasks (id, project_id, wbs_code, task_name) values
      ('${TASK_1}', '${P1}', '5.1.1.5', 'Initial clearing for Perimeter ESC ONLY');
  `);

  // Seed the commodity list for both projects, as seed-commodities.ts would.
  const seedValues = COMMODITIES.map(
    (c, i) =>
      `('${P1}', '${c.key}', '${c.formColumn.replace(/'/g, "''")}', '${c.category}', '${c.uom === "pct" ? "%" : c.uom}', ${i})`
  ).join(",\n");
  await db.exec(`
    insert into public.commodities (project_id, key, label, category, uom, sort_order)
    values ${seedValues};
    insert into public.commodities (project_id, key, label, category, uom, sort_order)
    values ('${P2}', 'site_prep', 'Site Prep', 'civil', '%', 0);
  `);
  const seeded = await db.query<{ count: string }>(
    `select count(*)::text as count from public.commodities where project_id = $1`,
    [P1]
  );
  check(
    "INT-03 all 18 commodities seed for a project",
    seeded.rows[0].count === "18",
    `got ${seeded.rows[0].count}`
  );

  // ---------- constraints ----------
  const sitePrepP1 = (
    await db.query<{ id: string }>(
      `select id from public.commodities where project_id = $1 and key = 'site_prep'`,
      [P1]
    )
  ).rows[0].id;
  const pilesP1 = (
    await db.query<{ id: string }>(
      `select id from public.commodities where project_id = $1 and key = 'piles'`,
      [P1]
    )
  ).rows[0].id;

  await db.query(
    `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
     values ($1, $2, '2026-08-04', 5, 'backfill')`,
    [P1, sitePrepP1]
  );
  check("INT-04 a daily production row inserts", true);

  // The unique key is what makes every importer safe to re-run. Without it a
  // second apply-backfill would double the client's reported production.
  await expectBlocked(
    "INT-05 duplicate (project, date, commodity) is rejected",
    () =>
      db.query(
        `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
         values ($1, $2, '2026-08-04', 9, 'backfill')`,
        [P1, sitePrepP1]
      )
  );

  // Upsert on that key is the path both the field report and the backfill use.
  await db.query(
    `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
     values ($1, $2, '2026-08-04', 7, 'backfill')
     on conflict (project_id, production_date, commodity_id)
     do update set quantity = excluded.quantity`,
    [P1, sitePrepP1]
  );
  const upserted = await db.query<{ quantity: string }>(
    `select quantity::text from public.daily_production
     where project_id = $1 and commodity_id = $2 and production_date = '2026-08-04'`,
    [P1, sitePrepP1]
  );
  check(
    "INT-06 upsert on the unique key corrects rather than duplicates",
    Number(upserted.rows[0].quantity) === 7,
    `got ${upserted.rows[0].quantity}`
  );

  await expectBlocked("INT-07 negative quantity is rejected", () =>
    db.query(
      `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
       values ($1, $2, '2026-08-05', -1, 'backfill')`,
      [P1, pilesP1]
    )
  );

  // updated_at must move on change; the sync bookkeeping relies on it.
  const before = await db.query<{ updated_at: string }>(
    `select updated_at::text from public.daily_production
     where project_id = $1 and commodity_id = $2 and production_date = '2026-08-04'`,
    [P1, sitePrepP1]
  );
  await db.query(
    `update public.daily_production set quantity = 8
     where project_id = $1 and commodity_id = $2 and production_date = '2026-08-04'`,
    [P1, sitePrepP1]
  );
  const after = await db.query<{ updated_at: string }>(
    `select updated_at::text from public.daily_production
     where project_id = $1 and commodity_id = $2 and production_date = '2026-08-04'`,
    [P1, sitePrepP1]
  );
  check(
    "INT-08 updated_at trigger fires on update",
    after.rows[0].updated_at !== before.rows[0].updated_at
  );

  // ---------- RLS ----------
  async function asUser(uid: string, fn: () => Promise<void>) {
    await db.exec(
      `select set_config('app.current_uid', '${uid}', false); set role authenticated;`
    );
    try {
      await fn();
    } finally {
      await db.exec(`reset role; select set_config('app.current_uid', '', false);`);
    }
  }

  // The subcontractor is now entirely walled off: they file Field Reports, and
  // AHC derives the owner's commodity report FROM those reports. A sub that
  // could see or edit it could alter what we tell the owner.
  await asUser(FM_A, async () => {
    const res = await db.query<{ count: string }>(
      `select count(*)::text as count from public.commodities`
    );
    check(
      "RLS-01 sub cannot read the commodity list at all",
      res.rows[0].count === "0",
      `got ${res.rows[0].count}`
    );
  });

  await asUser(FM_A, async () => {
    await expectBlocked(
      "RLS-02 sub cannot insert production on its own project",
      () =>
        db.query(
          `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
           values ($1, $2, '2026-08-06', 3, 'manual')`,
          [P1, pilesP1]
        )
    );
  });

  await asUser(FM_A, async () => {
    const res = await db.query<{ count: string }>(
      `select count(*)::text as count from public.daily_production`
    );
    check(
      "RLS-03 sub cannot read any production",
      res.rows[0].count === "0",
      `got ${res.rows[0].count}`
    );
  });

  await asUser(PHIL, async () => {
    await db.query(
      `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
       values ($1, $2, '2026-08-06', 3, 'manual')`,
      [P1, pilesP1]
    );
  });
  check("RLS-04 phil writes production (allowed)", true);

  // The CM sanity-checks the numbers but does not author them - a client
  // deliverable gets one author.
  await asUser(MARK, async () => {
    const res = await db.query<{ count: string }>(
      `select count(*)::text as count from public.daily_production`
    );
    check(
      "RLS-05 CM reads production",
      Number(res.rows[0].count) >= 2,
      `got ${res.rows[0].count}`
    );
    await expectBlocked("RLS-06 CM cannot write production", () =>
      db.query(
        `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
         values ($1, $2, '2026-08-09', 1, 'manual')`,
        [P1, pilesP1]
      )
    );
  });

  // An UPDATE that matches no rows under RLS affects zero rows silently rather
  // than raising, so this asserts the VALUE held - not that the query threw.
  await asUser(MARK, async () => {
    await db.query(
      `update public.daily_production set quantity = 999
       where project_id = $1 and commodity_id = $2`,
      [P1, pilesP1]
    );
  });
  const afterCmUpdate = await db.query<{ quantity: string }>(
    `select quantity::text from public.daily_production
     where project_id = $1 and commodity_id = $2 and production_date = '2026-08-06'`,
    [P1, pilesP1]
  );
  check(
    "RLS-07 CM cannot edit a filed production value",
    Number(afterCmUpdate.rows[0].quantity) === 3,
    `quantity is now ${afterCmUpdate.rows[0].quantity}, expected 3`
  );

  await asUser(OWNER, async () => {
    await expectBlocked("RLS-08 owner cannot write production", () =>
      db.query(
        `insert into public.daily_production (project_id, commodity_id, production_date, quantity, source)
         values ($1, $2, '2026-08-07', 1, 'manual')`,
        [P1, pilesP1]
      )
    );
  });

  // ---------- unit: the commodity list ----------
  check("UNIT-01 exactly 18 commodities", COMMODITIES.length === 18, `got ${COMMODITIES.length}`);

  const keys = new Set(COMMODITY_KEY_ORDER);
  check("UNIT-02 commodity keys are unique", keys.size === COMMODITIES.length);

  const rollupIds = new Set(COMMODITIES.map((c) => c.rollupRowId));
  check(
    "UNIT-03 Smartsheet roll-up row ids are unique",
    rollupIds.size === COMMODITIES.length
  );

  check(
    "UNIT-04 categories split 5 civil / 9 electrical / 4 mechanical",
    commoditiesByCategory("civil").length === 5 &&
      commoditiesByCategory("electrical").length === 9 &&
      commoditiesByCategory("mechanical").length === 4,
    `got ${commoditiesByCategory("civil").length}/${commoditiesByCategory("electrical").length}/${commoditiesByCategory("mechanical").length}`
  );

  // The four commodities the client names differently on its two sheets. Getting
  // these backwards would silently write to the wrong roll-up row.
  check(
    "UNIT-05 form column and roll-up label differ on exactly 4 commodities",
    COMMODITIES.filter((c) => c.formColumn !== c.rollupLabel).length === 4
  );

  check(
    "UNIT-06 lookup by key resolves",
    commodityByKey("site_prep")?.formColumn === "Site Prep" &&
      commodityByKey("nope") === undefined
  );

  const sitePrep = commodityByKey("site_prep")!;
  const piles = commodityByKey("piles")!;
  check(
    "UNIT-07 percent commodity rejects a daily value over 100",
    isValidDailyValue(sitePrep, 100) && !isValidDailyValue(sitePrep, 101)
  );
  check(
    "UNIT-08 count commodity accepts values over 100",
    isValidDailyValue(piles, 250)
  );
  check(
    "UNIT-09 negative and non-finite values are rejected",
    !isValidDailyValue(piles, -1) && !isValidDailyValue(piles, NaN)
  );

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
