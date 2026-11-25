// A submittal package: the AHC cover filled in, then every document that
// went out on it, as one PDF. The cover stays a fillable form, so the owner
// can tick their response and sign on it.

import { PDFDocument, type PDFForm } from "pdf-lib";

import { SUBMITTAL_COVER_TEMPLATE_B64 } from "./submittal-cover-template";

export type CoverInput = {
  project: string;
  date: string; // MM/DD/YYYY
  submittalNo: string; // SUS - 0001
  to: string;
  from: string;
  subject: string;
  cc: string;
  transmittedFor: "approval" | "record" | "signature" | "other";
  transmittedOther?: string | null;
  items: string[]; // document names, in order
  notes: string;
  requestedResponseDate: string; // MM/DD/YYYY or ""
};

// The template's five document lines: [item #, name] field pairs.
const ITEM_FIELDS: [string, string][] = [
  ["ITEM #", "DOCUMENT NAME / DESCRIPTION"],
  ["Text3", "Text4"],
  ["Text5", "Text6"],
  ["Text7", "Text8"],
  ["Text9", "Text10"],
];
// The response table and respondent name are the owner's to fill; the
// template ships with sample values in some fields, so every field we own is
// written, blank or not.
const BLANKED = [
  "ITEM # (1)", "RESPONSE", "Text20", "Text21", "Text22", "Text23", "Text24", "Text25", "Text26", "Text27",
  "RESPONDENT NAME AND AFFILIATION",
];

function setText(form: PDFForm, name: string, value: string, size?: number) {
  const f = form.getTextField(name);
  f.setText(value);
  if (size) f.setFontSize(size);
}

/** A field's width holds roughly this many characters at 10pt. */
const fit = (value: string, width: number) => (value.length * 5 > width ? Math.max(6, Math.floor((width / value.length) * 1.9)) : 10);

export async function fillCover(input: CoverInput): Promise<PDFDocument> {
  const doc = await PDFDocument.load(Buffer.from(SUBMITTAL_COVER_TEMPLATE_B64, "base64"));
  const form = doc.getForm();
  setText(form, "PROJECT", input.project, fit(input.project, 133));
  setText(form, "DATE", input.date);
  setText(form, "SUBMITTAL #", input.submittalNo);
  setText(form, "TO", input.to, fit(input.to, 111));
  setText(form, "FROM", input.from, fit(input.from, 144));
  setText(form, "SUBJECT", input.subject, fit(input.subject, 111));
  setText(form, "CC", input.cc, fit(input.cc, 144));
  setText(form, "REQUESTED RESPONSE DATE", input.requestedResponseDate, 8);

  const boxes: Record<CoverInput["transmittedFor"], string> = {
    approval: "For Approval", record: "For Record", signature: "For Signature", other: "Other Specify",
  };
  for (const [k, name] of Object.entries(boxes)) {
    const cb = form.getCheckBox(name);
    if (k === input.transmittedFor) cb.check();
    else cb.uncheck();
  }
  for (const name of ["APPROVED", "REVISE AND RESUBMIT", "APPROVED AS NOTED", "REJECTED"]) form.getCheckBox(name).uncheck();

  // Five lines on the form. More than five: four, then a pointer, and the
  // rest listed in the notes.
  const shown = input.items.length > 5 ? input.items.slice(0, 4) : input.items;
  const extra = input.items.length > 5 ? input.items.slice(4) : [];
  ITEM_FIELDS.forEach(([numField, nameField], i) => {
    const name = shown[i] ?? (i === 4 && extra.length ? `+ ${extra.length} more, listed in the notes below` : "");
    setText(form, numField, shown[i] ? String(i + 1) : "");
    setText(form, nameField, name, name ? fit(name, 441) : undefined);
  });
  const notes = [
    input.transmittedFor === "other" && input.transmittedOther ? `Other: ${input.transmittedOther}` : "",
    input.notes,
    extra.length ? extra.map((n, i) => `${i + 5}. ${n}`).join("\n") : "",
  ].filter(Boolean).join("\n");
  setText(form, "ADDITIONAL NOTES", notes, notes.split("\n").length > 5 ? 7 : 9);
  for (const name of BLANKED) setText(form, name, "");
  form.getTextField("ADDITIONAL NOTES").enableMultiline();
  return doc;
}

/** Cover first, then each document's pages in order. */
export async function buildPackage(cover: CoverInput, documents: Uint8Array[]): Promise<Uint8Array> {
  const out = await fillCover(cover);
  for (const bytes of documents) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  out.setTitle(`Submittal ${cover.submittalNo} - ${cover.subject}`);
  return out.save();
}

/**
 * The package's file name: the submittal number, then the Exhibit S name.
 * One document keeps its own Exhibit S name; a bundle uses the subject and
 * the submittal date, the same SPV_Item_vYYYY-MM-DD shape.
 */
export function packageFileName(submittalNo: string, exhibitSName: string): string {
  return `${submittalNo}_${exhibitSName}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
}
