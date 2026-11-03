/**
 * Ordering for the "pick a file" lists.
 *
 * Zarina, on the markup picker: "can you organize this". It was the library
 * in whatever order the database handed it back - a W-8 above the 60% civil
 * set, Rev B above Rev D, and the same file listed three times with nothing
 * to tell the copies apart.
 *
 * Three rules, in order of what actually costs time on site:
 *   1. Drawings first. The sheet an RFI is about is a drawing, nearly always.
 *   2. Newest first inside a group, so the current revision is at the top
 *      rather than three scrolls down from the superseded one.
 *   3. Repeat uploads of the same name are marked, so picking the stale copy
 *      of a sheet takes a deliberate click rather than a careless one.
 */

export type PickerDoc = {
  id: string;
  fileName: string;
  category: string;
  uploadedAt: string | null;
};

/** An older upload of a name that appears again, newer, in the same group. */
export type PickerRow<T extends PickerDoc = PickerDoc> = T & { olderCopy: boolean };

export type PickerGroup<T extends PickerDoc = PickerDoc> = {
  key: string;
  label: string;
  docs: Array<PickerRow<T>>;
};

/** Which heading a category sits under. */
const GROUP_OF: Record<string, string> = {
  drawing: "drawings",
  spec: "specs",
  submittal: "submittals",
  exhibit: "exhibits",
  rfi: "rfi",
  prime_contract: "contracts",
  amendment: "contracts",
  subcontract: "contracts",
  daily_log: "field",
  email: "field",
  coi: "financial",
  w9: "financial",
  bond: "financial",
  lien_waiver: "financial",
  invoice: "financial",
  other: "other",
};

/** Top to bottom. Drawings first because that is what a question is about. */
export const PICKER_GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "drawings", label: "Drawings" },
  { key: "specs", label: "Specs" },
  { key: "submittals", label: "Submittals" },
  { key: "exhibits", label: "Exhibits" },
  { key: "rfi", label: "RFI files" },
  { key: "contracts", label: "Contracts" },
  { key: "field", label: "Field and email" },
  { key: "financial", label: "Financial and compliance" },
  { key: "other", label: "Other" },
];

/** Case and spacing differences are not different files to a person. */
function nameKey(fileName: string): string {
  return fileName.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The date in the file name, as yyyy-mm-dd, when there is one.
 *
 * The sets are named 20261012_Sussex CSG 1_60% Civil_IFR_REV D, and that
 * leading date is the date of the SHEET. The upload date is not: 22 of the 29
 * Sussex drawings came in on one import and share a timestamp to the second,
 * so sorting by upload put Rev B above Rev D in whatever order the importer
 * happened to walk the folder.
 */
export function fileNameDate(fileName: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})[ _-]/.exec(fileName.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** The day something belongs to: the sheet's own date, else the upload's. */
function effectiveDate(doc: PickerDoc): string | null {
  return fileNameDate(doc.fileName) ?? (doc.uploadedAt ? doc.uploadedAt.slice(0, 10) : null);
}

/**
 * Newest first. Missing dates sort last, not first: an unknown date is not
 * the newest.
 *
 * Same date and same name means repeat uploads of one file, and there the
 * newest upload leads so the copies below it are the stale ones.
 */
function newestFirst(a: PickerDoc, b: PickerDoc): number {
  const da = effectiveDate(a);
  const db = effectiveDate(b);
  if (da && db) {
    if (da !== db) return da < db ? 1 : -1;
  } else if (da !== db) {
    return da ? -1 : 1;
  }
  const byName = a.fileName.localeCompare(b.fileName);
  if (byName !== 0) return byName;
  if (a.uploadedAt && b.uploadedAt && a.uploadedAt !== b.uploadedAt) {
    return a.uploadedAt < b.uploadedAt ? 1 : -1;
  }
  return 0;
}

// Generic so a caller's own fields - a mime type, a flag - survive the trip
// rather than being flattened to PickerDoc and cast back on the other side.
export function groupDocuments<T extends PickerDoc>(
  docs: readonly T[],
): Array<PickerGroup<T>> {
  const byGroup = new Map<string, T[]>();
  for (const doc of docs) {
    const key = GROUP_OF[doc.category] ?? "other";
    const list = byGroup.get(key);
    if (list) list.push(doc);
    else byGroup.set(key, [doc]);
  }

  const out: Array<PickerGroup<T>> = [];
  for (const group of PICKER_GROUPS) {
    const list = byGroup.get(group.key);
    if (!list || list.length === 0) continue;

    const sorted = [...list].sort(newestFirst);
    const seen = new Set<string>();
    out.push({
      key: group.key,
      label: group.label,
      docs: sorted.map((d) => {
        const key = nameKey(d.fileName);
        const olderCopy = seen.has(key);
        seen.add(key);
        return { ...d, olderCopy };
      }),
    });
  }
  return out;
}

/** How many files survived the search, for a count on the heading. */
export function countDocuments(groups: ReadonlyArray<PickerGroup<PickerDoc>>): number {
  return groups.reduce((n, g) => n + g.docs.length, 0);
}

/**
 * The date to show on a row: the sheet's own, when its name carries one.
 *
 * Showing the upload date would print "Oct 15, 2026" against all 22 Sussex
 * drawings, which tells the reader nothing and hides that the set spans
 * September to October.
 */
export function docDateLabel(doc: PickerDoc): string {
  const named = fileNameDate(doc.fileName);
  if (named) return uploadedLabel(`${named}T12:00:00Z`);
  return uploadedLabel(doc.uploadedAt);
}

/** Short and unambiguous. The year matters when a set spans two of them. */
export function uploadedLabel(uploadedAt: string | null): string {
  if (!uploadedAt) return "";
  const d = new Date(uploadedAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
