// Email updates: who decides what, what an approval writes, and when undo is safe.
import {
  canDecide,
  planApply,
  planUndo,
  requiresPhil,
  type TaskSnapshot,
} from "../../src/lib/email-updates";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name}`);
}

const PID = "p1";
const TODAY = "2026-10-28";
const task = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "t1",
  project_id: PID,
  task_name: "Building permit issued",
  task_type: "deliverable",
  status: "In Progress",
  pct_complete: 0,
  end_date: "2026-11-15",
  status_source: "manual",
  date_constraint_type: null,
  date_constraint_date: null,
  ...over,
});
const row = (kind: string, payload: unknown, over: Record<string, unknown> = {}) => ({
  kind, project_id: PID, target_id: "t1", payload, status: "proposed", requires_phil: false, ...over,
});

// --- who decides ---
check("zarina approves a schedule proposal", canDecide(row("schedule_constraint", {}), "zarina", "approve").ok);
check("phil approves", canDecide(row("schedule_constraint", {}), "phil", "approve").ok);
check("mark (ahc_super) cannot decide", !canDecide(row("schedule_constraint", {}), "ahc_super", "approve").ok);
check("sub cannot decide", !canDecide(row("schedule_constraint", {}), "sub_pm", "reject").ok);
check("change order is Phil only by kind", requiresPhil({ kind: "change_order" }));
check("percent complete is Phil only", requiresPhil({ kind: "percent_complete" }));
check("owner dispute is Phil only", requiresPhil({ kind: "owner_dispute" }));
check("flag makes any kind Phil only", requiresPhil({ kind: "afp_paid", requires_phil: true }));
check("zarina cannot approve a CO", !canDecide(row("change_order", {}), "zarina", "approve").ok);
check("zarina cannot reject a CO either", !canDecide(row("change_order", {}), "zarina", "reject").ok);
check("phil approves a CO", canDecide(row("change_order", {}), "phil", "approve").ok);
check("cannot approve twice", !canDecide(row("schedule_constraint", {}, { status: "applied" }), "phil", "approve").ok);
check("undo needs applied", !canDecide(row("schedule_constraint", {}), "phil", "undo").ok);
check("undo on applied ok", canDecide(row("schedule_constraint", {}, { status: "applied" }), "zarina", "undo").ok);
check("unmatched cannot be approved", !canDecide(row("unmatched", {}), "phil", "approve").ok);
check("unmatched can be dismissed", canDecide(row("unmatched", {}), "zarina", "reject").ok);

// --- schedule_complete ---
{
  const p = planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task(), hasChildren: false, today: TODAY });
  check("completion plans a write", p.ok && p.table === "schedule_tasks");
  if (p.ok && p.table) {
    check("completion sets Complete/100/date/email",
      p.patch.status === "Complete" && p.patch.pct_complete === 100 &&
      p.patch.end_date === "2026-10-27" && p.patch.status_source === "email");
    check("undo keeps prior values",
      p.undo.status === "In Progress" && p.undo.pct_complete === 0 && p.undo.end_date === "2026-11-15");
  }
}
check("construction task refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task({ task_type: "construction" }), hasChildren: false, today: TODAY }).ok);
check("unclassified task refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task({ task_type: null }), hasChildren: false, today: TODAY }).ok);
check("future date refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-29" }), task: task(), hasChildren: false, today: TODAY }).ok);
check("bad date refused",
  !planApply({ row: row("schedule_complete", { date: "2026-02-30" }), task: task(), hasChildren: false, today: TODAY }).ok);
check("summary row refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task(), hasChildren: true, today: TODAY }).ok);
check("already complete refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task({ status: "Complete", pct_complete: 100 }), hasChildren: false, today: TODAY }).ok);
check("task on another project refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: task({ project_id: "other" }), hasChildren: false, today: TODAY }).ok);
check("missing task refused",
  !planApply({ row: row("schedule_complete", { date: "2026-10-27" }), task: null, hasChildren: false, today: TODAY }).ok);

// --- schedule_constraint ---
{
  const p = planApply({ row: row("schedule_constraint", { type: "FNLT", date: "2026-12-01" }), task: task(), hasChildren: false, today: TODAY });
  check("constraint plans a write", p.ok && p.table === "schedule_tasks" &&
    p.patch.date_constraint_type === "FNLT" && p.patch.date_constraint_date === "2026-12-01" &&
    p.undo.date_constraint_type === null);
}
check("bad constraint type refused",
  !planApply({ row: row("schedule_constraint", { type: "ASAP", date: "2026-12-01" }), task: task(), hasChildren: false, today: TODAY }).ok);
check("same constraint refused",
  !planApply({ row: row("schedule_constraint", { type: "MFO", date: "2026-12-01" }), task: task({ date_constraint_type: "MFO", date_constraint_date: "2026-12-01" }), hasChildren: false, today: TODAY }).ok);
check("future constraint date is fine",
  planApply({ row: row("schedule_constraint", { type: "MSO", date: "2027-03-01" }), task: task(), hasChildren: false, today: TODAY }).ok);

// --- kinds without an applier ---
{
  const p = planApply({ row: row("afp_paid", { amount: 1 }), task: null, hasChildren: false, today: TODAY });
  check("no-applier kind approves without a write", p.ok && p.table === null);
}

// --- undo ---
{
  const applied = { status: "Complete", pct_complete: 100, end_date: "2026-10-27", status_source: "email" };
  const undo = { status: "In Progress", pct_complete: 0, end_date: "2026-11-15", status_source: "manual" };
  const now = task(applied);
  const u = planUndo({ applied, undo, task: now });
  check("undo restores an untouched task", u.ok && u.patch.status === "In Progress");
  check("undo refused after an edit",
    !planUndo({ applied, undo, task: task({ ...applied, end_date: "2026-10-30" }) }).ok);
  check("numeric compare tolerates 100 vs 100.0",
    planUndo({ applied, undo, task: task({ ...applied, pct_complete: 100.0 }) }).ok);
  check("undo refused with no record", !planUndo({ applied, undo: null, task: now }).ok);
  check("undo refused when task gone", !planUndo({ applied, undo, task: null }).ok);
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
