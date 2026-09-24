/**
 * No money field goes back to a bare number box.
 *
 * Zarina: "Can you make sure that every amounts have commas?" Fixing the ones
 * that existed took one pass. Keeping them fixed takes this, because the next
 * amount field somebody adds will reach for <Input> like every other field on
 * the form and nothing on screen will say it is wrong until the number is six
 * figures and somebody misreads it.
 *
 * Run: npx tsx scripts/ui/check-money-inputs.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Field names that hold dollars. Percentages and counts are not money. */
const MONEY_NAMES = [
  "contract_value",
  "total_value",
  "scheduled_value",
  "estimated_cost",
  "actual_cost",
  "paid_amount",
  "unit_cost",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const offenders: { file: string; field: string; snippet: string }[] = [];

for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  if (!/<[Ii]nput\b/.test(src)) continue;

  // Every self-closing input element in the file.
  const blocks = src.match(/<[Ii]nput\b[\s\S]*?\/>/g) ?? [];
  for (const block of blocks) {
    if (/type="hidden"/.test(block)) continue;
    const name = block.match(/name="([a-z_]+)"/)?.[1];
    if (!name || !MONEY_NAMES.includes(name)) continue;
    offenders.push({
      file,
      field: name,
      snippet: block.split("\n")[0].trim(),
    });
  }
}

console.log("Money fields must use <MoneyInput>, not <Input>.");
console.log(`Checked src/ for: ${MONEY_NAMES.join(", ")}\n`);

if (offenders.length === 0) {
  console.log("  PASS  every money field is a MoneyInput");
  console.log("=".repeat(60));
  process.exit(0);
}

console.log(`  FAIL  ${offenders.length} money field(s) on a plain input\n`);
for (const o of offenders) {
  console.log(`  ${o.file}`);
  console.log(`    ${o.field}  ${o.snippet}`);
}
console.log(
  "\nUse <MoneyInput name=\"...\"> from @/components/ui/money-input. It groups\n" +
    "thousands on screen and posts the raw number through a hidden field, so\n" +
    "the server action reading that name does not change.",
);
console.log("=".repeat(60));
process.exit(1);
