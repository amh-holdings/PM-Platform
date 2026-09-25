"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { amountFromPct, pctFromAmount } from "@/lib/milestone-split";
import {
  addMilestone,
  deleteMilestone,
  markMilestonePaid,
  setMilestoneLine,
  updateMilestone,
} from "../../procurement-actions";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  MILESTONE_TRIGGERS,
  MILESTONE_TRIGGER_GROUPS,
  isRecognisedTrigger,
} from "@/lib/progress";

/**
 * The trigger picker.
 *
 * A free-text box here looked harmless and quietly decided whether a PO ever
 * billed: the matcher reads words, so "Equipment arrival" earned nothing and
 * said nothing. The options now show when each one earns, because that is the
 * part nobody could have guessed.
 *
 * Grouped, because four options that all earn on signature read as four
 * different rules until you notice every label ends the same way. The heading
 * carries the rule and the options carry only the wording, which is the only
 * thing that actually differs between them.
 *
 * A value already stored that is not an option is kept and offered rather than
 * silently swapped - "Delivered to site" works fine and rewriting somebody's
 * wording to make a dropdown tidy is not a fix. It is only flagged when the
 * matcher genuinely does not recognise it.
 */
function TriggerSelect({
  id,
  defaultValue,
}: {
  id: string;
  defaultValue?: string | null;
}) {
  const current = (defaultValue ?? "").trim();
  const inList = MILESTONE_TRIGGERS.some((t) => t.value === current);
  const recognised = isRecognisedTrigger(current);
  return (
    <>
      <select
        id={id}
        name="trigger_event"
        defaultValue={current}
        className="h-9 w-full rounded-md border bg-background px-2 text-xs"
      >
        <option value="">No trigger - bills only when you enter a paid date</option>
        {MILESTONE_TRIGGER_GROUPS.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {MILESTONE_TRIGGERS.filter((t) => t.group === g.key).map((t) => (
              <option key={t.value} value={t.value}>
                {t.value}
              </option>
            ))}
          </optgroup>
        ))}
        {current && !inList && (
          <option value={current}>
            {current}
            {recognised ? "" : " - not recognised, earns nothing"}
          </option>
        )}
      </select>
      {current && !recognised && (
        <p className="mt-0.5 text-[10px] text-amber-700">
          This wording earns nothing. Pick one of the options above.
        </p>
      )}
    </>
  );
}

type Milestone = {
  id: string;
  milestone_name: string;
  pct_of_total: number | null;
  trigger_event: string | null;
  expected_date: string | null;
  amount: number | null;
  paid_at: string | null;
  paid_amount: number | null;
  sort_order: number | null;
  notes: string | null;
  /**
   * Which item on the PO this payment is for, when it is for one item rather
   * than the whole order. Null is the whole order. Migration 0062.
   */
  procurement_order_line_id?: string | null;
  /**
   * What date this row actually runs on and where it came from.
   *
   * `drives` is true when the schedule supplies it, which makes it the
   * Expected value rather than a footnote. Computed on the server.
   */
  forecast?: {
    date: string | null;
    drives: boolean;
    note: string | null;
  } | null;
};

type Props = {
  projectId: string;
  poId: string;
  poTotalValue: number;
  milestones: Milestone[];
  /**
   * The items on this PO, for tying a payment to one of them.
   *
   * Zarina: "there are POs that has multiple deliveries on it. And each item
   * inside a PO can be linked to a line in the schedule." A PO with one
   * delivery has nothing to choose between, so the control only appears once
   * there is more than one item.
   */
  lines?: { id: string; label: string }[];
  /**
   * Which schedule this editor is editing: what we pay the vendor, or what we
   * bill the owner. Migration 0055. Defaults to vendor, which is what every
   * milestone was before the two split.
   */
};

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function MilestoneEditor({
  projectId,
  poId,
  poTotalValue,
  milestones,
  lines = [],
}: Props) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Which milestone is having its payment recorded, and what is typed so far.
  // Most of these POs were paid before this app existed, so the date is an
  // input with today as a starting point, not an assumption.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState("");
  const [paidAmount, setPaidAmount] = useState("");

  /** Tie a payment to one item on the PO, or back to the whole order. */
  async function onSetLine(milestoneId: string, lineId: string | null) {
    setBusy(true);
    setError(null);
    const res = await setMilestoneLine(milestoneId, poId, projectId, lineId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  function openPayment(m: Milestone) {
    setError(null);
    setPayingId(m.id);
    // Blank, not today. Zarina: "I selected paid on 7/17, but it reads
    // september." A date input shows three separate segments in whatever
    // order the browser's locale puts them, and hers reads dd/mm/yyyy while
    // the app prints Sep 17, 2026. Seeding it with today handed her a
    // complete date where changing one segment leaves the other two as
    // today's, so an edited day with September still on it saves silently
    // and looks deliberate. Empty forces all three to be entered, and the
    // line under the box reads the choice back the way the page will print
    // it, so a month that is not the one meant is visible before Save.
    setPaidDate(m.paid_at ?? "");
    setPaidAmount(String(Number(m.paid_amount ?? m.amount ?? 0)));
  }

  async function onAdd(formData: FormData) {
    setBusy(true);
    setError(null);
    // The form posts the fields; which schedule they land on is the editor's
    // to say, not something a person should have to pick on every row.
    const res = await addMilestone(poId, projectId, formData);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAdding(false);
    startTransition(() => router.refresh());
  }

  async function onUpdate(formData: FormData, mid: string) {
    setBusy(true);
    setError(null);
    const res = await updateMilestone(mid, poId, projectId, formData);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditId(null);
    startTransition(() => router.refresh());
  }

  async function onSavePayment(mid: string) {
    setError(null);
    const date = paidDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Enter the date this was paid.");
      return;
    }
    // A payment cannot have happened tomorrow. The field for money you expect
    // to pay is Expected date, one column over.
    if (date > todayIso()) {
      setError("That date is in the future. Use Expected date for a payment that has not happened yet.");
      return;
    }
    const amt = Number(paidAmount.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Amount paid must be a positive number.");
      return;
    }
    setBusy(true);
    const res = await markMilestonePaid(mid, poId, projectId, date, amt);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPayingId(null);
    startTransition(() => router.refresh());
  }

  async function onClearPayment(mid: string) {
    if (!confirm("Clear the payment on this milestone? It goes back to unpaid.")) return;
    setError(null);
    setBusy(true);
    const res = await markMilestonePaid(mid, poId, projectId, null);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPayingId(null);
    startTransition(() => router.refresh());
  }

  async function onDelete(mid: string) {
    if (!confirm("Delete this milestone?")) return;
    setBusy(true);
    const res = await deleteMilestone(mid, poId, projectId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div>
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-2 text-left font-medium">Milestone</th>
              <th className="px-2 py-2 text-left font-medium">Trigger</th>
              <th className="px-2 py-2 text-right font-medium">%</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-2 py-2 text-left font-medium">Expected</th>
              <th className="px-2 py-2 text-left font-medium">Paid</th>
              <th className="px-2 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) =>
              editId === m.id ? (
                <EditRow
                  key={m.id}
                  m={m}
                  poTotalValue={poTotalValue}
                  onCancel={() => setEditId(null)}
                  onSubmit={(fd) => onUpdate(fd, m.id)}
                  busy={busy}
                />
              ) : (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{m.milestone_name}</div>
                    {m.notes && (
                      <div className="text-[10px] text-muted-foreground">
                        {m.notes}
                      </div>
                    )}
                    {/* Which item this payment is for. A whole-order milestone
                        waits for the last item to land; one tied to an item
                        follows that item. Only worth a control when there is
                        more than one item to choose between. */}
                    {lines.length > 1 && (
                      <select
                        value={m.procurement_order_line_id ?? ""}
                        disabled={busy}
                        onChange={(e) =>
                          void onSetLine(m.id, e.target.value || null)
                        }
                        className="mt-1 h-6 max-w-[16rem] rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
                        aria-label={`What ${m.milestone_name} pays for`}
                      >
                        <option value="">Pays for the whole order</option>
                        {lines.map((l) => (
                          <option key={l.id} value={l.id}>
                            Pays for {l.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {m.trigger_event ?? "-"}
                    {m.trigger_event && !isRecognisedTrigger(m.trigger_event) && (
                      <span
                        className="ml-1 text-amber-600"
                        title="This trigger wording is not recognised, so this milestone earns nothing. Edit it and pick one of the listed triggers."
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {m.pct_of_total != null ? `${m.pct_of_total.toFixed(0)}%` : "-"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono">
                    {formatCurrency(Number(m.amount ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {/* The schedule is the source of truth for a delivery, so
                        when it supplies the date it is the value here and the
                        typed one is demoted to a note. Anything else shows
                        what was typed, because that is all there is. */}
                    {m.forecast?.drives && m.forecast.date ? (
                      <>
                        <div className="font-medium text-foreground">
                          {formatDate(m.forecast.date)}
                        </div>
                        {m.expected_date && m.expected_date !== m.forecast.date && (
                          <div className="text-[10px] text-muted-foreground">
                            typed {formatDate(m.expected_date)}, superseded
                          </div>
                        )}
                      </>
                    ) : (
                      <div>{m.expected_date ? formatDate(m.expected_date) : "-"}</div>
                    )}
                    {m.forecast?.note && (
                      <div
                        className={cn(
                          "text-[10px]",
                          m.forecast.note.startsWith("No date")
                            ? "text-amber-700"
                            : "text-muted-foreground",
                        )}
                      >
                        {m.forecast.note}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {payingId === m.id ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <div>
                          <Input
                            type="date"
                            max={todayIso()}
                            value={paidDate}
                            onChange={(e) => setPaidDate(e.target.value)}
                            className="h-8 w-[9.5rem] text-xs"
                            aria-label="Date paid"
                          />
                          {/* The date read back the way this page prints it,
                              so a dd/mm box and a Mon D, YYYY column cannot
                              disagree without somebody seeing it. */}
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {paidDate ? formatDate(paidDate) : "Pick the date it was paid"}
                          </div>
                        </div>
                        <MoneyInput
                          value={paidAmount}
                          onTextChange={setPaidAmount}
                          className="h-8 w-28 text-right text-xs"
                          aria-label="Amount paid"
                        />
                      </div>
                    ) : m.paid_at ? (
                      <div>
                        <div className="text-emerald-700">
                          {formatCurrency(Number(m.paid_amount ?? m.amount ?? 0))}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          paid {formatDate(m.paid_at)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex justify-end gap-1">
                      {payingId === m.id ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => onSavePayment(m.id)}
                          >
                            {busy ? "Saving..." : "Save"}
                          </Button>
                          {m.paid_at && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              disabled={busy}
                              onClick={() => onClearPayment(m.id)}
                            >
                              Clear
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setPayingId(null);
                              setError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant={m.paid_at ? "ghost" : "outline"}
                          size="sm"
                          disabled={busy}
                          onClick={() => openPayment(m)}
                        >
                          {/* Already paid stays editable. These POs were paid
                              on paper long before the app, so the first date
                              entered is a recollection and recollections get
                              corrected. */}
                          {m.paid_at ? "Edit payment" : "Mark paid"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setEditId(m.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => onDelete(m.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {milestones.length === 0 && !adding && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-4 text-center text-muted-foreground"
                >
                  No milestones yet. Add a deposit, delivery, and any
                  commissioning milestones below.
                </td>
              </tr>
            )}

            {adding && (
              <AddRow
                poTotalValue={poTotalValue}
                onCancel={() => setAdding(false)}
                onSubmit={onAdd}
                busy={busy}
              />
            )}
          </tbody>
        </table>
      </div>

      {!adding && (
        <div className="border-t bg-muted/20 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            Add milestone
          </Button>
        </div>
      )}
    </div>
  );
}

function AddRow({
  poTotalValue,
  onCancel,
  onSubmit,
  busy,
}: {
  poTotalValue: number;
  onCancel: () => void;
  onSubmit: (fd: FormData) => void;
  busy: boolean;
}) {
  // The two boxes say the same thing, so whichever one is being typed in
  // drives the other. Zarina: "if I write here the % amount it should
  // calculate automatically." See milestone-split.
  const [pct, setPct] = useState("");
  const [amount, setAmount] = useState<number | null>(null);

  function typePct(next: string) {
    setPct(next);
    const n = next.trim() === "" ? null : Number(next);
    const derived = amountFromPct(poTotalValue, n);
    if (derived !== null) setAmount(derived);
    else if (n === null) setAmount(null);
  }

  function typeAmount(next: number | null) {
    setAmount(next);
    const derived = pctFromAmount(poTotalValue, next);
    if (derived !== null) setPct(String(derived));
    else if (next === null) setPct("");
  }

  return (
    <tr className="border-b bg-emerald-500/5">
      <td colSpan={7} className="p-3">
        <form action={onSubmit} className="grid gap-2 sm:grid-cols-[1fr_140px_100px_140px_130px_130px_auto]">
          <div>
            <Label htmlFor="m-name" className="text-[10px]">Milestone name *</Label>
            <Input id="m-name" name="milestone_name" placeholder="Deposit / Delivery / Commissioning" required />
          </div>
          <div>
            <Label htmlFor="m-trigger" className="text-[10px]">Trigger</Label>
            <TriggerSelect id="m-trigger" />
          </div>
          <div>
            <Label htmlFor="m-pct" className="text-[10px]">% of PO</Label>
            <Input
              id="m-pct"
              name="pct_of_total"
              type="number"
              step="0.01"
              value={pct}
              onChange={(e) => typePct(e.target.value)}
              placeholder="10"
            />
          </div>
          <div>
            <Label htmlFor="m-amount" className="text-[10px]">Amount</Label>
            <MoneyInput
              id="m-amount"
              name="amount"
              value={amount}
              onValueChange={typeAmount}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="m-expected" className="text-[10px]">Expected date</Label>
            <Input id="m-expected" name="expected_date" type="date" />
          </div>
          {/* Most POs on a job that predates the app were paid before anyone
              was entering milestones. Recording that took adding a milestone
              and then marking it paid - two actions for one fact. */}
          <div>
            <Label htmlFor="m-paid" className="text-[10px]">Already paid on</Label>
            <Input id="m-paid" name="paid_at" type="date" />
          </div>
          <div className="flex items-end justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Add
            </Button>
          </div>
          <div className="sm:col-span-7">
            <Input name="notes" placeholder="Notes (optional)" />
          </div>
          <p className="text-[10px] text-muted-foreground sm:col-span-7">
            Filling in <span className="font-medium">Already paid on</span>{" "}
            records the payment as made, so it lands in the month it left
            rather than in the forecast ahead. An amount, or a % to work one
            out from, is required with it - a payment of nothing counts as
            nothing.
          </p>
        </form>
      </td>
    </tr>
  );
}

function EditRow({
  m,
  poTotalValue,
  onCancel,
  onSubmit,
  busy,
}: {
  m: Milestone;
  poTotalValue: number;
  onCancel: () => void;
  onSubmit: (fd: FormData) => void;
  busy: boolean;
}) {
  // Same two-way rule as the add row. This is the one she was looking at: 50
  // in the % box next to the full PO value in Amount, and Amount is what
  // reaches the cash flow.
  const [pct, setPct] = useState(
    m.pct_of_total == null ? "" : String(m.pct_of_total),
  );
  const [amount, setAmount] = useState<number | null>(m.amount ?? null);

  function typePct(next: string) {
    setPct(next);
    const n = next.trim() === "" ? null : Number(next);
    const derived = amountFromPct(poTotalValue, n);
    if (derived !== null) setAmount(derived);
    else if (n === null) setAmount(null);
  }

  function typeAmount(next: number | null) {
    setAmount(next);
    const derived = pctFromAmount(poTotalValue, next);
    if (derived !== null) setPct(String(derived));
    else if (next === null) setPct("");
  }

  return (
    <tr className="border-b bg-amber-500/5">
      <td colSpan={7} className="p-3">
        <form
          action={onSubmit}
          className="grid gap-2 sm:grid-cols-[1fr_140px_100px_140px_140px_auto]"
        >
          <div>
            <Label htmlFor={`mn-${m.id}`} className="text-[10px]">Milestone name</Label>
            <Input id={`mn-${m.id}`} name="milestone_name" defaultValue={m.milestone_name} required />
          </div>
          <div>
            <Label htmlFor={`mt-${m.id}`} className="text-[10px]">Trigger</Label>
            <TriggerSelect id={`mt-${m.id}`} defaultValue={m.trigger_event} />
          </div>
          <div>
            <Label htmlFor={`mp-${m.id}`} className="text-[10px]">%</Label>
            <Input
              id={`mp-${m.id}`}
              name="pct_of_total"
              type="number"
              step="0.01"
              value={pct}
              onChange={(e) => typePct(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`ma-${m.id}`} className="text-[10px]">Amount</Label>
            <MoneyInput
              id={`ma-${m.id}`}
              name="amount"
              value={amount}
              onValueChange={typeAmount}
            />
          </div>
          <div>
            <Label htmlFor={`me-${m.id}`} className="text-[10px]">Expected</Label>
            <Input
              id={`me-${m.id}`}
              name="expected_date"
              type="date"
              defaultValue={m.expected_date ?? ""}
            />
          </div>
          <div className="flex items-end justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
          </div>
          <div className="sm:col-span-6">
            <Input
              name="notes"
              defaultValue={m.notes ?? ""}
              placeholder="Notes (optional)"
            />
          </div>
        </form>
      </td>
    </tr>
  );
}
