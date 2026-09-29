// How one SOV line splits its value between the scopes inside it.
//
// Zarina, on SOV 6.03 Fencing/SWPPP: "Please update this recommended rules of
// credit on what to bill to owner. Recommended rules of credit: SWPPP at 30%,
// rest is fence."
//
// The problem this solves. 6.03 is one contract line covering two unrelated
// scopes: permanent fencing, and the erosion and sediment control that
// implements the SWPPP. The recommendation weights its linked tasks by
// scheduled duration, which is a fair default when a line is one scope split
// across tasks, and wrong here. Duration says how long something takes, not
// what it is worth, and eight short ESC tasks next to one long fencing task
// gave the line a percent nobody could defend to Dimension.
//
// A rule of credit says what each scope is WORTH as a share of the line. The
// earned percent is then sum(weight x that scope's progress), and the number
// has a sentence behind it: "SWPPP is 54% done and carries 30% of the line,
// fencing has not started and carries 70%, so the line has earned 16.2%."
//
// Two design choices worth knowing.
//
// Components claim tasks by NAME PATTERN, not by a stored list of WBS codes.
// A stored list goes stale the moment the schedule gains a task, and it goes
// stale silently: the new task earns nothing and the line quietly under-bills.
// A pattern picks up "Basin 3 ESC" the day it is added.
//
// Exactly one component is the remainder, matching everything no other
// component claimed. That way no linked task can fall outside the rule, which
// is the failure that would actually cost money.

export type RuleOfCreditComponent = {
  /** What this scope is called on the AFP conversation. "Fence", "SWPPP". */
  name: string;
  /** Share of the line's value, 0 to 100. All components sum to 100. */
  weightPct: number;
  /**
   * Lowercased substrings of the task name this component claims. Empty means
   * this is the remainder: everything no other component took.
   */
  match: string[];
};

export type RuleOfCredit = {
  components: RuleOfCreditComponent[];
  /** Free text for the AFP thread: who agreed it and when. */
  note?: string | null;
};

export type RuleOfCreditTask = {
  wbsCode: string;
  taskName: string;
  /** 0 to 1. */
  pct: number;
  durationDays: number | null;
};

export type RuleOfCreditComponentResult = {
  name: string;
  weightPct: number;
  /** 0 to 1, this scope's own progress. */
  pct: number;
  tasks: RuleOfCreditTask[];
  /** True when the component claimed nothing, so it earns at zero. */
  empty: boolean;
};

export type RuleOfCreditResult = {
  /** 0 to 1, the whole line. */
  pct: number;
  components: RuleOfCreditComponentResult[];
  /** Components that claimed no task at all. Earning zero at full weight. */
  emptyComponents: string[];
  reason: string;
};

const WEIGHT_TOLERANCE = 0.01;

/**
 * A stored rule, or null when there is nothing usable.
 *
 * Deliberately strict. A rule whose weights do not sum to 100 is not a rule
 * that is slightly off, it is a rule somebody half-edited, and honouring it
 * would bill a line at a percentage of a percentage without saying so. Two
 * remainder components have the same problem: the second would silently claim
 * nothing. Both cases return null and the caller falls back to what it did
 * before, which is a visible change of basis rather than a wrong number.
 */
export function parseRuleOfCredit(raw: unknown): RuleOfCredit | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { components?: unknown; note?: unknown };
  if (!Array.isArray(obj.components) || obj.components.length === 0) return null;

  const components: RuleOfCreditComponent[] = [];
  for (const c of obj.components) {
    if (!c || typeof c !== "object") return null;
    const { name, weightPct, match } = c as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return null;
    const w = Number(weightPct);
    if (!Number.isFinite(w) || w < 0 || w > 100) return null;
    const patterns = Array.isArray(match)
      ? match.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    components.push({
      name: name.trim(),
      weightPct: w,
      match: patterns.map((m) => m.trim().toLowerCase()),
    });
  }

  const total = components.reduce((s, c) => s + c.weightPct, 0);
  if (Math.abs(total - 100) > WEIGHT_TOLERANCE) return null;

  // One remainder, no more. Zero is allowed: a rule where every component
  // names its own scope is fine as long as nothing is left over, which
  // applyRuleOfCredit checks against the tasks actually linked.
  if (components.filter((c) => c.match.length === 0).length > 1) return null;

  const note = typeof obj.note === "string" ? obj.note : null;
  return { components, note };
}

/** Which component claims this task, by the first pattern that hits. */
function claim(
  components: readonly RuleOfCreditComponent[],
  taskName: string,
): number {
  const name = (taskName ?? "").toLowerCase();
  for (let i = 0; i < components.length; i += 1) {
    const c = components[i];
    if (c.match.length === 0) continue;
    if (c.match.some((m) => name.includes(m))) return i;
  }
  return components.findIndex((c) => c.match.length === 0);
}

/**
 * Roll several tasks in one component into that component's own percent.
 *
 * Duration weighting still applies INSIDE a component, and that is the right
 * place for it: eight ESC tasks are one scope, so how long each takes is a
 * fair proxy for how much of that scope it is. What duration must not decide
 * is how the fence compares to the SWPPP, which is what the weights are for.
 */
function componentPct(tasks: readonly RuleOfCreditTask[]): number {
  if (tasks.length === 0) return 0;
  const known = tasks
    .map((t) => t.durationDays)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
  if (known.length === 0) {
    return tasks.reduce((s, t) => s + t.pct, 0) / tasks.length;
  }
  const fallback = known.reduce((s, d) => s + d, 0) / known.length;
  let num = 0;
  let den = 0;
  for (const t of tasks) {
    const w =
      t.durationDays != null && Number.isFinite(t.durationDays) && t.durationDays > 0
        ? t.durationDays
        : fallback;
    num += t.pct * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Percent, rounded the way the sentence prints it. */
function pctText(pct: number): string {
  return `${Math.round(pct * 1000) / 10}%`;
}

/**
 * What a line has earned under its rule of credit.
 *
 * A component that claimed no task earns zero at its full weight, which is
 * correct: scope that is not in the schedule has not been built. It is named
 * in `emptyComponents` all the same, because the other reason a component
 * claims nothing is that its pattern no longer matches anything, and that
 * looks identical from the number alone.
 */
export function applyRuleOfCredit(input: {
  rule: RuleOfCredit;
  tasks: readonly RuleOfCreditTask[];
}): RuleOfCreditResult {
  const { rule, tasks } = input;
  const buckets: RuleOfCreditTask[][] = rule.components.map(() => []);
  for (const t of tasks) {
    const i = claim(rule.components, t.taskName);
    // No remainder component and nothing matched. Cannot happen on a rule
    // that parsed with a remainder; on one without, the task is left out and
    // its scope earns nothing, which the reason line says out loud.
    if (i >= 0) buckets[i].push(t);
  }

  const components: RuleOfCreditComponentResult[] = rule.components.map((c, i) => {
    const own = buckets[i];
    return {
      name: c.name,
      weightPct: c.weightPct,
      pct: componentPct(own),
      tasks: own,
      empty: own.length === 0,
    };
  });

  const pct = components.reduce((s, c) => s + (c.weightPct / 100) * c.pct, 0);

  const parts = components.map(
    (c) =>
      `${c.name} ${c.empty ? "has no linked task" : `is ${pctText(c.pct)} done`} and carries ${c.weightPct}%`,
  );
  const claimed = components.reduce((s, c) => s + c.tasks.length, 0);
  const dropped = tasks.length - claimed;
  const tail = dropped > 0 ? `. ${dropped} linked task(s) match no scope and earn nothing` : "";

  return {
    pct: Math.min(1, Math.max(0, pct)),
    components,
    emptyComponents: components.filter((c) => c.empty).map((c) => c.name),
    reason: `Rule of credit: ${parts.join(", ")}, so the line has earned ${pctText(pct)}${tail}`,
  };
}

/**
 * The rule as one line, for a panel that has room for a sentence and not a
 * table. "SWPPP 30% / Fence 70%".
 */
export function describeRuleOfCredit(rule: RuleOfCredit): string {
  return rule.components.map((c) => `${c.name} ${c.weightPct}%`).join(" / ");
}
