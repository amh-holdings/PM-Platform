/**
 * Every file holding a Tailwind class must be somewhere Tailwind looks.
 *
 * Tailwind generates CSS only for class names it finds by scanning the globs
 * in tailwind.config. A class that lives outside them compiles, type-checks,
 * passes its unit tests, builds without a warning, ships, and colours nothing.
 *
 * That is exactly what happened to the Complete row tint. statusRowTone moved
 * into src/lib, which was not scanned, so bg-emerald-50/70 was never generated
 * and Zarina got "No color for the complete items still" on a change with 600
 * passing tests behind it. Nothing in the toolchain says a word.
 *
 * So this is the check that does. It fails the moment a Tailwind class appears
 * in a source file no glob covers.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// Tight on purpose. A loose pattern would flag ordinary prose and get muted,
// which is how a check stops being read.
const CLASS_PATTERNS = [
  /\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d{1,3})?\b/,
  /\b(?:bg|text|border|ring|fill|stroke|divide|outline)-(?:destructive|primary|secondary|muted|accent|card|popover|foreground|background|input|border)(?:-foreground)?(?:\/\d{1,3})?\b/,
];

function contentGlobs(): string[] {
  const config = readFileSync(join(ROOT, "tailwind.config.ts"), "utf8");
  const block = config.match(/content:\s*\[([\s\S]*?)\]/);
  if (!block) {
    console.error("Could not find the content array in tailwind.config.ts");
    process.exit(1);
  }
  return Array.from(block[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}

/** "./src/lib/**\/*.{ts,tsx}" -> "src/lib". Only the directory matters here. */
function globRoot(glob: string): string {
  return glob.replace(/^\.\//, "").split("/**")[0].replace(/\/$/, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mdx)$/.test(full)) out.push(full);
  }
  return out;
}

const covered = contentGlobs().map(globRoot);
const offenders: { file: string; sample: string }[] = [];

for (const file of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (covered.some((root) => rel === root || rel.startsWith(`${root}/`))) continue;

  const source = readFileSync(file, "utf8");
  for (const pattern of CLASS_PATTERNS) {
    const hit = source.match(pattern);
    if (hit) {
      offenders.push({ file: rel, sample: hit[0] });
      break;
    }
  }
}

console.log(`Tailwind content globs: ${covered.join(", ")}`);
console.log(`Scanned src/ for class names living outside them.\n`);

if (offenders.length) {
  console.log(`  FAIL  ${offenders.length} file(s) hold Tailwind classes Tailwind never sees:`);
  for (const o of offenders) {
    console.log(`        ${o.file} - e.g. ${o.sample}`);
  }
  console.log(`\n  Add the directory to content[] in tailwind.config.ts, or move`);
  console.log(`  the class strings into a file that is already scanned.`);
  console.log("=".repeat(60));
  process.exit(1);
}

console.log("  PASS  every Tailwind class in src/ is somewhere Tailwind scans");
console.log("=".repeat(60));
