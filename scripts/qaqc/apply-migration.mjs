// Applies a SQL migration file to the hosted Supabase project via the
// Management API (runs as the database owner). No secrets are stored here:
// the access token and project ref come from the environment.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=xxxx \
//     node scripts/qaqc/apply-migration.mjs db/migrations/0021_qaqc_inspections.sql
import { readFileSync } from "node:fs";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const file = process.argv[2];
if (!token || !ref || !file) {
  console.error("Need SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF env and a file arg.");
  process.exit(1);
}

const query = readFileSync(file, "utf8");
const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  },
);
const text = await res.text();
if (!res.ok) {
  console.error(`Apply failed (HTTP ${res.status}):`, text);
  process.exit(1);
}
console.log(`Applied ${file} OK. Response:`, text.slice(0, 300));
