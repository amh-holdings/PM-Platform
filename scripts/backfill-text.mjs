// Re-extract text for documents currently flagged text_status='skipped'.
// Handles:
//   - PDFs (likely scanned) via tesseract.js OCR
//   - xlsx via SheetJS
//
// Usage:
//   node scripts/backfill-text.mjs --project-id <uuid>
//   node scripts/backfill-text.mjs --project-id <uuid> --dry-run

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createWorker } from "tesseract.js";
import { pdf } from "pdf-to-img";
import * as XLSX from "xlsx";

// ============ ENV ============

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const BUCKET = "project-documents";

// ============ ARGS ============

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const key = k.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        args[key] = val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const projectId = args["project-id"];
const dryRun = args["dry-run"] === true;
if (!projectId) {
  console.error("Usage: node scripts/backfill-text.mjs --project-id <uuid> [--dry-run]");
  process.exit(1);
}

// ============ EXTRACTORS ============

async function extractXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    out.push(`=== Sheet: ${sheetName} ===`);
    out.push(XLSX.utils.sheet_to_csv(sheet));
    out.push("");
  }
  return { text: out.join("\n").trim(), pages: wb.SheetNames.length };
}

async function ocrPdf(buffer, label) {
  const doc = await pdf(buffer, { scale: 2.0 });
  const pageCount = doc.length;
  const worker = await createWorker("eng", undefined, {
    logger: () => {}, // suppress per-line logs
  });
  try {
    const pages = [];
    let pageNum = 0;
    for await (const pageBuf of doc) {
      pageNum++;
      process.stdout.write(`    OCR page ${pageNum}/${pageCount}... `);
      const start = Date.now();
      const { data } = await worker.recognize(pageBuf);
      const ms = Date.now() - start;
      const len = (data.text || "").trim().length;
      console.log(`${len} chars (${(ms/1000).toFixed(1)}s)`);
      pages.push(data.text);
    }
    return { text: pages.join("\n\n--- PAGE BREAK ---\n\n"), pages: pageCount };
  } finally {
    await worker.terminate();
    await doc.destroy();
  }
}

// ============ MAIN ============

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data: docs, error } = await supabase
  .from("project_documents")
  .select("id, file_name, storage_path, mime_type, text_status")
  .eq("project_id", projectId)
  .eq("text_status", "skipped")
  .order("file_name");

if (error) {
  console.error(`Could not list documents: ${error.message}`);
  process.exit(1);
}

console.log(`Found ${docs.length} document(s) with text_status='skipped'`);
if (dryRun) {
  for (const d of docs) console.log(`  ${d.file_name} (${d.mime_type})`);
  console.log("Dry run - not extracting or updating.");
  process.exit(0);
}

let success = 0;
let failed = 0;

for (const doc of docs) {
  console.log(`\n>>> ${doc.file_name}`);
  console.log(`    Downloading from ${doc.storage_path}...`);

  const { data: blob, error: dlError } = await supabase.storage
    .from(BUCKET)
    .download(doc.storage_path);
  if (dlError || !blob) {
    console.error(`    FAIL download: ${dlError?.message || "no blob"}`);
    failed++;
    continue;
  }
  const buffer = Buffer.from(await blob.arrayBuffer());

  let extracted;
  try {
    if (doc.mime_type === "application/pdf") {
      extracted = await ocrPdf(buffer, doc.file_name);
    } else if (
      doc.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      doc.mime_type === "application/vnd.ms-excel"
    ) {
      extracted = await extractXlsx(buffer);
      console.log(`    Extracted ${extracted.text.length} chars across ${extracted.pages} sheet(s)`);
    } else {
      console.log(`    No backfill extractor for MIME type ${doc.mime_type}, leaving as skipped`);
      continue;
    }
  } catch (err) {
    console.error(`    FAIL extract: ${err.message}`);
    const { error: updateError } = await supabase
      .from("project_documents")
      .update({ text_status: "failed", text_error: err.message })
      .eq("id", doc.id);
    if (updateError) console.error(`    (also failed to mark row failed: ${updateError.message})`);
    failed++;
    continue;
  }

  const text = (extracted.text || "").trim();
  if (text.length === 0) {
    console.log(`    Extracted text was empty - marking as failed`);
    await supabase
      .from("project_documents")
      .update({ text_status: "failed", text_error: "Extraction returned empty text" })
      .eq("id", doc.id);
    failed++;
    continue;
  }

  const { error: updateError } = await supabase
    .from("project_documents")
    .update({
      extracted_text: text,
      text_status: "ready",
      text_error: null,
      pages_count: extracted.pages,
    })
    .eq("id", doc.id);
  if (updateError) {
    console.error(`    FAIL update: ${updateError.message}`);
    failed++;
    continue;
  }

  console.log(`    OK: text_status -> ready (${text.length} chars)`);
  success++;
}

console.log(`\nDone. success: ${success}, failed: ${failed}`);
