// The review of a sub's bill, written the way it goes back to the sub.
//
// Phil, after reading the email drafted for Pyramid's AFP 3: "That email makes
// perfect sense. How can we get that rationale in the app." The review screen
// had every number but in the order the engine computed them. This puts them
// in the order a person explains a decision: what is approved, what is held,
// why, what was not done, what happens next, what is needed before payment.
// The same content renders on the page and copies out as the email, so the
// two can never disagree.
//
// Pure. The page loads the rows and hands them in.

export type GapRow = { area: string; task: string; pctDone: number; pctOfLine: number };

export type LetterHold = {
  item: string;
  description: string;
  held: number;
  scheduledValue: number;
  /** Where this application takes the line, as a fraction. */
  billedToPct: number;
  /** Built at the period end per reports and schedule, as a fraction. */
  builtPct: number;
  /** Billed on prior applications. */
  prevAmount: number;
  /** Earned this period per the field record (built less prior billing, floored at 0). */
  earned: number;
  /** Not-complete items grouped by area. */
  areas: { area: string; items: string; pct: number }[];
  /** Built today, when the field record has moved on since the period end. */
  todayPct: number | null;
  /** Of the held amount, what today's field record would support next time. */
  nextBillable: number | null;
};

export type SubLetter = {
  kind: "send_back" | "hold" | "needs_cm" | "approve";
  subject: string;
  opening: string;
  approved: string | null;
  heldLine: string | null;
  /** Each hold with its explanation and next step, as worded in the email. */
  holds: (LetterHold & { paragraph: string; next: string })[];
  sendBack: string[];
  asks: string[];
  text: string;
};

/** 2026-09-25 -> 9/25/2026 */
export function usDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}
const shortDate = (iso: string) => usDate(iso).replace(/\/\d{4}$/, "");
const pct1 = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, "")}%`;
const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`;

/** Gaps grouped by area, biggest area first; a task with no area is its own row. */
export function groupGaps(gaps: GapRow[]): { area: string; items: string; pct: number }[] {
  const byArea = new Map<string, { items: string[]; pct: number }>();
  for (const g of gaps) {
    const status = g.pctDone > 0 ? ` (${Math.round(g.pctDone * 100)}% complete)` : "";
    const key = g.area || g.task;
    const item = g.area ? `${g.task}${status}` : g.pctDone > 0 ? `${Math.round(g.pctDone * 100)}% complete` : "Not started";
    const cur = byArea.get(key) ?? { items: [], pct: 0 };
    cur.items.push(item);
    cur.pct += g.pctOfLine;
    byArea.set(key, cur);
  }
  return Array.from(byArea.entries())
    .map(([area, v]) => ({ area, items: v.items.join(", "), pct: v.pct }))
    .sort((a, b) => b.pct - a.pct);
}

export function buildSubLetter(args: {
  kind: SubLetter["kind"];
  projectName: string;
  appNumber: number;
  periodStart: string | null;
  periodEnd: string;
  todayIso: string;
  retainagePct: number;
  approveGross: number;
  retainage: number;
  net: number;
  holds: LetterHold[];
  sendBack: string[];
  asks: string[];
  money: (v: number) => string;
}): SubLetter {
  const { kind, holds, money } = args;
  const period = args.periodStart
    ? `${usDate(args.periodStart)} - ${usDate(args.periodEnd)}`
    : `through ${usDate(args.periodEnd)}`;
  const periodShort = args.periodStart
    ? `${shortDate(args.periodStart)} - ${shortDate(args.periodEnd)}`
    : `through ${shortDate(args.periodEnd)}`;
  const lineList = holds.map((h) => h.item).join(", ");

  const subject =
    kind === "send_back"
      ? `${args.projectName} - Pay Application #${args.appNumber} (${periodShort}) Returned for Correction`
      : kind === "hold"
        ? `${args.projectName} - Pay Application #${args.appNumber} (${periodShort}) Approved with Hold on Line${holds.length > 1 ? "s" : ""} ${lineList}`
        : `${args.projectName} - Pay Application #${args.appNumber} (${periodShort}) Approved`;

  const opening = `We have reviewed Pay Application #${args.appNumber} for the period ${period} against our approved daily reports and the project schedule.`;

  const approved =
    kind === "send_back"
      ? null
      : `Approved: ${money(args.approveGross)} gross, less ${args.retainagePct}% retainage (${money(args.retainage)}), for a payment of ${money(args.net)}.`;

  const heldTotal = Math.round(holds.reduce((s, h) => s + h.held, 0) * 100) / 100;
  const heldLine =
    kind === "hold"
      ? holds.length === 1
        ? `Held: ${money(heldTotal)} on Line ${holds[0].item}, ${holds[0].description}.`
        : `Held: ${money(heldTotal)} across Lines ${lineList}.`
      : null;

  const holdParagraph = (h: LetterHold) =>
    `The application bills Line ${h.item} to ${pct1(h.billedToPct)} complete. Our daily reports show it was ${pct1(h.builtPct)} complete at the ${shortDate(args.periodEnd)} period end. ` +
    `Prior applications already billed ${pct1(h.scheduledValue > 0 ? h.prevAmount / h.scheduledValue : 0)} (${money(h.prevAmount)}), so ` +
    (h.earned > 0.004 ? `only ${money(h.earned)} more is earned on this line for this period.` : `no additional amount is earned on this line for this period.`);

  const nextStep = (h: LetterHold) =>
    `Please carry the Line ${h.item} balance forward on your next application.` +
    (h.nextBillable != null && h.nextBillable > 0.004
      ? h.nextBillable >= h.held - 0.004
        ? ` Based on our reports through ${usDate(args.todayIso)}, this work is now complete and the held amount can be billed on Pay Application #${args.appNumber + 1}.`
        : ` Based on our reports through ${usDate(args.todayIso)}, about ${money(h.nextBillable)} of it is now supported and can be billed on Pay Application #${args.appNumber + 1}. The remainder will follow as the open work is completed.`
      : "");

  const lines: string[] = [`Subject: ${subject}`, "", "Hi,", "", opening, ""];
  if (kind === "send_back") {
    lines.push(`We are returning this application for correction before it can be approved:`);
    for (const r of args.sendBack) lines.push(`- ${r}`);
    lines.push("", "Please correct and resubmit.");
  } else {
    if (approved) lines.push(approved);
    if (heldLine) lines.push(heldLine);
    for (const h of holds) {
      lines.push("", `Line ${h.item} - ${h.description}`, holdParagraph(h));
      if (h.areas.length) {
        lines.push("", `Work not complete as of ${usDate(args.periodEnd)}:`);
        for (const a of h.areas) lines.push(`- ${a.area} (${pct2(a.pct)} of the line): ${a.items}`);
        lines.push(`Total not complete: ${pct1(1 - h.builtPct)}`);
      }
      lines.push("", nextStep(h));
    }
  }
  if (args.asks.length) {
    lines.push("", "Before payment is released, please send:");
    for (const a of args.asks) lines.push(`- ${a}`);
  }
  lines.push("", "Thank you,");

  return {
    kind,
    subject,
    opening,
    approved,
    heldLine,
    holds: holds.map((h) => ({ ...h, paragraph: holdParagraph(h), next: nextStep(h) })),
    sendBack: args.sendBack,
    asks: args.asks,
    text: lines.join("\n"),
  };
}
