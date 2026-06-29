// Creates the private `inspection-photos` storage bucket on the hosted
// Supabase project using the service-role key. Idempotent: a no-op if the
// bucket already exists. Run: node scripts/qaqc/create-bucket.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "inspection-photos";

const { data: existing } = await sb.storage.getBucket(BUCKET);
if (existing) {
  console.log(`Bucket "${BUCKET}" already exists (public=${existing.public}).`);
  process.exit(0);
}

const { error } = await sb.storage.createBucket(BUCKET, {
  public: false,
  fileSizeLimit: "25MB",
});
if (error) {
  console.error("Failed to create bucket:", error.message);
  process.exit(1);
}
console.log(`Created private bucket "${BUCKET}".`);
