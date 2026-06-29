// Shared client/server constants for the QA/QC inspection photo flow.

export const INSPECTION_BUCKET = "inspection-photos";
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25 MB per photo

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}
