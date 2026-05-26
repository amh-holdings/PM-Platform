// Bulk-import documents from a local folder into the PM Platform.
//
// Workflow:
//   1. scan   - walks folder, extracts text, writes manifest. No DB / Storage writes.
//   2. (you classify entries in the manifest)
//   3. apply  - reads manifest, uploads files to Storage, inserts rows.
//
// Usage:
//   node scripts/bulk-import.mjs scan  --project-id <uuid> --folder "/abs/path"
//   node scripts/bulk-import.mjs apply --project-id <uuid>
//
// Manifest lives at scripts/.import-manifest.json (gitignored).

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

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
const MANIFEST_PATH = "scripts/.import-manifest.json";

// ============ CONSTANTS ============

const VALID_CATEGORIES = new Set([
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
]);

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".eml": "message/rfc822",
};

const SKIP_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitkeep",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "__MACOSX",
]);

// ============ ARGS ============

function parseArgs(argv) {
  const [, , cmd, ...rest] = argv;
  const args = { _cmd: cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k.startsWith("--")) {
      const key = k.slice(2);
      const val = rest[i + 1];
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

// ============ WALK ============

function walkFolder(root) {
  if (!existsSync(root)) {
    console.error(`Folder does not exist: ${root}`);
    process.exit(1);
  }
  if (!statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
  }
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (SKIP_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        out.push(full);
      }
    }
  }
  return out.sort();
}

// ============ TEXT EXTRACTION ============

async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  const buf = readFileSync(filePath);

  if (ext === ".pdf") {
    let parser;
    try {
      parser = new PDFParse({ data: new Uint8Array(buf) });
      const result = await parser.getText();
      const text = (result.text || "").trim();
      const pages = result.total || 0;
      const minExpected = Math.max(50, pages * 30);
      if (text.length < minExpected && pages > 0) {
        return {
          status: "skipped",
          reason: "likely scanned (low text density) - needs OCR in Phase 2",
          text: text || null,
          pages,
        };
      }
      return { status: "ready", text, pages };
    } catch (err) {
      return {
        status: "failed",
        reason: `pdf-parse error: ${err.message}`,
        text: null,
        pages: null,
      };
    } finally {
      if (parser) await parser.destroy().catch(() => {});
    }
  }

  if (ext === ".docx") {
    try {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { status: "ready", text: (value || "").trim(), pages: null };
    } catch (err) {
      return {
        status: "failed",
        reason: `mammoth error: ${err.message}`,
        text: null,
        pages: null,
      };
    }
  }

  if (ext === ".txt" || ext === ".csv" || ext === ".md" || ext === ".eml") {
    return { status: "ready", text: buf.toString("utf8").trim(), pages: null };
  }

  return {
    status: "skipped",
    reason: `no extractor for ${ext || "(no extension)"}`,
    text: null,
    pages: null,
  };
}

// ============ SCAN ============

async function runScan(args) {
  const projectId = args["project-id"];
  const folder = args["folder"];
  if (!projectId || !folder) {
    console.error("Usage: scan --project-id <uuid> --folder <abs-path>");
    process.exit(1);
  }
  const absFolder = isAbsolute(folder) ? folder : join(process.cwd(), folder);

  console.log(`Scanning ${absFolder} for project ${projectId}...`);
  const files = walkFolder(absFolder);
  console.log(`Found ${files.length} file(s). Extracting text...`);

  const entries = [];
  for (const full of files) {
    const rel = relative(absFolder, full);
    const stat = statSync(full);
    const ext = extname(full).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";

    const extract = await extractText(full);
    const textLen = extract.text?.length ?? 0;

    entries.push({
      absolutePath: full,
      relativePath: rel,
      fileName: basename(full),
      sizeBytes: stat.size,
      mimeType,
      ext,
      textStatus: extract.status,
      textReason: extract.reason ?? null,
      textChars: textLen,
      pagesCount: extract.pages,
      textPreview: extract.text ? extract.text.slice(0, 500) : null,
      extractedText: extract.text,
      category: null, // to be filled in classification step
      contentSha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
    });

    const flag =
      extract.status === "ready"
        ? `${textLen} chars`
        : `${extract.status}: ${extract.reason}`;
    console.log(`  ${rel}  [${flag}]`);
  }

  const manifest = {
    version: 1,
    scannedAt: new Date().toISOString(),
    projectId,
    rootFolder: absFolder,
    fileCount: entries.length,
    files: entries,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

  const ready = entries.filter((e) => e.textStatus === "ready").length;
  const skipped = entries.filter((e) => e.textStatus === "skipped").length;
  const failed = entries.filter((e) => e.textStatus === "failed").length;

  console.log("");
  console.log(`Manifest written to ${MANIFEST_PATH}`);
  console.log(`  ready: ${ready}, skipped: ${skipped}, failed: ${failed}`);
  console.log("");
  console.log("Next: classify each file by setting its 'category' field, then run:");
  console.log(`  node scripts/bulk-import.mjs apply --project-id ${projectId}`);
}

// ============ APPLY ============

async function runApply(args) {
  const projectId = args["project-id"];
  if (!projectId) {
    console.error("Usage: apply --project-id <uuid>");
    process.exit(1);
  }
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`No manifest at ${MANIFEST_PATH}. Run scan first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (manifest.projectId !== projectId) {
    console.error(`Manifest project (${manifest.projectId}) does not match --project-id (${projectId}).`);
    process.exit(1);
  }

  const unclassified = manifest.files.filter((f) => !f.category);
  if (unclassified.length > 0) {
    console.error(`${unclassified.length} file(s) missing 'category'. Fill them in before applying:`);
    for (const f of unclassified) console.error(`  ${f.relativePath}`);
    process.exit(1);
  }
  const bad = manifest.files.filter((f) => !VALID_CATEGORIES.has(f.category));
  if (bad.length > 0) {
    console.error(`${bad.length} file(s) have invalid category:`);
    for (const f of bad) console.error(`  ${f.relativePath} -> ${f.category}`);
    console.error(`Valid: ${[...VALID_CATEGORIES].join(", ")}`);
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Existing rows in this project, so we can dedupe.
  const { data: existing, error: existingError } = await supabase
    .from("project_documents")
    .select("file_name, size_bytes")
    .eq("project_id", projectId);
  if (existingError) {
    console.error(`Could not list existing documents: ${existingError.message}`);
    process.exit(1);
  }
  const existingKeys = new Set(
    (existing ?? []).map((d) => `${d.file_name}|${d.size_bytes}`),
  );

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of manifest.files) {
    const key = `${f.fileName}|${f.sizeBytes}`;
    if (existingKeys.has(key)) {
      console.log(`  SKIP (already imported): ${f.relativePath}`);
      skipped++;
      continue;
    }

    const documentId = crypto.randomUUID();
    const safeName = f.fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_");
    const storagePath = `${projectId}/${documentId}/${safeName}`;

    const fileBuf = readFileSync(f.absolutePath);
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuf, {
        contentType: f.mimeType,
        upsert: false,
      });
    if (uploadError) {
      console.error(`  FAIL upload: ${f.relativePath} - ${uploadError.message}`);
      failed++;
      continue;
    }

    const { error: insertError } = await supabase.from("project_documents").insert({
      id: documentId,
      project_id: projectId,
      file_name: f.fileName,
      storage_path: storagePath,
      mime_type: f.mimeType,
      size_bytes: f.sizeBytes,
      category: f.category,
      extracted_text: f.extractedText,
      text_status: f.textStatus,
      text_error: f.textReason,
      pages_count: f.pagesCount,
    });
    if (insertError) {
      console.error(`  FAIL insert: ${f.relativePath} - ${insertError.message}`);
      // Roll back the upload so we don't leave an orphan blob.
      await supabase.storage.from(BUCKET).remove([storagePath]);
      failed++;
      continue;
    }

    console.log(`  OK: ${f.relativePath} -> ${f.category} (${f.textStatus})`);
    uploaded++;
  }

  console.log("");
  console.log(`Done. uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`);
}

// ============ MAIN ============

const args = parseArgs(process.argv);
switch (args._cmd) {
  case "scan":
    await runScan(args);
    break;
  case "apply":
    await runApply(args);
    break;
  default:
    console.error("Usage:");
    console.error("  node scripts/bulk-import.mjs scan  --project-id <uuid> --folder <abs-path>");
    console.error("  node scripts/bulk-import.mjs apply --project-id <uuid>");
    process.exit(1);
}
