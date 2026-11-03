/**
 * Document picker ordering - known-answer tests.
 *
 * The risk this guards is picking the wrong revision. Rev B and Rev D of the
 * same civil set differ by one letter in a 60-character file name, and if the
 * list is in database order they sit three scrolls apart with nothing saying
 * which is current.
 *
 * Run: npx tsx scripts/documents/run-picker-tests.ts
 */

import {
  countDocuments,
  mergePickedFiles,
  fileNameDate,
  groupDocuments,
  uploadedLabel,
  type PickerDoc,
} from "../../src/lib/document-picker";

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${name} - got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

const doc = (p: Partial<PickerDoc> & { id: string }): PickerDoc => ({
  fileName: `${p.id}.pdf`,
  category: "drawing",
  uploadedAt: "2026-10-01T00:00:00Z",
  ...p,
});

console.log("\n=== Group order ===");

// The real Sussex library, in the order the database handed it back.
const sussex: PickerDoc[] = [
  doc({ id: "w8", fileName: "Exactus W-8BEN-E (2026).pdf", category: "w9", uploadedAt: "2026-11-03T07:20:00Z" }),
  doc({ id: "coi", fileName: "26-27 - COI - Exactus Energy Inc - COI.pdf", category: "coi", uploadedAt: "2026-11-03T07:19:00Z" }),
  doc({ id: "revC", fileName: "20261009_Sussex_Exactus_60pct-Civil_IFR_Rev-C.pdf", uploadedAt: "2026-10-09T12:00:00Z" }),
  doc({ id: "exhibits", fileName: "Sussex CSG 1 LLC Exhibits.pdf", category: "exhibit", uploadedAt: "2026-09-10T18:35:00Z" }),
  doc({ id: "revD", fileName: "20261012_Sussex CSG 1_60% Civil_IFR_REV D.pdf", uploadedAt: "2026-10-12T12:00:00Z" }),
  doc({ id: "sub", fileName: "Exactus Energy - AHC - Sussex CSG - Signed.pdf", category: "subcontract", uploadedAt: "2026-09-10T18:35:00Z" }),
];

const grouped = groupDocuments(sussex);
eq(
  "drawings first, compliance last",
  grouped.map((g) => g.key),
  ["drawings", "exhibits", "contracts", "financial"],
);
eq("empty groups are not shown", grouped.filter((g) => g.docs.length === 0).length, 0);
eq("nothing is lost", countDocuments(grouped), sussex.length);

console.log("\n=== Newest first inside a group ===");

eq(
  "Rev D sits above Rev C",
  grouped[0].docs.map((d) => d.id),
  ["revD", "revC"],
);

const dated: PickerDoc[] = [
  doc({ id: "old", uploadedAt: "2026-01-01T00:00:00Z" }),
  doc({ id: "undated", uploadedAt: null }),
  doc({ id: "new", uploadedAt: "2026-10-01T00:00:00Z" }),
];
eq(
  "an unknown date is not the newest",
  groupDocuments(dated)[0].docs.map((d) => d.id),
  ["new", "old", "undated"],
);

const sameInstant: PickerDoc[] = [
  doc({ id: "b", fileName: "B set.pdf", uploadedAt: "2026-10-01T00:00:00Z" }),
  doc({ id: "a", fileName: "A set.pdf", uploadedAt: "2026-10-01T00:00:00Z" }),
];
eq(
  "a bulk upload falls back to the name",
  groupDocuments(sameInstant)[0].docs.map((d) => d.id),
  ["a", "b"],
);

console.log("\n=== Repeat uploads ===");

const dupes: PickerDoc[] = [
  doc({ id: "first", fileName: "Sussex CSG 1 LLC Exhibits.pdf", category: "exhibit", uploadedAt: "2026-09-10T18:00:00Z" }),
  doc({ id: "second", fileName: "Sussex CSG 1 LLC Exhibits.pdf", category: "exhibit", uploadedAt: "2026-09-10T18:35:00Z" }),
  doc({ id: "third", fileName: "sussex csg 1 llc  exhibits.pdf", category: "exhibit", uploadedAt: "2026-09-09T18:00:00Z" }),
];
const dupeGroup = groupDocuments(dupes)[0].docs;
eq("the newest copy is first", dupeGroup.map((d) => d.id), ["second", "first", "third"]);
eq(
  "only the newest is unmarked",
  dupeGroup.map((d) => d.olderCopy),
  [false, true, true],
);
check(
  "case and spacing do not make a different file",
  dupeGroup[2].olderCopy === true,
);

const across: PickerDoc[] = [
  doc({ id: "drawing", fileName: "Same.pdf", category: "drawing" }),
  doc({ id: "exhibit", fileName: "Same.pdf", category: "exhibit" }),
];
eq(
  "the same name in two groups is not a copy",
  groupDocuments(across).map((g) => g.docs.map((d) => d.olderCopy)),
  [[false], [false]],
);


console.log("\n=== The date in the sheet name beats the upload date ===");

eq("a dated set name", fileNameDate("20261012_Sussex CSG 1_60% Civil_IFR_REV D.pdf"), "2026-10-12");
eq("a space after the date", fileNameDate("20261012 Sussex Civil.pdf"), "2026-10-12");
eq("a dash after the date", fileNameDate("20261012-Sussex.pdf"), "2026-10-12");
eq("a plain name has none", fileNameDate("Sussex CSG 1 LLC Exhibits.pdf"), null);
eq("a long number is not a date", fileNameDate("123456789_set.pdf"), null);
eq("month 13 is not a date", fileNameDate("20261312_set.pdf"), null);
eq("day 00 is not a date", fileNameDate("20261200_set.pdf"), null);
eq("a date mid-name is not the prefix", fileNameDate("Sussex 20261012 Civil.pdf"), null);

// The real failure: 22 drawings imported in one go share an upload timestamp,
// so the upload date says nothing about which revision is current.
const bulkImport: PickerDoc[] = [
  doc({ id: "revB", fileName: "20261006_Sussex_Exactus_60pct-Civil_IFR_Rev-B.pdf", uploadedAt: "2026-10-15T09:00:01Z" }),
  doc({ id: "revD", fileName: "20261012_Sussex CSG 1_60% Civil_IFR_REV D.pdf", uploadedAt: "2026-10-15T09:00:02Z" }),
  doc({ id: "revA", fileName: "20260914_Sussex_Exactus_30pct-Civil_IFR_Rev-A.pdf", uploadedAt: "2026-10-15T09:00:03Z" }),
  doc({ id: "revC", fileName: "20261009_Sussex_Exactus_60pct-Civil_IFR_Rev-C.pdf", uploadedAt: "2026-10-15T09:00:04Z" }),
];
eq(
  "the current revision leads, whatever order they imported in",
  groupDocuments(bulkImport)[0].docs.map((d) => d.id),
  ["revD", "revC", "revB", "revA"],
);

// A sheet with no date in its name still has to sit somewhere sensible.
const mixed: PickerDoc[] = [
  doc({ id: "named", fileName: "20261012_Civil.pdf", uploadedAt: "2026-01-01T00:00:00Z" }),
  doc({ id: "plain", fileName: "Site plan.pdf", uploadedAt: "2026-10-20T00:00:00Z" }),
];
eq(
  "an undated name falls back to its upload date",
  groupDocuments(mixed)[0].docs.map((d) => d.id),
  ["plain", "named"],
);

// Repeat uploads of one sheet: newest upload first, the rest marked.
const repeats: PickerDoc[] = [
  doc({ id: "early", fileName: "20261009_Civil_Rev-C.pdf", uploadedAt: "2026-10-14T08:00:00Z" }),
  doc({ id: "late", fileName: "20261009_Civil_Rev-C.pdf", uploadedAt: "2026-10-15T08:00:00Z" }),
];
eq(
  "the newest upload of one sheet leads",
  groupDocuments(repeats)[0].docs.map((d) => [d.id, d.olderCopy]),
  [["late", false], ["early", true]],
);

console.log("\n=== Adding files in more than one go ===");

const f = (name: string, size: number) => ({ name, size });

eq(
  "a second trip to the file picker adds, it does not replace",
  mergePickedFiles([f("swale.jpg", 10)], [f("pad.jpg", 20)]).map((x) => x.name),
  ["swale.jpg", "pad.jpg"],
);
eq(
  "the same photo picked twice lands once",
  mergePickedFiles([f("swale.jpg", 10)], [f("swale.jpg", 10)]).map((x) => x.name),
  ["swale.jpg"],
);
eq(
  "two photos off two phones both land",
  mergePickedFiles([f("IMG_4821.jpg", 10)], [f("IMG_4821.jpg", 99)]).length,
  2,
);
eq(
  "a repeat inside one batch lands once",
  mergePickedFiles([], [f("a.jpg", 1), f("a.jpg", 1), f("b.jpg", 2)]).map((x) => x.name),
  ["a.jpg", "b.jpg"],
);
eq("picking nothing changes nothing", mergePickedFiles([f("a.jpg", 1)], []).map((x) => x.name), ["a.jpg"]);
check(
  "the original list is never mutated",
  (() => {
    const start = [f("a.jpg", 1)];
    mergePickedFiles(start, [f("b.jpg", 2)]);
    return start.length === 1;
  })(),
);

console.log("\n=== Odds and ends ===");

eq("an unknown category falls to Other", groupDocuments([doc({ id: "x", category: "mystery" })])[0].key, "other");
eq("an empty library is an empty list", groupDocuments([]), []);
eq("no date, no label", uploadedLabel(null), "");
eq("a broken date does not print NaN", uploadedLabel("not a date"), "");
check("a real date reads plainly", /^[A-Z][a-z]{2} \d{1,2}, 2026$/.test(uploadedLabel("2026-10-12T12:00:00Z")));

console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
