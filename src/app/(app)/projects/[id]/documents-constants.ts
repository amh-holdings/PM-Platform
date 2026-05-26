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
  { value: "other", label: "Other" },
];

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
