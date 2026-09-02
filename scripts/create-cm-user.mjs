// create-cm-user.mjs
//
// Provision a Construction Manager login for the PM Platform. Sibling of
// create-sub-user.mjs, which deliberately refuses to mint anything but sub
// roles; this is the tool for the AHC side.
//
// Why this is more than "make a user": Supabase's on_auth_user_created trigger
// auto-creates a profiles row with ONLY (id, email), so role defaults to
// 'sub_foreman'. A CM who signs up untouched lands in the subcontractor view
// -- field reports only, no schedule, no subs, no procurement -- and every
// AHC-side RLS policy (`current_user_role() in ('phil','zarina','ahc_super')`)
// locks them out. This script sets the role so that doesn't happen.
//
// Unlike a sub, a CM needs NO subcontractor_id: ahc_super RLS is global, not
// scoped through subcontractors.project_id, so one CM login sees every
// project. We null the link out explicitly in case the account was previously
// a sub.
//
// Usage:
//   node scripts/create-cm-user.mjs \
//     --email mark@example.com \
//     --name "Mark Wooley" \
//     [--phone "555-123-4567"] \
//     [--role ahc_super|zarina]     (default: ahc_super) \
//     [--password "PlainPassword"]  (omit to auto-generate) \
//     [--url https://your-app-domain]  (for the printed login link)
//
// ahc_super vs zarina: both collapse to the "cm" effective role in the UI
// (src/lib/roles.ts) and both get the same RLS reach. The difference is the
// QA/QC decision gate -- isInspectionApprover() in src/lib/inspection-status.ts
// admits ahc_super (and phil), not zarina. Use ahc_super for a CM who approves
// inspections; use zarina for AHC staff who should review but not decide.
//
// The account is created with email_confirm:true, so they can log in with the
// password immediately -- no magic-link email round-trip needed on flaky site
// wifi. Re-running for an existing email just resets the password and re-applies
// the role (idempotent), so it's safe to run twice.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ENV_PATH = "/Users/amh_holdings/Documents/AMH Claude/pm-platform/.env.local";
const ALLOWED_ROLES = new Set(["ahc_super", "zarina"]); // this tool only mints CM-side logins

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
  fail('Missing/invalid --email. Example: --email mark@example.com');
}
const fullName = (args.name || "").trim() || null;
const phone = (args.phone || "").trim() || null;
const role = (args.role || "ahc_super").trim();
if (!ALLOWED_ROLES.has(role)) {
  fail(`--role must be one of: ${[...ALLOWED_ROLES].join(", ")} (use create-sub-user.mjs for sub logins).`);
}
const password = (args.password && String(args.password).trim()) || generatePassword();
const loginUrl = ((args.url && String(args.url).trim()) || "").replace(/\/$/, "");

const env = loadEnvLocal();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`\nProvisioning Construction Manager login`);
console.log(`  email : ${email}`);
console.log(`  name  : ${fullName ?? "(none)"}`);
console.log(`  role  : ${role}`);

// --- Who else already holds this role? ---
// The QA/QC gate is role-based by default, so a second ahc_super silently
// becomes a second person who can approve/reject inspections. Surface that
// rather than letting it be a surprise.
const { data: peers } = await sb
  .from("profiles")
  .select("id, email, full_name, role")
  .eq("role", role);
const otherPeers = (peers ?? []).filter((p) => p.email?.toLowerCase() !== email);
if (otherPeers.length) {
  console.log(`\n  Existing ${role} accounts:`);
  for (const p of otherPeers) {
    console.log(`    ${p.email}${p.full_name ? `  (${p.full_name})` : ""}`);
  }
}

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
  console.log(`\n↻ Existing auth user found — password reset and role re-applied.`);
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

// --- Ensure the profile row carries the CM role and no sub link ---
// The on_auth_user_created trigger inserts (id, email) with role defaulting to
// 'sub_foreman'; we upsert to correct it. onConflict:id makes this safe whether
// the trigger already ran or not. subcontractor_id is forced to null so a
// converted sub account doesn't keep a stale company link.
const { error: upErr } = await sb
  .from("profiles")
  .upsert(
    {
      id: authUser.id,
      email,
      full_name: fullName,
      phone,
      role,
      subcontractor_id: null,
      active: true,
    },
    { onConflict: "id" }
  );
if (upErr) fail(`Failed to write profile (role): ${upErr.message}`);

// --- Verify what actually landed ---
const { data: check, error: checkErr } = await sb
  .from("profiles")
  .select("email, full_name, role, subcontractor_id, active")
  .eq("id", authUser.id)
  .maybeSingle();
if (checkErr || !check) fail(`Could not verify profile after write: ${checkErr?.message ?? "not found"}`);
if (check.role !== role) {
  fail(`Verification failed: role is ${check.role}, expected ${role}.`);
}

const loginLine = loginUrl ? `${loginUrl}/login` : "<your app URL>/login";

console.log(`\n${"=".repeat(56)}`);
console.log(`  ✓ ${created ? "CREATED" : "UPDATED"} — hand these credentials to the CM`);
console.log(`${"=".repeat(56)}`);
console.log(`  Login page : ${loginLine}`);
console.log(`  Email      : ${email}`);
console.log(`  Password   : ${password}`);
console.log(`  Role       : ${check.role}`);
console.log(`  Profile id : ${authUser.id}`);
console.log(`${"=".repeat(56)}`);
console.log(`  They sign in with "password" mode (not magic link).`);
console.log(`  Email is pre-confirmed, so it works immediately — no email needed.`);
console.log(`  Sees: dashboard, field reports, schedule, subs, procurement, docs.`);
console.log(`  Hidden: billing, change orders, costs/margin, pay apps.`);
if (role === "ahc_super") {
  console.log(`  This account CAN approve/reject QA/QC inspections.`);
  console.log(`  To pin that gate to one person, set INSPECTION_APPROVER_PROFILE_ID`);
  console.log(`  in src/lib/inspection-status.ts to the profile id above.`);
}
console.log(`${"=".repeat(56)}\n`);
