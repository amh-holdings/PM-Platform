/**
 * Read a change order's cost buildup and propose where its money belongs on
 * the schedule of values.
 *
 * Zarina, on CO-02: "I want the app to be able to read automatically... it will
 * show me suggestions where I want to link them so I can confirm and accept."
 *
 * The information is already there and nobody was using it. CO-02's nine
 * buildup lines are literally named "6.01 Mobilization", "6.02 Civil, Roads and
 * Landscaping if applicable" and so on - the person who priced the change order
 * already said which SOV line each cost belongs to. Making someone re-type that
 * nine times, from paperwork, into a form is work the app should be doing.
 *
 * A SUGGESTION, NEVER AN ACTION
 * Nothing here writes. It proposes, says how confident it is and why, and a
 * person accepts. A wrong guess accepted silently would misstate a contract
 * line's scope and its percent complete, which is the failure this whole
 * feature exists to prevent, so the guess is always shown before it counts.
 *
 * COST VERSUS WHAT THE OWNER PAYS
 * The buildup is AHC's cost. The SOV line carries what the owner is billed,
 * which is larger whenever the change order has markup, bond or tax. Splitting
 * by raw cost would then allocate less than the line holds and leave a
 * phantom remainder. So every share is scaled by (SOV line value / total
 * cost). On CO-02 the two are equal and the scale is 1.
 */

export type BuildupLine = {
  id: string;
  description: string;
  /** quantity x unitCost, AHC's cost for this line. */
  extendedCost: number;
};

export type ContractLine = {
  id: string;
  itemNumber: string;
  description: string;
};

export type SuggestionBasis = "item-number" | "description" | "none";

export type Suggestion = {
  /** Contract line to allocate to, null when nothing matched. */
  baseLineId: string | null;
  baseItemNumber: string | null;
  baseDescription: string | null;
  /** How the match was made, for the UI to show and a human to judge. */
  basis: SuggestionBasis;
  /** Scaled to the SOV line's value. This is what gets allocated. */
  amount: number;
  /** The buildup lines that produced it. */
  from: { id: string; description: string; extendedCost: number }[];
};

export type SuggestionSet = {
  matched: Suggestion[];
  /** Buildup lines nothing could be matched to. */
  unmatched: Suggestion[];
  /** Sum of the matched amounts. */
  matchedTotal: number;
  /** The SOV line's value that was being split. */
  lineValue: number;
  /** lineValue - matchedTotal. What stays as new scope if accepted as is. */
  remainder: number;
  /** True when cost and owner value differ, so shares were scaled. */
  scaled: boolean;
};

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** "6.01 Mobilization" -> "6.01". Anything else -> null. */
export function leadingItemNumber(description: string): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s+\S/.exec(String(description ?? ""));
  return m ? m[1] : null;
}

/** Lowercase, drop a leading item number, collapse punctuation and spacing. */
export function normalizeDescription(description: string): string {
  return String(description ?? "")
    .replace(/^\s*\d+(?:\.\d+)?\s+/, "")
    .toLowerCase()
    .replace(/[(),./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Proposes an allocation of `lineValue` across contract lines, read from the
 * buildup.
 *
 * Matching is tried in order of how much it can be trusted:
 *   1. The leading item number in the buildup line's description. The pricer
 *      wrote it down; nothing beats being told.
 *   2. The description, normalized, matching a contract line's exactly.
 * No fuzzy or partial matching. A near-miss presented as a match is worse than
 * an honest "could not tell" a person then answers in one click.
 */
export function suggestAllocations(
  buildupLines: BuildupLine[],
  contractLines: ContractLine[],
  lineValue: number,
): SuggestionSet {
  const byItem = new Map(contractLines.map((c) => [c.itemNumber.trim(), c]));
  const byDescription = new Map<string, ContractLine>();
  for (const c of contractLines) {
    const key = normalizeDescription(c.description);
    // First writer wins. Two contract lines sharing a description make the
    // description useless as a key, so do not let the later one silently
    // capture the match.
    if (key && !byDescription.has(key)) byDescription.set(key, c);
  }
  const duplicateDescriptions = new Set<string>();
  const descriptionCounts = new Map<string, number>();
  for (const c of contractLines) {
    const key = normalizeDescription(c.description);
    if (!key) continue;
    const n = (descriptionCounts.get(key) ?? 0) + 1;
    descriptionCounts.set(key, n);
    if (n > 1) duplicateDescriptions.add(key);
  }

  const totalCost = round2(
    buildupLines.reduce((s, l) => s + Number(l.extendedCost ?? 0), 0),
  );
  // Scale cost shares up to what the owner actually pays. Guard the zero-cost
  // case rather than producing NaN and calling it a suggestion.
  const scale = totalCost === 0 ? 0 : lineValue / totalCost;
  const scaled = Math.abs(scale - 1) > 0.000001;

  type Bucket = { target: ContractLine | null; basis: SuggestionBasis; lines: BuildupLine[] };
  const buckets = new Map<string, Bucket>();

  for (const l of buildupLines) {
    const item = leadingItemNumber(l.description);
    let target: ContractLine | null = null;
    let basis: SuggestionBasis = "none";

    if (item && byItem.has(item)) {
      target = byItem.get(item)!;
      basis = "item-number";
    } else {
      const key = normalizeDescription(l.description);
      if (key && !duplicateDescriptions.has(key) && byDescription.has(key)) {
        target = byDescription.get(key)!;
        basis = "description";
      }
    }

    // Several buildup lines can land on one contract line - a CO that touches
    // Mobilization twice allocates once, for the sum.
    const key = target ? `t:${target.id}` : `u:${l.id}`;
    const bucket = buckets.get(key) ?? { target, basis, lines: [] };
    bucket.lines.push(l);
    // Being told the item number once beats inferring it, so the stronger
    // basis wins for the merged row.
    if (basis === "item-number") bucket.basis = "item-number";
    buckets.set(key, bucket);
  }

  const matched: Suggestion[] = [];
  const unmatched: Suggestion[] = [];

  buckets.forEach((b) => {
    const cost = round2(b.lines.reduce((s, l) => s + Number(l.extendedCost ?? 0), 0));
    const s: Suggestion = {
      baseLineId: b.target?.id ?? null,
      baseItemNumber: b.target?.itemNumber ?? null,
      baseDescription: b.target?.description ?? null,
      basis: b.target ? b.basis : "none",
      amount: round2(cost * scale),
      from: b.lines.map((l) => ({
        id: l.id,
        description: l.description,
        extendedCost: round2(Number(l.extendedCost ?? 0)),
      })),
    };
    (b.target ? matched : unmatched).push(s);
  });

  const sortKey = (s: Suggestion) => s.baseItemNumber ?? s.from[0]?.description ?? "";
  matched.sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }),
  );
  unmatched.sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }),
  );

  // Rounding each share independently can miss the total by a cent or two.
  // Push the difference onto the largest matched row so accepting every
  // suggestion allocates the line exactly, with no phantom penny of new scope.
  let matchedTotal = round2(matched.reduce((s, m) => s + m.amount, 0));
  if (matched.length && unmatched.length === 0) {
    const drift = round2(lineValue - matchedTotal);
    if (drift !== 0 && Math.abs(drift) < 0.05) {
      const biggest = matched.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
      biggest.amount = round2(biggest.amount + drift);
      matchedTotal = round2(matched.reduce((s, m) => s + m.amount, 0));
    }
  }

  return {
    matched,
    unmatched,
    matchedTotal,
    lineValue: round2(lineValue),
    remainder: round2(lineValue - matchedTotal),
    scaled,
  };
}
