// What a project's contract is worth, and whether the app's two answers agree.
//
// THE PROBLEM THIS EXISTS FOR
// There are two ways to arrive at the contract value and the dashboard used
// only the second one:
//
//   1. The AGREEMENT. Original contract price plus every approved change
//      order. This is what Exhibit H computes, what the owner's records say,
//      and what AHC is contractually owed.
//   2. The SOV. Sum of billing_lines.scheduled_value, which is what actually
//      bills on a G703.
//
// They should be equal. When they are not, one of them is wrong, and which one
// matters enormously: if the SOV is over the contract, AHC is scheduled to bill
// more than it is owed and the overage will be rejected. If it is under, work
// has no line to bill against.
//
// The dashboard read the SOV total alone and labelled it "Includes approved
// COs", which is a claim about provenance it could not actually make: the
// number is whatever is in billing_lines, whether that is the contract, a
// double import, or a rollup line sitting beside its own detail. On Sweet
// Springs it read $8.1M against a $3.79M agreement and nothing said so.
//
// So the value comes from the agreement, the SOV becomes a cross-check, and a
// disagreement is reported rather than absorbed.

export type ContractValueInput = {
  /** projects.original_contract_value. The price before any change order. */
  originalContractValue: number | null;
  /** Sum of co_value across APPROVED change orders only. */
  approvedCoValue: number;
  /** Sum of billing_lines.scheduled_value. What is set up to bill. */
  sovTotal: number;
};

export type ContractValue = {
  /** The figure to show. */
  value: number;
  /** Where it came from, for the caption under it. */
  basis: "agreement" | "sov";
  originalContractValue: number | null;
  approvedCoValue: number;
  sovTotal: number;
  /** sovTotal - value. Positive means the SOV is scheduled above the contract. */
  sovDrift: number;
  /** True when the SOV and the agreement disagree by a cent or more. */
  sovDisagrees: boolean;
};

/** Money compares to the cent. Anything finer is float noise, not a finding. */
const CENT = 0.005;

export function deriveContractValue(input: ContractValueInput): ContractValue {
  const approvedCoValue = round2(input.approvedCoValue);
  const sovTotal = round2(input.sovTotal);

  // No original price on record means the agreement cannot be reconstructed, so
  // the SOV is the only answer available. It is reported as such rather than
  // dressed up as the contract.
  const hasAgreement = input.originalContractValue != null;
  const value = hasAgreement
    ? round2(Number(input.originalContractValue) + approvedCoValue)
    : sovTotal;

  const sovDrift = round2(sovTotal - value);

  return {
    value,
    basis: hasAgreement ? "agreement" : "sov",
    originalContractValue:
      input.originalContractValue == null ? null : round2(input.originalContractValue),
    approvedCoValue,
    sovTotal,
    sovDrift,
    // Only meaningful when there are two independent answers to compare.
    sovDisagrees: hasAgreement && Math.abs(sovDrift) >= CENT,
  };
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * SOV item numbers in the order a human reads them.
 *
 * "10.00" sorts BEFORE "9.00" as text, because "1" < "9". Postgres orders
 * item_number as text, so a schedule of values that runs past nine sections
 * comes back with 10 through 16 buried between 1.09 and 2.00 - which reads,
 * to anyone scrolling to the bottom of a picker, as a list that stops at 9.
 *
 * Split on the dots and compare each part as a number, falling back to text
 * for anything that is not one ("CO-03", "GC", a lettered line).
 */
/**
 * The next SOV item number for a project - the number "Add SOV line" fills in.
 *
 * Always max + 1, never the first gap, for the same reason nextCoNumber works
 * that way: a number missing from the middle of a schedule of values was used
 * and withdrawn, and handing it out again puts two different scopes under one
 * number in the owner's records.
 *
 * Only top-level numbered lines count toward the max. A change order line is a
 * new section of the SOV, not a sub-line of the last one - Sweet Springs' COs
 * are 13.00 through 16.00, beside the contract's 1.00 through 12.00, so the
 * next one is 17.00 rather than 16.01. Anything that is not a plain number is
 * skipped entirely ("CO-03", "GC", a lettered line).
 *
 * Decimal width follows the highest line already on the sheet, so a project
 * numbered 1.00, 2.00 gets 3.00 and one numbered 1, 2 gets 3.
 */
export function nextSovItemNumber(existing: readonly string[]): string {
  let max = 0;
  let width = 2;
  for (const raw of existing) {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(raw ?? "").trim());
    if (!m) continue;
    const section = Number(m[1]);
    if (!Number.isFinite(section) || section < max) continue;
    max = section;
    width = m[2]?.length ?? 0;
  }
  return width > 0 ? `${max + 1}.${"0".repeat(width)}` : String(max + 1);
}

/**
 * What to call the SOV line a change order is billed on.
 *
 * The CO number belongs in the description because the G703 is what the owner
 * reads, and "17.00" alone says nothing about which change order produced it.
 * The CO already carries a description; reuse it rather than asking Phil to
 * retype the scope he just priced.
 */
export function coLineDescription(
  coNumber: string,
  coDescription: string | null | undefined,
): string {
  const scope = (coDescription ?? "").trim();
  const number = (coNumber ?? "").trim();
  if (!number) return scope;
  return scope ? `${number} - ${scope}` : number;
}

export function compareItemNumbers(a: string, b: string): number {
  const pa = String(a ?? "").split(".");
  const pb = String(b ?? "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== "" && sb !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    const c = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
    if (c !== 0) return c;
  }
  return 0;
}
