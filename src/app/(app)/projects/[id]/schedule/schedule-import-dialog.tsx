"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  COLUMN_KEYS,
  COLUMN_LABELS,
  buildImportRows,
  diffImport,
  parseGrid,
  spanOf,
  type ColumnKey,
  type EditTask,
  type ImportDiff,
  type ImportRow,
  type ParsedGrid,
  guessColumns,
} from "@/lib/schedule-edit";
import { applyScheduleImport, type ImportPlan } from "../schedule-actions";

type Props = {
  projectId: string;
  tasks: EditTask[];
  trigger: React.ReactNode;
};

type Step = "paste" | "map" | "review";

const SAMPLE = `WBS\tTask Name\tDuration\tStart\tFinish\tPredecessors
5.2.1\tMobilize racking crew\t5d\t9/8/26\t9/14/26\t
5.2.2\tPile layout and survey\t10d\t9/15/26\t9/28/26\t1
5.2.3\tPile driving\t35d\t9/29/26\t11/16/26\t2SS+5d`;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function ScheduleImportDialog({ projectId, tasks, trigger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [wbsRoot, setWbsRoot] = useState("");
  const [deleteRoot, setDeleteRoot] = useState("");
  const [allowDeletes, setAllowDeletes] = useState(false);
  const [grid, setGrid] = useState<ParsedGrid | null>(null);
  const [mapping, setMapping] = useState<(ColumnKey | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const knownWbs = useMemo(() => tasks.map((t) => t.wbs_code), [tasks]);

  const built = useMemo(() => {
    if (!grid) return null;
    return buildImportRows(grid, mapping, {
      knownWbs,
      wbsRoot: wbsRoot.trim() || null,
    });
  }, [grid, mapping, knownWbs, wbsRoot]);

  const diff: ImportDiff | null = useMemo(() => {
    if (!built) return null;
    return diffImport(tasks, built.rows, mapping, {
      deleteMissingUnder: allowDeletes ? deleteRoot.trim() || null : null,
    });
  }, [built, tasks, mapping, allowDeletes, deleteRoot]);

  function reset() {
    setStep("paste");
    setText("");
    setGrid(null);
    setMapping([]);
    setError(null);
    setResult(null);
    setAllowDeletes(false);
    setDeleteRoot("");
    setWbsRoot("");
  }

  function doParse() {
    setError(null);
    const g = parseGrid(text);
    if (!g.rows.length) {
      setError("Nothing to read. Paste rows copied from Smartsheet or Excel.");
      return;
    }
    setGrid(g);
    setMapping(guessColumns(g.headers, g.rows));
    setStep("map");
  }

  async function apply() {
    if (!diff || !built) return;
    setSubmitting(true);
    setError(null);

    const patchOf = (row: ImportRow) => {
      const patch: Record<string, unknown> = {};
      for (const k of COLUMN_KEYS) {
        if (k === "wbs_code") continue;
        if (!mapping.includes(k)) continue;
        if (!(k in row.values)) continue;
        patch[k] = row.values[k] ?? null;
      }
      return patch;
    };

    const plan: ImportPlan = {
      adds: diff.adds.map((r) => ({
        wbs_code: r.wbs_code,
        task_name: String(r.values.task_name ?? ""),
        description: (r.values.description as string) ?? null,
        phase: (r.values.phase as string) ?? null,
        assigned_to: (r.values.assigned_to as string) ?? null,
        status: (r.values.status as string) ?? null,
        duration_days: (r.values.duration_days as number) ?? null,
        start_date: (r.values.start_date as string) ?? null,
        end_date: (r.values.end_date as string) ?? null,
        predecessors: (r.values.predecessors as string) ?? null,
        is_milestone: (r.values.is_milestone as boolean) ?? false,
      })),
      changes: diff.changes.map((c) => ({
        id: c.existing.id,
        patch: patchOf(c.row),
      })),
      deleteIds: diff.deletes.map((d) => d.id),
    };

    const res = await applyScheduleImport(projectId, plan);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(
      `${res.added} added, ${res.changed} updated, ${res.deleted} deleted. Dates and float have been recalculated.`,
    );
    startTransition(() => router.refresh());
  }

  const span = built ? spanOf(built.rows) : null;
  const rowIssues = built?.rows.filter((r) => r.issues.length) ?? [];

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">{trigger}</span>
      {!open ? null : (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="my-8 w-full max-w-5xl rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Import schedule rows</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste straight out of Smartsheet, Excel or any grid. Nothing is
                  written until you have seen the diff.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs">
              {(["paste", "map", "review"] as Step[]).map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium",
                      step === s
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {i + 1}. {s === "paste" ? "Paste" : s === "map" ? "Map columns" : "Review"}
                  </span>
                  {i < 2 && <span className="text-muted-foreground">→</span>}
                </span>
              ))}
            </div>

            {/* ---------------------------------------------------- paste -- */}
            {step === "paste" && (
              <div className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="paste">Pasted rows</Label>
                  <textarea
                    id="paste"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder={SAMPLE}
                    className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Include the header row if you have one. Predecessors written
                    as Smartsheet row numbers are translated to WBS codes
                    automatically; relationship types and lag (
                    <code className="font-mono">12SS+5d</code>) are kept.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wbsroot">Nest under WBS code (optional)</Label>
                  <Input
                    id="wbsroot"
                    value={wbsRoot}
                    onChange={(e) => setWbsRoot(e.target.value)}
                    placeholder="5.2"
                    className="max-w-xs font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Only used when the paste has no WBS column. Codes are then
                    generated from the indentation of the task names, beneath
                    this branch.
                  </p>
                </div>

                {error && <Problem>{error}</Problem>}

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={doParse} disabled={!text.trim()}>Read rows</Button>
                </div>
              </div>
            )}

            {/* ------------------------------------------------------ map -- */}
            {step === "map" && grid && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-muted-foreground">
                  {grid.rows.length} row{grid.rows.length === 1 ? "" : "s"},{" "}
                  {mapping.length} column{mapping.length === 1 ? "" : "s"},{" "}
                  {grid.delimiter === "tab" ? "tab" : "comma"} separated
                  {grid.headers ? ", header row detected" : ", no header row detected"}.
                  Set anything you do not want to import to Ignore.
                </p>

                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="border-b bg-muted/40">
                      <tr>
                        {mapping.map((_, i) => (
                          <th key={i} className="min-w-[10rem] p-2 text-left align-top">
                            <div className="truncate font-medium">
                              {grid.headers?.[i] || `Column ${i + 1}`}
                            </div>
                            <select
                              value={mapping[i] ?? ""}
                              onChange={(e) => {
                                const v = (e.target.value || null) as ColumnKey | null;
                                setMapping((prev) =>
                                  // A field can only come from one column. Taking
                                  // it here releases it wherever it was.
                                  prev.map((m, j) =>
                                    j === i ? v : v && m === v ? null : m,
                                  ),
                                );
                              }}
                              className="mt-1 h-8 w-full rounded border border-input bg-background px-1 text-xs"
                            >
                              <option value="">Ignore</option>
                              {COLUMN_KEYS.map((k) => (
                                <option key={k} value={k}>{COLUMN_LABELS[k]}</option>
                              ))}
                            </select>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {grid.rows.slice(0, 5).map((r, ri) => (
                        <tr key={ri}>
                          {mapping.map((m, ci) => (
                            <td
                              key={ci}
                              className={cn(
                                "max-w-[14rem] truncate p-2",
                                !m && "text-muted-foreground/50",
                              )}
                            >
                              {r[ci] || ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {!mapping.includes("task_name") && (
                  <Problem>
                    No column is mapped to Task name. Every new row needs one.
                  </Problem>
                )}

                {built?.notes.map((n) => <Note key={n}>{n}</Note>)}

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setStep("paste")}>Back</Button>
                  <Button
                    onClick={() => setStep("review")}
                    disabled={!mapping.includes("task_name")}
                  >
                    Preview changes
                  </Button>
                </div>
              </div>
            )}

            {/* --------------------------------------------------- review -- */}
            {step === "review" && diff && built && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Tally label="New tasks" value={diff.adds.length} tone="emerald" />
                  <Tally label="Updated" value={diff.changes.length} tone="blue" />
                  <Tally label="Unchanged" value={diff.unchangedCount} />
                  <Tally label="Deleted" value={diff.deletes.length} tone="destructive" />
                </div>

                {span?.start && (
                  <p className="text-xs text-muted-foreground">
                    Pasted work spans {span.start} to {span.end ?? "?"}.
                  </p>
                )}

                {built.notes.map((n) => <Note key={n}>{n}</Note>)}
                {diff.blocking.map((b) => <Problem key={b}>{b}</Problem>)}

                {rowIssues.length > 0 && (
                  <details className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <summary className="cursor-pointer font-medium">
                      {rowIssues.length} row{rowIssues.length === 1 ? "" : "s"} with
                      values that could not be read
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {rowIssues.slice(0, 25).map((r) => (
                        <li key={r.rowNumber}>
                          Row {r.rowNumber} ({r.wbs_code}): {r.issues.join("; ")}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2">
                      These rows still import. A value that could not be read is
                      left empty rather than guessed.
                    </p>
                  </details>
                )}

                {diff.adds.length > 0 && (
                  <Section title={`${diff.adds.length} new task${diff.adds.length === 1 ? "" : "s"}`}>
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">WBS</th>
                          <th className="p-2 font-medium">Task</th>
                          <th className="p-2 font-medium">Dur</th>
                          <th className="p-2 font-medium">Start</th>
                          <th className="p-2 font-medium">Finish</th>
                          <th className="p-2 font-medium">Predecessors</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.adds.map((r) => (
                          <tr key={r.wbs_code}>
                            <td className="p-2 font-mono">{r.wbs_code}</td>
                            <td className="p-2">{fmt(r.values.task_name)}</td>
                            <td className="p-2">{fmt(r.values.duration_days)}</td>
                            <td className="p-2">{fmt(r.values.start_date)}</td>
                            <td className="p-2">{fmt(r.values.end_date)}</td>
                            <td className="p-2 font-mono">
                              {fmt(r.values.predecessors)}
                              {r.rawPredecessors &&
                                r.rawPredecessors !== r.values.predecessors && (
                                  <span className="ml-1 text-muted-foreground">
                                    (was {r.rawPredecessors})
                                  </span>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                )}

                {diff.changes.length > 0 && (
                  <Section title={`${diff.changes.length} task${diff.changes.length === 1 ? "" : "s"} updated`}>
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">WBS</th>
                          <th className="p-2 font-medium">Task</th>
                          <th className="p-2 font-medium">Field</th>
                          <th className="p-2 font-medium">From</th>
                          <th className="p-2 font-medium">To</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.changes.flatMap((c) =>
                          c.fields.map((f, i) => (
                            <tr key={`${c.existing.id}-${f.field}`}>
                              <td className="p-2 font-mono">{i === 0 ? c.existing.wbs_code : ""}</td>
                              <td className="p-2">{i === 0 ? c.existing.task_name : ""}</td>
                              <td className="p-2">{COLUMN_LABELS[f.field]}</td>
                              <td className="p-2 text-muted-foreground line-through">{fmt(f.from)}</td>
                              <td className="p-2 font-medium">{fmt(f.to)}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </Section>
                )}

                <div className="space-y-2 rounded-md border p-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allowDeletes}
                      onChange={(e) => setAllowDeletes(e.target.checked)}
                    />
                    <span className="font-medium">
                      Treat this as the complete list for one branch
                    </span>
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Off by default. When on, any task under the branch below that
                    is missing from the paste is deleted. Scoping it to a branch
                    is deliberate - &ldquo;everything not in this paste&rdquo; is a
                    reasonable statement about civil earthworks and a dangerous
                    one about a whole project.
                  </p>
                  {allowDeletes && (
                    <Input
                      value={deleteRoot}
                      onChange={(e) => setDeleteRoot(e.target.value)}
                      placeholder="5.1"
                      className="max-w-xs font-mono"
                    />
                  )}
                  {allowDeletes && diff.deletes.length > 0 && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                      <p className="font-medium text-destructive">
                        {diff.deletes.length} task
                        {diff.deletes.length === 1 ? "" : "s"} will be deleted:
                      </p>
                      <p className="mt-1 font-mono text-muted-foreground">
                        {diff.deletes.map((d) => d.wbs_code).join(", ")}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        Their field-report updates go with them and any inspection
                        pinned to them loses its link.
                      </p>
                    </div>
                  )}
                </div>

                {error && <Problem>{error}</Problem>}
                {result && (
                  <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
                    {result}
                  </div>
                )}

                <div className="flex justify-end gap-2 border-t pt-4">
                  {result ? (
                    <>
                      <Button variant="ghost" onClick={reset}>Import more</Button>
                      <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => setStep("map")}>Back</Button>
                      <Button
                        onClick={apply}
                        disabled={
                          submitting ||
                          diff.blocking.length > 0 ||
                          (!diff.adds.length && !diff.changes.length && !diff.deletes.length)
                        }
                      >
                        {submitting
                          ? "Applying..."
                          : `Apply ${diff.adds.length + diff.changes.length + diff.deletes.length} change${
                              diff.adds.length + diff.changes.length + diff.deletes.length === 1 ? "" : "s"
                            }`}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="rounded-lg border">
      <summary className="cursor-pointer border-b bg-muted/30 px-3 py-2 text-sm font-medium">
        {title}
      </summary>
      <div className="max-h-72 overflow-auto">{children}</div>
    </details>
  );
}

function Tally({
  label, value, tone,
}: { label: string; value: number; tone?: "emerald" | "blue" | "destructive" }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className={cn(
        "text-xl font-semibold tabular-nums",
        tone === "emerald" && "text-emerald-700",
        tone === "blue" && "text-blue-700",
        tone === "destructive" && value > 0 && "text-destructive",
      )}>
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
