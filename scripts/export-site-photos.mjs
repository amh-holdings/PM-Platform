/**
 * Pull site photos out of the PM Platform and into the Drive mount, so they
 * can be used for social media.
 *
 *   node scripts/export-site-photos.mjs --project "Sweet Springs"
 *   node scripts/export-site-photos.mjs --project "Sweet Springs" --from 2026-09-01
 *   node scripts/export-site-photos.mjs --list
 *   node scripts/export-site-photos.mjs --project "Sweet Springs" --dry-run
 *
 * Where the photos actually are. `public.photos` is the table migration 0014
 * created for an in-DPR uploader and it has never held a row on any project.
 * The photos that exist belong to the two features people use:
 *
 *   inspection_photos    -> bucket `inspection-photos`, keyed to an inspection
 *   cm_daily_log_photos  -> bucket `dpr-photos`, keyed to a CM daily log
 *
 * `photos` is read anyway, so an in-DPR upload turns up if that uploader is
 * ever used. Same three sources, same `<source>:<id>` handles, as the weekly
 * report picker in src/lib/weekly-report-load.ts - a photo has one identity on
 * both the platform side and the content side.
 *
 * Read-only against the platform. Nothing is written back to Supabase.
 *
 * Files land here:
 *
 *   Site Pictures/<Project>/<YYYY-MM>/2026-09-14_cmlog_a3f2e1.jpg
 *   Site Pictures/<Project>/<YYYY-MM>/_rejected/...   (failed inspections)
 *   Site Pictures/<Project>/manifest.json
 *
 * Everything is pulled, nothing is withheld. Defect documentation is sorted
 * into _rejected so it is out of the way while browsing for a post, not to
 * hide it.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const DRIVE_ROOT =
  "/Users/amh_holdings/Library/CloudStorage/GoogleDrive-phil@amh.holdings" +
  "/Shared drives/AMH Holdings, LLC/A-02-MyCADBFF/2026/Social Media/Site Pictures";

// Drive for Desktop starts syncing the moment a file appears, so a file is
// finished in scratch and copied in whole. It never sees a half-written JPEG.
const SCRATCH = "/tmp/site-photos-scratch";

// Concurrent downloads. One storage call per file; a phone photo is 3-4MB.
const CONCURRENCY = 5;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const OPT = {
  project: arg("project"),
  from: arg("from"),
  to: arg("to"),
  list: flag("list"),
  dryRun: flag("dry-run"),
  force: flag("force"),
  dest: arg("dest", DRIVE_ROOT),
};

// ---------------------------------------------------------------- env

const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
}

// The service role key, not the anon key. RLS on both photo tables restricts
// reads to the phil/zarina/ahc_super roles, so an anon client sees zero rows
// and the script would report "no photos" on a site photographed daily.
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------- image hygiene

/**
 * Drop every EXIF/XMP/IPTC block from a JPEG.
 *
 * inspection_photos keeps GPS in its own columns, so the coordinates are not
 * lost by this - but the original file also carries them in EXIF, and that is
 * a published JPEG pinning the exact location of a client's site. APP0 (JFIF)
 * is kept because it is the density header, not metadata about the shot.
 *
 * Marker walk rather than a library: no new dependency, and a malformed file
 * falls through returning the original rather than corrupting it.
 */
function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return buf; // not a marker where one belongs, bail
    const marker = buf[i + 1];
    if (marker === 0xda) {
      // Start of scan. Everything from here is entropy-coded image data.
      out.push(buf.subarray(i));
      break;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return buf;
    // APP1..APP15 is EXIF, XMP, IPTC, Photoshop blocks. COM is a comment.
    const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMeta) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return Buffer.concat(out);
}

/** Drop PNG eXIf/tEXt/iTXt chunks, same reasoning as the JPEG walk. */
function stripPngMetadata(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return buf;
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return buf;
    if (!["eXIf", "tEXt", "iTXt", "zTXt"].includes(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

/**
 * Read the EXIF Orientation tag (0x0112) out of a JPEG.
 *
 * Phones almost never rotate the pixels. They store the sensor's landscape
 * frame and set this tag to say how to turn it. Sweet Springs photos come in
 * at orientation 6, meaning "rotate 90 clockwise to display".
 */
function readJpegOrientation(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return 1;
    const marker = buf[i + 1];
    if (marker === 0xda) return 1;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return 1;
    if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 10) === "Exif\0\0") {
      const tiff = i + 10;
      const le = buf.toString("ascii", tiff, tiff + 2) === "II";
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buf.length) return 1;
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const entry = ifd + 2 + e * 12;
        if (entry + 12 > buf.length) break;
        if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/**
 * Bake an EXIF orientation into the pixels.
 *
 * This has to happen BEFORE metadata is stripped, because stripping removes
 * the tag that was holding the image upright. Without this every portrait
 * phone photo lands in the library lying on its side, and nothing downstream
 * has any way to know it is wrong.
 */
function applyOrientation(buf, orientation, scratchPath) {
  const ops = {
    2: ["--flip", "horizontal"],
    3: ["--rotate", "180"],
    4: ["--flip", "vertical"],
    5: ["--rotate", "90", "--flip", "horizontal"],
    6: ["--rotate", "90"],
    7: ["--rotate", "270", "--flip", "horizontal"],
    8: ["--rotate", "270"],
  }[orientation];
  if (!ops) return buf;
  writeFileSync(scratchPath, buf);
  try {
    execFileSync("sips", [...ops, scratchPath], { stdio: "ignore" });
    return readFileSync(scratchPath);
  } catch {
    // Better an upright-but-unrotated original than no photo at all.
    return buf;
  }
}

const isHeic = (buf) =>
  buf.length > 12 &&
  buf.toString("ascii", 4, 8) === "ftyp" &&
  ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(buf.toString("ascii", 8, 12));

/**
 * The uploader accepts anything image/* up to 15MB. iOS Safari usually
 * converts HEIC to JPEG on upload, but not always, and a HEIC that reaches a
 * carousel renderer fails silently. `sips` ships with macOS, so this needs no
 * dependency either.
 */
function heicToJpeg(srcPath) {
  const outPath = `${srcPath}.jpg`;
  execFileSync("sips", ["-s", "format", "jpeg", srcPath, "--out", outPath], { stdio: "ignore" });
  return outPath;
}

// ---------------------------------------------------------------- helpers

const slug = (s) =>
  s.trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim();

const extOf = (path, buf) => {
  if (isHeic(buf)) return ".jpg"; // it will have been converted by then
  const m = /\.([a-z0-9]{3,4})$/i.exec(path);
  const e = m ? `.${m[1].toLowerCase()}` : "";
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(e) ? e : ".jpg";
};

const pool = async (items, n, worker) => {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
};

// ---------------------------------------------------------------- project

async function resolveProject(nameish) {
  const { data, error } = await sb.from("projects").select("id, name, status").order("name");
  if (error) throw new Error(`projects: ${error.message}`);
  if (OPT.list || !nameish) {
    console.log("\nProjects:\n");
    for (const p of data) console.log(`  ${p.name}${p.status ? `  (${p.status})` : ""}`);
    console.log("\nRun again with --project \"<name>\".\n");
    process.exit(0);
  }
  const needle = nameish.toLowerCase();
  const hit =
    data.find((p) => p.name.toLowerCase() === needle) ??
    data.find((p) => p.name.toLowerCase().includes(needle));
  if (!hit) throw new Error(`No project matching "${nameish}". Use --list to see them.`);
  return hit;
}

// ---------------------------------------------------------------- catalog

/**
 * Every photo on the project, from all three sources, merged.
 *
 * The date is the one real gotcha. inspection_photos carries its own taken_at;
 * cm_daily_log_photos has nothing but created_at, which is when somebody got
 * back to the trailer and uploaded, sometimes days after the shot. Its real
 * date is the parent log's log_date. Whichever field was used is recorded on
 * the row, so a photo dated by upload time is visibly less trustworthy than
 * one dated by the camera.
 */
async function buildCatalog(projectId) {
  const [inspRes, logRes, dprRes] = await Promise.all([
    sb
      .from("inspections")
      .select("id, title, status, decided_at, submitted_at, created_at")
      .eq("project_id", projectId),
    sb.from("cm_daily_logs").select("id, log_date").eq("project_id", projectId),
    sb.from("dprs").select("id, report_date").eq("project_id", projectId),
  ]);
  for (const [what, res] of [["inspections", inspRes], ["cm_daily_logs", logRes], ["dprs", dprRes]]) {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
  }

  const inspMeta = new Map(
    (inspRes.data ?? []).map((i) => [
      i.id,
      {
        title: i.title ?? "Inspection",
        status: i.status,
        day: (i.decided_at ?? i.submitted_at ?? i.created_at ?? "").slice(0, 10),
      },
    ]),
  );
  const logDay = new Map((logRes.data ?? []).map((l) => [l.id, l.log_date]));
  const dprDay = new Map((dprRes.data ?? []).map((d) => [d.id, d.report_date]));

  const ids = (m) => Array.from(m.keys()).filter(Boolean);
  const [inspPhotos, cmPhotos, dprPhotos] = await Promise.all([
    ids(inspMeta).length
      ? sb
          .from("inspection_photos")
          .select("id, inspection_id, side, caption, storage_path, taken_at, created_at, gps_lat, gps_lng")
          .in("inspection_id", ids(inspMeta))
      : { data: [] },
    ids(logDay).length
      ? sb
          .from("cm_daily_log_photos")
          .select("id, cm_daily_log_id, caption, storage_path, created_at")
          .in("cm_daily_log_id", ids(logDay))
      : { data: [] },
    ids(dprDay).length
      ? sb
          .from("photos")
          .select("id, dpr_id, caption, storage_path, taken_at, created_at")
          .in("dpr_id", ids(dprDay))
      : { data: [] },
  ]);

  const rows = [];

  for (const p of inspPhotos.data ?? []) {
    const meta = inspMeta.get(p.inspection_id);
    const own = (p.taken_at ?? "").slice(0, 10);
    rows.push({
      key: `insp:${p.id}`,
      day: own || meta?.day || (p.created_at ?? "").slice(0, 10),
      dayFrom: own ? "taken_at" : meta?.day ? "inspection" : "created_at",
      source: "insp",
      bucket: "inspection-photos",
      path: p.storage_path,
      caption: p.caption ?? null,
      // The side matters: an AHC photo is our own verification, a sub photo is
      // what they submitted for it.
      context: `${meta?.title ?? "Inspection"} (${p.side === "ahc" ? "AHC" : "sub"})`,
      side: p.side ?? null,
      // A rejected inspection's photos document a failure. Still pulled, but
      // parked in _rejected so they never turn up while browsing for a post.
      rejected: meta?.status === "rejected",
      gps: p.gps_lat != null && p.gps_lng != null ? { lat: Number(p.gps_lat), lng: Number(p.gps_lng) } : null,
    });
  }

  for (const p of cmPhotos.data ?? []) {
    const parent = logDay.get(p.cm_daily_log_id);
    rows.push({
      key: `cmlog:${p.id}`,
      day: parent ?? (p.created_at ?? "").slice(0, 10),
      dayFrom: parent ? "log_date" : "created_at",
      source: "cmlog",
      bucket: "dpr-photos",
      path: p.storage_path,
      caption: p.caption ?? null,
      context: "CM daily log",
      side: null,
      rejected: false,
      gps: null,
    });
  }

  for (const p of dprPhotos.data ?? []) {
    const own = (p.taken_at ?? "").slice(0, 10);
    rows.push({
      key: `dpr:${p.id}`,
      day: own || dprDay.get(p.dpr_id) || (p.created_at ?? "").slice(0, 10),
      dayFrom: own ? "taken_at" : dprDay.get(p.dpr_id) ? "report_date" : "created_at",
      source: "dpr",
      bucket: "dpr-photos",
      path: p.storage_path,
      caption: p.caption ?? null,
      context: "Field report",
      side: null,
      rejected: false,
      gps: null,
    });
  }

  return rows
    .filter((r) => r.day)
    .filter((r) => (OPT.from ? r.day >= OPT.from : true))
    .filter((r) => (OPT.to ? r.day <= OPT.to : true))
    .sort((a, b) => (a.day === b.day ? a.key.localeCompare(b.key) : a.day < b.day ? -1 : 1));
}

// ---------------------------------------------------------------- manifest

/**
 * The manifest is the part worth keeping. Lose the JPEGs and they re-pull in a
 * minute; lose this and the curation is gone - what exists, what it shows, and
 * which shots have already been published.
 */
function loadManifest(file) {
  if (!existsSync(file)) return { project: null, updated: null, photos: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A half-synced manifest should not take the run down with it.
    const backup = `${file}.corrupt-${Date.now()}`;
    copyFileSync(file, backup);
    console.warn(`  ! manifest unreadable, kept a copy at ${backup} and starting fresh`);
    return { project: null, updated: null, photos: {} };
  }
}

// ---------------------------------------------------------------- run

/**
 * Delete files the manifest no longer points at.
 *
 * A --force re-pull that newly recognises a photo as a duplicate leaves the
 * previous copy in the folder under its own name, where it looks like a
 * separate shot. Only files matching this script's own naming are removed, so
 * anything dropped in by hand stays put.
 */
function pruneOrphans(destRoot, manifest) {
  const referenced = new Set(Object.values(manifest.photos).map((p) => p.file));
  const OURS = /^\d{4}-\d{2}-\d{2}_(cmlog|insp|dpr)_[0-9a-f]{6}\.[a-z]+$/;
  let pruned = 0;
  for (const monthDir of readdirSync(destRoot, { withFileTypes: true })) {
    if (!monthDir.isDirectory()) continue;
    for (const sub of [monthDir.name, join(monthDir.name, "_rejected")]) {
      const abs = join(destRoot, sub);
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs)) {
        if (!OURS.test(f) || referenced.has(join(sub, f))) continue;
        rmSync(join(abs, f), { force: true });
        pruned += 1;
      }
    }
  }
  return pruned;
}

async function main() {
  const project = await resolveProject(OPT.project);
  const destRoot = join(OPT.dest, slug(project.name));

  if (!existsSync(OPT.dest)) {
    throw new Error(
      `Destination not found:\n  ${OPT.dest}\n` +
        `If that is the Drive mount, check Drive for Desktop is running.`,
    );
  }

  console.log(`\nProject   ${project.name}`);
  console.log(`Window    ${OPT.from ?? "(start)"} to ${OPT.to ?? "(today)"}`);
  console.log(`Dest      ${destRoot}`);

  const catalog = await buildCatalog(project.id);
  console.log(`\nCatalog   ${catalog.length} photos on the platform`);
  if (!catalog.length) {
    console.log("Nothing to do.\n");
    return;
  }

  const manifestFile = join(destRoot, "manifest.json");
  mkdirSync(destRoot, { recursive: true });
  const manifest = loadManifest(manifestFile);
  manifest.project = project.name;
  manifest.projectId = project.id;

  // Already on disk and recorded, so skip. A re-run over an overlapping window
  // costs nothing.
  const todo = catalog.filter((r) => {
    const prior = manifest.photos[r.key];
    if (OPT.force || !prior?.file) return true;
    return !existsSync(join(destRoot, prior.file));
  });
  console.log(`Already   ${catalog.length - todo.length} present`);
  console.log(`To pull   ${todo.length}\n`);

  if (OPT.dryRun) {
    for (const r of todo.slice(0, 40)) {
      console.log(`  ${r.day}  ${r.rejected ? "[rejected] " : ""}${r.context}${r.caption ? ` - ${r.caption}` : ""}`);
    }
    if (todo.length > 40) console.log(`  ... and ${todo.length - 40} more`);
    console.log("\nDry run, nothing written.\n");
    return;
  }

  if (!todo.length) {
    const orphans = pruneOrphans(destRoot, manifest);
    manifest.updated = new Date().toISOString();
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(orphans ? `Up to date. Pruned ${orphans} orphaned files.\n` : "Up to date.\n");
    return;
  }

  mkdirSync(SCRATCH, { recursive: true });
  let done = 0;
  let failed = 0;
  let duped = 0;

  // The same shot reaches the platform twice often enough to matter: a photo
  // attached to both a CM log and the inspection that verifies it, or a sub
  // re-uploading after a failed submit. A 6-photo sample from 2026-08-04 held
  // one byte-identical pair. Content hash rather than filename, because the
  // storage path carries a fresh uuid every upload.
  const byHash = new Map();
  for (const [key, p] of Object.entries(manifest.photos)) {
    if (p.sha1 && p.file && !p.duplicateOf) byHash.set(p.sha1, { key, file: p.file });
  }

  await pool(todo, CONCURRENCY, async (row) => {
    try {
      // .download() and not createSignedUrls(): signed URLs expire in an hour,
      // which is fine for rendering a page and useless for a photo library.
      const { data: blob, error } = await sb.storage.from(row.bucket).download(row.path);
      if (error || !blob) throw new Error(error?.message ?? "empty body");

      let buf = Buffer.from(await blob.arrayBuffer());
      const scratchFile = join(SCRATCH, `${row.key.replace(":", "_")}.bin`);

      if (isHeic(buf)) {
        writeFileSync(scratchFile, buf);
        const jpg = heicToJpeg(scratchFile);
        buf = readFileSync(jpg);
        rmSync(jpg, { force: true });
      }

      // Order matters: rotate the pixels while the tag that describes the
      // rotation is still there, then strip.
      const orientation = readJpegOrientation(buf);
      if (orientation !== 1) buf = applyOrientation(buf, orientation, scratchFile);

      buf = buf[0] === 0x89 ? stripPngMetadata(buf) : stripJpegMetadata(buf);
      writeFileSync(scratchFile, buf);

      // No await between the lookup and the set, so concurrent workers holding
      // the same bytes cannot both decide they are the original.
      const sha1 = createHash("sha1").update(buf).digest("hex");
      // A photo is never its own twin. On a --force re-pull the map is seeded
      // from the previous manifest, so an unchanged file matches the hash it
      // recorded last time - which is its own. Without this guard every such
      // photo is filed as a duplicate of itself.
      const candidate = byHash.get(sha1);
      const twin = candidate && candidate.key !== row.key ? candidate : null;
      if (candidate && candidate.key === row.key) byHash.delete(sha1);

      const month = row.day.slice(0, 7);
      const shortId = row.key.split(":")[1].replace(/-/g, "").slice(0, 6);
      const name = `${row.day}_${row.source}_${shortId}${extOf(row.path, buf)}`;
      const relDir = row.rejected ? join(month, "_rejected") : month;

      if (twin) {
        // Recorded, not written. The row stays in the manifest because it is a
        // real platform record worth knowing about, it just points at the copy
        // already on disk instead of adding a second one.
        rmSync(scratchFile, { force: true });
        duped += 1;
      } else {
        byHash.set(sha1, { key: row.key, file: join(relDir, name) });
        mkdirSync(join(destRoot, relDir), { recursive: true });
        copyFileSync(scratchFile, join(destRoot, relDir, name));
        rmSync(scratchFile, { force: true });
      }

      manifest.photos[row.key] = {
        file: twin ? twin.file : join(relDir, name),
        sha1,
        duplicateOf: twin ? twin.key : null,
        day: row.day,
        dayFrom: row.dayFrom,
        source: row.source,
        context: row.context,
        caption: row.caption,
        side: row.side,
        rejected: row.rejected,
        gps: row.gps,
        bytes: buf.length,
        storagePath: row.path,
        bucket: row.bucket,
        pulledAt: new Date().toISOString(),
        // Stamped when a photo ships in a post, so the next review pass can
        // leave it out.
        usedIn: manifest.photos[row.key]?.usedIn ?? [],
      };

      done += 1;
      if (done % 10 === 0) console.log(`  ${done}/${todo.length}`);
    } catch (e) {
      failed += 1;
      console.warn(`  ! ${row.key} (${row.day}): ${e.message}`);
    }
  });

  manifest.updated = new Date().toISOString();
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const pruned = pruneOrphans(destRoot, manifest);

  const all = Object.values(manifest.photos);
  const onDisk = all.filter((p) => !p.duplicateOf);
  const bytes = onDisk.reduce((n, p) => n + (p.bytes ?? 0), 0);
  const rejected = onDisk.filter((p) => p.rejected).length;

  console.log(`\nPulled    ${done}${failed ? `, ${failed} failed` : ""}`);
  console.log(`Library   ${onDisk.length} files, ${(bytes / 1e9).toFixed(2)} GB`);
  console.log(`Records   ${all.length} platform photos${duped ? `, ${duped} were duplicate uploads` : ""}`);
  console.log(`Rejected  ${rejected} parked in _rejected/`);
  if (pruned) console.log(`Pruned    ${pruned} orphaned files no longer in the manifest`);
  console.log(`Manifest  ${manifestFile}`);
  console.log(
    `\nDrive for Desktop syncs these in the background. A first backfill is` +
      `\nseveral GB, so leave the Mac awake and online until it settles.\n`,
  );

  try {
    if (statSync(SCRATCH).isDirectory()) rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* scratch already gone */
  }
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
