import "server-only";

import * as XLSX from "xlsx";

/**
 * Turns an uploaded bid file into plain text for Claude to read.
 *
 * Bids come back as our Excel bid sheet, a sub's own Excel, or a PDF
 * proposal. Excel goes sheet by sheet as CSV so the columns survive; a PDF
 * goes page by page as its text layer. A scanned PDF has no text layer and is
 * refused with a message, because an empty read would come back as a bid of
 * nothing.
 *
 * The pdf.js setup mirrors sub-billing/pdf-actions.ts: the DOMMatrix stand-in
 * and the worker import are both needed for pdf.js to load under Node on
 * Vercel. See that file for why.
 */

export const MAX_BID_TEXT = 300_000;

export type BidFileText = { ok: true; text: string; kind: "excel" | "pdf" | "text" } | { ok: false; error: string };

export async function bidFileText(fileName: string, bytes: Uint8Array): Promise<BidFileText> {
  if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
  const lower = fileName.toLowerCase();
  try {
    if (/\.(xlsx|xlsm|xls)$/.test(lower)) return { ok: true, kind: "excel", text: clip(excelText(bytes)) };
    if (lower.endsWith(".pdf")) {
      const text = await pdfText(bytes);
      if (text.replace(/\s/g, "").length < 200) {
        return {
          ok: false,
          error: "This PDF has no readable text. It looks like a scan. Ask the bidder for the Excel bid sheet.",
        };
      }
      return { ok: true, kind: "pdf", text: clip(text) };
    }
    if (/\.(csv|txt)$/.test(lower)) return { ok: true, kind: "text", text: clip(Buffer.from(bytes).toString("utf8")) };
    return { ok: false, error: "Upload the bid as Excel, PDF or CSV." };
  } catch (err) {
    return { ok: false, error: `That file could not be read: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

function clip(text: string): string {
  return text.length > MAX_BID_TEXT ? `${text.slice(0, MAX_BID_TEXT)}\n\n[... truncated]` : text;
}

function excelText(bytes: Uint8Array): string {
  const wb = XLSX.read(bytes, { type: "array" });
  return wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    return `=== Sheet: ${name} ===\n${csv}`;
  }).join("\n\n");
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const g = globalThis as { DOMMatrix?: unknown; pdfjsWorker?: unknown };
  if (!g.DOMMatrix) {
    const unavailable = () => {
      throw new Error("DOMMatrix is not available here. This runtime reads text out of a PDF and cannot render one.");
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
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Group by baseline so a table row reads as one line.
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const raw of content.items) {
        if (!("str" in raw) || !raw.str.trim()) continue;
        const y = Math.round(Number(raw.transform?.[5] ?? 0));
        rows.set(y, [...(rows.get(y) ?? []), { x: Number(raw.transform?.[4] ?? 0), s: raw.str }]);
      }
      const lines = Array.from(rows.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.s).join("  "));
      pages.push(`=== Page ${n} ===\n${lines.join("\n")}`);
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await doc.destroy();
  }
}
