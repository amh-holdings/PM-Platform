// Shared between the change order server actions and the client-side buildup
// editor / uploader. Non-function exports only, so the browser can import it.

export const ATTACHMENT_KINDS = [
  "quote",
  "ticket",
  "photo",
  "rfi",
  "directive",
  "drawing",
  "other",
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  quote: "Quote",
  ticket: "T&M ticket",
  photo: "Photo",
  rfi: "RFI",
  directive: "Owner directive",
  drawing: "Drawing",
  other: "Other",
};

// Backup files live in the same private bucket as the document library, under
// a change-orders/ prefix. The bucket's storage policies are bucket-wide, so
// no new bucket or policy is needed.
export const CO_ATTACHMENT_PREFIX = "change-orders";
