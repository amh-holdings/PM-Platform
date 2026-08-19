// Propose daily commodity production for dates that already have a Field
// Report, so the historical record can be reconstructed and reviewed.
//
// WHY THIS IS A PROPOSAL AND NOT AN IMPORT
//
// The subs' Field Reports predate commodity capture, so no commodity quantities
// were ever recorded. What exists is narrative plus pins whose quantities are
// truckloads of logs / pulpwood / chips tagged "EA" - not commodity units. So
// this script cannot read the numbers off anything; it classifies each day's
// work from keywords, shows the evidence it matched, and proposes a value the
// CM must confirm or correct before apply-backfill.ts writes anything.
//
// WHAT THE EVIDENCE SUPPORTS (Sweet Springs, Aug 2026)
//
// Only two of the eighteen commodities have any signal in this window:
//   Site Prep  - clearing, grubbing, logging, mulching, silt fence. The client's
//                roll-up labels this row "Site Prep (Silt Fence, Timbering
//                Clearing/Grubbing)", so silt fence belongs HERE, not under
//                Fencing. Fencing is the permanent perimeter fence, unstarted.
//   Civil Work - basins, diversion ditches, grading, stabilisation.
// The other sixteen are legitimately zero: that scope has not started.
//
// HOW THE PERCENT IS PROPOSED
//
// Both commodities with signal are percent-of-scope, and a percent cannot be
// counted off a narrative. So each working day gets an activity score (truck
// loads hauled + crew size), and the scope's assumed completion-to-date is
// distributed across days in proportion to that score. The completion-to-date
// figures are ASSUMPTIONS supplied on the command line, and they are printed at
// the top of the report so the reviewer is judging a stated assumption rather
// than a number that appeared from nowhere.
//
// Usage:
//   npx tsx scripts/commodity/propose-backfill.ts \
//     [--project-id <uuid>] [--from 2026-08-04] [--to 2026-08-18] \
//     [--site-prep-complete 60] [--civil-work-complete 15] [--out <path>]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { COMMODITIES } from "@/lib/commodities";
import { parseArgs, serviceClient } from "./lib";

// Keyword rules. Order matters: a day that mentions a basin or ditch is civil
// work even when the verb is "grubbing", because the scope is what classifies
// it, not the activity. Every matched keyword is reported as evidence.
const CIVIL_WORK_KEYWORDS = [
  "basin",
  "diversion",
  "ditch",
  "culvert",
  "grading",
  "stabiliz",
  "seeding",
  "swale",
  "riprap",
  "check dam",
];

const SITE_PREP_KEYWORDS = [
  "clearing",
  "grubbing",
  "grabbing", // recurring typo for "grubbing" in the CM logs
  "logging",
  "log load",
  "log truck",
  "pulpwood",
  "chip",
  "mulch",
  "silt fence",
  "timber",
  "lod",
  "limits of disturbance",
  "debris",
];

const ROAD_KEYWORDS = ["road", "entrance way", "entranceway", "access road"];

type DayEvidence = {
  date: string;
  reportStatus: string;
  crewCount: number | null;
  narrative: string;
  cmLog: string;
  pins: string[];
  /** Truck loads, taken as the higher of the two sources. */
  loads: number;
  loadsFromSub: number;
  loadsFromCm: number;
  sitePrepHits: string[];
  civilWorkHits: string[];
  roadHits: string[];
  score: number;
};

function matched(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k));
}

// Count truck loads in ONE source. Matches "7 log loads out", "2 loads of
// chips", "3 mulch trucks out", "5 truck loads of timber".
function countLoadsIn(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  const patterns = [
    /(\d+)\s+(?:\w+\s+){0,2}?loads?\b/g,
    /(\d+)\s+(?:\w+\s+){0,2}?trucks?\s+out\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100) total += n;
    }
  }
  return total;
}

// The sub's narrative and the CM's log describe the SAME trucks. Summing the two
// double-counts every day where both itemised the haul-off, and under-weights
// every day where only one of them did - which then skews the distributed
// percent toward whichever days happened to be written up twice. Take the
// higher of the two instead: the more complete account of one day's hauling.
function countLoads(narrative: string, cmLog: string): number {
  return Math.max(countLoadsIn(narrative), countLoadsIn(cmLog));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

async function main() {
  const args = parseArgs();
  const supabase = serviceClient();

  const from = args.flag("from") ?? "2026-08-04";
  const to = args.flag("to") ?? "2026-08-18";
  const sitePrepComplete = Number(args.flag("site-prep-complete") ?? 60);
  const civilWorkComplete = Number(args.flag("civil-work-complete") ?? 15);
  const outPath =
    args.flag("out") ?? `reports/commodity-backfill-proposal-${to}.html`;
  const jsonPath = outPath.replace(/\.html$/, ".json");

  console.log(`Window: ${from} to ${to}`);
  console.log(
    `Assumptions: Site Prep ${sitePrepComplete}% complete to date, Civil Work ${civilWorkComplete}%`
  );

  const { data: dprs, error: dprErr } = await supabase
    .from("dprs")
    .select("id, report_date, status, work_narrative, crew_count")
    .eq("project_id", args.projectId)
    .gte("report_date", from)
    .lte("report_date", to)
    .order("report_date", { ascending: true });
  if (dprErr) throw dprErr;
  if (!dprs?.length) {
    console.error(`No field reports between ${from} and ${to}`);
    process.exit(1);
  }

  const dprIds = dprs.map((d) => d.id);
  const [{ data: pins }, { data: cmLogs }] = await Promise.all([
    supabase
      .from("inspections")
      .select("dpr_id, title, quantity, unit_of_measure, status")
      .in("dpr_id", dprIds)
      .eq("origin", "sub"),
    supabase
      .from("cm_daily_logs")
      .select("log_date, progress_summary, site_conditions")
      .eq("project_id", args.projectId)
      .gte("log_date", from)
      .lte("log_date", to),
  ]);

  const pinsByDpr = new Map<string, string[]>();
  for (const p of pins ?? []) {
    if (!p.dpr_id) continue;
    const line = `${p.title} = ${p.quantity ?? "-"} ${p.unit_of_measure ?? ""} (${p.status})`;
    const existing = pinsByDpr.get(p.dpr_id);
    if (existing) existing.push(line);
    else pinsByDpr.set(p.dpr_id, [line]);
  }

  const cmByDate = new Map<string, string>();
  for (const l of cmLogs ?? []) {
    cmByDate.set(
      l.log_date,
      [l.progress_summary ?? "", l.site_conditions ?? ""].join("\n").trim()
    );
  }

  // ---- Build the evidence for each day ----
  const days: DayEvidence[] = dprs.map((d) => {
    const narrative = d.work_narrative ?? "";
    const cmLog = cmByDate.get(d.report_date) ?? "";
    const pinLines = pinsByDpr.get(d.id) ?? [];
    const combined = [narrative, cmLog, pinLines.join(" ")].join("\n");
    const loadsFromSub = countLoadsIn(narrative);
    const loadsFromCm = countLoadsIn(cmLog);
    const loads = countLoads(narrative, cmLog);
    const crew = d.crew_count ?? null;
    return {
      date: d.report_date,
      reportStatus: d.status,
      crewCount: crew,
      narrative,
      cmLog,
      pins: pinLines,
      loads,
      loadsFromSub,
      loadsFromCm,
      sitePrepHits: matched(combined, SITE_PREP_KEYWORDS),
      civilWorkHits: matched(combined, CIVIL_WORK_KEYWORDS),
      roadHits: matched(combined, ROAD_KEYWORDS),
      // Loads are the strongest production signal; crew size is a weak
      // tiebreaker so a day with people but no hauling still scores above zero.
      score: loads * 2 + (crew ?? 0) * 0.5,
    };
  });

  // ---- Distribute each percent scope across the days that show that scope ----
  function distribute(
    eligible: (d: DayEvidence) => boolean,
    totalPct: number
  ): Map<string, number> {
    const active = days.filter(eligible);
    const totalScore = active.reduce((sum, d) => sum + d.score, 0);
    const out = new Map<string, number>();
    if (active.length === 0 || totalPct <= 0) return out;
    for (const d of active) {
      // If nothing scored, fall back to an even split across active days so the
      // scope is still represented rather than silently dropped.
      const share =
        totalScore > 0 ? d.score / totalScore : 1 / active.length;
      out.set(d.date, round(totalPct * share));
    }
    return out;
  }

  const sitePrepByDate = distribute(
    (d) => d.sitePrepHits.length > 0,
    sitePrepComplete
  );
  const civilWorkByDate = distribute(
    (d) => d.civilWorkHits.length > 0,
    civilWorkComplete
  );

  // ---- Assemble the proposal ----
  type ProposedDay = {
    date: string;
    values: Record<string, number>;
    evidence: Record<string, string>;
  };

  const proposal: ProposedDay[] = days.map((d) => {
    const values: Record<string, number> = {};
    const evidence: Record<string, string> = {};
    for (const c of COMMODITIES) values[c.key] = 0;

    const sitePrep = sitePrepByDate.get(d.date);
    if (sitePrep != null && sitePrep > 0) {
      values.site_prep = sitePrep;
      evidence.site_prep = `${d.loads} load(s), crew ${d.crewCount ?? "?"}; matched: ${d.sitePrepHits.join(", ")}`;
    }
    const civilWork = civilWorkByDate.get(d.date);
    if (civilWork != null && civilWork > 0) {
      values.civil_work = civilWork;
      evidence.civil_work = `${d.loads} load(s), crew ${d.crewCount ?? "?"}; matched: ${d.civilWorkHits.join(", ")}`;
    }
    if (d.roadHits.length > 0) {
      // Flagged, not valued. Clearing debris off the entrance is a precursor to
      // road install, not road install - proposing footage here would invent it.
      evidence.road_install = `NOT VALUED - mentions ${d.roadHits.join(", ")} but this reads as debris clearing, not road construction. Confirm.`;
    }
    return { date: d.date, values, evidence };
  });

  // ---- Write the editable JSON ----
  const jsonDoc = {
    projectId: args.projectId,
    generatedFor: { from, to },
    assumptions: {
      sitePrepCompleteToDate: sitePrepComplete,
      civilWorkCompleteToDate: civilWorkComplete,
      note: "Daily percents are a distribution of these totals, weighted by truck loads and crew size. Correct any value below, then run apply-backfill.ts against this file.",
    },
    days: proposal.map((p) => ({ date: p.date, values: p.values })),
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(jsonDoc, null, 2));

  // ---- Write the review HTML ----
  const activeKeys = COMMODITIES.filter((c) =>
    proposal.some((p) => p.values[c.key] > 0 || p.evidence[c.key])
  );
  const zeroKeys = COMMODITIES.filter((c) => !activeKeys.includes(c));

  const rows = proposal
    .map((p) => {
      const day = days.find((d) => d.date === p.date)!;
      const cells = activeKeys
        .map((c) => {
          const v = p.values[c.key];
          const ev = p.evidence[c.key];
          return `<td class="num">${v > 0 ? v : "0"}${
            ev ? `<div class="ev">${escapeHtml(ev)}</div>` : ""
          }</td>`;
        })
        .join("");
      return `<tr>
        <td class="date">${p.date}<div class="ev">${escapeHtml(day.reportStatus)} &middot; crew ${day.crewCount ?? "?"} &middot; ${day.loads} loads (sub ${day.loadsFromSub} / CM ${day.loadsFromCm})</div></td>
        ${cells}
        <td class="src">
          <div><strong>Sub report:</strong> ${escapeHtml(day.narrative.slice(0, 300)) || "<em>none</em>"}</div>
          <div class="cm"><strong>CM log:</strong> ${escapeHtml(day.cmLog.slice(0, 300)) || "<em>none</em>"}</div>
          ${day.pins.length ? `<div class="cm"><strong>Pins:</strong> ${escapeHtml(day.pins.join(" | "))}</div>` : ""}
        </td>
      </tr>`;
    })
    .join("\n");

  const totalsRow = activeKeys
    .map((c) => {
      const total = proposal.reduce((s, p) => s + (p.values[c.key] ?? 0), 0);
      return `<td class="num total">${round(total)}</td>`;
    })
    .join("");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Commodity backfill proposal ${from} to ${to}</title>
<style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #666; margin-bottom: 16px; }
  .warn { background: #fff6e5; border: 1px solid #f0c67a; padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; }
  .warn strong { display: block; margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; text-align: left; }
  th { background: #f5f5f5; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; width: 110px; }
  td.total { font-weight: 600; background: #f9f9f9; }
  td.date { white-space: nowrap; font-weight: 600; }
  td.src { font-size: 11px; color: #444; max-width: 480px; }
  .cm { margin-top: 4px; }
  .ev { font-size: 10px; color: #888; font-weight: 400; margin-top: 3px; }
  .zeros { margin-top: 20px; font-size: 12px; color: #666; }
</style>
<h1>Commodity backfill proposal</h1>
<div class="sub">${from} to ${to} &middot; ${proposal.length} days with a field report</div>

<div class="warn">
  <strong>These numbers are proposed, not measured.</strong>
  No commodity quantities were captured at the time. Site Prep and Civil Work are
  percent-of-scope, so each day's value is a share of an assumed completion-to-date
  &mdash; <b>Site Prep ${sitePrepComplete}%</b>, <b>Civil Work ${civilWorkComplete}%</b> &mdash;
  distributed by truck loads hauled and crew size. Change those assumptions with
  <code>--site-prep-complete</code> / <code>--civil-work-complete</code>, or edit any
  individual value in the JSON. Nothing is written to the database until
  <code>apply-backfill.ts</code> is run against the corrected file.
</div>

<div class="warn">
  <strong>Known limitation in the load count.</strong>
  Loads are read out of free text, and a narrative that states a total and then
  breaks it down &mdash; &ldquo;Done 7 loads, 1 chips 3 logs 3 pulpwood&rdquo; &mdash;
  is counted twice, overweighting that day. Each row shows the sub and CM counts
  separately so you can see where the figure came from. Check any day whose two
  sources disagree sharply before accepting its percentage.
</div>

<table>
  <tr>
    <th>Date</th>
    ${activeKeys.map((c) => `<th>${escapeHtml(c.formColumn)}<div class="ev">${c.uom === "pct" ? "% (daily)" : c.uom}</div></th>`).join("")}
    <th>Evidence</th>
  </tr>
  ${rows}
  <tr><td class="date total">Total</td>${totalsRow}<td></td></tr>
</table>

<div class="zeros">
  <strong>Reported as zero for every day in this window (${zeroKeys.length} commodities):</strong>
  ${zeroKeys.map((c) => escapeHtml(c.formColumn)).join(", ")}.
  That scope has not started. Fencing is the permanent perimeter fence &mdash; the
  silt fence installed in August belongs under Site Prep, which is what the client's
  roll-up row "Site Prep (Silt Fence, Timbering Clearing/Grubbing)" is for.
</div>
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  console.log(`\nDays proposed: ${proposal.length}`);
  console.log(`Commodities with a proposed value: ${activeKeys.map((c) => c.formColumn).join(", ") || "none"}`);
  console.log(`\nReview grid: ${outPath}`);
  console.log(`Editable values: ${jsonPath}`);
  console.log("\nCorrect the JSON, then: npx tsx scripts/commodity/apply-backfill.ts --file " + jsonPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
