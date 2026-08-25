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
  coverageGaps,
  defaultPeriod,
  autoSelectPhotos,
  compareWbs,
  deriveEnvironment,
  selectPhotoKeys,
  deriveManHours,
  deriveProjectPosition,
  deriveSafety,
  positionSentence,
  diffContractors,
  diffEquipment,
  diffMilestones,
  groupEquipmentNames,
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
  // A near miss is a SAFETY matter. It used to print in this box; it now prints
  // under Safety, and the security box must not claim anything about it.
  const nearMiss = deriveSecurity(
    [{ ...mkDpr("d9", "2026-08-20", SUB_A, "x", 4), near_miss: true, safety_narrative: "Truck reversed near a spotter." }],
    [],
  );
  check("SEC-03 a near miss is no longer reported in the security box", !nearMiss.value.includes("Near miss"), nearMiss.value);
  check("SEC-03b and the box still makes its own clean-week claim", nearMiss.value.startsWith("There were no security concerns"), nearMiss.value);

  // The CM uses safety_notes as a general notepad - his POD minutes live there -
  // and an earlier version let that prose REPLACE the no-concerns sentence, so
  // the owner's box would have read "Pyramid is going to start hauling the brush
  // out today". Prose is not a claim that anything went wrong.
  const notepad = deriveSecurity(dprs, [
    { log_date: "2026-08-19", progress_summary: null, site_conditions: null,
      safety_notes: "POD meeting notes\nPyramid is going to start hauling the brush out today.",
      weather_conditions: null, temp_high: null, temp_low: null },
  ]);
  check(
    "SEC-04 an unflagged CM note does not replace the no-concerns statement",
    notepad.value.startsWith("There were no security concerns"),
    notepad.value.slice(0, 60),
  );
  check("SEC-05 the security box only reports security matters", !notepad.value.includes("POD meeting notes"), notepad.value);
  check("SEC-06 the basis says safety is reported elsewhere", notepad.basis.includes("own box"), notepad.basis);

  // A theft IS a security matter and leads the box.
  const theft = deriveSecurity([], [
    { log_date: "2026-08-20", progress_summary: null, site_conditions: null,
      safety_notes: "Two generators stolen from the laydown yard overnight.",
      weather_conditions: null, temp_high: null, temp_low: null },
  ]);
  check("SEC-07 a theft is reported here", theft.value.includes("stolen") && !theft.value.includes("no security concerns"), theft.value);
  check("SEC-08 the basis warns a keyword match is not a finding", theft.basis.includes("not a finding"), theft.basis);

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
  // The box is grouped by contractor now, not listed by day. It used to be one
  // dated line per report, which was complete and unreadable - and unreadable
  // loses, because this is the one box the owner actually reads.
  check(
    "WORK-01 each contractor gets a heading with their days on site",
    work.value.includes("Pyramid Excavation LLC - 3 days on site:"),
    work.value,
  );
  check(
    "WORK-03 a contractor's work reads as one sentence list, not dated lines",
    work.value.includes(
      "Cleared basin 1; chipped brush, hauled 2 log loads; culvert at front entrance.",
    ),
    work.value,
  );
  check(
    "WORK-03b the day prefix is gone from the narrative lines",
    !work.value.includes("Aug 19 - "),
    work.value,
  );
  // The CM log is an internal record - POD minutes, phone calls, what a
  // surveyor quoted per pole. One real week of it ran to nine hundred words and
  // carried AHC's own subcontractor pricing. It belongs in the evidence panel,
  // not auto-pasted into a document addressed to the owner.
  check(
    "WORK-02 the CM log is NOT pasted into the owner's draft",
    !work.value.includes("Surveyor set control points"),
    work.value,
  );
  check(
    "WORK-02b the basis says the CM log was left out and where to find it",
    work.basis.includes("left out on purpose"),
    work.basis,
  );
  // A blank box is worse than a long one, so a week with no contractor
  // narrative at all falls back to the log.
  {
    const cmOnly = deriveWorkThisWeek(
      [],
      [{ log_date: "2026-08-20", progress_summary: "Surveyor set control points.", site_conditions: null, safety_notes: null, weather_conditions: null, temp_high: null, temp_low: null }],
      subs,
      [],
      [],
    );
    check("WORK-02c with no contractor narrative the CM log fills the box", cmOnly.value.includes("Surveyor set control points"), cmOnly.value);
    check("WORK-02d and the basis says so", cmOnly.basis.includes("No contractor filed"), cmOnly.basis);
  }
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

  // ---- the save round trip: overrides must survive a second Save ----
  //
  // This is the regression that shipped. The diff was taken against the
  // RESOLVED report - the derivation with the human's own corrections already
  // folded in - so an override left alone equalled its own baseline, was
  // dropped as "same as derived", and the next Save deleted it. End date was
  // the worst case: the one column with no derivation at all.
  {
    const msTasks = [
      { wbs_code: "9.1", task_name: "Substantial Completion", assigned_to: null, status: null, pct_complete: null, end_date: "2026-12-15", is_milestone: true },
    ];
    const base = deriveContractors(subs, dprs, manpower, onsite, [], {}, []);
    const withOverride = deriveContractors(
      subs, dprs, manpower, onsite, [],
      { [SUB_A]: { endDate: "2026-10-02", headcount: 11, scope: "Civil - clearing" } },
      [],
    );

    // Save #1: the human types the three cells.
    const first = diffContractors(withOverride, base);
    check("SAVE-01 a typed end date is stored", first.overrides[SUB_A]?.endDate === "2026-10-02", JSON.stringify(first.overrides));
    check("SAVE-02 a typed headcount is stored", first.overrides[SUB_A]?.headcount === 11);
    check("SAVE-03 a typed scope is stored", first.overrides[SUB_A]?.scope === "Civil - clearing");

    // Save #2: the form reloads showing those values and the human presses Save
    // again without touching anything. The overrides must still be there.
    const second = diffContractors(withOverride, base);
    check("SAVE-04 a second save does not erase the end date", second.overrides[SUB_A]?.endDate === "2026-10-02", JSON.stringify(second.overrides));
    check("SAVE-05 a second save does not erase the headcount", second.overrides[SUB_A]?.headcount === 11);
    check("SAVE-06 a second save does not erase the scope", second.overrides[SUB_A]?.scope === "Civil - clearing");

    // A cell put back to what the platform says stops being an override, so a
    // late field report can move the number again.
    const reset = diffContractors(base, base);
    check("SAVE-07 resetting a cell clears the override", !reset.overrides[SUB_A]);

    // A row deleted from the table stays deleted.
    const deleted = diffContractors(base.filter((r) => r.key !== SUB_A), base);
    check("SAVE-08 a deleted contractor is recorded as hidden", deleted.overrides[SUB_A]?.hidden === true);
    // ...including on the next save, when the derivation no longer offers it.
    const hiddenBase = deriveContractors(subs, dprs, manpower, onsite, [], { [SUB_A]: { hidden: true } }, []);
    const stillHidden = diffContractors(hiddenBase, base);
    check("SAVE-09 a hidden contractor stays hidden on the next save", stillHidden.overrides[SUB_A]?.hidden === true);

    const eqBase = deriveEquipment(dprs, equip, {}, []);
    const eqKey = eqBase[0]?.key ?? "";
    const eqOver = deriveEquipment(dprs, equip, { [eqKey]: { quantity: 9 } }, []);
    const eqSecond = diffEquipment(eqOver, eqBase);
    check("SAVE-10 a second save does not erase an equipment quantity", eqSecond.overrides[eqKey]?.quantity === 9, JSON.stringify(eqSecond.overrides));

    const msBase = deriveMilestones(msTasks, {}, {});
    const kept = diffMilestones({ mechanicalCompletion: "2026-12-15" }, msBase);
    check("SAVE-11 a milestone date that differs from the schedule is stored", kept.mechanicalCompletion === "2026-12-15");
    const keptAgain = diffMilestones({ mechanicalCompletion: "2026-12-15" }, msBase);
    check("SAVE-12 a second save does not erase a milestone override", keptAgain.mechanicalCompletion === "2026-12-15", JSON.stringify(keptAgain));

    // The proof of the original bug, kept as a test so the reason cannot be
    // refactored away: diffing against the RESOLVED report - which is what the
    // save action used to do - loses the override, because the override is
    // sitting in the baseline being compared against.
    const wrongBaseline = diffContractors(withOverride, withOverride);
    check(
      "SAVE-14 diffing against the resolved report is what erased the override",
      !wrongBaseline.overrides[SUB_A],
      "if this now HAS an override the diff is no longer baseline-sensitive and SAVE-04 proves nothing",
    );

    const dropped = diffMilestones({ substantialCompletion: msBase.substantialCompletion.value ?? "" }, msBase);
    check("SAVE-13 a milestone equal to the schedule is not stored", !dropped.substantialCompletion, JSON.stringify(dropped));
  }

  // ---- equipment: one row per machine, not one per spelling ----
  //
  // A month of real Sweet Springs reports carried 34 spellings of nine
  // machines, and grouping on the exact string printed all 34 on the owner's
  // Equipment table.
  {
    const REAL = ["620 skidder","Devlon excavator","Develon 350","John Deere 750","Devlon 350","Develon 235","Knuckleboom","953 loader","250 tigercat","Cat 730","724 tiger cat cutter","953 cat front end loader","John Deere 60 mini excavator","Tigercat 250 knuckleboom","Dodson excavator","Tigercat 620 skidder","250 tigercat loader","Tigercat 250 loader","John Deere mini excavator","Tigercat 250","620 tigercat","750k bull dozer","953 cat","Tiger cat loader 250","620 tigercat skidder","Bulldozer","Devlon excvator","Off-road dumptruck","350 develon","235 Develon1","Cat 953","John Deere 60 mini","John Deere 60","Cat 299"];
    const { keyOf, display, variants } = groupEquipmentNames(REAL);
    const rowCount = new Set(Array.from(keyOf.values())).size;
    check(`EQG-01 34 field spellings collapse to about a dozen machines (got ${rowCount})`, rowCount <= 14 && rowCount >= 8, `${rowCount} rows`);

    const keyFor = (n: string) => keyOf.get(n);
    check("EQG-02 the skidder's four spellings are one machine", new Set(["620 skidder","620 tigercat","620 tigercat skidder","Tigercat 620 skidder"].map(keyFor)).size === 1);
    check("EQG-03 the 250 knuckleboom's spellings are one machine", new Set(["250 tigercat","Tigercat 250","Tigercat 250 loader","Tiger cat loader 250","Knuckleboom"].map(keyFor)).size === 1);
    check("EQG-04 a bare type word joins the only machine of that type", keyFor("Bulldozer") === keyFor("John Deere 750"));
    check("EQG-05 a typo joins its machine", keyFor("Devlon excvator") === keyFor("Devlon excavator"));
    check("EQG-06 Doosan, Develon and Devlon are one make", keyFor("Dodson excavator") === keyFor("Devlon excavator"));
    // Two different model numbers are two different machines. Merging them
    // would understate the fleet, which is the opposite error but still wrong.
    check("EQG-07 the 350 and the 235 stay apart", keyFor("Develon 350") !== keyFor("Develon 235"));
    check("EQG-08 the display name is not the typo", display.get(keyFor("Develon 235")!) === "Develon 235", display.get(keyFor("Develon 235")!));
    check("EQG-09 the display name is the most informative spelling", display.get(keyFor("620 skidder")!) === "Tigercat 620 skidder", display.get(keyFor("620 skidder")!));
    check("EQG-10 the merged spellings are reported for review", (variants.get(keyFor("620 skidder")!) ?? []).length === 4);
  }

  // Two spellings of one machine on ONE day is one machine, not two. Summing
  // across spellings is what inflated the fleet.
  {
    const dupDay = deriveEquipment(
      [mkDpr("x1", "2026-08-19", SUB_A, "", 4)],
      [
        { dpr_id: "x1", equipment_name: "620 skidder", quantity: 1, active: true, rental_company: null },
        { dpr_id: "x1", equipment_name: "Tigercat 620 skidder", quantity: 1, active: true, rental_company: null },
      ],
      {}, [],
    );
    check("EQG-11 one machine described twice in a day counts once", dupDay.length === 1 && dupDay[0].quantity === 1, JSON.stringify(dupDay));

    const twoReal = deriveEquipment(
      [mkDpr("x2", "2026-08-19", SUB_A, "", 4)],
      [
        { dpr_id: "x2", equipment_name: "620 skidder", quantity: 1, active: true, rental_company: null },
        { dpr_id: "x2", equipment_name: "620 skidder", quantity: 1, active: true, rental_company: null },
      ],
      {}, [],
    );
    check("EQG-12 two lines of the same spelling really is two machines", twoReal[0]?.quantity === 2, JSON.stringify(twoReal));
  }

  // ---- environment is not weather ----
  //
  // The box used to be built from the CM's site-conditions notes plus every
  // weather delay, which on this project made it a copy of the Weather box.
  {
    const wet = [
      { log_date: "2026-08-17", progress_summary: null, site_conditions: "Wet muddy and slick", safety_notes: null, weather_conditions: "Rain", temp_high: 80, temp_low: 70 },
      { log_date: "2026-08-18", progress_summary: null, site_conditions: "Dry and good to go", safety_notes: null, weather_conditions: "Clear", temp_high: 88, temp_low: 71 },
    ];
    const period = { start: "2026-08-17", end: "2026-08-23" };
    const clean = deriveEnvironment(wet, dprs, [{ dpr_id: "d1", cause_code: "weather", hours_lost: 8, narrative: "Rained out" }], [], period);
    // A wet week is weather, not an environmental concern - but the box must
    // never print blank on a form the owner reads, so a clean week gets a
    // sentence stating what was checked.
    check("ENV-01 a wet week is not reported as an environmental concern", !clean.value.includes("muddy") && !clean.value.includes("Wet"), clean.value);
    check("ENV-01b the box is never blank", clean.value.startsWith("No environmental concerns were identified"), clean.value);
    check("ENV-01c the sentence names what was searched", clean.value.includes("5 daily report and CM log notes filed during the period"), clean.value);
    check("ENV-02 the basis says where weather is reported", clean.basis.includes("own box"), clean.basis);
    // With nothing filed at all there is no clean week to claim.
    const nothing = deriveEnvironment([], [], [], [], period);
    check("ENV-02b with nothing filed it does not claim a clean week", !nothing.value.includes("No environmental concerns were identified") && nothing.value.includes("no environmental review"), nothing.value);

    const spill = deriveEnvironment(
      [{ ...wet[0], safety_notes: "Hydraulic fluid leak from the excavator, absorbent pads down." }],
      [], [], [], period,
    );
    check("ENV-03 a spill is an environmental concern", spill.value.includes("Hydraulic fluid leak"), spill.value);

    // Installing erosion control is progress. A failure of it is a finding.
    const install = deriveEnvironment([], [mkDpr("e1", "2026-08-18", SUB_A, "Silt fence is starting installation.", 6)], [], [], period);
    check("ENV-04 installing a silt fence is not a concern", !install.value.includes("starting installation"), install.value);
    const failed = deriveEnvironment([], [mkDpr("e2", "2026-08-18", SUB_A, "Silt fence washed out at basin 2.", 6)], [], [], period);
    check("ENV-05 a silt fence that failed is a concern", failed.value.includes("washed out"), failed.value);

    const badInsp = deriveEnvironment([], [], [], [
      { inspection_type: null, title: "5.1.1.6 Construct Basin 1 ESC", inspector_name: null, status: "rejected", submitted_at: null, decided_at: "2026-08-19T12:00:00Z", created_at: null },
    ], period);
    check("ENV-06 an ESC inspection that did not pass is a concern", badInsp.value.includes("Basin 1 ESC"), badInsp.value);
    const goodInsp = deriveEnvironment([], [], [], [
      { inspection_type: null, title: "5.1.1.6 Construct Basin 1 ESC", inspector_name: null, status: "approved", submitted_at: null, decided_at: "2026-08-19T12:00:00Z", created_at: null },
    ], period);
    check("ENV-07 an ESC inspection that passed is not a concern", !goodInsp.value.includes("not passed"), goodInsp.value);
    check("ENV-07b a passed inspection is counted as evidence of the clean week", goodInsp.value.includes("The erosion and sediment control inspection carried out during the period passed."), goodInsp.value);
  }

  // Weather delay hours have to land somewhere now that Environment does not
  // carry them, or removing them from Environment loses them entirely.
  {
    const wx2 = deriveWeather(
      [{ ...mkDpr("w9", "2026-08-17", SUB_A, "", 4), weather_conditions: "Rain", temp_high: 78, temp_low: 66 }],
      [],
      [{ dpr_id: "w9", cause_code: "weather", hours_lost: 6, narrative: "Rained out" }],
    );
    check("WX-04 weather delay hours are reported in the weather box", wx2.value.includes("6h lost"), wx2.value);
  }

  // ---- SWPPP naming ----
  // Matching only the literal acronym found NOTHING on this project: the CM
  // titles them "5.1.1.6 Construct Basin 1 ESC".
  check("SWP-05 an ESC inspection is recognised", isSwppp({ inspection_type: null, title: "5.1.1.6 Construct Basin 1 ESC" }));
  check("SWP-06 a silt fence inspection is recognised", isSwppp({ inspection_type: null, title: "5.1.1.5 Silt/Rock Fence Install" }));
  check("SWP-07 an unrelated haul inspection is not", !isSwppp({ inspection_type: null, title: "5.1.1.4 Debris Removal and Offsite Haul" }));
  check("SWP-08 'esc' inside another word does not count", !isSwppp({ inspection_type: null, title: "Escort vehicle check" }));

  // ---- the reporting window ----
  // A week-ending date late in the week used to be walked back to the previous
  // Sunday, so six worked days appeared in no report at all.
  {
    const mon = defaultPeriod("2026-08-24"); // Monday filing for the week before
    check("PER-01 a Monday filing covers the week that just ended", mon.start === "2026-08-17" && mon.end === "2026-08-23", JSON.stringify(mon));
    const sun = defaultPeriod("2026-08-23");
    check("PER-02 a Sunday date is the end of its own week", sun.start === "2026-08-17" && sun.end === "2026-08-23", JSON.stringify(sun));
    const fri = defaultPeriod("2026-08-21");
    check("PER-03 a Friday date ends on that Friday, not eleven days earlier", fri.end === "2026-08-21" && fri.start === "2026-08-15", JSON.stringify(fri));
    const sat = defaultPeriod("2026-08-22");
    check("PER-04 a Saturday date ends on that Saturday", sat.end === "2026-08-22", JSON.stringify(sat));
  }

  // ---- man-hours ----
  // Every field report already carried total_man_hours and nothing read it.
  {
    const hourly = [
      { ...mkDpr("h1", "2026-08-17", SUB_A, "", 4), total_man_hours: 36 },
      { ...mkDpr("h2", "2026-08-18", SUB_A, "", 6), total_man_hours: 57 },
    ];
    const allTime = [
      { report_date: "2026-08-10", total_man_hours: 100, crew_count: 10 },
      { report_date: "2026-08-17", total_man_hours: 36, crew_count: 4 },
      { report_date: "2026-08-18", total_man_hours: 57, crew_count: 6 },
      // After the period end. Cumulative is "to date", not "to now".
      { report_date: "2026-09-01", total_man_hours: 80, crew_count: 8 },
    ];
    const mh = deriveManHours(hourly, allTime, [], "2026-08-23");
    check("MH-01 the week's hours are summed", mh.value.week === 93, String(mh.value.week));
    check("MH-02 cumulative counts everything up to the period end", mh.value.cumulative === 193, String(mh.value.cumulative));
    check("MH-03 a report after the period end is not in the cumulative", mh.value.cumulative !== 273);
    check("MH-04 hours are not silently estimated when they were reported", !mh.value.estimated);

    // A report with no hours recorded falls back to crew x 8, and SAYS so - a
    // figure the owner may quote back should never be a silent guess.
    const guessed = deriveManHours(
      [{ ...mkDpr("h3", "2026-08-19", SUB_A, "", 5), total_man_hours: null }],
      [], [], "2026-08-23",
    );
    check("MH-05 a missing hours figure falls back to crew x 8", guessed.value.week === 40, String(guessed.value.week));
    check("MH-06 and the basis flags the estimate", guessed.value.estimated && guessed.basis.includes("estimated"), guessed.basis);

    // ---- safety, split out of security ----
    const clean = deriveSafety(hourly, [], mh.value);
    check("SAF-01 a clean week says so, with the hours behind it", clean.value.includes("No injuries") && clean.value.includes("93"), clean.value);
    const hurt = deriveSafety(
      [{ ...hourly[0], safety_incident: true, safety_narrative: "Laceration to the hand, first aid on site." }],
      [], mh.value,
    );
    check("SAF-02 a flagged incident leads the box", hurt.value.startsWith("Mon, Aug 17 - Safety incident"), hurt.value);
    check("SAF-03 an incident is not swallowed by the clean sentence", !hurt.value.includes("No injuries"));

    // The whole point of the split: an injury must not be filed under Security,
    // and a clean security week must not claim anything about safety.
    const sec = deriveSecurity(
      [{ ...hourly[0], safety_incident: true, safety_narrative: "Laceration to the hand." }],
      [],
    );
    check("SAF-04 an injury does not appear in the security box", !sec.value.includes("Laceration"), sec.value);
    check("SAF-05 the security sentence no longer claims anything about safety", !sec.value.toLowerCase().includes("safety incident"), sec.value);
    const breach = deriveSecurity([], [
      { log_date: "2026-08-18", progress_summary: null, site_conditions: null, safety_notes: "Found the main gate open at 6am, unauthorized entry suspected.", weather_conditions: null, temp_high: null, temp_low: null },
    ]);
    check("SAF-06 an actual security matter is reported", breach.value.includes("gate open"), breach.value);
    // The CM uses safety_notes as a general notepad - his POD minutes live
    // there - and that prose must not become a security finding.
    const notepad = deriveSecurity([], [
      { log_date: "2026-08-18", progress_summary: null, site_conditions: null, safety_notes: "POD meeting. Discussed hauling brush out today.", weather_conditions: null, temp_high: null, temp_low: null },
    ]);
    check("SAF-07 the CM's notepad prose is not a security finding", !notepad.value.includes("POD meeting"), notepad.value);

    // The real Sweet Springs entry. The CM uses safety_notes as a general
    // notepad, so carrying every note under the clean-week statement put his
    // POD minutes into the owner's Safety box.
    const podLog = [{
      log_date: "2026-08-19", progress_summary: null, site_conditions: null,
      safety_notes: "POD meeting notes\nPyramid is going to start hauling the brush out today. They're going to make a new pile towards the center of the field and work on getting the entrance and the Rough in Road.",
      weather_conditions: null, temp_high: null, temp_low: null,
    }];
    const podSafety = deriveSafety(hourly, podLog, mh.value);
    check("SAF-08 POD meeting minutes are not carried into the safety box", !podSafety.value.includes("POD meeting") && !podSafety.value.includes("Rough in Road"), podSafety.value);
    check("SAF-08b the clean-week statement still stands alone", podSafety.value.startsWith("No injuries") && !podSafety.value.includes("Noted in the logs"), podSafety.value);
    check("SAF-08c the basis says what was left out and where to find it", podSafety.basis.includes("left out as not being a safety matter"), podSafety.basis);

    // A note that genuinely reads as a hazard is still carried.
    const hazardLog = [{
      log_date: "2026-08-19", progress_summary: null, site_conditions: null,
      safety_notes: "Excavator working under the overhead line at the entrance, spotter assigned.",
      weather_conditions: null, temp_high: null, temp_low: null,
    }];
    const hazard = deriveSafety(hourly, hazardLog, mh.value);
    check("SAF-09 a genuine hazard note is still carried", hazard.value.includes("overhead line"), hazard.value);
    check("SAF-09b and it rides under the clean statement, not instead of it", hazard.value.startsWith("No injuries"), hazard.value);
  }

  // ---- where the project stands ----
  {
    const posTasks = [
      { wbs_code: "1.1", task_name: "Mobilize", assigned_to: null, status: null, pct_complete: 100, end_date: "2026-08-10", duration_days: 2 },
      { wbs_code: "1.2", task_name: "Clear and grub", assigned_to: null, status: null, pct_complete: 50, end_date: "2026-09-10", duration_days: 30 },
      { wbs_code: "1.3", task_name: "Punch list", assigned_to: null, status: null, pct_complete: 0, end_date: "2026-12-01", duration_days: 1 },
      // A milestone has no duration and must not be counted as work.
      { wbs_code: "9.1", task_name: "Substantial Completion", assigned_to: null, status: null, pct_complete: 0, end_date: "2026-12-15", duration_days: 0, is_milestone: true },
    ];
    const pos = deriveProjectPosition(
      posTasks,
      { plannedFinish: "2026-12-01", projectedFinish: "2026-12-08", finishSlipDays: 7 },
      [
        { id: "c1", label: "Fencing", uom: "ft", total_quantity: 1000, total_verified: false },
        { id: "c2", label: "Site Prep", uom: "%", total_quantity: 1, total_verified: false },
      ],
      [
        { production_date: "2026-08-19", commodity_id: "c1", quantity: 250, confirmed_at: "x" },
        { production_date: "2026-08-20", commodity_id: "c1", quantity: 150, confirmed_at: null },
        { production_date: "2026-08-20", commodity_id: "c2", quantity: 25, confirmed_at: "x" },
        { production_date: "2026-08-21", commodity_id: "c2", quantity: 35.02, confirmed_at: "x" },
      ],
    );
    // Duration-weighted: (2*1 + 30*0.5 + 1*0) / 33 = 17/33 = 51.5%. A plain
    // average of the percentages would say 50% and let a one-day punch item
    // count as much as a thirty-day grub.
    check("POS-01 percent complete is weighted by duration", pos.value.pctComplete === 51.5, String(pos.value.pctComplete));
    check("POS-02 milestones are not counted as work", pos.value.tasksTotal === 3, String(pos.value.tasksTotal));
    check("POS-03 finished activities are counted", pos.value.tasksComplete === 1);
    check("POS-04 the projected finish and slip come from the CPM", pos.value.projectedFinish === "2026-12-08" && pos.value.slipDays === 7);
    check("POS-05 the basis says how far behind plan", pos.basis.includes("7 days behind"), pos.basis);

    const fencing = pos.value.commodities.find((c) => c.label === "Fencing")!;
    check("POS-06 quantities to date are a percentage of the contract quantity", fencing.toDate === 250 && fencing.pct === 25, JSON.stringify(fencing));
    check("POS-07 unconfirmed production is not counted to date", fencing.toDate !== 400);
    // A placeholder contract total produces a real-looking percentage. Say so.
    check("POS-08 an unverified contract total is flagged provisional", fencing.provisional === true);
    check("POS-09 the basis warns about provisional totals", pos.basis.includes("provisional"), pos.basis);

    // A commodity measured in percent IS already a percentage - the tracker
    // records daily percentage points and total_quantity is 1 as a placeholder.
    // Dividing by it reported Site Prep as 6002% complete on the real project.
    const prep = pos.value.commodities.find((c) => c.label === "Site Prep")!;
    check("POS-08b percentage points are summed, not divided by a placeholder total", prep.pct === 60.02, JSON.stringify(prep));
    check("POS-08c a percent commodity is not flagged provisional", prep.provisional === false);

    const sentence = positionSentence(pos.value);
    check("POS-10 the printed sentence states percent complete", sentence.includes("51.5% complete"), sentence);
    check("POS-11 the printed sentence states the projected finish", sentence.includes("08-Dec-26") && sentence.includes("7 days behind current plan"), sentence);
    // The slip is measured against the working plan when no baseline exists,
    // and must not be dressed up as a baseline variance.
    check(
      "POS-13 with no baseline the slip is reported against the current plan",
      pos.value.finishBasis === "plan" && pos.basis.includes("behind the current plan"),
      pos.basis,
    );
    // And when there is no slip at all, the absence of a baseline is stated
    // outright rather than left to read as "on baseline".
    const onPlan = deriveProjectPosition(
      posTasks,
      { plannedFinish: "2026-12-01", projectedFinish: "2026-12-01", finishSlipDays: 0 },
      [], [],
    );
    check("POS-13b a clean finish says no baseline is set", onPlan.basis.includes("No baseline is set"), onPlan.basis);
    const withBase = deriveProjectPosition(
      posTasks.map((t) => ({ ...t, baseline_end: "2026-11-20" })),
      { plannedFinish: "2026-12-01", projectedFinish: "2026-12-08", finishSlipDays: 7 },
      [], [],
    );
    check("POS-14 a real baseline is measured against instead", withBase.value.finishBasis === "baseline" && withBase.value.slipDays === 18, JSON.stringify({ b: withBase.value.finishBasis, s: withBase.value.slipDays }));

    // Parent WBS rows carry the sum of their children's durations. Counting
    // them weights the same work several times over.
    const withParents = deriveProjectPosition(
      [{ wbs_code: "1", task_name: "All civil", assigned_to: null, status: null, pct_complete: 0, end_date: "2026-12-01", duration_days: 33 }, ...posTasks],
      { plannedFinish: null, projectedFinish: null, finishSlipDays: 0 },
      [], [],
    );
    check("POS-15 a parent WBS row is not counted as work", withParents.value.tasksTotal === 3 && withParents.value.pctComplete === 51.5, JSON.stringify({ t: withParents.value.tasksTotal, p: withParents.value.pctComplete }));

    const empty = deriveProjectPosition([], { plannedFinish: null, projectedFinish: null, finishSlipDays: 0 }, [], []);
    check("POS-12 no schedule means no invented percentage", empty.value.pctComplete === null && empty.basis.includes("no durationed work"), empty.basis);
  }

  // ---- choosing the photos ----
  //
  // The photo page first read `public.photos`, which has never held a row on any
  // project, so it reported "no photos" every week while the site was being
  // photographed daily. The photos live on inspections and CM daily logs, and
  // one real Sweet Springs week holds 64 of them.
  //
  // The rule is ONE PHOTO PER ACTIVITY. The owner reads a progress report
  // activity by activity, so eleven shots of Thursday is not the page they want.
  {
    const insp = (
      key: string,
      day: string,
      taskKey: string,
      side: "ahc" | "sub",
    ) => ({ key, day, who: taskKey, caption: null, source: "inspection" as const, taskKey, side });
    const log = (key: string, day: string) =>
      ({ key, day, who: "CM daily log", caption: null, source: "cmlog" as const, taskKey: null, side: null });

    const week = [
      // Basin 1 inspected twice in the week - one activity, not two.
      insp("insp:b1-mon-sub", "2026-08-17", "5.1.1.6", "sub"),
      insp("insp:b1-wed-sub", "2026-08-19", "5.1.1.6", "sub"),
      insp("insp:b1-wed-ahc", "2026-08-19", "5.1.1.6", "ahc"),
      insp("insp:b2-thu", "2026-08-20", "5.1.1.7", "ahc"),
      insp("insp:debris-tue", "2026-08-18", "5.1.1.4", "ahc"),
      insp("insp:yard-fri", "2026-08-21", "5.1.1.10", "sub"),
      // The bulk of what actually gets uploaded: general site shots.
      ...Array.from({ length: 40 }, (_, i) => log(`cmlog:${i}`, "2026-08-20")),
    ];

    const auto = autoSelectPhotos(week);
    check("PHO-01 one photo per activity, not one per day", auto.length === 4, JSON.stringify(auto));
    check("PHO-02 the same activity inspected twice is one photo", auto.filter((k) => k.startsWith("insp:b1")).length === 1, JSON.stringify(auto));
    // Later in the week shows how far the work actually got.
    check("PHO-03 the latest day wins within an activity", auto.some((k) => k.startsWith("insp:b1-wed")), JSON.stringify(auto));
    // On our own outbound document, our own verification photo leads.
    check("PHO-04 AHC's verification photo is preferred over the sub's", auto.includes("insp:b1-wed-ahc"), JSON.stringify(auto));
    check("PHO-05 forty general site shots do not crowd out the activities", !auto.some((k) => k.startsWith("cmlog:")), JSON.stringify(auto));
    // The page should read down the schedule, not at random.
    check("PHO-06 activities come out in WBS order", auto.join(",") === "insp:debris-tue,insp:b1-wed-ahc,insp:b2-thu,insp:yard-fri", auto.join(","));
    // 5.1.1.10 must sort after 5.1.1.7, not between 5.1.1.1 and 5.1.1.2.
    check("PHO-07 WBS sorts numerically, so 10 follows 7", compareWbs("5.1.1.10", "5.1.1.7") > 0);

    // A week with no inspection photos must not print a blank page.
    const logsOnly = [log("cmlog:a", "2026-08-17"), log("cmlog:b", "2026-08-17"), log("cmlog:c", "2026-08-19")];
    const fallback = autoSelectPhotos(logsOnly);
    check("PHO-08 with no activity photos it falls back to the general shots", fallback.length === 3, JSON.stringify(fallback));
    const spread = autoSelectPhotos(logsOnly, 2);
    check("PHO-09 the fallback spreads across days rather than taking one day", new Set(spread.map((k) => logsOnly.find((l) => l.key === k)!.day)).size === 2, JSON.stringify(spread));

    // A human choice wins outright, in date order, however it was clicked.
    const chosen = selectPhotoKeys(week, ["insp:yard-fri", "cmlog:3"]);
    check("PHO-10 a saved choice wins over the automatic selection", chosen.length === 2);
    // Activity photos lead, in WBS order; general site shots follow by date.
    check("PHO-11 an activity photo prints ahead of a general site shot", chosen[0] === "insp:yard-fri" && chosen[1] === "cmlog:3", JSON.stringify(chosen));
    const mixed = selectPhotoKeys(week, ["cmlog:5", "insp:yard-fri", "insp:debris-tue"]);
    check("PHO-11b a hand-picked set still reads down the schedule", mixed.join(",") === "insp:debris-tue,insp:yard-fri,cmlog:5", mixed.join(","));

    // A photo deleted from its inspection after the report was drafted must not
    // print as a gap on the owner's page.
    const stale = selectPhotoKeys(week, ["insp:b2-thu", "insp:deleted"]);
    check("PHO-12 a key with no photo behind it is dropped, not printed as a gap", stale.length === 1 && stale[0] === "insp:b2-thu", JSON.stringify(stale));

    check("PHO-13 no photos at all selects nothing rather than throwing", autoSelectPhotos([]).length === 0);
    check("PHO-14 the ceiling is respected when a week has many activities", autoSelectPhotos(
      Array.from({ length: 30 }, (_, i) => insp(`insp:t${i}`, "2026-08-19", `5.2.${i}`, "ahc")),
    ).length === 12);
  }

  // ---- coverage gaps ----
  // On a five-day week the banner used to say "2 days have no field report"
  // every single week, because it counted the weekend.
  {
    const covered = new Set(["2026-08-17", "2026-08-18", "2026-08-20", "2026-08-21"]);
    const five = coverageGaps("2026-08-17", "2026-08-23", covered, 5);
    check("GAP-01 the weekend is not a gap on a five-day week", !five.includes("2026-08-22") && !five.includes("2026-08-23"), JSON.stringify(five));
    check("GAP-02 a missed working day is a gap", five.includes("2026-08-19"), JSON.stringify(five));
    const six = coverageGaps("2026-08-17", "2026-08-23", covered, 6);
    check("GAP-03 Saturday is a gap on a six-day week", six.includes("2026-08-22"), JSON.stringify(six));
    const holiday = coverageGaps("2026-08-17", "2026-08-23", covered, 5, new Set(["2026-08-19"]));
    check("GAP-04 a calendar holiday is not a gap", !holiday.includes("2026-08-19"), JSON.stringify(holiday));
  }
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
