"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  RFI_BALL_IN_COURT,
  RFI_STATE_LABEL,
  daysOpen,
  daysWithEor,
  isOverdue,
  rfiState,
  wasLate,
  type RfiRow,
  type RfiState,
  type RfiSummary,
} from "@/lib/rfi-log";

import { createRfi, deleteRfi, setRfiStep, type RfiStep } from "./rfis-actions";

type Sub = { id: string; company_name: string };

type Props = {
  projectId: string;
  rfis: RfiRow[];
  summary: RfiSummary;
  subs: Sub[];
  today: string;
  suggestedNumber: string;
};

const STATE_TONE: Record<RfiState, string> = {
  with_us: "bg-amber-100 text-amber-900",
  with_eor: "bg-sky-100 text-sky-900",
  answered: "bg-emerald-100 text-emerald-900",
  closed: "bg-muted text-muted-foreground",
};

export function RfiLog({
  projectId,
  rfis,
  summary,
  subs,
  today,
  suggestedNumber,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [, startTransition] = useTransition();

  const subName = (id: string | null) =>
    subs.find((s) => s.id === id)?.company_name ?? null;

  async function step(rfi: RfiRow, which: RfiStep, date: string | null, answer?: string) {
    setBusyId(rfi.id);
    setError(null);
    const res = await setRfiStep(rfi.id, projectId, which, date, answer);
    setBusyId(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setExpanded(null);
    startTransition(() => router.refresh());
  }

  async function submitNew(form: FormData) {
    setError(null);
    const res = await createRfi({
      projectId,
      rfiNumber: String(form.get("rfi_number") ?? ""),
      subject: String(form.get("subject") ?? ""),
      question: String(form.get("question") ?? ""),
      discipline: String(form.get("discipline") ?? "") || null,
      wbsCode: String(form.get("wbs_code") ?? "") || null,
      subcontractorId: String(form.get("subcontractor_id") ?? "") || null,
      raisedBy: String(form.get("raised_by") ?? "") || null,
      eorFirm: String(form.get("eor_firm") ?? "") || null,
      eorContact: String(form.get("eor_contact") ?? "") || null,
      receivedAt: String(form.get("received_at") ?? today),
      responseNeededBy: String(form.get("response_needed_by") ?? "") || null,
      costImpact: form.get("cost_impact") === "on",
      scheduleImpact: form.get("schedule_impact") === "on",
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">RFIs</h2>
          <p className="text-xs text-muted-foreground">
            Questions from the subs, forwarded to the engineer of record.
            Whose desk each one is on, and how long it has been there.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>Log an RFI</Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Open" value={summary.open} />
        <Stat label="To forward" value={summary.withUs} tone={summary.withUs > 0 ? "warn" : undefined} />
        <Stat label="With EOR" value={summary.withEor} />
        <Stat label="To pass back" value={summary.answered} tone={summary.answered > 0 ? "warn" : undefined} />
        <Stat label="Overdue" value={summary.overdue} tone={summary.overdue > 0 ? "bad" : "good"} />
      </div>

      {open && (
        <form
          action={submitNew}
          className="space-y-3 rounded-lg border bg-card p-4 shadow-sm"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="RFI number" name="rfi_number" defaultValue={suggestedNumber} required />
            <Field label="Received" name="received_at" type="date" defaultValue={today} required />
            <Field label="Answer needed by" name="response_needed_by" type="date" />
          </div>
          <Field label="Subject" name="subject" required />
          <div className="space-y-2">
            <Label htmlFor="question">Question</Label>
            <textarea
              id="question"
              name="question"
              required
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="subcontractor_id">Raised by (sub)</Label>
              <select
                id="subcontractor_id"
                name="subcontractor_id"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Not recorded</option>
                {subs.map((s) => (
                  <option key={s.id} value={s.id}>{s.company_name}</option>
                ))}
              </select>
            </div>
            <Field label="Person" name="raised_by" />
            <Field label="Discipline" name="discipline" placeholder="Civil" />
            <Field label="Blocks WBS" name="wbs_code" placeholder="1.2.1.4" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="EOR firm" name="eor_firm" placeholder="Exactus" />
            <Field label="EOR contact" name="eor_contact" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="cost_impact" /> Possible cost impact
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="schedule_impact" /> Possible schedule impact
            </label>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </div>
        </form>
      )}

      {rfis.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          No RFIs logged yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2 font-medium">RFI</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">EOR</th>
                <th className="px-4 py-2 font-medium">Where</th>
                <th className="px-4 py-2 font-medium">Age</th>
                <th className="px-4 py-2 text-right font-medium">Next</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rfis.map((r) => {
                const state = rfiState(r);
                const overdue = isOverdue(r, today);
                const withEor = daysWithEor(r, today);
                return (
                  // Fragment with the key, not a bare <>: the row and its
                  // detail are two <tr>s and React needs the key on the
                  // thing the list yields, not on its children.
                  <Fragment key={r.id}>
                    <tr
                      className={cn(
                        "cursor-pointer hover:bg-muted/30",
                        overdue && "bg-destructive/5",
                      )}
                      onClick={() => {
                        setExpanded(expanded === r.id ? null : r.id);
                        setAnswerDraft(r.answer ?? "");
                      }}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs">{r.rfi_number}</td>
                      <td className="px-4 py-2.5 font-medium">
                        {r.subject || r.question.slice(0, 60)}
                        {(r.cost_impact || r.schedule_impact) && (
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">
                            {r.cost_impact && r.schedule_impact
                              ? "$ + time"
                              : r.cost_impact
                                ? "$"
                                : "time"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {subName(r.subcontractor_id) ?? r.raised_by ?? "-"}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.eor_firm ?? "-"}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            STATE_TONE[state],
                          )}
                        >
                          {RFI_STATE_LABEL[state]}
                        </span>
                        {overdue && (
                          <span className="ml-2 text-[11px] font-semibold text-destructive">
                            overdue
                          </span>
                        )}
                        {!overdue && wasLate(r) && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            answered late
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {daysOpen(r, today)}d
                        {withEor !== null && state === "with_eor" && (
                          <span className="ml-1 text-[11px]">({withEor}d EOR)</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {RFI_BALL_IN_COURT[state]}
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="bg-muted/20">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="space-y-3 text-sm">
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Question
                              </p>
                              <p className="whitespace-pre-wrap">{r.question}</p>
                            </div>
                            {r.answer && (
                              <div>
                                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  Answer
                                </p>
                                <p className="whitespace-pre-wrap">{r.answer}</p>
                              </div>
                            )}
                            <div className="flex flex-wrap items-end gap-2">
                              {state === "with_us" && (
                                <Button
                                  size="sm"
                                  disabled={busyId === r.id}
                                  onClick={() => step(r, "sent_to_eor_at", today)}
                                >
                                  Forwarded to EOR today
                                </Button>
                              )}
                              {state === "with_eor" && (
                                <>
                                  <textarea
                                    value={answerDraft}
                                    onChange={(e) => setAnswerDraft(e.target.value)}
                                    rows={3}
                                    placeholder="What the engineer said"
                                    className="min-w-[20rem] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                                  />
                                  <Button
                                    size="sm"
                                    disabled={busyId === r.id}
                                    onClick={() => step(r, "answered_at", today, answerDraft)}
                                  >
                                    Record the answer
                                  </Button>
                                </>
                              )}
                              {state === "answered" && (
                                <Button
                                  size="sm"
                                  disabled={busyId === r.id}
                                  onClick={() => step(r, "closed_at", today)}
                                >
                                  Passed back, close it
                                </Button>
                              )}
                              {/* Every step is reversible. "I forwarded the
                                  wrong one" is a Tuesday, and without this the
                                  only way back is the SQL editor. */}
                              {state !== "with_us" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyId === r.id}
                                  onClick={() =>
                                    step(
                                      r,
                                      state === "closed"
                                        ? "closed_at"
                                        : state === "answered"
                                          ? "answered_at"
                                          : "sent_to_eor_at",
                                      null,
                                    )
                                  }
                                >
                                  Undo last step
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busyId === r.id}
                                onClick={async () => {
                                  if (!confirm(`Delete ${r.rfi_number}?`)) return;
                                  setBusyId(r.id);
                                  const res = await deleteRfi(r.id, projectId);
                                  setBusyId(null);
                                  if (!res.ok) setError(res.error);
                                  else startTransition(() => router.refresh());
                                }}
                              >
                                Delete
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Received {r.received_at || "-"}
                              {r.sent_to_eor_at && ` - sent ${r.sent_to_eor_at}`}
                              {r.answered_at && ` - answered ${r.answered_at}`}
                              {r.closed_at && ` - closed ${r.closed_at}`}
                              {r.response_needed_by && ` - needed by ${r.response_needed_by}`}
                              {r.wbs_code && ` - blocks ${r.wbs_code}`}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-emerald-700",
          tone === "warn" && "text-amber-700",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}
