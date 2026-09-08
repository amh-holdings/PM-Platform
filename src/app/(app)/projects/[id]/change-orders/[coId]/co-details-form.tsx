"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChangeOrderDetail } from "@/lib/change-order-load";
import {
  updateCoFormFields,
  updateCoNumber,
  updateProjectContractFacts,
} from "../../change-orders-actions";

type ContractFacts = {
  originalContractValue: number | null;
  agreementDate: string | null;
  guaranteedMechanicalCompletionDate: string | null;
  guaranteedSubstantialCompletionDate: string | null;
  contractorLegalName: string | null;
  contractorSignatoryName: string | null;
  contractorSignatoryTitle: string | null;
};

type Props = {
  co: ChangeOrderDetail;
  contractFacts: ContractFacts;
  /** Contract facts are project-wide, so only offer them where they belong. */
  canEditProject: boolean;
};

function s(v: string | null | undefined): string {
  return v ?? "";
}
function n(v: number | null): string {
  return v == null ? "" : String(v);
}
function toNumOrNull(v: string): number | null {
  if (!v.trim()) return null;
  const x = Number(v.replace(/[$,%\s]/g, ""));
  return Number.isFinite(x) ? x : null;
}
function toIntOrNull(v: string): number | null {
  if (!v.trim()) return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

export function CoDetailsForm({ co, contractFacts, canEditProject }: Props) {
  const router = useRouter();
  // A freshly created CO has an auto-assigned number and nothing else. It
  // lands straight on this page, so open the section holding its number and
  // description rather than hiding them behind "Edit".
  const [open, setOpen] = useState(!co.description && !co.reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [coNumber, setCoNumber] = useState(co.coNumber);
  const [description, setDescription] = useState(s(co.description));
  const [reason, setReason] = useState(s(co.reason));
  const [dateOfCo, setDateOfCo] = useState(s(co.dateOfChangeOrder));
  const [profitPct, setProfitPct] = useState(n(co.profitPct));
  const [bondPct, setBondPct] = useState(n(co.bondPct));
  const [taxPct, setTaxPct] = useState(n(co.taxPct));
  const [mechDays, setMechDays] = useState(n(co.mechCompletionDeltaDays));
  const [substDays, setSubstDays] = useState(n(co.substCompletionDeltaDays));
  const [exhibitE, setExhibitE] = useState(s(co.exhibitEImpact));
  const [capacity, setCapacity] = useState(s(co.capacityRatioImpact));
  const [designBasis, setDesignBasis] = useState(s(co.designBasisImpact));
  const [other, setOther] = useState(s(co.otherImpacts));

  const [origValue, setOrigValue] = useState(n(contractFacts.originalContractValue));
  const [agreementDate, setAgreementDate] = useState(s(contractFacts.agreementDate));
  const [mechDate, setMechDate] = useState(s(contractFacts.guaranteedMechanicalCompletionDate));
  const [substDate, setSubstDate] = useState(s(contractFacts.guaranteedSubstantialCompletionDate));
  const [contractorName, setContractorName] = useState(s(contractFacts.contractorLegalName));
  const [signatory, setSignatory] = useState(s(contractFacts.contractorSignatoryName));
  const [signatoryTitle, setSignatoryTitle] = useState(s(contractFacts.contractorSignatoryTitle));

  async function save() {
    setError(null);
    setSaved(false);
    setBusy(true);

    if (coNumber.trim() !== co.coNumber) {
      const numRes = await updateCoNumber(co.id, co.projectId, coNumber);
      if (!numRes.ok) {
        setBusy(false);
        setError(numRes.error);
        return;
      }
    }

    const coRes = await updateCoFormFields(co.id, co.projectId, {
      description: description.trim() || null,
      reason: reason.trim() || null,
      dateOfChangeOrder: dateOfCo || null,
      profitPct: toNumOrNull(profitPct),
      bondPct: toNumOrNull(bondPct),
      taxPct: toNumOrNull(taxPct),
      mechCompletionDeltaDays: toIntOrNull(mechDays),
      substCompletionDeltaDays: toIntOrNull(substDays),
      exhibitEImpact: exhibitE.trim() || null,
      capacityRatioImpact: capacity.trim() || null,
      designBasisImpact: designBasis.trim() || null,
      otherImpacts: other.trim() || null,
    });
    if (!coRes.ok) {
      setBusy(false);
      setError(coRes.error);
      return;
    }

    if (canEditProject) {
      const projRes = await updateProjectContractFacts(co.projectId, {
        originalContractValue: toNumOrNull(origValue),
        agreementDate: agreementDate || null,
        guaranteedMechanicalCompletionDate: mechDate || null,
        guaranteedSubstantialCompletionDate: substDate || null,
        contractorLegalName: contractorName.trim() || null,
        contractorSignatoryName: signatory.trim() || null,
        contractorSignatoryTitle: signatoryTitle.trim() || null,
      });
      if (!projRes.ok) {
        setBusy(false);
        setError(projRes.error);
        return;
      }
    }

    setBusy(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between p-4 text-left"
      >
        <div>
          <h3 className="text-sm font-semibold">Change order details and contract facts</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Markup and bond rates, schedule impact, the narrative sections of Exhibit H, and the
            contract figures the form&apos;s first five lines are built from.
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "Hide" : "Edit"}</span>
      </button>

      {open && (
        <div className="space-y-5 border-t p-4">
          <Group title="This change order">
            <Field
              label="CO number"
              hint="Assigned from the project sequence. Renaming also retitles its SOV line"
            >
              <input
                value={coNumber}
                onChange={(e) => setCoNumber(e.target.value)}
                className={inputCls}
                placeholder="CO-07"
              />
            </Field>
            <Field label="Date of change order">
              <input type="date" value={dateOfCo} onChange={(e) => setDateOfCo(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Description" wide>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
               
                rows={2}
                className={inputCls}
                placeholder="Equipment Storage (Racking + Transformer) and Power Factors SCADA cost increase."
              />
            </Field>
            <Field label="Reason / justification" wide>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
               
                rows={2}
                className={inputCls}
                placeholder="Owner directive, differing site condition, design change..."
              />
            </Field>
            <Field label="Default markup %" hint="Applies to lines that do not set their own">
              <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} inputMode="decimal" className={cn(inputCls, "text-right")} placeholder="10" />
            </Field>
            <Field label="Bond %" hint="Of cost + markup. Leave blank for none">
              <input value={bondPct} onChange={(e) => setBondPct(e.target.value)} inputMode="decimal" className={cn(inputCls, "text-right")} />
            </Field>
            <Field label="Tax %" hint="Of cost + markup. Leave blank for none">
              <input value={taxPct} onChange={(e) => setTaxPct(e.target.value)} inputMode="decimal" className={cn(inputCls, "text-right")} />
            </Field>
            <Field label="Mechanical completion, days" hint="Positive pushes the date out">
              <input value={mechDays} onChange={(e) => setMechDays(e.target.value)} inputMode="numeric" className={cn(inputCls, "text-right")} placeholder="0" />
            </Field>
            <Field label="Substantial completion, days" hint="Positive pushes the date out">
              <input value={substDays} onChange={(e) => setSubstDays(e.target.value)} inputMode="numeric" className={cn(inputCls, "text-right")} placeholder="0" />
            </Field>
          </Group>

          <Group title="Exhibit H narrative sections">
            <Field label="Impact on Exhibit E, including Payment Schedule" wide>
              <textarea value={exhibitE} onChange={(e) => setExhibitE(e.target.value)} rows={2} className={inputCls} placeholder="None." />
            </Field>
            <Field label="Impact on Facility Capacity Ratio / performance ratio" wide>
              <textarea value={capacity} onChange={(e) => setCapacity(e.target.value)} rows={2} className={inputCls} placeholder="None." />
            </Field>
            <Field label="Impact on Design Basis" wide>
              <textarea value={designBasis} onChange={(e) => setDesignBasis(e.target.value)} rows={2} className={inputCls} placeholder="None." />
            </Field>
            <Field label="Other impacts to liability or obligation" wide>
              <textarea value={other} onChange={(e) => setOther(e.target.value)} rows={2} className={inputCls} placeholder="None." />
            </Field>
          </Group>

          {canEditProject && (
            <Group
              title="Contract facts (project-wide)"
              note="These drive Exhibit H lines 1 through 5 and the guaranteed dates on every change order for this project. Set them once."
            >
              <Field label="Original contract price" hint="At execution, before any CO">
                <input value={origValue} onChange={(e) => setOrigValue(e.target.value)} inputMode="decimal" className={cn(inputCls, "text-right")} placeholder="2507500.00" />
              </Field>
              <Field label="Date of agreement">
                <input type="date" value={agreementDate} onChange={(e) => setAgreementDate(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Guaranteed Mechanical Completion Date">
                <input type="date" value={mechDate} onChange={(e) => setMechDate(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Guaranteed Substantial Completion Date">
                <input type="date" value={substDate} onChange={(e) => setSubstDate(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Contractor legal name">
                <input value={contractorName} onChange={(e) => setContractorName(e.target.value)} className={inputCls} placeholder="American Helios Constructors (AHC)" />
              </Field>
              <Field label="Signatory name">
                <input value={signatory} onChange={(e) => setSignatory(e.target.value)} className={inputCls} placeholder="Shannon Posey" />
              </Field>
              <Field label="Signatory title">
                <input value={signatoryTitle} onChange={(e) => setSignatoryTitle(e.target.value)} className={inputCls} placeholder="EVP" />
              </Field>
            </Group>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
            <Button type="button" onClick={save} disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(wide && "sm:col-span-2")}>
      <label className="text-xs font-medium">{label}</label>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
