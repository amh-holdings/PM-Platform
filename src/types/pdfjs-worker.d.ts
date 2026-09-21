// The worker build ships no types. It is never called from here - it is
// handed to pdf.js through globalThis.pdfjsWorker so that pdf.js does not
// reach for it with a runtime string a build tracer cannot follow.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
