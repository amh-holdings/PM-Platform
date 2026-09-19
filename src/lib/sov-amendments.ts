/**
 * Change orders that raise the price of scope the SOV already carries.
 *
 * See db/migrations/0054_billing_line_amendments.sql for why this exists. The
 * short version: a change order either adds a new SOV line, raises an existing
 * one, or moves no money at all, and only the first of the three was modelled.
 * A contract line whose price a change order raised kept its original
 * scheduled value and so read as finished the moment that value was billed.
 *
 * Everything here is pure. The rule it encodes is one sentence: a contract
 * line's CURRENT scope is its own scheduled value plus every amendment
 * allocated to it, and percent complete belongs against that, not against the
 * contract figure.
 *
 * Nothing in this module changes a scheduled value. Both numbers stay on the
 * sheet, which is what keeps the executed contract recoverable.
 */

export type AmendmentRow = {
  amendment_line_id: string;
  base_line_id: string;
  amount: number | string | null;
};

export type SovLine = {
  id: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
  /** Null on a contract line, set on a line a change order brought in. */
  changeOrderId: string | null;
};

/** Where one slice of a change order's money landed. */
export type AmendmentSource = {
  amendmentLineId: string;
  itemNumber: string;
  description: string;
  coNumber: string | null;
  amount: number;
};

export type LineRollup = {
  /** The line's own scheduled value - what the contract says. */
  contractValue: number;
  /** Everything change orders added to it. Can be negative on a credit. */
  amendedValue: number;
  /** contractValue + amendedValue. What percent complete runs on. */
  currentValue: number;
  /** Which change order lines contributed, in item-number order. */
  sources: AmendmentSource[];
};

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Current scope per contract line.
 *
 * Returns an entry for EVERY line handed in, amended or not, so callers can
 * read one map rather than branching on whether a line was touched. An
 * untouched line reports currentValue === contractValue and no sources, which
 * is exactly the behaviour the billing page had before this existed.
 *
 * Allocations pointing at a line that is not in `lines` are ignored rather
 * than throwing: a deleted line should not take the page down with it.
 */
export function rollUpAmendments(
  lines: SovLine[],
  amendments: AmendmentRow[],
  coNumberByLineId: Map<string, string> = new Map(),
): Map<string, LineRollup> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out = new Map<string, LineRollup>();
  for (const l of lines) {
    out.set(l.id, {
      contractValue: round2(l.scheduledValue),
      amendedValue: 0,
      currentValue: round2(l.scheduledValue),
      sources: [],
    });
  }

  for (const a of amendments) {
    const target = out.get(a.base_line_id);
    if (!target) continue;
    const from = byId.get(a.amendment_line_id);
    const amount = num(a.amount);
    target.amendedValue = round2(target.amendedValue + amount);
    target.currentValue = round2(target.contractValue + target.amendedValue);
    target.sources.push({
      amendmentLineId: a.amendment_line_id,
      itemNumber: from?.itemNumber ?? "",
      description: from?.description ?? "",
      coNumber: coNumberByLineId.get(a.amendment_line_id) ?? null,
      amount,
    });
  }

  out.forEach((r) => {
    r.sources.sort((x, y) =>
      x.itemNumber.localeCompare(y.itemNumber, undefined, { numeric: true }),
    );
  });
  return out;
}

/**
 * How much of a change order line has been allocated to contract lines.
 *
 * The remainder is new scope. That is not a defect to warn about - Piles and
 * Bond Premium are entirely new scope and should allocate nothing.
 */
export function allocatedFromLine(
  amendmentLineId: string,
  amendments: AmendmentRow[],
): number {
  return round2(
    amendments
      .filter((a) => a.amendment_line_id === amendmentLineId)
      .reduce((s, a) => s + num(a.amount), 0),
  );
}

export type CoSovImpactKind = "amends" | "adds" | "mixed" | "none";

export type CoSovImpact = {
  kind: CoSovImpactKind;
  /**
   * One entry per allocation, NOT per contract line. A change order that
   * raises Mobilization from two of its own lines gets two rows, because the
   * unlink button has to know which one it is undoing.
   */
  amends: {
    /** The change order line the money comes from. */
    fromLineId: string;
    fromItemNumber: string;
    baseLineId: string;
    itemNumber: string;
    description: string;
    amount: number;
  }[];
  /** This CO's own lines, with the part of each that is new scope. */
  lines: {
    lineId: string;
    itemNumber: string;
    description: string;
    scheduledValue: number;
    allocated: number;
    newScope: number;
  }[];
  /** Total raised against existing contract lines. */
  amendedTotal: number;
  /** Total that is genuinely new scope. */
  newScopeTotal: number;
};

/**
 * What a change order does to the schedule of values, in the shape the CO page
 * renders.
 *
 * "none" is a real answer, not a gap. CO-03 moves a completion date and
 * touches no money, and the page should say so rather than showing an
 * unallocated balance that nobody is ever going to allocate.
 */
export function coSovImpact(
  coLines: SovLine[],
  allLines: SovLine[],
  amendments: AmendmentRow[],
): CoSovImpact {
  const byId = new Map(allLines.map((l) => [l.id, l]));
  const coLineIds = new Set(coLines.map((l) => l.id));
  const mine = amendments.filter((a) => coLineIds.has(a.amendment_line_id));

  const amends = mine
    .map((a) => ({
      fromLineId: a.amendment_line_id,
      fromItemNumber: byId.get(a.amendment_line_id)?.itemNumber ?? "",
      baseLineId: a.base_line_id,
      itemNumber: byId.get(a.base_line_id)?.itemNumber ?? "",
      description:
        byId.get(a.base_line_id)?.description ?? "(line no longer on the SOV)",
      amount: round2(num(a.amount)),
    }))
    .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true }));

  const lines = coLines
    .map((l) => {
      const allocated = allocatedFromLine(l.id, mine);
      return {
        lineId: l.id,
        itemNumber: l.itemNumber,
        description: l.description,
        scheduledValue: round2(l.scheduledValue),
        allocated,
        newScope: round2(l.scheduledValue - allocated),
      };
    })
    .sort((a, b) => a.itemNumber.localeCompare(b.itemNumber, undefined, { numeric: true }));

  const amendedTotal = round2(amends.reduce((s, a) => s + a.amount, 0));
  const newScopeTotal = round2(lines.reduce((s, l) => s + l.newScope, 0));

  let kind: CoSovImpactKind = "none";
  if (amendedTotal !== 0 && newScopeTotal !== 0) kind = "mixed";
  else if (amendedTotal !== 0) kind = "amends";
  else if (newScopeTotal !== 0 || lines.length > 0) kind = "adds";

  return { kind, amends, lines, amendedTotal, newScopeTotal };
}

export type AllocationCheck = {
  amount: number;
  /** Scheduled value of the change order's line. */
  amendmentLineValue: number;
  /** Already allocated from that line to OTHER contract lines. */
  allocatedElsewhere: number;
  /** True when the chosen target is itself a change order line. */
  targetIsChangeOrderLine: boolean;
  /** True when somebody picked the same line on both sides. */
  targetIsSameLine: boolean;
};

/**
 * Why an allocation cannot be saved, or null when it can.
 *
 * Over-allocating is refused rather than warned about: a change order line
 * cannot hand out more money than it carries, and letting it would quietly
 * inflate a contract line's scope and deflate its percent complete - the exact
 * failure this whole feature exists to fix, running the other way.
 *
 * Chains are refused too. A change order raising another change order's line
 * has no meaning on a G703, where the second CO would simply carry its own
 * line, and allowing it turns a one-level sum into a graph walk.
 */
export function allocationBlocker(c: AllocationCheck): string | null {
  if (c.targetIsSameLine) {
    return "A line cannot amend itself. Pick the contract line whose scope this change order increases.";
  }
  if (c.targetIsChangeOrderLine) {
    return "That line belongs to another change order. Amendments point at contract lines - if this CO adds to another CO's scope, give it its own SOV line instead.";
  }
  if (!Number.isFinite(c.amount) || c.amount === 0) {
    return "Enter how much of this change order line belongs to that contract line.";
  }
  const room = round2(c.amendmentLineValue - c.allocatedElsewhere);
  const over = Math.abs(c.amount) - Math.abs(room);
  if (Math.sign(c.amount) !== Math.sign(c.amendmentLineValue) && c.amendmentLineValue !== 0) {
    return "The allocation runs the opposite way to the change order line. A credit allocates a credit.";
  }
  if (over > 0.005) {
    return `Only ${room.toFixed(2)} of this change order line is left to allocate.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */

/**
 * Every per-line money figure the billing table shows.
 *
 * All of them roll up by the same share. Rolling only some would let the
 * columns contradict the percentage sitting next to them - the exact class of
 * bug this module exists to close.
 */
export type LineMoney = {
  /** Billed in periods before the one on screen. */
  previous: number;
  /** Billed in the period on screen. */
  current: number;
  /** The part of `current` that has reached a pay application. */
  currentBilled?: number;
  /** Prior-period money with no billing evidence behind it. */
  stalePrior?: number;
};

export type EffectiveLine = {
  /** The line's own scheduled value. */
  contractValue: number;
  /** Brought in by change orders. Zero on a change order's own line. */
  amendedValue: number;
  /** Handed to contract lines. Zero on a contract line. */
  allocatedAway: number;
  /** How many contract lines it was handed to, so the row can say so. */
  allocatedToCount: number;
  /** What percent complete measures against. */
  scope: number;
  /** Billed before the period on screen, after the roll-up. */
  previous: number;
  /** Billed in the period on screen, after the roll-up. */
  current: number;
  /** previous + current. What percent complete measures. */
  billed: number;
  /** The part of `current` that has reached a pay application. */
  currentBilled: number;
  /** Prior-period money with no billing evidence behind it. */
  stalePrior: number;
  sources: AmendmentSource[];
};

/**
 * Scope AND billing, rolled up together, so the two halves of a percentage
 * agree with each other.
 *
 * Rolling up scope alone double counts. If POI 5.05 grows to $235,793.63 by
 * absorbing CO-04's line 14.00, and 14.00 still reports its own $67,458.31
 * of scope, the sheet now claims $67,458.31 more work than the contract buys.
 * Sweet Springs also BILLED that money on line 14.00 back on AFP 9, so
 * crediting the scope to 5.05 while leaving the billing on 14.00 would show
 * 5.05 further behind than it is and 14.00 impossibly ahead.
 *
 * So an allocation moves both halves together:
 *
 *   contract line   scope   = its value + everything allocated to it
 *                   billed  = its billing + each amendment line's billing,
 *                             in proportion to what that line allocated here
 *   change order    scope   = its value MINUS what it allocated away
 *   line            billed  = its billing, less the same proportion
 *
 * Which means sum(scope) is always the SOV total and sum(billed) is always
 * what was billed. Allocating attributes money; it never creates or destroys
 * any. Both are asserted in the tests.
 */
export function effectiveLineProgress(
  lines: SovLine[],
  amendments: AmendmentRow[],
  billedByLine: Map<string, LineMoney> = new Map(),
  coNumberByLineId: Map<string, string> = new Map(),
): Map<string, EffectiveLine> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const moneyOf = (id: string): Required<LineMoney> => {
    const m = billedByLine.get(id);
    return {
      previous: num(m?.previous),
      current: num(m?.current),
      currentBilled: num(m?.currentBilled),
      stalePrior: num(m?.stalePrior),
    };
  };

  const out = new Map<string, EffectiveLine>();
  for (const l of lines) {
    const v = round2(l.scheduledValue);
    const m = moneyOf(l.id);
    out.set(l.id, {
      contractValue: v,
      amendedValue: 0,
      allocatedAway: 0,
      allocatedToCount: 0,
      scope: v,
      previous: round2(m.previous),
      current: round2(m.current),
      billed: round2(m.previous + m.current),
      currentBilled: round2(m.currentBilled),
      stalePrior: round2(m.stalePrior),
      sources: [],
    });
  }

  // Only allocations whose BOTH ends still exist can move anything. An orphan
  // would otherwise take money off one side and put it nowhere.
  const live = amendments.filter(
    (a) => byId.has(a.amendment_line_id) && out.has(a.base_line_id),
  );

  for (const a of live) {
    const from = byId.get(a.amendment_line_id)!;
    const target = out.get(a.base_line_id)!;
    const source = out.get(a.amendment_line_id)!;
    const amount = num(a.amount);

    // Proportion of the change order line this allocation represents. A line
    // split between Mobilization and Fencing sends each its own share of the
    // billing, not all of it to whichever was allocated first.
    const share = from.scheduledValue === 0 ? 0 : amount / from.scheduledValue;
    const fromMoney = moneyOf(from.id);
    // Each period moves on its own, so the table's Previous and Current
    // columns keep agreeing with the percentage beside them.
    const movedPrevious = round2(fromMoney.previous * share);
    const movedCurrent = round2(fromMoney.current * share);
    const movedCurrentBilled = round2(fromMoney.currentBilled * share);
    const movedStalePrior = round2(fromMoney.stalePrior * share);

    target.amendedValue = round2(target.amendedValue + amount);
    target.scope = round2(target.contractValue + target.amendedValue);
    target.previous = round2(target.previous + movedPrevious);
    target.current = round2(target.current + movedCurrent);
    target.billed = round2(target.previous + target.current);
    target.currentBilled = round2(target.currentBilled + movedCurrentBilled);
    target.stalePrior = round2(target.stalePrior + movedStalePrior);
    target.sources.push({
      amendmentLineId: from.id,
      itemNumber: from.itemNumber,
      description: from.description,
      coNumber: coNumberByLineId.get(from.id) ?? null,
      amount,
    });

    source.allocatedAway = round2(source.allocatedAway + amount);
    source.allocatedToCount += 1;
    source.scope = round2(source.contractValue - source.allocatedAway);
    source.previous = round2(source.previous - movedPrevious);
    source.current = round2(source.current - movedCurrent);
    source.billed = round2(source.previous + source.current);
    source.currentBilled = round2(source.currentBilled - movedCurrentBilled);
    source.stalePrior = round2(source.stalePrior - movedStalePrior);
  }

  out.forEach((r) => {
    r.sources.sort((x, y) =>
      x.itemNumber.localeCompare(y.itemNumber, undefined, { numeric: true }),
    );
  });
  return out;
}
