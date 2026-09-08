"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ExhibitH } from "@/lib/change-order-pricing";

type Props = { exhibitH: ExhibitH };

/**
 * Every value Exhibit H asks for, computed and laid out in the order the form
 * asks for it, with a copy button on each one.
 *
 * This deliberately does not render or export the owner's form. Phil fills out
 * Dimension's document; the platform's job is to make sure the numbers he
 * types into it are right and tie out to the contract.
 */
export function ExhibitHPanel({ exhibitH: h }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

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
          {h.missing.join(", ")}. Fill them in under &ldquo;Change order details and contract
          facts&rdquo; below.
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
        <Row
          label="Date of agreement"
          value={h.agreementDate ? formatDate(h.agreementDate) : "-"}
          onCopy={copy}
          copied={copied}
        />
      </dl>

      <div className="border-t bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Adjustment to contract price
      </div>
      <dl className="divide-y text-sm">
        <Row
          label="1. The original Contract Price was"
          value={money(h.originalContractPrice)}
          copyValue={raw(h.originalContractPrice)}
          onCopy={copy}
          copied={copied}
          mono
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
        <Row
          label="Guaranteed Mechanical Completion Date (current)"
          value={h.mechanical.currentDate ? formatDate(h.mechanical.currentDate) : "-"}
          onCopy={copy}
          copied={copied}
        />
        <Row
          label="Mechanical - change by"
          value={
            h.mechanical.deltaDays == null
              ? "unchanged"
              : `${h.mechanical.direction} by ${Math.abs(h.mechanical.deltaDays)} days`
          }
          onCopy={copy}
          copied={copied}
        />
        <Row
          label="Guaranteed Mechanical Completion Date (revised)"
          value={h.mechanical.revisedDate ? formatDate(h.mechanical.revisedDate) : "-"}
          onCopy={copy}
          copied={copied}
          accent
        />
        <Row
          label="Guaranteed Substantial Completion Date (current)"
          value={h.substantial.currentDate ? formatDate(h.substantial.currentDate) : "-"}
          onCopy={copy}
          copied={copied}
        />
        <Row
          label="Substantial - change by"
          value={
            h.substantial.deltaDays == null
              ? "unchanged"
              : `${h.substantial.direction} by ${Math.abs(h.substantial.deltaDays)} days`
          }
          onCopy={copy}
          copied={copied}
        />
        <Row
          label="Guaranteed Substantial Completion Date (revised)"
          value={h.substantial.revisedDate ? formatDate(h.substantial.revisedDate) : "-"}
          onCopy={copy}
          copied={copied}
          accent
        />
      </dl>
    </section>
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
