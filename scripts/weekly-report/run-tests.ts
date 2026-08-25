// Weekly progress report - known-answer test harness.
//
// Runs entirely locally against embedded Postgres (pglite, WASM). NEVER touches
// the hosted Supabase project. Two layers, mirroring scripts/commodity/run-tests.ts:
//   1. Integration: applies db/migrations/0041_weekly_progress_reports.sql into a
//      real Postgres and exercises the constraints and RLS the report relies on.
//      Migrations here are pasted by hand into the Supabase SQL editor, so
//      proving the file runs BEFORE it is pasted is the whole point.
//   2. Unit: the pure derivation logic in src/lib/weekly-report.ts, which is
//      what decides every number Dimension reads.
//
// Run: npx tsx scripts/weekly-report/run-tests.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  addDays,
  defaultPeriod,
  defaultWeekEnding,
  deriveContractors,
  deriveEquipment,
  deriveMilestones,
  deriveRisks,
  deriveSecurity,
  deriveWeather,
  deriveWorkThisWeek,
  dimensionDate,
  isSwppp,
  deriveSwppp,
} from "@/lib/weekly-report";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "..", "..", "db", "migrations", "0041_weekly_progress_reports.sql");

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

const P1 = "11111111-1111-1111-1111-111111111111";
const PHIL = "d0000000-0000-0000-0000-000000000001";
const MARK = "d0000000-0000-0000-0000-000000000002";
const FOREMAN = "d0000000-0000-0000-0000-00000000000a";
const SUB_A = "aaaaaaaa-0000-0000-0000-000000000001";

async function integration() {
  console.log("\nIntegration - migration 0041 against real Postgres");
  const db = new PGlite();

  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_uid', true), '')::uuid
    $$;
    create type user_role as enum
      ('phil','zarina','ahc_super','sub_pm','sub_foreman','owner','counsel');
    create table public.profiles (
      id uuid primary key, email text unique not null,
      role user_role not null default 'sub_foreman', subcontractor_id uuid
    );
    create table public.projects (id uuid primary key, name text not null);
    create or replace function public.current_user_role() returns public.user_role
      language sql security definer stable set search_path = public as $$
      select role from public.profiles where id = auth.uid();
    $$;
    create role authenticated;
    grant usage on schema public, auth to authenticated;
  `);

  const sql = readFileSync(MIGRATION, "utf8");
  await db.exec(sql);
  check("INT-01 migration 0041 applies cleanly into Postgres", true);
  await db.exec(sql);
  check("INT-02 migration 0041 is idempotent (applied twice)", true);

  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
  await db.exec(`
    insert into public.projects (id, name) values ('${P1}', 'MOCK - Weekly Report Project');
    insert into public.profiles (id, email, role, subcontractor_id) values
      ('${PHIL}',    'phil@amh.holdings', 'phil', null),
      ('${MARK}',    'mark@ahc.com',      'ahc_super', null),
      ('${FOREMAN}', 'fm@suba.com',       'sub_foreman', '${SUB_A}');
  `);

  await db.query(
    `insert into public.weekly_progress_reports (project_id, week_ending, period_start, period_end)
     values ($1, '2026-08-24', '2026-08-17', '2026-08-23')`,
    [P1],
  );
  check("INT-03 a draft report inserts", true);

  await expectBlocked("INT-04 a second report for the same week is rejected", () =>
    db.query(
      `insert into public.weekly_progress_reports (project_id, week_ending, period_start, period_end)
       values ($1, '2026-08-24', '2026-08-17', '2026-08-23')`,
      [P1],
    ),
  );

  // The upsert the save action uses has to land on that unique key.
  await db.query(
    `insert into public.weekly_progress_reports (project_id, week_ending, period_start, period_end, dimension_cm)
     values ($1, '2026-08-24', '2026-08-17', '2026-08-23', 'Matt Clark')
     on conflict (project_id, week_ending)
     do update set dimension_cm = excluded.dimension_cm`,
    [P1],
  );
  const cm = await db.query<{ dimension_cm: string }>(
    `select dimension_cm from public.weekly_progress_reports where project_id = $1`,
    [P1],
  );
  check("INT-05 upsert on (project, week) updates rather than forking", cm.rows[0].dimension_cm === "Matt Clark");

  await expectBlocked("INT-06 an inverted period is rejected", () =>
    db.query(
      `insert into public.weekly_progress_reports (project_id, week_ending, period_start, period_end)
       values ($1, '2026-09-07', '2026-09-06', '2026-08-31')`,
      [P1],
    ),
  );

  // The issue constraint: a report cannot claim to be issued without the frozen
  // copy of what was sent. That copy is the only defence when a field report is
  // corrected after the owner already has the PDF.
  await expectBlocked("INT-07 status=issued without a frozen payload is rejected", () =>
    db.query(
      `update public.weekly_progress_reports set status = 'issued', issued_at = now()
        where project_id = $1 and week_ending = '2026-08-24'`,
      [P1],
    ),
  );
  await db.query(
    `update public.weekly_progress_reports
        set status = 'issued', issued_at = now(), issued_payload = '{"work":"x"}'::jsonb
      where project_id = $1 and week_ending = '2026-08-24'`,
    [P1],
  );
  check("INT-08 issuing with a frozen payload succeeds", true);

  await expectBlocked("INT-09 a draft cannot keep a stale frozen payload", () =>
    db.query(
      `update public.weekly_progress_reports set status = 'draft'
        where project_id = $1 and week_ending = '2026-08-24'`,
      [P1],
    ),
  );

  // ---- RLS ----
  await db.exec(`set role authenticated;`);

  await db.exec(`select set_config('app.current_uid', '${PHIL}', false);`);
  const philRows = await db.query(`select id from public.weekly_progress_reports`);
  check("RLS-01 Phil reads the weekly report", philRows.rows.length === 1);

  await db.exec(`select set_config('app.current_uid', '${MARK}', false);`);
  const cmRows = await db.query(`select id from public.weekly_progress_reports`);
  check("RLS-02 the CM reads the weekly report", cmRows.rows.length === 1);

  // The document goes to the owner over AHC's name. A sub contributes through
  // their field report, which is reviewable - not by editing this.
  await db.exec(`select set_config('app.current_uid', '${FOREMAN}', false);`);
  const subRows = await db.query(`select id from public.weekly_progress_reports`);
  check("RLS-03 a subcontractor cannot read the weekly report", subRows.rows.length === 0);

  await expectBlocked("RLS-04 a subcontractor cannot insert a weekly report", () =>
    db.query(
      `insert into public.weekly_progress_reports (project_id, week_ending, period_start, period_end)
       values ($1, '2026-09-14', '2026-09-07', '2026-09-13')`,
      [P1],
    ),
  );

  await db.exec(`reset role;`);
}

function unit() {
  console.log("\nUnit - the derivation logic");

  // ---- dates ----
  // The case that motivated storing the period separately: Sweet Springs files
  // on a Monday for the week that ended the Friday before.
  const p = defaultPeriod("2026-08-24"); // a Monday
  check(
    "DATE-01 a Monday week-ending covers the previous Mon-Sun",
    p.start === "2026-08-17" && p.end === "2026-08-23",
    `got ${p.start}..${p.end}`,
  );
  const pSun = defaultPeriod("2026-08-23"); // a Sunday
  check(
    "DATE-02 a Sunday week-ending covers the week it closes",
    pSun.start === "2026-08-17" && pSun.end === "2026-08-23",
    `got ${pSun.start}..${pSun.end}`,
  );
  check("DATE-03 defaultWeekEnding walks back to Sunday", defaultWeekEnding("2026-08-25") === "2026-08-23");
  check("DATE-04 dimensionDate matches the form's format", dimensionDate("2026-08-24") === "24-Aug-26", dimensionDate("2026-08-24"));
  check("DATE-05 addDays crosses a month boundary", addDays("2026-08-31", 1) === "2026-09-01");

  // ---- contractors ----
  const subs = [
    { id: SUB_A, company_name: "Pyramid Excavation LLC", trade: "Civil", active: true },
    { id: "sub-b", company_name: "LV Electrical", trade: "Electrical", active: true },
  ];
  const dprs = [
    mkDpr("d1", "2026-08-17", SUB_A, "Cleared basin 1.", 6),
    mkDpr("d2", "2026-08-19", SUB_A, "Chipped brush, hauled 2 log loads.", 8),
    mkDpr("d3", "2026-08-21", SUB_A, "Culvert at front entrance.", 5),
  ];
  const manpower = [
    { dpr_id: "d1", subcontractor_id: SUB_A, trade: "Civil", headcount: 6, regular_hours: 60, ot_hours: 0 },
    { dpr_id: "d2", subcontractor_id: SUB_A, trade: "Civil", headcount: 8, regular_hours: 80, ot_hours: 4 },
    { dpr_id: "d3", subcontractor_id: SUB_A, trade: "Civil", headcount: 5, regular_hours: 50, ot_hours: 0 },
  ];
  const onsite = [
    { subcontractor_id: SUB_A, report_date: "2026-08-17" },
    { subcontractor_id: SUB_A, report_date: "2026-08-21" },
    { subcontractor_id: SUB_A, report_date: "2026-08-19" },
  ];

  const rows = deriveContractors(subs, dprs, manpower, onsite, [], {}, []);
  const pyramid = rows.find((r) => r.name === "Pyramid Excavation LLC")!;
  // Peak, not average and not last. The real report says 8 for this week.
  check("CON-01 headcount is the peak day", pyramid.headcount === 8, `got ${pyramid.headcount}`);
  check("CON-02 last date onsite is the latest report", pyramid.lastOnsite === "2026-08-21", `got ${pyramid.lastOnsite}`);
  check("CON-03 scope comes from the sub's trade", pyramid.scope === "Civil");
  check("CON-04 end date is blank when nothing knows it", pyramid.endDate === null);
  check("CON-05 the basis explains the number", pyramid.basis.includes("Peak of 8"), pyramid.basis);

  // A sub under contract who has never been on site is not a site resource.
  // Sweet Springs carries ten active subs and one crew actually working; listing
  // all ten with blank cells buries the one that matters.
  check("CON-06 a sub who has never been on site is not listed", !rows.some((r) => r.name === "LV Electrical"));
  check("CON-07 the sub who worked is listed", rows[0].name === "Pyramid Excavation LLC");

  // Demobbed subs stay: their last-onsite date is exactly what Dimension asks for.
  const demobbed = deriveContractors(
    subs, [], [], [{ subcontractor_id: "sub-b", report_date: "2026-06-04" }], [], {}, [],
  );
  const lv = demobbed.find((r) => r.name === "LV Electrical")!;
  check("CON-06b a sub with past history stays, showing when they left", lv?.lastOnsite === "2026-06-04");
  check("CON-06c a sub off site this period shows no headcount", lv?.headcount === null);

  // An override typed against a sub is a decision to put them on the report.
  const forced = deriveContractors(subs, [], [], [], [], { "sub-b": { endDate: "2026-11-01" } }, []);
  check("CON-06d a sub with an override typed against them is kept", forced.some((r) => r.name === "LV Electrical"));

  const overridden = deriveContractors(subs, dprs, manpower, onsite, [], {
    [SUB_A]: { headcount: 12, endDate: "2026-10-02" },
  }, []);
  const ov = overridden.find((r) => r.name === "Pyramid Excavation LLC")!;
  check("CON-08 an override wins over the derived headcount", ov.headcount === 12);
  check("CON-09 an overridden cell is flagged", ov.overridden.includes("headcount") && ov.overridden.includes("endDate"));

  const hidden = deriveContractors(
    subs, dprs, manpower, [...onsite, { subcontractor_id: "sub-b", report_date: "2026-08-18" }],
    [], { "sub-b": { hidden: true } }, [],
  );
  check("CON-10 a hidden sub is dropped even when they were on site", !hidden.some((r) => r.name === "LV Electrical"));

  // ---- equipment ----
  const equip = [
    { dpr_id: "d1", equipment_name: "Wood Chipper", quantity: 1, active: true, rental_company: null },
    { dpr_id: "d2", equipment_name: "Wood Chipper", quantity: 1, active: true, rental_company: null },
    { dpr_id: "d2", equipment_name: "Haul Truck", quantity: 3, active: true, rental_company: null },
    { dpr_id: "d3", equipment_name: "Haul Truck", quantity: 1, active: true, rental_company: null },
    { dpr_id: "d3", equipment_name: "Broken Dozer", quantity: 1, active: false, rental_company: null },
  ];
  const eq = deriveEquipment(dprs, equip, {}, []);
  check("EQ-01 quantity is the peak day", eq.find((e) => e.name === "Haul Truck")?.quantity === 3);
  check("EQ-02 the same machine on two days is one row", eq.filter((e) => e.name === "Wood Chipper").length === 1);
  // Listing an out-of-service machine as plant on site overstates the resource.
  check("EQ-03 inactive equipment is excluded", !eq.some((e) => e.name === "Broken Dozer"));

  // ---- security ----
  const quiet = deriveSecurity(dprs, []);
  check(
    "SEC-01 a clean week produces the no-incidents sentence",
    quiet.value.startsWith("There were no security concerns"),
    quiet.value,
  );
  const noReports = deriveSecurity([], []);
  // An empty box means "we did not fill this in". The sentence means "we
  // checked". With no reports at all, only the first claim is true.
  check("SEC-02 with no reports at all the box stays blank", noReports.value === "");
  const incident = deriveSecurity(
    [{ ...mkDpr("d9", "2026-08-20", SUB_A, "x", 4), near_miss: true, safety_narrative: "Truck reversed near a spotter." }],
    [],
  );
  check("SEC-03 a near miss is reported, not swallowed", incident.value.includes("Near miss") && incident.value.includes("spotter"));

  // The Sweet Springs case. The CM uses safety_notes as a general notepad, so
  // his POD meeting minutes live there. Letting unflagged prose REPLACE the
  // no-incidents sentence put "Pyramid exclamations it's going to start hauling
  // the brush out today" in the owner's Security Concerns box.
  const notepad = deriveSecurity(dprs, [
    { log_date: "2026-08-19", progress_summary: null, site_conditions: null,
      safety_notes: "POD meeting notes\nPyramid is going to start hauling the brush out today.",
      weather_conditions: null, temp_high: null, temp_low: null },
  ]);
  check(
    "SEC-04 an unflagged CM note does not replace the no-incidents statement",
    notepad.value.startsWith("There were no security concerns"),
    notepad.value.slice(0, 60),
  );
  check("SEC-05 the note is still carried, not silently dropped", notepad.value.includes("POD meeting notes"));
  check("SEC-06 the basis tells you to trim non-security notes", notepad.basis.includes("trim"), notepad.basis);

  // A real incident still leads, with unflagged notes underneath it.
  const both = deriveSecurity(
    [{ ...mkDpr("d8", "2026-08-20", SUB_A, "x", 4), safety_incident: true, safety_narrative: "Hand laceration." }],
    [{ log_date: "2026-08-20", progress_summary: null, site_conditions: null, safety_notes: "Toolbox talk held.", weather_conditions: null, temp_high: null, temp_low: null }],
  );
  check("SEC-07 a real incident leads and notes follow", both.value.startsWith("Thu, Aug 20 - Safety incident") && both.value.includes("Also noted:"));

  // ---- weather ----
  const wx = deriveWeather(
    [
      { ...mkDpr("w1", "2026-08-17", SUB_A, "", 4), weather_conditions: "Rain", temp_high: 78, temp_low: 64 },
      { ...mkDpr("w2", "2026-08-18", SUB_A, "", 4), weather_conditions: "Clear", temp_high: 91, temp_low: 70 },
    ],
    [],
  );
  check("WX-01 weather names the day a condition fell on", wx.value.includes("Rain") && wx.value.includes("Aug 17"), wx.value);
  check("WX-02 the temperature band spans the week", wx.value.includes("64-91"), wx.value);
  check("WX-03 no weather anywhere leaves the box blank", deriveWeather([], []).value === "");

  // ---- SWPPP ----
  check("SWP-01 a stormwater inspection is recognised by title", isSwppp({ inspection_type: null, title: "Storm Water walk" }));
  check("SWP-02 an unrelated inspection is not", !isSwppp({ inspection_type: "Rebar", title: "Pier 4" }));
  const stale = deriveSwppp(
    [{ inspection_type: "SWPPP", inspector_name: "Timmons", status: "approved", submitted_at: "2026-07-30T00:00:00Z", decided_at: null, created_at: null }],
    "2026-08-23",
  );
  check("SWP-03 the most recent inspection shows even when it predates the week", stale.value === "2026-07-30");
  // An overdue inspection reported as a bare date reads as compliant. It is not.
  check("SWP-04 an out-of-period inspection is flagged as possibly overdue", stale.basis.includes("BEFORE"), stale.basis);

  // ---- work this week ----
  const work = deriveWorkThisWeek(
    dprs,
    [{ log_date: "2026-08-20", progress_summary: "Surveyor set control points.", site_conditions: null, safety_notes: null, weather_conditions: null, temp_high: null, temp_low: null }],
    subs,
    [
      { production_date: "2026-08-19", commodity_id: "c1", quantity: 12, confirmed_at: "2026-08-20T00:00:00Z" },
      { production_date: "2026-08-20", commodity_id: "c1", quantity: 5, confirmed_at: null },
    ],
    [{ id: "c1", label: "Clearing", uom: "AC" }],
  );
  check("WORK-01 narratives are attributed to the sub", work.value.includes("Pyramid Excavation LLC: Cleared basin 1."));
  check("WORK-02 the CM log is included", work.value.includes("CM log: Surveyor set control points."));
  check("WORK-03 entries are in date order", work.value.indexOf("Cleared basin 1") < work.value.indexOf("Culvert at front"));
  // The owner reads these quantities. A proposed figure is one nobody has stood
  // behind yet, so it must not be totalled in.
  // Match the quantity line itself, not the whole blob - a bare `includes("17")`
  // also matches the "Aug 17" in the date column above it.
  const qtyLine = work.value.split("\n").find((l) => l.trim().startsWith("Clearing:")) ?? "";
  check("WORK-04 only confirmed quantities are totalled", qtyLine.trim() === "Clearing: 12 AC", `got "${qtyLine.trim()}"`);

  // Sweet Springs tracks 18 commodities and two moved this week. Printing the
  // other sixteen as "0 ea" buries them, and on the owner's copy it reads as a
  // claim the trade was worked and produced nothing.
  const zeros = deriveWorkThisWeek(
    dprs, [], subs,
    [
      { production_date: "2026-08-19", commodity_id: "c1", quantity: 3.69, confirmed_at: "x" },
      { production_date: "2026-08-19", commodity_id: "c2", quantity: 0, confirmed_at: "x" },
    ],
    [{ id: "c1", label: "Civil Work", uom: "%" }, { id: "c2", label: "Modules", uom: "ea" }],
  );
  check("WORK-05 a commodity with nothing installed is not listed", !zeros.value.includes("Modules"));
  check("WORK-06 a commodity that moved is listed", zeros.value.includes("Civil Work: 3.69 %"));

  // ---- risks ----
  const risks = deriveRisks(
    [
      { id: "c1", title: "Transformer not on site", category: "Material", owner: "Dimension", need_by: "2026-08-10", status: "open", wbs_code: "3.1" },
      { id: "c2", title: "Cleared already", category: "Access", owner: null, need_by: null, status: "cleared", wbs_code: null },
    ],
    [{ wbs_code: "4.2", task_name: "Pile driving", assigned_to: null, status: "In Progress", pct_complete: 40, end_date: null, is_at_risk: true }],
    [{ dpr_id: "d2", cause_code: "Weather", hours_lost: 4, narrative: "Rained out" }, { dpr_id: "d2", cause_code: "Material shortage", hours_lost: 2, narrative: "No stone" }],
    dprs,
    "2026-08-23",
  );
  check("RISK-01 an open constraint is listed", risks.value.includes("Transformer not on site"));
  check("RISK-02 a cleared constraint is not", !risks.value.includes("Cleared already"));
  check("RISK-03 a constraint past its need-by is flagged", risks.value.includes("PAST DUE"));
  check("RISK-04 an at-risk task is listed", risks.value.includes("Pile driving"));
  // Weather is reported under Environment. Repeating it here double-counts it.
  check("RISK-05 weather delays are not repeated here", !risks.value.includes("Rained out"));
  check("RISK-06 a non-weather delay is listed", risks.value.includes("No stone"));

  // ---- milestones ----
  const ms = deriveMilestones(
    [{ wbs_code: "9.1", task_name: "Substantial Completion", assigned_to: null, status: null, pct_complete: null, end_date: "2026-12-15", is_milestone: true }],
    { permissionToOperate: "2027-02-01" },
    { mechanicalCompletion: "2026-11-30" },
  );
  check("MS-01 an override wins", ms.mechanicalCompletion.value === "2026-11-30");
  check("MS-02 a schedule milestone is matched by name", ms.substantialCompletion.value === "2026-12-15");
  check("MS-03 last week's date carries forward when nothing matches", ms.permissionToOperate.value === "2027-02-01");
  check("MS-04 a carried date says so", ms.permissionToOperate.basis.includes("Carried forward"));
  check("MS-05 an unknown milestone is null, not a guess", ms.placedInService.value === null);
}

function mkDpr(
  id: string,
  date: string,
  sub: string,
  narrative: string,
  crew: number,
) {
  return {
    id,
    report_date: date,
    status: "approved",
    subcontractor_id: sub,
    work_narrative: narrative,
    crew_count: crew,
    total_man_hours: crew * 10,
    weather_conditions: null,
    temp_high: null,
    temp_low: null,
    safety_incident: false,
    near_miss: false,
    safety_narrative: null,
  };
}

async function main() {
  await integration();
  unit();
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
