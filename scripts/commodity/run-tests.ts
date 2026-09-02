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
import {
  activityScore,
  countLoads,
  percentRate,
  proposeForDay,
  type ProposalCommodity,
} from "@/lib/production-proposal";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  "0035_commodity_tracking.sql",
  // 0036 corrects the ownership model: daily production is AHC's deliverable to
  // the owner, filed by Phil, NOT something the subcontractor enters.
  "0036_daily_production_phil_only.sql",
  // 0040 added a confirmation flag; 0044 retires it. Both are applied here so
  // the retirement is proved to run against the schema 0040 actually left
  // behind - including dropping the partial index it created.
  "0040_production_proposals.sql",
  "0044_production_no_confirmation_gate.sql",
].map((f) => join(__dirname, "..", "..", "db", "migrations", f));

// Application source, for the checks that assert a call site exists.
const SRC = join(__dirname, "..", "..", "src");

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

  // ---------- unit: the auto-proposer ----------
  // The rules that fire when a CM approves a Field Report. These decide what
  // lands on the owner's tracker, so the interesting cases are the ones where
  // the answer must be NOTHING.

  const PROP_COMMODITIES: ProposalCommodity[] = [
    { id: "c-site", key: "site_prep", label: "Site Prep", uom: "%" },
    { id: "c-civil", key: "civil_work", label: "Civil Work", uom: "%" },
    { id: "c-road", key: "road_install", label: "Road Install", uom: "ft" },
    { id: "c-piles", key: "piles", label: "Piles", uom: "ea" },
  ];
  // 60% of site prep earned over 300 points of activity = 0.2% per point.
  // typicalDaily is the ceiling a proposal may not beat: the MEDIAN day Phil
  // has confirmed for that scope.
  const HISTORY = {
    totalByCommodity: { site_prep: 60, civil_work: 15 },
    scoreByCommodity: { site_prep: 300, civil_work: 150 },
    typicalDailyByCommodity: { site_prep: 14, civil_work: 8 },
  };
  const day = (over: Partial<Parameters<typeof proposeForDay>[0]["day"]> = {}) => ({
    date: "2026-08-25",
    narrative: "",
    cmLog: "",
    pinTitles: [] as string[],
    crewCount: null as number | null,
    ...over,
  });

  check(
    "PROP-01 the same trucks in both reports are counted once, not twice",
    countLoads("3 loads of logs", "3 loads of logs") === 3,
    `got ${countLoads("3 loads of logs", "3 loads of logs")}`
  );

  check(
    "PROP-02 activity score weights loads over crew size",
    activityScore(day({ narrative: "4 loads out", crewCount: 6 })) === 11,
    `got ${activityScore(day({ narrative: "4 loads out", crewCount: 6 }))}`
  );

  check(
    "PROP-03 rate comes from confirmed history",
    percentRate(HISTORY, "site_prep") === 0.2,
    `got ${percentRate(HISTORY, "site_prep")}`
  );

  const grubbing = proposeForDay({
    day: day({ narrative: "Grubbing and hauling debris, 5 loads out", crewCount: 6 }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 60 },
  });
  check(
    "PROP-04 a site prep day proposes score x rate",
    grubbing.values.length === 1 &&
      grubbing.values[0].commodityKey === "site_prep" &&
      grubbing.values[0].quantity === 2.6,
    JSON.stringify(grubbing.values)
  );
  check(
    "PROP-05 the proposal carries a written basis",
    (grubbing.values[0]?.basis ?? "").includes("Matched:") &&
      grubbing.values[0].basis.includes("confirmed rate")
  );

  // No confirmed history means no defensible rate. A fabricated first percent
  // is worse than a blank cell, so the day must be skipped with a reason.
  const noHistory = proposeForDay({
    day: day({ narrative: "Grubbing, 5 loads out", crewCount: 6 }),
    commodities: PROP_COMMODITIES,
    history: {
      totalByCommodity: {},
      scoreByCommodity: {},
      typicalDailyByCommodity: {},
    },
    committedPercent: {},
  });
  check(
    "PROP-06 no confirmed history proposes nothing and says why",
    noHistory.values.length === 0 &&
      noHistory.skipped.some((sk) => sk.commodityKey === "site_prep"),
    JSON.stringify(noHistory)
  );

  // A day with a report but no measurable activity has nothing to scale by.
  const idle = proposeForDay({
    day: day({ narrative: "Grubbing continued", crewCount: null }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 60 },
  });
  check(
    "PROP-07 zero activity proposes nothing",
    idle.values.length === 0 && idle.skipped.length > 0,
    JSON.stringify(idle)
  );

  // Percent scopes cannot be pushed past 100 by an estimate.
  const nearlyDone = proposeForDay({
    day: day({ narrative: "Grubbing, 20 loads out", crewCount: 8 }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 99 },
  });
  check(
    "PROP-08 a percent scope is capped at its remaining headroom",
    nearlyDone.values[0]?.quantity === 1,
    JSON.stringify(nearlyDone.values)
  );
  const done = proposeForDay({
    day: day({ narrative: "Grubbing, 20 loads out", crewCount: 8 }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 100 },
  });
  check(
    "PROP-09 a finished percent scope proposes nothing",
    done.values.length === 0,
    JSON.stringify(done.values)
  );

  // The bound that stops a detailed CM log from asserting a record day: Sweet
  // Springs' load counts tripled when the crew moved to the entranceway, and
  // raw rate x score wanted 16-21% of the whole scope in a day.
  // Sweet Springs' real figures: 60.02% of site prep confirmed over 141 points
  // of activity, median confirmed day 4.26%. Score 39 (18 loads, crew 6) puts
  // raw rate x score at 16.6% - nearly four typical days in one - which is the
  // case that took the scope from 60% to 95% before the ceiling existed.
  const SWEET_SPRINGS_HISTORY = {
    totalByCommodity: { site_prep: 60.02 },
    scoreByCommodity: { site_prep: 141 },
    typicalDailyByCommodity: { site_prep: 4.26 },
  };
  const bigDay = proposeForDay({
    day: day({ narrative: "Grubbing, 18 truck loads of debris out", crewCount: 6 }),
    commodities: PROP_COMMODITIES,
    history: SWEET_SPRINGS_HISTORY,
    committedPercent: { site_prep: 0 },
  });
  check(
    "PROP-12 a load-count spike is held to a typical confirmed day",
    bigDay.values[0]?.quantity === 4.26,
    JSON.stringify(bigDay.values)
  );
  check(
    "PROP-13 the basis says the number was held down",
    (bigDay.values[0]?.basis ?? "").includes("typical confirmed day")
  );

  // Road keywords flag the day for a human; they never produce footage.
  const roadDay = proposeForDay({
    day: day({ narrative: "Cleared debris off the access road, 4 loads", crewCount: 5 }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 60 },
  });
  check(
    "PROP-10 road mentions are flagged, never valued",
    roadDay.values.every((v) => v.commodityKey !== "road_install") &&
      roadDay.flags.some((f) => f.commodityKey === "road_install"),
    JSON.stringify(roadDay)
  );

  // A measured pin quantity is real data and outranks any keyword estimate.
  const pinned = proposeForDay({
    day: day({ narrative: "Grubbing, 5 loads out", crewCount: 6 }),
    commodities: PROP_COMMODITIES,
    history: HISTORY,
    committedPercent: { site_prep: 60 },
    pinQuantities: { piles: { quantity: 42, source: "5.2.1 Pile Driving" } },
  });
  check(
    "PROP-11 measured pin quantities are proposed as-is",
    pinned.values.some((v) => v.commodityKey === "piles" && v.quantity === 42),
    JSON.stringify(pinned.values)
  );

  // ---------- integration: provenance, not a gate ----------
  // The tracker reports the approved field record. An approved report's
  // production is filed the moment it is approved - it is not held pending a
  // second sign-off - so these tests assert the row is LIVE and that the only
  // thing provenance still changes is rate calibration.
  const { rows: confCols } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_name = 'daily_production'
        and column_name in ('confirmed_at','confirmed_by','proposal_basis')`
  );
  check(
    "CONF-01 the provenance columns exist",
    confCols.length === 3,
    `got ${confCols.map((c) => c.column_name).join(",")}`
  );

  // Written exactly as proposeProductionForReport writes it.
  await db.query(
    `insert into public.daily_production
       (project_id, commodity_id, production_date, quantity, source,
        proposal_basis, confirmed_at)
     values ($1, $2, '2026-08-25', 3.5, 'field_report', '5 loads, crew 6', now())`,
    [P1, pilesP1]
  );
  const { rows: pending } = await db.query<{ count: string }>(
    `select count(*)::text as count from public.daily_production
      where confirmed_at is null and production_date = '2026-08-25'`
  );
  check(
    "CONF-02 an approved report's production lands filed, not pending",
    pending[0].count === "0",
    `${pending[0].count} row(s) landed unconfirmed`
  );

  // The regression this whole change exists to prevent: an approved day reading
  // as no work done because nobody clicked a button.
  const { rows: billable } = await db.query<{ total: string }>(
    `select coalesce(sum(quantity),0)::text as total from public.daily_production
      where commodity_id = $1`,
    [pilesP1]
  );
  check(
    "CONF-03 an approved report's production counts toward billing evidence",
    Number(billable[0].total) >= 3.5,
    `billable total is ${billable[0].total}`
  );

  // Provenance still matters in exactly one place: the proposer calibrates its
  // daily rate from human-authored rows only. Feeding its own past output back
  // in would let one estimate justify the next.
  const { rows: calib } = await db.query<{ total: string }>(
    `select coalesce(sum(quantity),0)::text as total from public.daily_production
      where commodity_id = $1 and source in ('manual','backfill')`,
    [pilesP1]
  );
  check(
    "CONF-04 rate calibration excludes the proposer's own rows",
    !calib.some((r) => Number(r.total) >= 3.5),
    `calibration total is ${calib[0].total}, which includes the field_report row`
  );

  // ---------- every approval path fills the tracker ----------
  // A Field Report reaches 'approved' from two places. For a while only one of
  // them proposed production, so a report approved from the DPR review screen
  // filled nothing and the day read as zero work to the owner and to billing -
  // silently, because a blank row looks the same as a quiet day. Sweet Springs
  // 2026-08-24 was that bug in the wild.
  //
  // This is a source check rather than a behavioural one on purpose: the defect
  // was a MISSING CALL SITE, which no amount of testing the proposer itself
  // would ever have caught.
  const APPROVAL_PATHS = [
    join(SRC, "app/(app)/projects/[id]/dpr-actions.ts"),
    join(SRC, "app/(app)/projects/[id]/field-report-actions.ts"),
  ];
  for (const file of APPROVAL_PATHS) {
    const name = file.split("/").pop();
    let src = "";
    try {
      src = readFileSync(file, "utf8");
    } catch {
      src = "";
    }
    check(
      `PATH-${name} approving a report proposes the day's production`,
      src.includes("proposeProductionForReport"),
      `${name} sets a report to approved but never calls proposeProductionForReport`
    );
  }

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
