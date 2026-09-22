"use server";

import { requireCapability } from "@/lib/sub-billing-auth";
import { pdfPagesToSheets, type PdfPageItems, type PdfTextItem } from "@/lib/sov-pdf";
import type { SheetSummary } from "@/lib/schedule-workbook";

/**
 * Reads an SOV PDF on the server and hands the rows back for review.
 *
 * On the server rather than in the browser for two reasons: pdf.js is a large
 * bundle nobody should download to look at a billing page, and in Node it
 * needs no worker URL to be configured or served. Kept out of actions.ts so
 * the reader is only in the module graph of the one action that needs it.
 *
 * Nothing is written here. The rows go back to the browser, land in the same
 * textarea a paste lands in, and are saved - if at all - by importSovLines.
 */

export type PdfSovResult =
  | { ok: true; sheets: SheetSummary[]; pages: number }
  | { ok: false; error: string };

/** A page of an SOV exhibit yields far more than this if it has a text layer. */
const MIN_ITEMS_PER_PAGE = 5;

export async function readSovPdf(base64: string): Promise<PdfSovResult> {
  const auth = await requireCapability("enterSubBill");
  if (!auth.ok) return auth;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return { ok: false, error: "That file could not be read." };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };

  // Everything from here is inside the try, including the imports.
  //
  // A server action that throws rather than returning gets its message
  // replaced by Next with "An error occurred in the Server Components
  // render. The specific message is omitted in production builds", and the
  // two failures below both throw at import time. That message cost an
  // afternoon: the feature was broken in production, the cause was printed
  // nowhere, and the screen said only that something had gone wrong.
  let doc: Awaited<
    ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]
  > | null = null;

  try {
    // pdf.js needs a DOMMatrix at module scope - `const SCALE_MATRIX = new
    // DOMMatrix()` - and in Node it gets one by require()ing @napi-rs/canvas,
    // an optional native package. A build tracer cannot follow a runtime
    // require, so the package is not deployed, pdf.mjs throws on import, and
    // nothing about it is visible from the outside.
    //
    // Installing a 40 MB native canvas to read text off a page is the wrong
    // trade. SCALE_MATRIX is only ever read by the canvas rasteriser, in
    // Path2D.addPath, which extracting text never reaches. The matrix has to
    // exist; it does not have to work. Anything that would actually use it
    // throws rather than returning a quietly wrong number.
    const g = globalThis as {
      DOMMatrix?: unknown;
      pdfjsWorker?: unknown;
    };
    if (!g.DOMMatrix) {
      const unavailable = () => {
        throw new Error(
          "DOMMatrix is not available here. This runtime reads text out of a PDF and cannot render one.",
        );
      };
      g.DOMMatrix = class {
        a = 1;
        b = 0;
        c = 0;
        d = 1;
        e = 0;
        f = 0;
        multiply = unavailable;
        translate = unavailable;
        scale = unavailable;
        rotate = unavailable;
        invertSelf = unavailable;
        transformPoint = unavailable;
      };
    }

    // Hand pdf.js its worker before it goes looking for one.
    //
    // Under Node it runs the worker on the main thread, but it still has to
    // load the worker module, and it does that with `import(workerSrc)` where
    // workerSrc defaults to the relative string "./pdf.worker.mjs", marked
    // webpackIgnore. Same problem as the canvas require: a tracer cannot see
    // through a runtime string, so the file is not deployed. Importing it by
    // its package path is something the tracer can follow, and
    // globalThis.pdfjsWorker is the hook pdf.js checks first.
    if (!g.pdfjsWorker) {
      g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    }

    // The legacy build is the one that runs under Node.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

    doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;

    const pages: PdfPageItems[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const tm = raw.transform;
        items.push({
          str: raw.str,
          x: Number(tm?.[4] ?? 0),
          y: Number(tm?.[5] ?? 0),
          width: Number(raw.width ?? 0),
          height: Number(raw.height ?? 0),
        });
      }
      pages.push({ num: n, items });
      page.cleanup();
    }

    // A scan has no text layer, so it reads as a PDF with no words in it.
    // Saying so beats handing back an empty review box.
    const totalItems = pages.reduce(
      (s, p) => s + p.items.filter((i) => i.str.trim()).length,
      0,
    );
    if (totalItems < Math.max(MIN_ITEMS_PER_PAGE, pages.length * MIN_ITEMS_PER_PAGE)) {
      return {
        ok: false,
        error:
          "This PDF has no readable text - it looks like a scan or a photo of the SOV. Ask the sub for the Excel version, or copy the rows and paste them in.",
      };
    }

    const sheets = pdfPagesToSheets(pages);
    if (sheets.every((s) => s.filledRows === 0)) {
      return { ok: false, error: "No rows could be read from that PDF." };
    }
    return { ok: true, sheets, pages: doc.numPages };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return { ok: false, error: `Could not read that PDF: ${msg}` };
  } finally {
    if (doc) await doc.destroy().catch(() => {});
  }
}
