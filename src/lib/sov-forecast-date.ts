// Which month a subcontractor SOV line's cost belongs in.
//
// "It is mapped." Zarina was right, and the forecast still could not place the
// money, because the word covers two different columns.
//
// The sub billing page counts a line mapped when verification_method is
// anything but 'unmapped' - that is the EVIDENCE mapping, how the line's
// percent complete gets proven. The cash forecast needed the SCHEDULE mapping,
// linked_task_wbs_codes or milestone_task_wbs_code, because a percentage
// without a date cannot go in a month. Lumina's seven lines were mapped to
// commodity quantities, read "all mapped" on screen, and dropped out of the
// curve reporting "no dated task", which sounded like nobody had done the
// work. Somebody had. The forecast was reading the wrong column.
//
// Commodities do reach the schedule, through commodity_task_links. So does
// mobilization, through the first field report from that sub. Both were
// already in the database and neither was being followed.
//
// Order, and it matters: an explicit milestone beats a task list beats what
// the commodities reach beats the mobilization date. Each step is a weaker
// statement about when the work lands, so a stronger one is never passed over.
//
// A line that still has no date is named by the mapping it DOES have, not by
// the one it is missing. "Mapped to commodity quantities, and no commodity on
// it is linked to a schedule task" sends somebody to the right screen.
// "No dated task" sends them looking for work that is already done.

export type SovMappingLine = {
  itemNumber: string;
  description?: string | null;
  /** schedule | commodity | milestone | on_site | time | manual | unmapped */
  verificationMethod?: string | null;
  linkedTaskWbsCodes?: readonly string[] | null;
  milestoneTaskWbsCode?: string | null;
  linkedCommodityIds?: readonly string[] | null;
};

export type SovDateSource = "milestone" | "tasks" | "commodity" | "on_site";

export type SovForecastDate = {
  month: string | null;
  source: SovDateSource | null;
  /** The WBS code the month came from, when it came from a task. */
  via: string | null;
  /** Why there is no month, said in terms of the mapping that is set. */
  why: string | null;
};

/** Resolves one WBS code to the month its work is planned to finish. */
export type FinishResolver = (
  wbsCode: string,
) => { wbs: string; month: string } | null;

// Two different failures wear the word commodity, and they are fixed on two
// different screens. "No commodity selected" is the Edit mapping dialog on the
// sub billing page. "Commodity selected but it reaches no task" is the
// commodity tracker. One message for both sends half the people to the wrong
// place, which is the mistake this whole module exists to stop repeating.
const MISSING: Record<string, string> = {
  commodity:
    "is mapped to commodity quantities, and no commodity on it is linked to a schedule task",
  commodity_none:
    "is set to earn on commodity quantities but no commodity is selected on it, so there is nothing to date it from",
  schedule: "links to work with no planned finish date",
  milestone: "is milestone-triggered on a task that was not found or has no finish date",
  on_site:
    "earns on mobilization, and no field report from this subcontractor has been filed yet",
  time: "is mapped to a date window, and the tasks behind it have no planned finish date",
  manual: "is entered by hand each period, so nothing in the app says when it lands",
  unmapped: "has no evidence source mapped at all",
};

export function resolveSovMonth(input: {
  line: SovMappingLine;
  finishOf: FinishResolver;
  /** commodity id to the WBS codes that commodity is linked to. */
  wbsByCommodityId?: ReadonlyMap<string, readonly string[]>;
  /** Earliest field report from this subcontractor, for a mobilization line. */
  onSiteDate?: string | null;
}): SovForecastDate {
  const { line, finishOf } = input;
  const method = (line.verificationMethod ?? "unmapped").trim();

  // 1. An explicit milestone is the strongest statement there is: somebody
  //    named the one task this line turns on.
  if (line.milestoneTaskWbsCode) {
    const at = finishOf(line.milestoneTaskWbsCode);
    if (at) return { month: at.month, source: "milestone", via: at.wbs, why: null };
  }

  // 2. Direct task links.
  for (const code of line.linkedTaskWbsCodes ?? []) {
    const at = finishOf(code);
    if (at) return { month: at.month, source: "tasks", via: at.wbs, why: null };
  }

  // 3. What the line's commodities reach. The LATEST of them: the line is not
  //    finished until every commodity it measures is, the same way a summary
  //    resolves to the last deliverable under it rather than the first.
  const commodityIds = line.linkedCommodityIds ?? [];
  if (commodityIds.length > 0 && input.wbsByCommodityId) {
    let best: { wbs: string; month: string } | null = null;
    for (const id of commodityIds) {
      for (const code of input.wbsByCommodityId.get(id) ?? []) {
        const at = finishOf(code);
        if (!at) continue;
        if (!best || at.month > best.month) best = at;
      }
    }
    if (best) return { month: best.month, source: "commodity", via: best.wbs, why: null };
  }

  // 4. Mobilization. The line is fully earned the day the crew arrives, so the
  //    cost belongs in the month the first field report puts them on site.
  if (method === "on_site" && input.onSiteDate) {
    return {
      month: monthOf(input.onSiteDate),
      source: "on_site",
      via: null,
      why: null,
    };
  }

  const key =
    method === "commodity" && commodityIds.length === 0 ? "commodity_none" : method;
  return {
    month: null,
    source: null,
    via: null,
    why: MISSING[key] ?? MISSING.unmapped,
  };
}

function monthOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * The warning line for a sub SOV line the forecast cannot date.
 *
 * Names the subcontractor, the line, the money and what is actually missing.
 * The old message said "has no dated task" for every case, which is false on a
 * line that is mapped to commodities and true-sounding enough that nobody
 * checked.
 */
export function describeSovDateGap(input: {
  subName: string;
  line: SovMappingLine;
  at: SovForecastDate;
  remaining: number;
}): string {
  const money = `$${Math.round(input.remaining).toLocaleString()}`;
  return `${input.subName} line ${input.line.itemNumber} ${input.at.why} - ${money} of cost is missing from the forecast`;
}

/** One line for the notes panel when a commodity or mobilization mapping supplied the date. */
export function describeSovDateSource(input: {
  subName: string;
  line: SovMappingLine;
  at: SovForecastDate;
}): string | null {
  const { subName, line, at } = input;
  if (at.source === "commodity") {
    return `${subName} line ${line.itemNumber} is dated from the schedule task its commodity is linked to, ${at.via}`;
  }
  if (at.source === "on_site") {
    return `${subName} line ${line.itemNumber} is mobilization, dated to ${at.month?.slice(0, 7)} from the first field report`;
  }
  return null;
}
