// AFP numbering.
//
// Sweet Springs bills a single continuous sequence, but that sequence is
// recorded in two places that do not agree:
//
//   1. pay_applications.app_number - written by this app, only since the
//      pay_applications table existed.
//   2. billing_entries.afp_number  - free text, loaded by
//      scripts/import-collections.mjs for the AFPs that predate the app.
//      Sweet Springs carries AFP 1 through AFP 8 here and nowhere else.
//
// Counting rows in pay_applications (the old fallback) proposed "AFP 1" on a
// project whose next application was AFP 12. Both sources are scanned and the
// highest number found wins.
//
// Real AFP numbers carry revision and split suffixes - "AFP 2A/2B", "AFP 3R",
// "AFP 4R". Those are the SAME ordinal as their base integer, so parsing takes
// the first integer in the string and ignores everything after it. A resubmit
// of AFP 12 is "AFP 12R", not AFP 13, and the PM types that by hand.

/** The default prefix for generated numbers. */
const DEFAULT_PREFIX = "AFP";

/**
 * The ordinal of an AFP label, or null if it carries no number.
 *
 *   "AFP 7"      -> 7
 *   "AFP 2A/2B"  -> 2
 *   "AFP 3R"     -> 3
 *   "12"         -> 12
 *   "Final"      -> null
 */
export function parseAfpOrdinal(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** The highest ordinal across a mixed list of app_number / afp_number labels. */
export function highestAfpOrdinal(
  labels: Array<string | null | undefined>,
): number {
  let max = 0;
  for (const l of labels) {
    const n = parseAfpOrdinal(l);
    if (n != null && n > max) max = n;
  }
  return max;
}

/**
 * The prefix to reuse, taken from the highest-numbered label so a project that
 * labels its applications "Pay App 8" keeps saying "Pay App". Falls back to
 * "AFP". Trailing punctuation and whitespace are trimmed.
 */
function prefixFrom(labels: Array<string | null | undefined>): string {
  let best: { n: number; prefix: string } | null = null;
  for (const l of labels) {
    const n = parseAfpOrdinal(l);
    if (n == null || !l) continue;
    if (best && n <= best.n) continue;
    const prefix = l.slice(0, l.indexOf(String(n))).replace(/[\s\-#:]+$/, "").trim();
    best = { n, prefix };
  }
  return best?.prefix || DEFAULT_PREFIX;
}

/**
 * The next AFP label for a project, scanning both numbering sources.
 * Returns e.g. "AFP 12". Never throws - on a query failure it degrades to
 * whatever it did manage to read, and to "AFP 1" if it read nothing.
 */
export async function nextAppNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  projectId: string,
): Promise<string> {
  const labels: Array<string | null> = [];

  const { data: apps } = await supabase
    .from("pay_applications")
    .select("app_number")
    .eq("project_id", projectId);
  for (const a of (apps ?? []) as Array<{ app_number: string | null }>) {
    labels.push(a.app_number);
  }

  // billing_entries has no project_id of its own - it hangs off billing_lines.
  const { data: lines } = await supabase
    .from("billing_lines")
    .select("id")
    .eq("project_id", projectId);
  const lineIds = ((lines ?? []) as Array<{ id: string }>).map((l) => l.id);
  if (lineIds.length > 0) {
    const { data: entries } = await supabase
      .from("billing_entries")
      .select("afp_number")
      .in("billing_line_id", lineIds)
      .not("afp_number", "is", null);
    for (const e of (entries ?? []) as Array<{ afp_number: string | null }>) {
      labels.push(e.afp_number);
    }
  }

  const next = highestAfpOrdinal(labels) + 1;
  return `${prefixFrom(labels)} ${next}`;
}

/**
 * Turns the Postgres unique-violation on (project_id, app_number) into
 * something a PM can act on. Returns null when the error is something else.
 */
export function friendlyAppNumberError(
  message: string | null | undefined,
  appNumber: string,
): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("duplicate key") || m.includes("unique constraint")) {
    if (m.includes("app_number") || m.includes("pay_applications")) {
      return `Pay application "${appNumber}" already exists on this project. Use a revision suffix (e.g. "${appNumber}R") or pick a different number.`;
    }
  }
  return null;
}
