// Shared client/server constants for the QA/QC inspection photo flow.

export const INSPECTION_BUCKET = "inspection-photos";
// Must not exceed the inspection-photos bucket's own file_size_limit, which
// is 25,000,000 bytes. The old 25 * 1024 * 1024 was 26,214,400 - larger than
// the bucket - so files in that gap passed the client check and were then
// rejected by storage.
export const MAX_PHOTO_BYTES = 25_000_000; // 25 MB per photo, matches the bucket

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
}
