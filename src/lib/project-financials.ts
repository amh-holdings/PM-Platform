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
