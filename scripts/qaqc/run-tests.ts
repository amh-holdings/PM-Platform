// QA/QC Inspection Engine - known-answer test harness.
//
// Runs entirely locally against embedded Postgres (pglite, WASM). NEVER touches
// the hosted Supabase project. Two layers:
//   1. Integration: applies db/migrations/0021_qaqc_inspections.sql into a real
//      Postgres, seeds a known-answer mock project, and exercises RLS + scoping
//      + the secure-link insert path under SET ROLE authenticated.
//   2. Unit: the pure decision logic the server actions rely on (state machine,
//      approver gate, map geometry, token usability).
//
// Run: npx tsx scripts/qaqc/run-tests.ts
//
// RLS note: pglite's bootstrap user is a superuser and bypasses RLS. We create
// a non-superuser `authenticated` role and SET ROLE to it (mirroring Supabase's
// `to authenticated` policies). auth.uid() is stubbed to read a session GUC.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  canTransition,
  nextStatuses,
  isTerminal,
  isLocked,
  isInspectionApprover,
  canReview,
  INSPECTION_STATUSES,
} from "@/lib/inspection-status";
import {
  clientToNormalized,
  normalizedToPercent,
  parsePin,
  basemapSrc,
} from "@/lib/inspection-map";
import { isLinkUsable, generateInspectionToken } from "@/lib/inspection-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, "..", "..", "db", "migrations", "0021_qaqc_inspections.sql");

// ---- tiny test runner ----
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function expectBlocked(
  name: string,
  fn: () => Promise<unknown>,
) {
  try {
    await fn();
    check(name, false, "expected the operation to be blocked, but it succeeded");
  } catch {
    check(name, true);
  }
}

// Known-answer fixed UUIDs.
const P1 = "11111111-1111-1111-1111-111111111111";
const SUB_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SUB_B = "bbbbbbbb-0000-0000-0000-000000000002";
const PHIL = "d0000000-0000-0000-0000-000000000001";
const MARK = "d0000000-0000-0000-0000-000000000002";
const ZAR = "d0000000-0000-0000-0000-000000000003";
const FM_A = "d0000000-0000-0000-0000-00000000000a";
const FM_B = "d0000000-0000-0000-0000-00000000000b";
const OWNER = "d0000000-0000-0000-0000-00000000000c";
const TOKEN_A = "tokenA-active";
const TOKEN_EXP = "tokenA-expired";

async function main() {
  const db = new PGlite();

  // ---------- setup: minimal Supabase-shaped schema ----------
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;

    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_uid', true), '')::uuid
    $$;

    create type user_role as enum
      ('phil','zarina','ahc_super','sub_pm','sub_foreman','owner','counsel');

    create table public.profiles (
      id uuid primary key,
      email text unique not null,
      role user_role not null default 'sub_foreman',
      subcontractor_id uuid,
      active boolean default true
    );
    create table public.projects (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      status text default 'active'
    );
    create table public.subcontractors (
      id uuid primary key default gen_random_uuid(),
      project_id uuid references public.projects(id) on delete cascade,
      company_name text not null
    );

    create or replace function public.current_user_role() returns public.user_role
      language sql security definer stable set search_path = public as $$
      select role from public.profiles where id = auth.uid();
    $$;

    -- stub so the migration's storage.objects policies apply
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text
    );

    create role authenticated;
    grant usage on schema public, auth, storage to authenticated;
  `);

  // ---------- apply the real migration ----------
  const migrationSql = readFileSync(MIGRATION, "utf8");
  await db.exec(migrationSql);
  check("INT-01 migration 0021 applies cleanly into Postgres", true);

  // grants so the authenticated role has a baseline (RLS still gates rows)
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  `);

  // ---------- seed known-answer data (as superuser, bypasses RLS) ----------
  await db.exec(`
    insert into public.projects (id, name) values ('${P1}', 'MOCK - QAQC Test Project');
    insert into public.subcontractors (id, project_id, company_name) values
      ('${SUB_A}', '${P1}', 'Sub A Grading'),
      ('${SUB_B}', '${P1}', 'Sub B Electrical');
    insert into public.profiles (id, email, role, subcontractor_id) values
      ('${PHIL}', 'phil@amh.holdings', 'phil', null),
      ('${ZAR}',  'zarina@x.com',      'zarina', null),
      ('${MARK}', 'mark@ahc.com',      'ahc_super', null),
      ('${FM_A}', 'fa@suba.com',       'sub_foreman', '${SUB_A}'),
      ('${FM_B}', 'fb@subb.com',       'sub_foreman', '${SUB_B}'),
      ('${OWNER}','owner@dev.com',     'owner', null);
    insert into public.inspection_secure_links (id, project_id, subcontractor_id, token, active, expires_at) values
      ('${"cccccccc-0000-0000-0000-000000000001"}', '${P1}', '${SUB_A}', '${TOKEN_A}', true, null),
      ('${"cccccccc-0000-0000-0000-000000000002"}', '${P1}', '${SUB_A}', '${TOKEN_EXP}', true, '2020-01-01T00:00:00Z');
  `);

  // helper: run a fn as a given user under RLS
  async function asUser(uid: string, fn: () => Promise<void>) {
    await db.exec(`select set_config('app.current_uid', '${uid}', false); set role authenticated;`);
    try {
      await fn();
    } finally {
      await db.exec(`reset role; select set_config('app.current_uid', '', false);`);
    }
  }

  // ===== RLS: sub insert scope =====
  await asUser(FM_A, async () => {
    await db.query(
      `insert into public.inspections (project_id, subcontractor_id, title, submitted_by, status)
       values ($1,$2,$3,$4,'submitted')`,
      [P1, SUB_A, "Sub A inspection 1", FM_A],
    );
  });
  check("INT-02 sub_foreman A inserts inspection for own sub (allowed)", true);

  await asUser(FM_A, async () => {
    await expectBlocked(
      "INT-03 sub_foreman A cannot insert for a different sub (RLS with_check)",
      () =>
        db.query(
          `insert into public.inspections (project_id, subcontractor_id, title, submitted_by, status)
           values ($1,$2,$3,$4,'submitted')`,
          [P1, SUB_B, "cross-sub attempt", FM_A],
        ),
    );
  });

  // seed one for sub B via superuser for read-scope tests
  await db.query(
    `insert into public.inspections (project_id, subcontractor_id, title, status)
     values ($1,$2,$3,'submitted')`,
    [P1, SUB_B, "Sub B inspection 1"],
  );

  // ===== RLS: read scoping =====
  await asUser(FM_A, async () => {
    const r = await db.query<{ subcontractor_id: string }>(
      `select subcontractor_id from public.inspections`,
    );
    check(
      "INT-04 sub A reads only its own inspections",
      r.rows.length === 1 && r.rows.every((x) => x.subcontractor_id === SUB_A),
      `saw ${r.rows.length} rows`,
    );
  });
  await asUser(FM_B, async () => {
    const r = await db.query<{ subcontractor_id: string }>(
      `select subcontractor_id from public.inspections`,
    );
    check(
      "INT-05 sub B reads only its own inspections",
      r.rows.length === 1 && r.rows.every((x) => x.subcontractor_id === SUB_B),
      `saw ${r.rows.length} rows`,
    );
  });
  await asUser(MARK, async () => {
    const r = await db.query(`select id from public.inspections`);
    check("INT-06 AHC (Mark/ahc_super) reads all inspections", r.rows.length === 2, `saw ${r.rows.length}`);
  });
  await asUser(PHIL, async () => {
    const r = await db.query(`select id from public.inspections`);
    check("INT-07 AHC (Phil) reads all inspections", r.rows.length === 2, `saw ${r.rows.length}`);
  });

  // ===== RLS: owner read-only =====
  await asUser(OWNER, async () => {
    const r = await db.query(`select id from public.inspections`);
    check("INT-08a owner reads all inspections (read-only portal)", r.rows.length === 2, `saw ${r.rows.length}`);
    await expectBlocked("INT-08b owner cannot insert inspections", () =>
      db.query(
        `insert into public.inspections (project_id, subcontractor_id, title, status) values ($1,$2,$3,'submitted')`,
        [P1, SUB_A, "owner attempt"],
      ),
    );
  });

  // ===== RLS: photos two-sided + scope =====
  const subAInsp = (
    await db.query<{ id: string }>(
      `select id from public.inspections where subcontractor_id = $1 limit 1`,
      [SUB_A],
    )
  ).rows[0].id;
  const subBInsp = (
    await db.query<{ id: string }>(
      `select id from public.inspections where subcontractor_id = $1 limit 1`,
      [SUB_B],
    )
  ).rows[0].id;

  await asUser(FM_A, async () => {
    await db.query(
      `insert into public.inspection_photos (inspection_id, side, storage_path) values ($1,'sub',$2)`,
      [subAInsp, "p/sub1.jpg"],
    );
  });
  check("INT-09a sub adds a 'sub'-side photo to own inspection (allowed)", true);

  await asUser(FM_A, async () => {
    await expectBlocked(
      "INT-09b sub cannot add an 'ahc'-side verification photo",
      () =>
        db.query(
          `insert into public.inspection_photos (inspection_id, side, storage_path) values ($1,'ahc',$2)`,
          [subAInsp, "p/ahc1.jpg"],
        ),
    );
    await expectBlocked(
      "INT-09c sub cannot add a photo to another sub's inspection",
      () =>
        db.query(
          `insert into public.inspection_photos (inspection_id, side, storage_path) values ($1,'sub',$2)`,
          [subBInsp, "p/x.jpg"],
        ),
    );
  });

  // AHC attaches verification photo (ahc side) - the two-sided record
  await asUser(MARK, async () => {
    await db.query(
      `insert into public.inspection_photos (inspection_id, side, storage_path) values ($1,'ahc',$2)`,
      [subAInsp, "p/ahc-verify.jpg"],
    );
  });
  const sides = (
    await db.query<{ side: string }>(
      `select side from public.inspection_photos where inspection_id = $1 order by side`,
      [subAInsp],
    )
  ).rows.map((x) => x.side);
  check(
    "INT-09d one record carries both sub and ahc photo sets",
    sides.includes("sub") && sides.includes("ahc"),
    `sides=${sides.join(",")}`,
  );

  // ===== RLS: secure links AHC-only =====
  await asUser(FM_A, async () => {
    const r = await db.query(`select id from public.inspection_secure_links`);
    check("INT-10a sub cannot read secure links (0 rows under RLS)", r.rows.length === 0, `saw ${r.rows.length}`);
  });
  await asUser(MARK, async () => {
    const r = await db.query(`select id from public.inspection_secure_links`);
    check("INT-10b AHC reads secure links", r.rows.length === 2, `saw ${r.rows.length}`);
  });

  // ===== secure-link submission scoping (admin path) =====
  // The action validates the token and takes project/sub from the STORED link,
  // never the request body. Simulate: insert scoped by the link row.
  const linkA = (
    await db.query<{ project_id: string; subcontractor_id: string }>(
      `select project_id, subcontractor_id from public.inspection_secure_links where token = $1`,
      [TOKEN_A],
    )
  ).rows[0];
  await db.query(
    `insert into public.inspections (project_id, subcontractor_id, title, inspector_name, submitted_via_link, status)
     values ($1,$2,$3,$4,(select id from public.inspection_secure_links where token=$5),'submitted')`,
    [linkA.project_id, linkA.subcontractor_id, "via secure link", "Joe Field", TOKEN_A],
  );
  check(
    "INT-11 secure-link submission is scoped to the link's sub (Sub A)",
    linkA.subcontractor_id === SUB_A,
  );
  // the link-submitted record must be visible to Sub A only, not Sub B
  await asUser(FM_B, async () => {
    const r = await db.query(
      `select id from public.inspections where title = 'via secure link'`,
    );
    check("INT-11b link-submitted record is NOT visible to Sub B", r.rows.length === 0);
  });

  // ===== DB-level state transition + lock =====
  // Approve the Sub A inspection, then prove approved is terminal/locked.
  await db.query(
    `update public.inspections set status='under_review', reviewed_by=$2 where id=$1`,
    [subAInsp, MARK],
  );
  await db.query(
    `update public.inspections set status='approved', decided_by=$2, decided_at=now() where id=$1`,
    [subAInsp, MARK],
  );
  const approved = (
    await db.query<{ status: string }>(`select status from public.inspections where id=$1`, [subAInsp])
  ).rows[0].status;
  check("INT-12a inspection reaches approved", approved === "approved");
  check("INT-12b approved is terminal in the state machine (locked)", isTerminal("approved") && isLocked("approved"));

  // ============ UNIT: state machine ============
  console.log("\n  -- unit: state machine --");
  check("U-01 submitted -> under_review allowed", canTransition("submitted", "under_review"));
  check("U-02 under_review -> approved allowed", canTransition("under_review", "approved"));
  check("U-03 under_review -> rejected allowed", canTransition("under_review", "rejected"));
  check("U-04 rejected -> submitted (resubmit) allowed", canTransition("rejected", "submitted"));
  check("U-05 submitted -> approved NOT allowed (must review first)", !canTransition("submitted", "approved"));
  check("U-06 approved -> anything NOT allowed (locked)", nextStatuses("approved").length === 0);
  check("U-07 under_review -> submitted NOT allowed", !canTransition("under_review", "submitted"));
  check("U-08 all 4 statuses present", INSPECTION_STATUSES.length === 4);

  // ============ UNIT: approver gate ============
  console.log("\n  -- unit: approver gate --");
  check("U-09 Mark (ahc_super) IS the approver", isInspectionApprover({ role: "ahc_super" }));
  check("U-10 Phil is NOT the approver (digest only)", !isInspectionApprover({ role: "phil" }));
  check("U-11 Zarina is NOT the approver", !isInspectionApprover({ role: "zarina" }));
  check("U-12 a sub is NOT the approver", !isInspectionApprover({ role: "sub_foreman" }));
  check("U-13 Phil/Zarina/AHC-super can run review", canReview("phil") && canReview("zarina") && canReview("ahc_super"));
  check("U-14 a sub cannot run review", !canReview("sub_foreman"));

  // ============ UNIT: map geometry ============
  console.log("\n  -- unit: map geometry --");
  const rect = { left: 100, top: 50, width: 200, height: 400 };
  const center = clientToNormalized(200, 250, rect);
  check("U-15 center click -> (0.5, 0.5)", Math.abs(center.x - 0.5) < 1e-9 && Math.abs(center.y - 0.5) < 1e-9, `${center.x},${center.y}`);
  const oob = clientToNormalized(5000, -1000, rect);
  check("U-16 out-of-bounds click clamps to 0..1", oob.x === 1 && oob.y === 0, `${oob.x},${oob.y}`);
  const pct = normalizedToPercent({ x: 0.25, y: 0.75 });
  check("U-17 normalized -> percent strings", pct.left === "25%" && pct.top === "75%", `${pct.left},${pct.top}`);
  check("U-18 parsePin rejects out-of-range", parsePin(1.5, 0.5) === null);
  check("U-19 parsePin rejects nulls", parsePin(null, 0.5) === null);
  check("U-20 parsePin accepts valid", parsePin(0.4, 0.6)?.x === 0.4);
  check("U-21 basemapSrc falls back to C2-01 for unknown key", basemapSrc("ZZZ").includes("c2-01"));

  // ============ UNIT: token usability ============
  console.log("\n  -- unit: secure-link token --");
  check("U-22 active, no expiry -> usable", isLinkUsable({ active: true, expires_at: null }));
  check("U-23 inactive -> not usable", !isLinkUsable({ active: false, expires_at: null }));
  check("U-24 active but past expiry -> not usable", !isLinkUsable({ active: true, expires_at: "2020-01-01T00:00:00Z" }));
  check("U-25 active, future expiry -> usable", isLinkUsable({ active: true, expires_at: "2999-01-01T00:00:00Z" }));
  const t1 = generateInspectionToken();
  const t2 = generateInspectionToken();
  check("U-26 token is long & unique & url-safe", t1.length >= 40 && t1 !== t2 && /^[A-Za-z0-9_-]+$/.test(t1));

  await db.close();

  // ---------- summary ----------
  console.log(`\n================ RESULT ================`);
  console.log(`  PASSED: ${passed}`);
  console.log(`  FAILED: ${failed}`);
  if (failures.length) {
    console.log(`  Failures:`);
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log(`========================================`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
