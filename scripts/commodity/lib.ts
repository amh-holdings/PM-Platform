// Shared plumbing for the commodity scripts.
//
// Follows the existing importer convention (scripts/backfill-schedule-phase.mjs):
// hand-parse .env.local, service-role client, --project-id defaulting to Sweet
// Springs, --dry-run supported. Written in TypeScript rather than .mjs so these
// scripts can import the canonical commodity list from src/lib/commodities.ts
// instead of duplicating it - a second copy of that list would drift.
//
// Run with: npx tsx scripts/commodity/<script>.ts

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Sweet Springs Solar. Every commodity script defaults here. */
export const SWEET_SPRINGS_PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";

export function loadEnvLocal(): Record<string, string> {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

export function serviceClient(): SupabaseClient {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type CliArgs = {
  dryRun: boolean;
  projectId: string;
  /** Value of an arbitrary --flag, or null. */
  flag: (name: string) => string | null;
  has: (name: string) => boolean;
};

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) return null;
    return next;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    projectId: flag("project-id") ?? SWEET_SPRINGS_PROJECT_ID,
    flag,
    has: (name: string) => argv.includes(`--${name}`),
  };
}

/** ISO date (YYYY-MM-DD) for a Date, in UTC, no time component. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
