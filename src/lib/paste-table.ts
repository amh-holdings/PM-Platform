// Shared helpers for reading a block of spreadsheet text pasted into the app.
//
// Both the change-order buildup and the subcontract SOV arrive the same way:
// someone copies a range out of Excel and pastes it in. The cell splitting and
// money parsing are identical in both places, so they live here rather than
// being re-derived per feature and drifting apart.

/** Strips $ , % and whitespace, and reads (123.45) as negative. */
export function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[()$,%\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function splitRow(row: string): string[] {
  // Excel and Sheets both put tabs between cells on copy, so tabs win when
  // present. Falling back to commas would split "Racking, delivered" in two.
  if (row.includes("\t")) return row.split("\t").map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
