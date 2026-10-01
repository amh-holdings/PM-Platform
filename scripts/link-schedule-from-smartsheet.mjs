// Load schedule LOGIC from the Smartsheet authoring copy into schedule_tasks.
//
// The platform owns the schedule. Smartsheet is the authoring tool for logic
// only, used once per branch and never as a parallel copy - so this script
// writes predecessors and fills missing durations, and deliberately does not
// touch dates, pct_complete or status. Dates are the engine's output and
// progress belongs to approved field reports.
//
// Three things make this more than a column copy:
//
//   1. The WBS numbers diverge. Electrical is 5.3.x in the sheet and 5.5.x in
//      the platform, so links are mapped by task name inside the branch and
//      any name that does not match is reported rather than guessed.
//
//   2. Civil (5.1) and Mechanical (5.2) are AHEAD in the platform - the basin
//      breakdown, dewatering sub-tasks, DEQ and Golden Row do not exist in the
//      sheet at all, and civil is already linked. Those branches are skipped.
//
//   3. Procurement logic in the sheet runs backwards on purpose: it was built
//      to answer "what is the latest date this can arrive", so Delivery is
//      driven by the install that consumes it (Delivery <- InstallSF). Now
//      that POs carry real delivery dates, the drive flips: the equipment
//      arrives, then it can be installed. Every SF pairing in the sheet names
//      which install consumes which delivery, so the flip reverses each one
//      into Install <- DeliveryFS and keeps the pairing exactly as authored.
//
// The snapshot this reads lives under db/reference/, which is gitignored, so it
// does not travel with the repo. Re-export it from the Smartsheet connector -
// sheet 8210000971255684, columns WBS / Task / Duration / Start / End /
// Predecessors - which returns predecessors structured as row id, relationship
// type and lag rather than as display text.
//
// Usage:
//   node scripts/link-schedule-from-smartsheet.mjs            # dry run, prints the proposal
//   node scripts/link-schedule-from-smartsheet.mjs --apply    # writes
//   node scripts/link-schedule-from-smartsheet.mjs --md <file> # dry run + markdown review doc

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SHEET = "db/reference/smartsheet-sss-schedule-2026-10-01.json";
const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0"; // Sweet Springs Solar

const APPLY = process.argv.includes("--apply");
const MD_AT = process.argv.indexOf("--md");
const MD_PATH = MD_AT === -1 ? null : process.argv[MD_AT + 1];

// Branch mapping: sheet root -> platform root. Sheet branches 1-3 (Contracts,
// Permitting, Engineering) have no platform counterpart and are left out.
// Modules (4.1) and inverters (4.2) are owner-supplied by Dimension. AHC does
// not hold those POs and cannot pull the delivery in, so the question the
// schedule has to answer for them is the original one: what is the LATEST date
// this can arrive. That is what the sheet's SF logic computes, so those two
// branches keep it and the answer becomes the need-by date handed to Dimension.
// Everything under 4.3 and 4.4 is on an AHC PO with a real delivery date, so
// there the drive flips: it arrives, then it gets installed.
const BRANCH_MAP = [
  { sheet: "4.1", platform: "4.1", label: "Modules (owner-supplied)", flipSf: false },
  { sheet: "4.2", platform: "4.2", label: "Inverters (owner-supplied)", flipSf: false },
  { sheet: "4.3", platform: "4.3", label: "Racking", flipSf: true },
  { sheet: "4.4", platform: "4.4", label: "Electrical Equipment", flipSf: true },
  { sheet: "5.3", platform: "5.5", label: "Electrical", flipSf: false },
  { sheet: "5.4", platform: "5.4", label: "Completion", flipSf: false },
];

// Rows the sheet carries that the platform flattened away. Both are
// owner-supplied items whose lead time and delivery need to be schedulable so
// the need-by date is computable rather than assumed.
const CREATE_ROWS = [
  { wbs: "4.1.1",   name: "JA 540 / 545",          parent: "4.1", level: 3, type: null },
  { wbs: "4.1.1.1", name: "Lead Time",             parent: "4.1.1", level: 4, type: "procurement" },
  { wbs: "4.1.1.2", name: "Delivery",              parent: "4.1.1", level: 4, type: "procurement" },
  { wbs: "4.2.1",   name: "SMA SHP-150-US-21",     parent: "4.2", level: 3, type: null },
  { wbs: "4.2.1.1", name: "Lead Time",             parent: "4.2.1", level: 4, type: "procurement" },
  { wbs: "4.2.1.2", name: "Delivery",              parent: "4.2.1", level: 4, type: "procurement" },
];

// ---------------------------------------------------------------------------
// Read the sheet snapshot.

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}

const snap = JSON.parse(readFileSync(SHEET, "utf8"));
const COL = { wbs: 6, task: 7, duration: 12 };
const cell = (row, idx) => row.cells.find((c) => c.columnIndex === idx)?.value ?? null;

const sheetRows = snap.rows.map((r) => ({
  rowId: r.rowId,
  wbs: cell(r, COL.wbs),
  task: cell(r, COL.task),
  // Smartsheet durations read "4d", "0d" for a milestone, sometimes "12d".
  duration: (() => {
    const d = cell(r, COL.duration);
    if (d == null) return null;
    const m = String(d).match(/^(\d+(?:\.\d+)?)d/);
    return m ? Math.round(Number(m[1])) : null;
  })(),
  preds: r.predecessors ?? [],
}));
const byRowId = new Map(sheetRows.map((r) => [r.rowId, r]));
const sheetByWbs = new Map(sheetRows.filter((r) => r.wbs).map((r) => [r.wbs, r]));

// ---------------------------------------------------------------------------
// Read the platform.

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: tasks, error: taskErr } = await sb
  .from("schedule_tasks")
  .select("id, wbs_code, task_name, predecessors, duration_days, is_milestone, date_constraint_type, date_constraint_date, sort_order, phase")
  .eq("project_id", PROJECT_ID);
if (taskErr) throw new Error(`schedule_tasks: ${taskErr.message}`);

const dbByWbs = new Map(tasks.map((t) => [t.wbs_code, t]));
const isLeaf = (wbs) => !tasks.some((o) => o.wbs_code !== wbs && o.wbs_code.startsWith(wbs + "."));

const { data: pos, error: poErr } = await sb
  .from("procurement_orders")
  .select("po_number, vendor_name, linked_delivery_task_wbs_code, expected_delivery_date")
  .eq("project_id", PROJECT_ID);
if (poErr) throw new Error(`procurement_orders: ${poErr.message}`);

const poByTask = new Map(
  pos.filter((p) => p.linked_delivery_task_wbs_code && p.expected_delivery_date)
     .map((p) => [p.linked_delivery_task_wbs_code, p]),
);

// ---------------------------------------------------------------------------
// Create the owner-supplied rows the platform is missing, so their logic has
// somewhere to land. Sort order is wedged between the parent and the next
// sibling; duration comes from the sheet and dates are left to the engine.

const created = [];
for (const r of CREATE_ROWS) {
  if (dbByWbs.has(r.wbs)) continue;
  const parent = dbByWbs.get(r.parent);
  if (!parent) {
    console.error(`cannot create ${r.wbs}: parent ${r.parent} not in the platform`);
    continue;
  }
  const siblings = tasks
    .filter((t) => t.wbs_code !== r.wbs && (t.sort_order ?? 0) > (parent.sort_order ?? 0))
    .map((t) => t.sort_order ?? 0);
  const nextSort = siblings.length ? Math.min(...siblings) : (parent.sort_order ?? 0) + 10;
  const sheetRow = sheetByWbs.get(r.wbs);
  const row = {
    project_id: PROJECT_ID,
    wbs_code: r.wbs,
    task_name: r.name,
    parent_wbs_code: r.parent,
    level_code: r.level,
    sort_order: Math.round(((parent.sort_order ?? 0) + nextSort) / 2),
    phase: parent.phase,
    task_type: r.type,
    duration_days: sheetRow?.duration ?? null,
    is_milestone: sheetRow?.duration === 0,
  };
  created.push(row);
  // Visible to the rest of the loop immediately: 4.1.1.1 cannot find its
  // parent 4.1.1 otherwise, and only the two top rows get built.
  const stub = { ...row, id: null, predecessors: null };
  tasks.push(stub);
  dbByWbs.set(row.wbs_code, stub);
}

if (created.length && APPLY) {
  const { data: ins, error } = await sb.from("schedule_tasks").insert(created).select("id, wbs_code, task_name, predecessors, duration_days, is_milestone, date_constraint_type, date_constraint_date, sort_order");
  if (error) throw new Error(`creating rows: ${error.message}`);
  for (const t of ins) {
    const at = tasks.findIndex((x) => x.wbs_code === t.wbs_code);
    if (at === -1) tasks.push(t);
    else tasks[at] = t;
    dbByWbs.set(t.wbs_code, t);
  }
  console.log(`Created ${ins.length} rows: ${ins.map((t) => t.wbs_code).join(", ")}\n`);
} else if (created.length) {
  console.log(`Would create ${created.length} rows: ${created.map((r) => r.wbs_code).join(", ")}\n`);
}

// ---------------------------------------------------------------------------
// Map a sheet WBS to a platform WBS.
//
// Same-numbered branches map straight through. The electrical offset maps by
// position AND is verified by task name, because a silent mis-map would write
// the wrong logic onto a real task, which is worse than writing nothing.

const nameKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nameMismatches = [];
const unmapped = [];

function mapWbs(sheetWbs) {
  for (const b of BRANCH_MAP) {
    if (sheetWbs !== b.sheet && !sheetWbs.startsWith(b.sheet + ".")) continue;
    const platformWbs = b.platform + sheetWbs.slice(b.sheet.length);
    const db = dbByWbs.get(platformWbs);
    if (!db) {
      unmapped.push({ sheetWbs, platformWbs, task: sheetByWbs.get(sheetWbs)?.task, branch: b.label });
      return null;
    }
    const sheetName = nameKey(sheetByWbs.get(sheetWbs)?.task);
    const dbName = nameKey(db.task_name);
    // Truncated sheet titles are common, so a prefix match counts.
    if (sheetName !== dbName && !dbName.startsWith(sheetName) && !sheetName.startsWith(dbName)) {
      nameMismatches.push({ sheetWbs, platformWbs, sheetName: sheetByWbs.get(sheetWbs)?.task, dbName: db.task_name });
      return null;
    }
    return platformWbs;
  }
  return null;
}

const branchOf = (sheetWbs) =>
  BRANCH_MAP.find((b) => sheetWbs === b.sheet || sheetWbs.startsWith(b.sheet + "."));

// ---------------------------------------------------------------------------
// Build the proposed link set.

const linkFmt = (pred, type, lagDays) => {
  const t = type && type !== "FS" ? type : "";
  const lag = lagDays ? (lagDays > 0 ? `+${lagDays}` : `${lagDays}`) : "";
  return `${pred}${t}${lag}`;
};

/** platformWbs -> Set of serialized links */
const proposed = new Map();

// A task is "in scope" when the sheet owns its logic - then its whole
// predecessor set is rebuilt from the sheet. A flipped link can also land on a
// task OUTSIDE that scope: Pile Unloading sits in Mechanical, which this loader
// deliberately does not import, but it is the task that consumes the CAB pile
// delivery. Rebuilding its set would throw away the logic it already has, which
// is exactly what happened on the first run - Pile Unloading lost "5.2.1" and
// pile driving stopped waiting for Array Layout and Marking. Out of scope, the
// link is merged in.
const outOfScopeSeed = new Set();
const addLink = (platformWbs, link, { merge = false } = {}) => {
  if (!proposed.has(platformWbs)) {
    const existing = merge ? (dbByWbs.get(platformWbs)?.predecessors ?? "") : "";
    const seed = existing
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (merge && seed.length) outOfScopeSeed.add(platformWbs);
    proposed.set(platformWbs, new Set(seed));
  }
  proposed.get(platformWbs).add(link);
};

const flipped = [];
const repairs = [];
const skippedCrossBranch = [];

// computeCpm runs leavesOf() first and builds its link map from leaves only, so
// a predecessor written onto a summary row is never read - it looks linked in
// the grid and drives nothing. The sheet names MV Installation (a summary) as
// the consumer of four MV deliveries, so the link has to land on the leaf that
// actually starts that work instead.
function firstLeafUnder(wbs) {
  const under = tasks
    .filter((t) => t.wbs_code.startsWith(wbs + ".") && isLeaf(t.wbs_code))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return under[0]?.wbs_code ?? null;
}

function schedulable(wbs, note) {
  if (isLeaf(wbs)) return wbs;
  const leaf = firstLeafUnder(wbs);
  if (!leaf) return wbs;
  repairs.push({
    wbs: leaf,
    was: `on summary ${wbs}`,
    now: `on leaf ${leaf}`,
    why: note ?? "a predecessor on a summary row is never read by the engine",
  });
  return leaf;
}

for (const row of sheetRows) {
  if (!row.wbs) continue;
  const branch = branchOf(row.wbs);
  if (!branch) continue;
  const target = mapWbs(row.wbs);
  if (!target) continue;

  // Register every in-scope task, even one that ends up with no links. A
  // flipped Delivery row keeps its stale "install SF" predecessor otherwise,
  // and the old link plus the new reversed one close a loop - which is exactly
  // what the cycle check caught on the first run.
  if (!proposed.has(target)) proposed.set(target, new Set());

  for (const p of row.preds) {
    const predSheet = byRowId.get(p.rowId);
    if (!predSheet?.wbs) continue;
    const lag = p.lagDays ?? (p.lag ? Number(p.lag) : 0);
    const type = p.type ?? "FS";

    // The procurement flip. In the sheet, a Delivery row carries an SF link to
    // the install that consumes it. Reversed, the install waits on delivery.
    if (branch.flipSf && type === "SF") {
      const installTarget = mapWbs(predSheet.wbs) ?? mapElectricalOrNull(predSheet.wbs);
      if (!installTarget) {
        skippedCrossBranch.push({ from: row.wbs, to: predSheet.wbs, type, reason: "install task not mapped" });
        continue;
      }
      const installLeaf = schedulable(installTarget, `${installTarget} is a summary; delivery drives the first task under it`);
      addLink(installLeaf, linkFmt(target, "FS", 0), { merge: branchOf(predSheet.wbs) == null });
      flipped.push({
        sheetDelivery: row.wbs,
        delivery: target,
        deliveryName: sheetByWbs.get(row.wbs)?.task,
        sheetInstall: predSheet.wbs,
        install: installLeaf,
        installName: sheetByWbs.get(predSheet.wbs)?.task,
      });
      continue;
    }

    // 4.1.1.1 Lead Time carries "4.4SF" in the sheet - a link to the whole
    // Electrical Equipment summary, which cannot be what was meant for a
    // module lead time. Inverters chain Lead Time to their own Delivery, so
    // modules get the same shape and the slip is reported rather than copied.
    if (row.wbs === "4.1.1.1" && predSheet.wbs === "4.4") {
      addLink(target, linkFmt("4.1.1.2", "SF", 0));
      repairs.push({ wbs: "4.1.1.1", was: "4.4SF", now: "4.1.1.2SF", why: "sheet pointed at the 4.4 summary" });
      continue;
    }

    const predTarget = mapWbs(predSheet.wbs) ?? mapElectricalOrNull(predSheet.wbs);
    if (!predTarget) {
      skippedCrossBranch.push({ from: row.wbs, to: predSheet.wbs, type, reason: "predecessor not mapped" });
      continue;
    }
    addLink(target, linkFmt(predTarget, type, lag));
  }
}

// A predecessor can sit in a branch we are not importing (electrical depends on
// mechanical 5.2.4, which is the same number in both). Those resolve straight
// across when the platform has that WBS and the names agree.
function mapElectricalOrNull(sheetWbs) {
  const db = dbByWbs.get(sheetWbs);
  if (!db) return null;
  const a = nameKey(sheetByWbs.get(sheetWbs)?.task);
  const b = nameKey(db.task_name);
  if (a === b || b.startsWith(a) || a.startsWith(b)) return sheetWbs;
  return null;
}

// ---------------------------------------------------------------------------
// Cycle check. The engine expands a summary link to the leaves beneath it, so
// the check has to see links the same way or a loop through a branch gets past.

function expand(wbs) {
  if (isLeaf(wbs)) return [wbs];
  return tasks.filter((t) => t.wbs_code.startsWith(wbs + ".") && isLeaf(t.wbs_code)).map((t) => t.wbs_code);
}

const finalLinks = new Map(); // wbs -> [predWbs]
for (const t of tasks) {
  const raw = proposed.has(t.wbs_code)
    ? Array.from(proposed.get(t.wbs_code)).join(", ")
    : t.predecessors;  // empty proposed set -> "" -> no links, which is the point
  const preds = [];
  for (const token of String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = token.match(/^(\d+(?:\.\d+)*)(FS|SS|FF|SF)?([+-]\d+)?$/i);
    if (m) preds.push(...expand(m[1]).filter((w) => dbByWbs.has(w)));
  }
  finalLinks.set(t.wbs_code, preds);
}

function findCycle() {
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (n) => {
    if (cycle) return;
    if (state.get(n) === "done") return;
    if (state.get(n) === "open") {
      cycle = stack.slice(stack.indexOf(n));
      return;
    }
    state.set(n, "open");
    stack.push(n);
    for (const p of finalLinks.get(n) ?? []) visit(p);
    stack.pop();
    state.set(n, "done");
  };
  for (const t of tasks) visit(t.wbs_code);
  return cycle;
}
const cycle = findCycle();

// ---------------------------------------------------------------------------
// Durations. Fill only where the platform has none - never overwrite.

const durationFills = [];
for (const row of sheetRows) {
  if (!row.wbs || row.duration == null) continue;
  const target = mapWbs(row.wbs);
  if (!target) continue;
  const db = dbByWbs.get(target);
  if (db.duration_days != null) continue;
  durationFills.push({ wbs: target, name: db.task_name, days: row.duration, milestone: row.duration === 0 });
}

// Delivery anchors from real PO dates. SNET, not MSO: the PO date is the
// earliest the material can be on site, and a hard "must start on" would stop
// the engine reporting an arrival that slips further.
const anchors = [];
for (const [wbs, po] of poByTask) {
  const db = dbByWbs.get(wbs);
  if (!db) continue;
  anchors.push({
    wbs,
    name: db.task_name,
    date: po.expected_delivery_date,
    po: po.po_number,
    vendor: po.vendor_name,
    current: db.date_constraint_type ? `${db.date_constraint_type} ${db.date_constraint_date}` : "none",
  });
}

// ---------------------------------------------------------------------------
// Report.

const changes = [];
for (const [wbs, set] of proposed) {
  const db = dbByWbs.get(wbs);
  const next = set.size ? Array.from(set).join(", ") : null;
  if ((db.predecessors ?? null) === next) continue;
  changes.push({ wbs, name: db.task_name, before: db.predecessors ?? "(none)", after: next ?? "(cleared)", value: next });
}
changes.sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }));

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`Sheet: ${snap.sheetName} (${snap.metadata.rowsActual} rows, snapshot ${SHEET})`);
console.log(`Project: Sweet Springs Solar\n`);

console.log(`=== LINK CHANGES (${changes.length}) ===`);
console.log(pad("WBS", 12) + pad("Task", 40) + pad("Now", 22) + "Proposed");
for (const c of changes) console.log(pad(c.wbs, 12) + pad(c.name, 40) + pad(c.before, 22) + c.after);

console.log(`\n=== PROCUREMENT FLIPS (${flipped.length}) ===`);
for (const f of flipped)
  console.log(`${pad(f.sheetDelivery + " " + (f.deliveryName ?? ""), 34)} drove ${pad(f.sheetInstall, 10)} -> now ${pad(f.install, 10)} ${f.installName ?? ""} waits on ${f.delivery}`);

console.log(`\n=== DURATION FILLS (${durationFills.length}, null only) ===`);
for (const d of durationFills) console.log(`${pad(d.wbs, 12)}${pad(d.name, 44)}${d.days}d${d.milestone ? "  (milestone)" : ""}`);

console.log(`\n=== DELIVERY ANCHORS AVAILABLE FROM POs (${anchors.length}) ===`);
for (const a of anchors) console.log(`${pad(a.wbs, 12)}${pad(a.name, 20)}${pad(a.date, 12)}${pad(a.po, 20)}${pad(a.vendor, 24)}current: ${a.current}`);

console.log(`\n=== REPAIRED SHEET LINKS (${repairs.length}) ===`);
for (const r of repairs) console.log(`${pad(r.wbs, 12)}${pad(r.was, 12)}-> ${pad(r.now, 14)}${r.why}`);

if (outOfScopeSeed.size) {
  console.log(`\n=== MERGED, NOT REPLACED (${outOfScopeSeed.size}) ===`);
  for (const w of outOfScopeSeed)
    console.log(`${pad(w, 12)}outside the imported branches - existing logic kept and the delivery link added`);
}

console.log(`\n=== NEEDS ATTENTION ===`);
console.log(`name mismatches (not mapped): ${nameMismatches.length}`);
for (const m of nameMismatches) console.log(`   sheet ${m.sheetWbs} "${m.sheetName}" vs platform ${m.platformWbs} "${m.dbName}"`);
const unmappedUniq = Array.from(new Map(unmapped.map((u) => [u.sheetWbs, u])).values());
console.log(`sheet rows with no platform task: ${unmappedUniq.length}`);
for (const u of unmappedUniq) console.log(`   ${u.sheetWbs} "${u.task}" -> ${u.platformWbs} missing (${u.branch})`);
console.log(`links dropped (unmappable predecessor): ${skippedCrossBranch.length}`);
for (const s of skippedCrossBranch) console.log(`   ${s.from} <- ${s.to}${s.type} : ${s.reason}`);
console.log(`cycle: ${cycle ? cycle.join(" -> ") : "none"}`);

if (MD_PATH) {
  const md = [];
  md.push(`# Schedule link load from Smartsheet - proposal\n`);
  md.push(`Source: \`${snap.sheetName}\`, ${snap.metadata.rowsActual} rows, snapshot \`${SHEET}\`.`);
  md.push(`Target: Sweet Springs Solar. Dry run - nothing written.\n`);
  md.push(`Scope: procurement (4.x), electrical (sheet 5.3.x -> platform 5.5.x), completion (5.4.x).`);
  md.push(`Civil (5.1) and mechanical (5.2) are skipped: the platform carries detail the sheet does not have.\n`);
  md.push(`## Link changes (${changes.length})\n`);
  md.push(`| # | WBS | Task | Now | Proposed |`);
  md.push(`|---|---|---|---|---|`);
  changes.forEach((c, i) => md.push(`| ${i + 1} | ${c.wbs} | ${c.name} | \`${c.before}\` | \`${c.after}\` |`));
  md.push(`\n## Procurement flips (${flipped.length})\n`);
  md.push(`| # | Delivery | Was driven by | Now drives |`);
  md.push(`|---|---|---|---|`);
  flipped.forEach((f, i) => md.push(`| ${i + 1} | ${f.delivery} ${f.deliveryName ?? ""} | ${f.sheetInstall} (SF) | ${f.install} ${f.installName ?? ""} |`));
  md.push(`\n## Duration fills (${durationFills.length}, null only)\n`);
  md.push(`| # | WBS | Task | Days |`);
  md.push(`|---|---|---|---|`);
  durationFills.forEach((d, i) => md.push(`| ${i + 1} | ${d.wbs} | ${d.name} | ${d.days}${d.milestone ? " (milestone)" : ""} |`));
  md.push(`\n## Delivery anchors available from POs (${anchors.length})\n`);
  md.push(`| # | WBS | Task | PO date | PO | Vendor | Current constraint |`);
  md.push(`|---|---|---|---|---|---|---|`);
  anchors.forEach((a, i) => md.push(`| ${i + 1} | ${a.wbs} | ${a.name} | ${a.date} | ${a.po} | ${a.vendor} | ${a.current} |`));
  md.push(`\n## Needs attention\n`);
  md.push(`| Item | Count |`);
  md.push(`|---|---|`);
  md.push(`| Name mismatches, not mapped | ${nameMismatches.length} |`);
  md.push(`| Sheet rows with no platform task | ${unmappedUniq.length} |`);
  md.push(`| Links dropped, unmappable predecessor | ${skippedCrossBranch.length} |`);
  md.push(`| Cycle | ${cycle ? cycle.join(" -> ") : "none"} |`);
  if (nameMismatches.length) {
    md.push(`\n### Name mismatches\n`);
    md.push(`| Sheet WBS | Sheet task | Platform WBS | Platform task |`);
    md.push(`|---|---|---|---|`);
    for (const m of nameMismatches) md.push(`| ${m.sheetWbs} | ${m.sheetName} | ${m.platformWbs} | ${m.dbName} |`);
  }
  if (unmappedUniq.length) {
    md.push(`\n### Sheet rows with no platform task\n`);
    md.push(`| Sheet WBS | Task | Expected platform WBS | Branch |`);
    md.push(`|---|---|---|---|`);
    for (const u of unmappedUniq) md.push(`| ${u.sheetWbs} | ${u.task} | ${u.platformWbs} | ${u.branch} |`);
  }
  if (skippedCrossBranch.length) {
    md.push(`\n### Dropped links\n`);
    md.push(`| Task | Predecessor | Type | Reason |`);
    md.push(`|---|---|---|---|`);
    for (const s of skippedCrossBranch) md.push(`| ${s.from} | ${s.to} | ${s.type} | ${s.reason} |`);
  }
  writeFileSync(MD_PATH, md.join("\n") + "\n");
  console.log(`\nMarkdown review written to ${MD_PATH}`);
}

// ---------------------------------------------------------------------------
// Apply.

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to create ${created.length} rows, write ${changes.length} link changes, ${durationFills.length} durations and ${anchors.length} delivery anchors.`);
  process.exit(0);
}

if (cycle) {
  console.error(`\nRefusing to write: the proposed network contains a cycle (${cycle.join(" -> ")}).`);
  process.exit(1);
}

let wrote = 0;
for (const c of changes) {
  const { error } = await sb
    .from("schedule_tasks")
    .update({ predecessors: c.value })
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", c.wbs);
  if (error) {
    console.error(`  ${c.wbs}: ${error.message}`);
    continue;
  }
  wrote++;
}
let durWrote = 0;
for (const d of durationFills) {
  const patch = { duration_days: d.days };
  if (d.milestone) patch.is_milestone = true;
  const { error } = await sb
    .from("schedule_tasks")
    .update(patch)
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", d.wbs);
  if (error) {
    console.error(`  ${d.wbs}: ${error.message}`);
    continue;
  }
  durWrote++;
}
let anchorWrote = 0;
for (const a of anchors) {
  const { error } = await sb
    .from("schedule_tasks")
    .update({ date_constraint_type: "SNET", date_constraint_date: a.date })
    .eq("project_id", PROJECT_ID)
    .eq("wbs_code", a.wbs);
  if (error) {
    console.error(`  ${a.wbs}: ${error.message}`);
    continue;
  }
  anchorWrote++;
}
console.log(`\nWrote ${wrote} link changes, ${durWrote} durations, ${anchorWrote} delivery anchors.`);
