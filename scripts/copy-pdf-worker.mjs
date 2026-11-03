/**
 * Put pdf.js's worker where the browser can fetch it.
 *
 * The markup tool renders a plan sheet in the browser, and pdf.js does that
 * work in a Web Worker. Next's webpack config refuses to bundle the worker
 * through `new URL("pdfjs-dist/...", import.meta.url)` - it is an ESM package
 * and the build fails with "ESM packages need to be imported" - so the worker
 * is copied into public/ and loaded by path instead.
 *
 * Copied from node_modules rather than committed so it cannot drift from the
 * pdfjs-dist version actually installed. A mismatched worker fails at runtime
 * with "The API version does not match the Worker version", which is a
 * confusing way to find out about a stale file.
 *
 * Runs automatically before `npm run dev` and `npm run build`.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const target = join(root, "public/pdf.worker.min.mjs");

try {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const version = JSON.parse(
    readFileSync(join(root, "node_modules/pdfjs-dist/package.json"), "utf8"),
  ).version;
  console.log(`pdf.js worker ${version} -> public/pdf.worker.min.mjs`);
} catch (err) {
  // Never fail the build over this. The markup tool is one feature; the rest
  // of the app does not need the worker, and a missing one reports itself
  // plainly when somebody opens the markup dialog.
  console.warn(`Could not copy the pdf.js worker: ${err.message}`);
}
