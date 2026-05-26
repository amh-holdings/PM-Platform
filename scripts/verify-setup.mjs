// Quick sanity check before bulk import:
//   - project_documents table exists and is queryable with service-role
//   - project-documents storage bucket exists
//   - Phil's profile role is one of phil/zarina/ahc_super
//   - Sweet Springs project exists and we know its UUID
//
// Run from pm-platform/ with: node scripts/verify-setup.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

let allGood = true;

console.log("Checking project_documents table...");
const { error: tableError, count } = await supabase
  .from("project_documents")
  .select("*", { count: "exact", head: true });
if (tableError) {
  console.error(`  FAIL: ${tableError.message}`);
  allGood = false;
} else {
  console.log(`  OK (current row count: ${count ?? 0})`);
}

console.log("Checking project-documents storage bucket...");
const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
if (bucketError) {
  console.error(`  FAIL: ${bucketError.message}`);
  allGood = false;
} else {
  const bucket = buckets.find((b) => b.name === "project-documents");
  if (!bucket) {
    console.error("  FAIL: bucket 'project-documents' not found");
    console.error(`  Available buckets: ${buckets.map((b) => b.name).join(", ") || "(none)"}`);
    allGood = false;
  } else {
    console.log(`  OK (public: ${bucket.public}, file_size_limit: ${bucket.file_size_limit ?? "unlimited"})`);
  }
}

console.log("Checking your profile role...");
const { data: profiles, error: profileError } = await supabase
  .from("profiles")
  .select("id, email, role")
  .in("role", ["phil", "zarina", "ahc_super"]);
if (profileError) {
  console.error(`  FAIL: ${profileError.message}`);
  allGood = false;
} else if (profiles.length === 0) {
  console.error("  FAIL: no profiles have phil/zarina/ahc_super role - documents UI will be empty for everyone");
  allGood = false;
} else {
  console.log(`  OK (${profiles.length} AHC-tier profile(s)):`);
  for (const p of profiles) {
    console.log(`    - ${p.email} (${p.role})`);
  }
}

console.log("Looking for Sweet Springs project...");
const { data: projects, error: projError } = await supabase
  .from("projects")
  .select("id, name, client")
  .ilike("name", "%sweet%");
if (projError) {
  console.error(`  FAIL: ${projError.message}`);
  allGood = false;
} else if (projects.length === 0) {
  console.error("  FAIL: no project name contains 'sweet' - create it in the UI first");
  allGood = false;
} else {
  console.log(`  OK (${projects.length} match${projects.length === 1 ? "" : "es"}):`);
  for (const p of projects) {
    console.log(`    - ${p.id}  ${p.name} (${p.client ?? "no client set"})`);
  }
}

console.log("");
if (allGood) {
  console.log("All checks passed. Ready to build/run the bulk import.");
} else {
  console.log("One or more checks failed. Fix above before bulk import.");
  process.exit(1);
}
