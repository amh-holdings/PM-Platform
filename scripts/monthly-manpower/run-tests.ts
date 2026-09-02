/**
 * Checks on the Monthly Manpower and Incident Report derivation.
 *
 * Sweet Springs has no safety incidents on record, so the half of this report
 * that matters most has no live data to prove it against. These cases stand in
 * for that: they are the situations the owner's form has to be filled in for,
 * written down so a change to the keyword lists or the hours fallbacks cannot
 * quietly stop handling them.
 *
 * Run: npx tsx scripts/monthly-manpower/run-tests.ts
 */
import {
  buildSubmissions,
  defaultPeriodMonth,
  deriveIncidentCandidates,
  deriveManHours,
  diffIncidents,
  monthPeriod,
  readiness,
  resolveIncidents,
  stepMonth,
  type MonthlyCmLog,
  type MonthlyDpr,
} from "../../src/lib/monthly-manpower";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const SUBS = [{ id: "s1", company_name: "Pyramid Excavation LLC", trade: "Civil" }];

const dpr = (over: Partial<MonthlyDpr> & { id: string; report_date: string }): MonthlyDpr => ({
  status: "approved",
  subcontractor_id: "s1",
  crew_count: null,
  total_man_hours: null,
  safety_incident: false,
  near_miss: false,
  safety_narrative: null,
  work_narrative: null,
  ...over,
});

const log = (over: Partial<MonthlyCmLog> & { log_date: string }): MonthlyCmLog => ({
  safety_notes: null,
  progress_summary: null,
  ahc_headcount: null,
  ahc_man_hours: null,
  ...over,
});

console.log("\nPeriod helpers");
check("default month is the month just finished", defaultPeriodMonth("2026-09-02") === "2026-08-01");
check("default month rolls back over a year", defaultPeriodMonth("2026-01-14") === "2025-12-01");
check("month period ends on the last day", monthPeriod("2026-02-01").end === "2026-02-28");
check("leap February", monthPeriod("2028-02-01").end === "2028-02-29");
check("step back over a year", stepMonth("2026-01-01", -1) === "2025-12-01");

console.log("\nMan-hours");
{
  const h = deriveManHours(
    [
      dpr({ id: "a", report_date: "2026-08-05", total_man_hours: 72 }),
      dpr({ id: "b", report_date: "2026-08-06", crew_count: 8 }),
      dpr({ id: "c", report_date: "2026-08-07" }),
    ],
    [{ dpr_id: "z", subcontractor_id: "s1", trade: null, headcount: 2, regular_hours: 16, ot_hours: 0 }],
    [log({ log_date: "2026-08-05", ahc_man_hours: 10 }), log({ log_date: "2026-08-06" })],
    SUBS,
    true,
  );
  check("reported hours win", h.value.subHours === 136, h.value.subHours); // 72 + 64
  check("crew x 8 is used and flagged", h.gaps.some((g) => g.kind === "estimated"));
  check("a report with nothing is a missing gap", h.gaps.some((g) => g.day === "2026-08-07" && g.kind === "missing"));
  check("AHC hours are added on top", h.value.total === 146, h.value.total);
  check("a CM log with no hours is a missing gap", h.gaps.some((g) => g.day === "2026-08-06" && g.kind === "missing"));
  check("a recorded AHC day is marked recorded", h.value.perDay.find((d) => d.day === "2026-08-05")?.ahcRecorded === true);
  check("recorded AHC days are counted", h.value.ahcRecordedDays === 1, h.value.ahcRecordedDays);
  check("a recorded AHC month reports the days", h.basis.includes("10 AHC across 1 day"), h.basis);
  check("a per-day AHC gap stays day-scoped", h.gaps.find((g) => g.day === "2026-08-06")?.scope === "day");
  check("a sub-only day is not marked AHC-recorded", h.value.perDay.find((d) => d.day === "2026-08-07") === undefined);
}
{
  // The manpower breakdown is the second fallback, ahead of crew x 8.
  const h = deriveManHours(
    [dpr({ id: "a", report_date: "2026-08-05", crew_count: 4 })],
    [{ dpr_id: "a", subcontractor_id: "s1", trade: "Civil", headcount: 4, regular_hours: 36, ot_hours: 4 }],
    [],
    SUBS,
    true,
  );
  check("manpower rows beat crew x 8", h.value.subHours === 40, h.value.subHours);
  check("using manpower rows is not an estimate", h.gaps.length === 0, h.gaps);
}
{
  // A month where nobody has ever filled in AHC hours must raise ONE gap, not
  // one per working day.
  const logs = ["01", "02", "03", "04", "05"].map((d) => log({ log_date: `2026-08-${d}` }));
  // Sub hours present, so the basis reaches the AHC sentence instead of
  // short-circuiting on "the period recorded no hours at all".
  const h = deriveManHours(
    [dpr({ id: "a", report_date: "2026-08-04", total_man_hours: 72 })],
    [],
    logs,
    SUBS,
    true,
  );
  check("blanket AHC omission collapses to one gap", h.gaps.length === 1, h.gaps.length);
  check("and is scoped to the period, not to a day", h.gaps[0].scope === "period");
  check("no AHC day is counted as recorded", h.value.ahcRecordedDays === 0);
  // The bug this guards: an unrecorded month printed "0 AHC", which claims we
  // checked and found none rather than that nobody entered anything.
  check("an unrecorded AHC month never claims a figure", h.basis.includes("No AHC hours were recorded"), h.basis);
}
{
  const h = deriveManHours(
    [dpr({ id: "a", report_date: "2026-08-03", total_man_hours: 40 })],
    [],
    [log({ log_date: "2026-08-03" })],
    SUBS,
    false,
  );
  check("no AHC gaps raised before 0045 is applied", h.gaps.length === 0, h.gaps);
  check("basis says why AHC is absent", h.basis.includes("0045"), h.basis);
  check("the total is subs only", h.value.total === 40 && h.value.ahcHours === 0);
}

console.log("\nIncident candidates");
{
  const c = deriveIncidentCandidates(
    [
      dpr({ id: "a", report_date: "2026-08-05", safety_incident: true, safety_narrative: "Laborer took stitches at urgent care after a laceration." }),
      dpr({ id: "b", report_date: "2026-08-06", near_miss: true, safety_narrative: "Excavator swung close to a spotter. No injury." }),
      dpr({ id: "c", report_date: "2026-08-07", safety_narrative: "Toolbox talk on heat stress. All PPE in order." }),
      dpr({ id: "d", report_date: "2026-08-10", safety_narrative: "Dozer backed into the perimeter fence, damaged two panels." }),
    ],
    [
      log({ log_date: "2026-08-11", safety_notes: "Operator sent home after a strain, did not return to work." }),
      log({ log_date: "2026-08-12", safety_notes: "POD meeting - Pyramid moving the brush pile toward the center." }),
    ],
    SUBS,
  );
  const keys = c.value.map((x) => x.key);
  check("a flagged incident is raised", keys.includes("dpr:a"));
  check("a flagged near miss is raised", keys.includes("dpr:b"));
  check("a clean toolbox note is NOT raised", !keys.includes("dpr:c"), keys);
  check("damage wording is raised from an unflagged report", keys.includes("dpr:d"));
  check("a CM log injury note is raised", keys.includes("cm:2026-08-11"));
  check("CM meeting minutes are NOT raised", !keys.includes("cm:2026-08-12"), keys);

  // The strong/weak split: a hazard word inside a safety briefing is a topic,
  // the same word on its own is an event, and a strong word overrides both.
  const talk = deriveIncidentCandidates(
    [
      dpr({ id: "t1", report_date: "2026-08-13", safety_narrative: "Toolbox talk on heat stress. All PPE in order." }),
      dpr({ id: "t2", report_date: "2026-08-14", safety_narrative: "Laborer showing signs of heat stress, pulled off the face." }),
      dpr({ id: "t3", report_date: "2026-08-17", safety_narrative: "Toolbox talk on heat stress. Ruiz was taken to hospital that afternoon." }),
    ],
    [],
    SUBS,
  ).value.map((x) => x.key);
  check("a hazard word inside a safety talk is NOT raised", !talk.includes("dpr:t1"), talk);
  check("the same hazard word on its own IS raised", talk.includes("dpr:t2"), talk);
  check("a strong word overrides the talk context", talk.includes("dpr:t3"), talk);

  const byKey = new Map(c.value.map((x) => [x.key, x]));
  check("stitches suggest Recordable", byKey.get("dpr:a")!.suggestedTypes.includes("recordable"));
  check("the near-miss flag suggests Near Miss", byKey.get("dpr:b")!.suggestedTypes.includes("near_miss"));
  check("fence damage suggests Asset Damage", byKey.get("dpr:d")!.suggestedTypes.includes("asset_damage"));
  check("sent home suggests Lost Time", byKey.get("cm:2026-08-11")!.suggestedTypes.includes("lost_time"));
  check("a keyword find is not marked flagged", byKey.get("dpr:d")!.flagged === false);
  check("a suggestion does NOT classify it", resolveIncidents(c.value, {}, []).every((r) => !r.classified));
}

console.log("\nClassification round-trip");
{
  const candidates = deriveIncidentCandidates(
    [dpr({ id: "a", report_date: "2026-08-05", safety_incident: true, safety_narrative: "Cut hand, first aid on site." })],
    [],
    SUBS,
  ).value;

  // A classification that matches the suggestion is still a human decision and
  // must survive the diff - otherwise the next save silently unclassifies it.
  const suggested = candidates[0].suggestedTypes;
  const kept = diffIncidents({ "dpr:a": { types: suggested } }, candidates);
  check("a classification matching the suggestion is stored", kept["dpr:a"]?.types?.length === suggested.length);

  // A description left exactly as the narrative is not an override.
  const same = diffIncidents(
    { "dpr:a": { types: ["first_aid"], description: candidates[0].narrative } },
    candidates,
  );
  check("an untouched description is not stored", same["dpr:a"]?.description === undefined, same);

  const dismissed = diffIncidents({ "dpr:a": { hidden: true } }, candidates);
  check("a dismissal is stored", dismissed["dpr:a"]?.hidden === true);

  const cleared = diffIncidents({ "dpr:a": { types: [] } }, candidates);
  check("clearing every type drops the override", cleared["dpr:a"] === undefined, cleared);

  const bogus = diffIncidents({ "dpr:a": { types: ["not_a_type"] } }, candidates);
  check("an unknown type is discarded", bogus["dpr:a"] === undefined, bogus);
}

console.log("\nSubmissions and readiness");
{
  const candidates = deriveIncidentCandidates(
    [
      dpr({ id: "a", report_date: "2026-08-05", safety_incident: true, safety_narrative: "First aid." }),
      dpr({ id: "b", report_date: "2026-08-06", near_miss: true, safety_narrative: "Close call." }),
    ],
    [],
    SUBS,
  ).value;

  const unclassified = resolveIncidents(candidates, {}, []);
  const s1 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1302,
    hoursDerived: 1302,
    hoursOverridden: false,
    hoursNote: "",
    gaps: [],
    incidents: unclassified,
  });
  check("one submission per incident, plus the hours", s1.length === 3, s1.length);
  check("hours submission carries the form's date format", s1[0].fields.some((f) => f.value === "08/01/2026"));
  check("an unclassified incident blocks filing", !readiness(s1).ready);

  const classified = resolveIncidents(
    candidates,
    { "dpr:a": { types: ["first_aid"] }, "dpr:b": { types: ["near_miss"] } },
    [],
  );
  const s2 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1302,
    hoursDerived: 1302,
    hoursOverridden: false,
    hoursNote: "",
    gaps: [],
    incidents: classified,
  });
  check("classified incidents file clean", readiness(s2).ready, readiness(s2).blockers);
  check("the type prints as the form's label", s2[1].fields.some((f) => f.value === "First Aid"));

  // A dismissed candidate leaves the submission list entirely.
  const dismissed = resolveIncidents(candidates, { "dpr:a": { hidden: true }, "dpr:b": { types: ["near_miss"] } }, []);
  const s3 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1302,
    hoursDerived: 1302,
    hoursOverridden: false,
    hoursNote: "",
    gaps: [],
    incidents: dismissed,
  });
  check("a dismissed candidate is not filed", s3.length === 2, s3.length);
  check("the remaining incident is renumbered 1 of 1", s3[1].title.includes("1 of 1"), s3[1].title);

  // An override with no reason is a blocker in its own right.
  const s4 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1500,
    hoursDerived: 1302,
    hoursOverridden: true,
    hoursNote: "",
    gaps: [],
    incidents: [],
  });
  check("a bare override blocks filing", !readiness(s4).ready);
  const s5 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1500,
    hoursDerived: 1302,
    hoursOverridden: true,
    hoursNote: "Includes 198 hours from the survey crew, who file no DPR.",
    gaps: [],
    incidents: [],
  });
  check("an explained override files", readiness(s5).ready, readiness(s5).blockers);

  // A missing day is a blocker: the month reports fewer hours than were worked.
  const s6 = buildSubmissions({
    projectName: "Sweet Springs Solar",
    period: monthPeriod("2026-08-01"),
    hours: 1302,
    hoursDerived: 1302,
    hoursOverridden: false,
    hoursNote: "",
    gaps: [{ day: "2026-08-04", scope: "day", issue: "No hours.", kind: "missing" }],
    incidents: [],
  });
  check("a missing day blocks filing", !readiness(s6).ready);
}

console.log(failed === 0 ? "\nAll checks passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
