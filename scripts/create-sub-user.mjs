// create-sub-user.mjs
//
// Provision a subcontractor login for the PM Platform and link it to the right
// company so RLS lets them actually see their project. Designed for on-site
// onboarding: one command, credentials printed at the end, hand them over.
//
// Why this is more than "make a user": Supabase's on_auth_user_created trigger
// auto-creates a profiles row with ONLY (id, email) -> role defaults to
// 'sub_foreman' and subcontractor_id is NULL. With a NULL subcontractor_id the
// contractor logs in and sees NOTHING (empty project list + empty WBS/sub
// dropdowns) because every sub RLS policy scopes through
// profiles.subcontractor_id -> subcontractors.project_id (see db/migrations/
// 0029_sub_read_schedule_and_subs.sql). This script sets the role AND the link.
//
// Usage:
//   node scripts/create-sub-user.mjs \
//     --email person@company.com \
//     --name "First Last" \
//     [--phone "555-123-4567"] \
//     [--role sub_pm|sub_foreman]   (default: sub_foreman) \
//     --sub-id <subcontractor uuid>                        \
//       OR  --company "Pyramid Excavation LLC" --project <project uuid> \
//     [--password "PlainPassword"]  (omit to auto-generate) \
//     [--url https://your-app-domain]  (for the printed login link)
//
// The account is created with email_confirm:true, so they can log in with the
// password immediately -- no magic-link email round-trip needed on flaky site
// wifi. Re-running for an existing email just resets the password + re-links
// (idempotent), so it's safe to run twice.
//
// Sweet Springs Solar quick reference:
//   project id            53cff193-21e4-45ff-833d-43813e8578a0
//   Pyramid Excavation    --sub-id 74d77172-618e-478a-b0ec-8d756c786189

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ENV_PATH = "/Users/amh_holdings/Documents/AMH Claude/pm-platform/.env.local";
const ALLOWED_ROLES = new Set(["sub_pm", "sub_foreman"]); // this tool only mints sub logins

function loadEnvLocal() {
  const raw = readFileSync(ENV_PATH, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return env;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// Readable-but-strong password: no ambiguous chars, easy to read off a screen.
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(14);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}

async function findAuthUserByEmail(sb, email) {
  const target = email.toLowerCase();
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (!data?.users?.length || data.users.length < 200) return null;
    page++;
  }
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const email = (args.email || "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  fail('Missing/invalid --email. Example: --email foreman@pyramid-excavation.com');
}
const fullName = (args.name || "").trim() || null;
const phone = (args.phone || "").trim() || null;
const role = (args.role || "sub_foreman").trim();
if (!ALLOWED_ROLES.has(role)) {
  fail(`--role must be one of: ${[...ALLOWED_ROLES].join(", ")} (this tool only creates sub logins).`);
}
const password = (args.password && String(args.password).trim()) || generatePassword();
const loginUrl = ((args.url && String(args.url).trim()) || "").replace(/\/$/, "");

const env = loadEnvLocal();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- Resolve the subcontractor company row (this is the load-bearing part) ---
let sub;
if (args["sub-id"]) {
  const { data, error } = await sb
    .from("subcontractors")
    .select("id, company_name, project_id, active")
    .eq("id", args["sub-id"])
    .maybeSingle();
  if (error) fail(`Lookup by --sub-id failed: ${error.message}`);
  if (!data) fail(`No subcontractor found with id ${args["sub-id"]}`);
  sub = data;
} else if (args.company && args.project) {
  const { data, error } = await sb
    .from("subcontractors")
    .select("id, company_name, project_id, active")
    .eq("project_id", args.project)
    .ilike("company_name", `%${args.company}%`);
  if (error) fail(`Lookup by --company failed: ${error.message}`);
  if (!data?.length) fail(`No subcontractor matching "${args.company}" on project ${args.project}.`);
  if (data.length > 1) {
    fail(
      `"${args.company}" matched ${data.length} rows on that project. Re-run with --sub-id:\n` +
        data.map((r) => `    ${r.id}  ${r.company_name}`).join("\n")
    );
  }
  sub = data[0];
} else {
  fail("Tell me which company to link: --sub-id <uuid>  OR  --company \"Name\" --project <uuid>");
}

if (sub.active === false) {
  console.warn(`⚠ Warning: ${sub.company_name} is marked inactive. Continuing anyway.`);
}

console.log(`\nLinking login to: ${sub.company_name}`);
console.log(`  subcontractor_id : ${sub.id}`);
console.log(`  project_id       : ${sub.project_id}`);
console.log(`  role             : ${role}`);
console.log(`  email            : ${email}`);

// --- Create or reuse the auth user ---
let authUser = await findAuthUserByEmail(sb, email);
let created = false;
if (authUser) {
  const { error } = await sb.auth.admin.updateUserById(authUser.id, {
    password,
    email_confirm: true,
    user_metadata: { ...(authUser.user_metadata || {}), full_name: fullName || authUser.user_metadata?.full_name },
  });
  if (error) fail(`Failed to reset existing user's password: ${error.message}`);
  console.log(`\n↻ Existing auth user found — password reset and re-linked.`);
} else {
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (error) fail(`createUser failed: ${error.message}`);
  authUser = data.user;
  created = true;
  console.log(`\n＋ Auth user created.`);
}

// --- Ensure the profile row has role + subcontractor link (the RLS gate) ---
// The on_auth_user_created trigger inserts (id, email); we upsert to set the
// rest. onConflict:id makes this safe whether the trigger already ran or not.
const { error: upErr } = await sb
  .from("profiles")
  .upsert(
    {
      id: authUser.id,
      email,
      full_name: fullName,
      phone,
      role,
      subcontractor_id: sub.id,
      active: true,
    },
    { onConflict: "id" }
  );
if (upErr) fail(`Failed to write profile (role/link): ${upErr.message}`);

// --- Verify what actually landed ---
const { data: check, error: checkErr } = await sb
  .from("profiles")
  .select("email, full_name, role, subcontractor_id, active")
  .eq("id", authUser.id)
  .maybeSingle();
if (checkErr || !check) fail(`Could not verify profile after write: ${checkErr?.message ?? "not found"}`);
if (check.subcontractor_id !== sub.id) {
  fail(`Verification failed: subcontractor_id is ${check.subcontractor_id}, expected ${sub.id}.`);
}

const loginLine = loginUrl ? `${loginUrl}/login` : "<your app URL>/login";

console.log(`\n${"=".repeat(56)}`);
console.log(`  ✓ ${created ? "CREATED" : "UPDATED"} — hand these credentials to the contractor`);
console.log(`${"=".repeat(56)}`);
console.log(`  Login page : ${loginLine}`);
console.log(`  Email      : ${email}`);
console.log(`  Password   : ${password}`);
console.log(`  Role       : ${check.role}`);
console.log(`  Company    : ${sub.company_name}`);
console.log(`${"=".repeat(56)}`);
console.log(`  They sign in with "password" mode (not magic link).`);
console.log(`  Email is pre-confirmed, so it works immediately — no email needed.`);
console.log(`${"=".repeat(56)}\n`);
