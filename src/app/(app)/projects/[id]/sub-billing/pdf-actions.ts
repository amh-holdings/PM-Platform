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

  // The legacy build is the one that runs under Node without a worker.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
  try {
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
