// Sussex civil section rebuilt from the Civil Task Sequence, 2026-11-12.
//
// Zarina: "Please update civil section in sussex schedule with this tasks.
// Follow predecessor and successor." Source: Civil_Task_Sequence_Sussex_CSG_1
// .docx, 53 tasks in three phases, each with its predecessors and successors
// written out.
//
// WBS. The document numbers from 5.1, which is where civil lives on SWEET
// SPRINGS (5.1 Civil Construction). Zarina: "If you can't find where it is
// referenced for WBS, you can refer sweet spring schedule as this sequence is
// from that project." On Sussex civil is 4.2 under 4 Construction, and its
// three phase summaries already match the document's three phases, so every
// code maps straight across:
//   5.1.1.x -> 4.2.1.x   Phase 1, initial controls and clearing
//   5.1.2.x -> 4.2.2.x   Phase 2, roads, culverts and utilities
//   5.1.3.x -> 4.2.3.x   Phase 3, fence and final stabilisation
//
// REPLACES the 20 coarse rows under 4.2 (4.2.1.01 .. 4.2.3.07). The three
// phase summaries stay, so anything linked to 4.2 or 4.2.2 as a summary is
// untouched.
//
// TWO MILESTONES ARE CARRIED OVER, not invented. The document has no
// milestones, but three tasks outside civil depend on one:
//   3.21  Equipment pads accepted and released   <- 4.2.2.06
//   4.4.01 Electrical field start                <- 4.2.2.06
//   4.3.02 Pile Unloading                        <- 4.2.2 (summary, survives)
// So "Site released for pile install" keeps its code and now follows the 20'
// road GABC, which the document names as the hand-off that releases swales,
// trenching, fence and pads. "District initial inspection" likewise keeps its
// code and closes Phase 1.
//
// TWO LINKS THE DOCUMENT NAMES IN PROSE ARE WIRED TO REAL ROWS:
//   "(and DNREC approval)" on the 36" crossing -> 2.2.3.5 Meadow Branch Tax
//      Ditch LONO, which is the tax ditch permit
//   "(and PV install complete)" on final grade -> 4.3.15 Module Installation
//
// TWO ROWS NOT IN THE DOCUMENT ARE KEPT because the work is real and already
// scheduled: vegetation establishment to 70% cover (the document names 70%
// cover as the gate on removing controls) and as-builts / closeout.
//
// DURATIONS ARE NOT IN THE DOCUMENT. They are split from the coarse rows
// being replaced, so the civil window stays about where it is rather than
// being re-baselined off a document that only carries logic. Every one is a
// working day and every one is a guess to be corrected - that is why this is
// a dry run by default.
//
//   npx tsx scripts/schedule/rebuild-sussex-civil-2026-11-12.mts
//   npx tsx scripts/schedule/rebuild-sussex-civil-2026-11-12.mts --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadScheduleContext, syncScheduleDates } from "@/lib/schedule-sync-server";
import { planScheduleSync } from "@/lib/schedule-sync";
import type { CpmInput } from "@/lib/schedule-cpm";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";

// .env.local on the Mac Mini, the environment's own variables in a cloud
// session, where there is no .env.local.
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
try {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1);
  }
} catch {
  // No .env.local. The environment variables above are the source.
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const LONO = "2.2.3.5";   // DNREC Meadow Branch Tax Ditch LONO
const MODULES = "4.3.15"; // Module Installation, the "PV install complete" gate

type Row = { wbs: string; name: string; days: number; pred?: string; milestone?: boolean };

// Phase 1 - initial controls and clearing. Replaces 4.2.1.01 .. 4.2.1.05.
const PHASE1: Row[] = [
  { wbs: "4.2.1.1",   name: "Survey & stake LOD, wetlands, 25 ft buffers", days: 2, pred: "4.1, 2.2.1.3, 2.2.1.4" },
  { wbs: "4.2.1.2",   name: "Temporary widened driveway (R50 ft)", days: 2, pred: "4.2.1.1" },
  { wbs: "4.2.1.3",   name: "Stabilized construction entrance", days: 2, pred: "4.2.1.2" },
  { wbs: "4.2.1.4.1", name: "Silt fence install", days: 3, pred: "4.2.1.3" },
  { wbs: "4.2.1.4.2", name: "Straw bale barriers", days: 1, pred: "4.2.1.4.1" },
  { wbs: "4.2.1.4.3", name: "Sensitive area / wetland protection", days: 2, pred: "4.2.1.3" },
  { wbs: "4.2.1.5",   name: "Concrete washout", days: 1, pred: "4.2.1.4.2, 4.2.1.4.3" },
  { wbs: "4.2.1.6.1", name: "Tree clearing (0.65 ac)", days: 3, pred: "4.2.1.4.2, 4.2.1.4.3" },
  { wbs: "4.2.1.6.2", name: "Grub & haul debris", days: 4, pred: "4.2.1.6.1" },
  { wbs: "4.2.1.7.1", name: "Strip topsoil", days: 3, pred: "4.2.1.6.2" },
  { wbs: "4.2.1.7.2", name: "Stockpile protection", days: 1, pred: "4.2.1.7.1" },
  { wbs: "4.2.1.8.1", name: "Laydown yard - subgrade prep", days: 2, pred: "4.2.1.6.2" },
  { wbs: "4.2.1.8.2", name: "Laydown yard - geotextile", days: 1, pred: "4.2.1.8.1" },
  { wbs: "4.2.1.8.3", name: "Laydown yard - 12 in GABC place & compact", days: 3, pred: "4.2.1.8.2" },
  { wbs: "4.2.1.9",   name: "Temporary seed & mulch", days: 2, pred: "4.2.1.7.2" },
  // Carried over. Closes Phase 1 once the controls, the washout and the
  // laydown pad are in.
  { wbs: "4.2.1.05",  name: "District initial inspection", days: 0, milestone: true,
    pred: "4.2.1.5, 4.2.1.8.3, 4.2.1.9" },
];

// Phase 2 - roads, culverts and utilities. Replaces 4.2.2.01 .. 4.2.2.05.
const PHASE2: Row[] = [
  { wbs: "4.2.2.1.1", name: "12 in culvert - excavate & bed pipe", days: 1, pred: "4.2.1.8.3" },
  { wbs: "4.2.2.1.2", name: "Set 50 LF 12 in HDPE", days: 1, pred: "4.2.2.1.1" },
  { wbs: "4.2.2.1.3", name: "12 in culvert - backfill & compact", days: 1, pred: "4.2.2.1.2" },
  { wbs: "4.2.2.1.4", name: "Riprap outlet apron (7 ft x 4 ft)", days: 1, pred: "4.2.2.1.3" },
  { wbs: "4.2.2.1.5", name: "12 in culvert - inlet protection", days: 1, pred: "4.2.2.1.3" },
  { wbs: "4.2.2.2.1", name: "15 ft road - subgrade prep & proof roll", days: 2, pred: "4.2.2.1.4, 4.2.2.1.5" },
  { wbs: "4.2.2.2.2", name: "15 ft road - geotextile", days: 1, pred: "4.2.2.2.1" },
  { wbs: "4.2.2.2.3", name: "15 ft road - 12 in GABC in 6 in lifts", days: 3, pred: "4.2.2.2.2" },
  { wbs: "4.2.2.3",   name: "Reduce driveway to permanent size", days: 1, pred: "4.2.2.2.3" },
  // The document: "5.1.2.2.3 (and DNREC approval)".
  { wbs: "4.2.2.4.1", name: "36 in crossing - divert / dewater ditch flow", days: 2, pred: `4.2.2.2.3, ${LONO}` },
  { wbs: "4.2.2.4.2", name: "36 in crossing - excavate & bed pipe", days: 2, pred: "4.2.2.4.1" },
  { wbs: "4.2.2.4.3", name: "Set 48 LF 36 in HDPE", days: 1, pred: "4.2.2.4.2" },
  { wbs: "4.2.2.4.4", name: "36 in crossing - backfill & compact", days: 2, pred: "4.2.2.4.3" },
  { wbs: "4.2.2.4.5", name: "Riprap apron (13 ft, 3 ft up banks)", days: 1, pred: "4.2.2.4.4" },
  { wbs: "4.2.2.4.6", name: "36 in crossing - inlet protection", days: 1, pred: "4.2.2.4.4" },
  { wbs: "4.2.2.5.1", name: "20 ft road - subgrade prep & proof roll", days: 3, pred: "4.2.2.4.5, 4.2.2.4.6" },
  { wbs: "4.2.2.5.2", name: "20 ft road - geotextile", days: 1, pred: "4.2.2.5.1" },
  { wbs: "4.2.2.5.3", name: "20 ft road - 12 in GABC in 6 in lifts", days: 4, pred: "4.2.2.5.2" },
  { wbs: "4.2.2.6.1", name: "Grade swales / channels", days: 3, pred: "4.2.2.5.3" },
  { wbs: "4.2.2.6.2", name: "Channel matting", days: 2, pred: "4.2.2.6.1" },
  { wbs: "4.2.2.6.3", name: "EC logs", days: 1, pred: "4.2.2.6.1" },
  { wbs: "4.2.2.7.1", name: "UG trench excavation", days: 3, pred: "4.2.2.5.3" },
  { wbs: "4.2.2.7.2", name: "UG trench - backfill & compact", days: 2, pred: "4.2.2.7.1" },
  { wbs: "4.2.2.7.3", name: "UG trench - restore surface", days: 1, pred: "4.2.2.7.2" },
  { wbs: "4.2.2.8",   name: "Temporary stabilization", days: 2, pred: "4.2.2.6.2, 4.2.2.6.3" },
  // Carried over, and three rows outside civil depend on this code.
  { wbs: "4.2.2.06",  name: "Site released for pile install", days: 0, milestone: true,
    pred: "4.2.2.5.3" },
];

// Phase 3 - fence and final stabilisation. Replaces 4.2.3.01 .. 4.2.3.07.
const PHASE3: Row[] = [
  { wbs: "4.2.3.1.1", name: "Fence - posts & bracing", days: 8, pred: "4.2.2.5.3" },
  { wbs: "4.2.3.1.2", name: "Fence - fabric & privacy screen", days: 5, pred: "4.2.3.1.1" },
  { wbs: "4.2.3.1.3", name: "Gates & Knox Box", days: 2, pred: "4.2.3.1.2, 4.2.2.3" },
  { wbs: "4.2.3.1.4", name: "Fence grounding", days: 1, pred: "4.2.3.1.3" },
  { wbs: "4.2.3.2",   name: "Equipment pad subgrade", days: 3, pred: "4.2.2.5.3" },
  // The document: "5.1.2.7.3, 5.1.2.8, 5.1.3.1.4 (and PV install complete)".
  { wbs: "4.2.3.3.1", name: "Final grade / positive drainage", days: 5,
    pred: `4.2.2.7.3, 4.2.2.8, 4.2.3.1.4, ${MODULES}` },
  { wbs: "4.2.3.3.2", name: "Restore ruts & compacted areas", days: 3, pred: "4.2.3.3.1" },
  { wbs: "4.2.3.4.1", name: "Scarify compacted areas", days: 2, pred: "4.2.3.3.2" },
  { wbs: "4.2.3.4.2", name: "Permanent seed & pollinator mix", days: 3, pred: "4.2.3.4.1" },
  { wbs: "4.2.3.4.3", name: "Mulch", days: 2, pred: "4.2.3.4.2" },
  { wbs: "4.2.3.4.4", name: "Channel matting & EC logs (permanent)", days: 2, pred: "4.2.3.4.3" },
  // Not in the document as a task, but it names 70% cover as the gate on
  // removing controls and the row already exists at 30 days.
  { wbs: "4.2.3.4.5", name: "Vegetation establishment, 70 percent cover", days: 30, pred: "4.2.3.4.3" },
  { wbs: "4.2.3.5",   name: "Remove temporary E&S controls", days: 3, pred: "4.2.3.4.4, 4.2.3.4.5" },
  // Not in the document. Real work, already scheduled at 26 days.
  { wbs: "4.2.3.6",   name: "As-builts and closeout", days: 26, pred: "4.2.3.5" },
];

const ROWS = [...PHASE1, ...PHASE2, ...PHASE3];

const dup = ROWS.map((r) => r.wbs).filter((w, i, a) => a.indexOf(w) !== i);
if (dup.length) throw new Error(`Duplicate WBS in the plan: ${dup.join(", ")}`);

const ctx = await loadScheduleContext(sb as never, PID);
const existing = ctx.tasks as unknown as {
  id: string; wbs_code: string; task_name: string; sort_order: number | null;
  start_date: string | null; end_date: string | null; duration_days: number | null;
  predecessors: string | null; phase: string | null; task_type: string | null;
}[];

// Everything under a phase summary goes; the three summaries and 4.2 stay.
const KEEP = new Set(["4.2", "4.2.1", "4.2.2", "4.2.3"]);
const doomed = existing.filter((t) => t.wbs_code.startsWith("4.2") && !KEEP.has(t.wbs_code));
const phaseOf = (w: string) => (w.startsWith("4.2.1") ? "4.2.1" : w.startsWith("4.2.2") ? "4.2.2" : "4.2.3");
const summarySort = new Map(
  ["4.2.1", "4.2.2", "4.2.3"].map((w) => [w, Number(existing.find((t) => t.wbs_code === w)?.sort_order ?? 0)]),
);
const seq = new Map<string, number>();
const placeholder = ctx.dataDate;

const fresh = ROWS.map((r) => {
  const p = phaseOf(r.wbs);
  const n = (seq.get(p) ?? 0) + 1;
  seq.set(p, n);
  const sample = doomed.find((t) => t.wbs_code.startsWith(p));
  return {
    project_id: PID,
    wbs_code: r.wbs,
    task_name: r.name,
    parent_wbs_code: r.wbs.slice(0, r.wbs.lastIndexOf(".")),
    level_code: r.wbs.split(".").length,
    sort_order: (summarySort.get(p) ?? 0) + n,
    predecessors: r.pred ?? null,
    duration_days: r.milestone ? 0 : r.days,
    is_milestone: !!r.milestone,
    start_date: placeholder,
    end_date: placeholder,
    status: "Not Started",
    pct_complete: 0,
    phase: sample?.phase ?? null,
    task_type: sample?.task_type ?? "construction",
  };
});

// Preview, using the same forecast the schedule page computes.
const doomedIds = new Set(doomed.map((t) => t.id));
const sim = [
  ...(ctx.tasks as unknown as { id: string }[]).filter((t) => !doomedIds.has(t.id)),
  ...fresh.map((f, i) => ({ ...f, id: `new-${i}` })),
] as unknown as CpmInput[];
const plan = new Map(
  planScheduleSync(sim, { calendar: ctx.calendar, dataDate: ctx.dataDate }).map((u) => [u.wbs, u]),
);
const dateOf = (w: string) => {
  const p = plan.get(w);
  const t = (sim as unknown as { wbs_code: string; start_date: string; end_date: string }[])
    .find((x) => x.wbs_code === w);
  return { start: p?.start ?? t?.start_date ?? "?", end: p?.end ?? t?.end_date ?? "?" };
};

console.log(`REMOVING ${doomed.length} rows under 4.2`);
for (const t of doomed.sort((a, b) => a.wbs_code.localeCompare(b.wbs_code))) {
  console.log(`  - ${t.wbs_code.padEnd(10)} ${t.task_name.slice(0, 52)}`);
}
console.log(`\nNEW CIVIL SEQUENCE, ${ROWS.length} rows`);
for (const r of ROWS) {
  const d = dateOf(r.wbs);
  const tag = r.milestone ? "  [milestone, carried over]" : "";
  console.log(
    `  ${r.wbs.padEnd(10)} ${r.name.slice(0, 44).padEnd(44)} ${String(r.days).padStart(2)}d  ${d.start} -> ${d.end}   ${r.pred ?? ""}${tag}`,
  );
}
console.log("\nKNOCK-ON, rows outside civil whose dates move");
let moved = 0;
for (const t of existing) {
  if (t.wbs_code.startsWith("4.2")) continue;
  const p = plan.get(t.wbs_code);
  if (!p || (p.start === t.start_date && p.end === t.end_date)) continue;
  moved++;
  console.log(`  ${t.wbs_code.padEnd(10)} ${t.task_name.slice(0, 38).padEnd(38)} ${t.start_date} -> ${t.end_date}   now ${p.start} -> ${p.end}`);
}
if (!moved) console.log("  none");

if (!APPLY) {
  console.log("\nDry run. Nothing written. Pass --apply to write.");
  process.exit(0);
}

for (const t of doomed) {
  const { error } = await sb.from("schedule_tasks").delete().eq("id", t.id);
  if (error) throw error;
}
const { error: insErr } = await sb.from("schedule_tasks").insert(fresh as never);
if (insErr) throw insErr;
const written = await syncScheduleDates(sb as never, PID);
console.log(`\nRemoved ${doomed.length}, inserted ${fresh.length}, synced ${written} dates.`);
