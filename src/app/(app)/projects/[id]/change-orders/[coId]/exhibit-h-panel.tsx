"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ExhibitH } from "@/lib/change-order-pricing";
import {
  updateContractDates,
  updateCoFormFields,
  updateOriginalContractValue,
} from "../../change-orders-actions";

type Props = {
  exhibitH: ExhibitH;
  coId: string;
  projectId: string;
  mechDeltaDays: number | null;
  substDeltaDays: number | null;
  /**
   * Project facts, editable here because this is where you need them. The two
   * guaranteed dates should eventually come off the schedule's milestones
   * instead of being typed.
   */
  originalContractValue: number | null;
  agreementDate: string | null;
  guaranteedMechanicalDate: string | null;
  guaranteedSubstantialDate: string | null;
};

/**
 * Every value Exhibit H asks for, computed and laid out in the order the form
 * asks for it, with a copy button on each one.
 *
 * This deliberately does not render or export the owner's form. Phil fills out
 * Dimension's document; the platform's job is to make sure the numbers he
 * types into it are right and tie out to the contract.
 */
export function ExhibitHPanel({
  exhibitH: h,
  coId,
  projectId,
  mechDeltaDays,
  substDeltaDays,
  originalContractValue,
  agreementDate,
  guaranteedMechanicalDate,
  guaranteedSubstantialDate,
}: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);
  const [mech, setMech] = useState(mechDeltaDays == null ? "" : String(mechDeltaDays));
  const [subst, setSubst] = useState(substDeltaDays == null ? "" : String(substDeltaDays));
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // Project-level facts save the moment the field is left, so there is no
  // second Save button competing with the one below.
  async function saveDates(patch: Parameters<typeof updateContractDates>[1], key: string) {
    setSaving(key);
    await updateContractDates(projectId, patch);
    setSaving(null);
    router.refresh();
  }

  async function saveOriginal(raw: string) {
    const cleaned = raw.replace(/[$,\s]/g, "");
    const n = cleaned ? Number(cleaned) : null;
    if (cleaned && !Number.isFinite(n)) return;
    setSaving("original");
    await updateOriginalContractValue(projectId, { originalContractValue: n });
    setSaving(null);
    router.refresh();
  }

  const dirty =
    mech !== (mechDeltaDays == null ? "" : String(mechDeltaDays)) ||
    subst !== (substDeltaDays == null ? "" : String(substDeltaDays));

  async function saveDeltas() {
    setBusy(true);
    await updateCoFormFields(coId, projectId, {
      mechCompletionDeltaDays: toIntOrNull(mech),
      substCompletionDeltaDays: toIntOrNull(subst),
    });
    setBusy(false);
    router.refresh();
  }

  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  }

  const money = (n: number | null) => (n == null ? "-" : formatCurrency(n));
  const raw = (n: number | null) => (n == null ? "" : n.toFixed(2));

  const line2Label =
    h.previousChangeOrderNumbers.length > 0
      ? `Net change by previously authorized Change Orders (# ${h.previousChangeOrderNumbers.join(", ")})`
      : "Net change by previously authorized Change Orders (none yet)";

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="border-b p-4">
        <h3 className="text-sm font-semibold">Exhibit H - Form of Change Order</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The numbers and dates for the owner&apos;s form, computed from the contract and the
          approved change orders. Copy each into the form.
        </p>
      </div>

      {h.missing.length > 0 && (
        <div className="border-b border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>Not enough contract data to fill the form completely.</strong> Missing:{" "}
          {h.missing.join(", ")}.{" "}
          {h.missing.some((m) => m !== "Date of change order") && (
            <a
              href={`/projects/${projectId}/edit`}
              className="underline underline-offset-2"
            >
              Set the contract terms on the project
            </a>
          )}
          {h.originalContractPriceIsFallback && (
            <div className="mt-1">
              Line 1 is currently showing the project&apos;s CURRENT contract value as a stand-in.
              That is only correct if no change order has ever been approved.
            </div>
          )}
        </div>
      )}

      <dl className="divide-y text-sm">
        <Row label="Project name" value={h.projectName} onCopy={copy} copied={copied} />
        <Row label="Owner" value={h.owner || "-"} onCopy={copy} copied={copied} />
        <Row label="Contractor" value={h.contractor} onCopy={copy} copied={copied} />
        <Row label="Change order number" value={h.coNumber} onCopy={copy} copied={copied} />
        <Row
          label="Date of change order"
          value={h.dateOfChangeOrder ? formatDate(h.dateOfChangeOrder) : "-"}
          onCopy={copy}
          copied={copied}
        />
        <EditRow
          label="Date of agreement"
          type="date"
          defaultValue={agreementDate ?? ""}
          saving={saving === "agreement"}
          onCommit={(v) => saveDates({ agreementDate: v || null }, "agreement")}
        />
      </dl>

      <div className="border-t bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Adjustment to contract price
      </div>
      <dl className="divide-y text-sm">
        <EditRow
          label="1. The original Contract Price was"
          defaultValue={originalContractValue == null ? "" : String(originalContractValue)}
          placeholder="2507500.00"
          hint={money(h.originalContractPrice)}
          saving={saving === "original"}
          onCommit={saveOriginal}
          align="right"
        />
        <Row
          label={`2. ${line2Label}`}
          value={money(h.netPreviousChangeOrders)}
          copyValue={raw(h.netPreviousChangeOrders)}
          onCopy={copy}
          copied={copied}
          mono
        />
        <Row
          label="3. The Contract Price prior to this Change Order was"
          value={money(h.contractPricePriorToThisCo)}
          copyValue={raw(h.contractPricePriorToThisCo)}
          onCopy={copy}
          copied={copied}
          mono
        />
        <Row
          label={`4. The Contract Price will be ${h.direction} by this Change Order in the amount of`}
          value={money(h.thisChangeOrderAmount)}
          copyValue={raw(h.thisChangeOrderAmount)}
          onCopy={copy}
          copied={copied}
          mono
          accent
        />
        <Row
          label="5. The new Contract Price including this Change Order will be"
          value={money(h.newContractPrice)}
          copyValue={raw(h.newContractPrice)}
          onCopy={copy}
          copied={copied}
          mono
          accent
        />
      </dl>

      <div className="border-t bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Adjustment to dates in project schedule
      </div>
      <dl className="divide-y text-sm">
        <EditRow
          label="Guaranteed Mechanical Completion Date (current)"
          type="date"
          defaultValue={guaranteedMechanicalDate ?? ""}
          saving={saving === "mechDate"}
          onCommit={(v) =>
            saveDates({ guaranteedMechanicalCompletionDate: v || null }, "mechDate")
          }
        />
        <DeltaRow
          label="Mechanical - change by"
          value={mech}
          onChange={setMech}
          direction={h.mechanical.direction}
        />
        <Row
          label="Guaranteed Mechanical Completion Date (revised)"
          value={h.mechanical.revisedDate ? formatDate(h.mechanical.revisedDate) : "-"}
          onCopy={copy}
          copied={copied}
          accent
        />
        <EditRow
          label="Guaranteed Substantial Completion Date (current)"
          type="date"
          defaultValue={guaranteedSubstantialDate ?? ""}
          saving={saving === "substDate"}
          onCommit={(v) =>
            saveDates({ guaranteedSubstantialCompletionDate: v || null }, "substDate")
          }
        />
        <DeltaRow
          label="Substantial - change by"
          value={subst}
          onChange={setSubst}
          direction={h.substantial.direction}
        />
        <Row
          label="Guaranteed Substantial Completion Date (revised)"
          value={h.substantial.revisedDate ? formatDate(h.substantial.revisedDate) : "-"}
          onCopy={copy}
          copied={copied}
          accent
        />
      </dl>

      {dirty && (
        <div className="flex items-center justify-end gap-2 border-t bg-muted/20 px-4 py-2">
          <span className="mr-auto text-[11px] text-muted-foreground">
            Positive days push the date out.
          </span>
          <button
            type="button"
            onClick={saveDeltas}
            disabled={busy}
            className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save schedule impact"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * A value that is typed here rather than derived. Commits on blur so a project
 * fact does not need its own Save button in a panel that mostly reads.
 */
function EditRow({
  label,
  defaultValue,
  type,
  placeholder,
  hint,
  saving,
  onCommit,
  align,
}: {
  label: string;
  defaultValue: string;
  type?: "date";
  placeholder?: string;
  hint?: string;
  saving: boolean;
  onCommit: (value: string) => void;
  align?: "right";
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>
      {hint && value.trim() !== "" && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{hint}</span>
      )}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== defaultValue) onCommit(value);
        }}
        className={cn(
          "h-7 w-40 rounded border border-input bg-background px-2 text-sm",
          align === "right" && "text-right tabular-nums",
        )}
      />
      <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground">
        {saving ? "Saving" : ""}
      </span>
    </div>
  );
}

function toIntOrNull(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function DeltaRow({
  label,
  value,
  onChange,
  direction,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  direction: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        placeholder="0"
        aria-label={label}
        className="h-7 w-20 rounded border border-input bg-background px-2 text-right text-sm tabular-nums"
      />
      <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground">
        {direction === "unchanged" ? "days" : direction}
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  copyValue,
  onCopy,
  copied,
  mono,
  accent,
}: {
  label: string;
  value: string;
  copyValue?: string;
  onCopy: (key: string, value: string) => void;
  copied: string | null;
  mono?: boolean;
  accent?: boolean;
}) {
  const toCopy = copyValue ?? value;
  const disabled = !toCopy || toCopy === "-";
  return (
    <div className="flex items-baseline gap-3 px-4 py-2">
      <dt className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "shrink-0 text-right",
          mono && "tabular-nums",
          accent && "font-semibold text-emerald-700",
        )}
      >
        {value}
      </dd>
      <button
        type="button"
        onClick={() => onCopy(label, toCopy)}
        disabled={disabled}
        className="w-12 shrink-0 text-right text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        {copied === label ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
