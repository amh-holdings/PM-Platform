// Shared between server actions and the client uploader. Keep in a non-server
// file so non-function exports (the option lists) are accessible from the
// browser.

import type { Database } from "@/lib/database.types";

export type DocumentCategory = Database["public"]["Enums"]["document_category"];
export type DocumentTextStatus =
  Database["public"]["Enums"]["document_text_status"];

export const DOCUMENT_CATEGORY_OPTIONS: ReadonlyArray<{
  value: DocumentCategory;
  label: string;
}> = [
  { value: "prime_contract", label: "Prime Contract" },
  { value: "amendment", label: "Amendment" },
  { value: "exhibit", label: "Exhibit" },
  { value: "subcontract", label: "Subcontract" },
  { value: "drawing", label: "Drawing" },
  { value: "spec", label: "Spec" },
  { value: "submittal", label: "Submittal" },
  { value: "rfi", label: "RFI" },
  { value: "daily_log", label: "Daily Log" },
  { value: "email", label: "Email" },
  // Financial and compliance. A certificate of insurance used to go in as
  // Other and be found by remembering the file name.
  { value: "coi", label: "COI" },
  { value: "w9", label: "W-9" },
  { value: "bond", label: "Bond" },
  { value: "lien_waiver", label: "Lien Waiver" },
  { value: "invoice", label: "Invoice" },
  { value: "other", label: "Other" },
];

/**
 * The categories that belong to a subcontractor rather than to the project.
 *
 * Used to decide when the uploader asks which sub a file is for, and which
 * rows the compliance view reads.
 */
export const SUBCONTRACTOR_DOCUMENT_CATEGORIES: ReadonlyArray<DocumentCategory> =
  ["coi", "w9", "bond", "lien_waiver", "subcontract", "invoice"];

/** A COI expires. A W-9 does not. */
export const EXPIRING_DOCUMENT_CATEGORIES: ReadonlyArray<DocumentCategory> = [
  "coi",
  "bond",
];

/**
 * Whether a string is a category the app knows.
 *
 * The move control is a <select>, and a select is a suggestion, not a
 * guarantee: what reaches the server is whatever was posted. The database
 * enum would reject a bad value anyway, but it would do it as a Postgres
 * error string in a red box, which tells the reader nothing they can act on.
 */
export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return DOCUMENT_CATEGORY_OPTIONS.some((o) => o.value === value);
}

export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> =
  Object.fromEntries(
    DOCUMENT_CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
  ) as Record<DocumentCategory, string>;

// Display order in the document list - more important categories first.
export const DOCUMENT_CATEGORY_ORDER: DocumentCategory[] = [
  "prime_contract",
  "amendment",
  "exhibit",
  "subcontract",
  "drawing",
  "spec",
  "submittal",
  "rfi",
  "daily_log",
  "email",
  "coi",
  "w9",
  "bond",
  "lien_waiver",
  "invoice",
  "other",
];

// Which categories are expanded by default in the documents section.
// Everything else stays collapsed (user clicks to expand).
export const DOCUMENT_CATEGORY_DEFAULT_OPEN: DocumentCategory[] = [
  "prime_contract",
  "amendment",
];

export const DOCUMENT_BUCKET = "project-documents";

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export const ACCEPTED_MIME_PREFIXES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "image/",
];
