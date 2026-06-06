// Nightly missing-DPR sweep.
//
// For each active project, check whether a DPR with report_date = yesterday
// (America/New_York) exists. If not, push a Telegram message to Phil.
//
// Required env (read from .env.local when run from pm-platform/, otherwise
// from process.env when run by launchd):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//
// Optional:
//   MISSING_DPR_PROJECT_FILTER  - comma-separated project IDs to scope to
//   MISSING_DPR_STATUSES        - comma-separated project statuses to include
//                                 (default: "Construction,Commissioning" - the
//                                  lifecycle stages where DPRs are expected)
//   MISSING_DPR_SILENT_IF_CLEAR - "1" to skip the "all clear" Telegram
//
// Manual: from pm-platform/, `node scripts/check-missing-dprs.mjs`
// Scheduled: see scripts/com.ahc.missing-dpr.plist

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocalIfPresent() {
  if (!existsSync(".env.local")) return {};
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

function getEnv(name, fileEnv) {
  return process.env[name] ?? fileEnv[name];
}

function isoYesterdayEastern() {
  // America/New_York day for "yesterday relative to now". Compute via
  // toLocaleDateString to dodge DST math.
  const now = new Date();
  const partsToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(partsToday.find((p) => p.type === "year").value);
  const m = Number(partsToday.find((p) => p.type === "month").value);
  const d = Number(partsToday.find((p) => p.type === "day").value);
  // Subtract a day via UTC arithmetic and re-format
  const todayUtc = Date.UTC(y, m - 1, d);
  const yesterdayUtc = new Date(todayUtc - 24 * 60 * 60 * 1000);
  const yy = yesterdayUtc.getUTCFullYear();
  const mm = String(yesterdayUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(yesterdayUtc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed (${res.status}): ${body}`);
  }
}

async function main() {
  const fileEnv = loadEnvLocalIfPresent();
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL", fileEnv);
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY", fileEnv);
  const tgToken = getEnv("TELEGRAM_BOT_TOKEN", fileEnv);
  const tgChat = getEnv("TELEGRAM_CHAT_ID", fileEnv);
  const projectFilter = getEnv("MISSING_DPR_PROJECT_FILTER", fileEnv);
  const statusesEnv = getEnv("MISSING_DPR_STATUSES", fileEnv);
  const activeStatuses = (statusesEnv ?? "Construction,Commissioning")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const silentIfClear = getEnv("MISSING_DPR_SILENT_IF_CLEAR", fileEnv) === "1";

  for (const [name, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    TELEGRAM_BOT_TOKEN: tgToken,
    TELEGRAM_CHAT_ID: tgChat,
  })) {
    if (!value) {
      console.error(`Missing env: ${name}`);
      process.exit(1);
    }
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const yesterday = isoYesterdayEastern();
  console.log(`Checking DPRs for ${yesterday} (yesterday, America/New_York)`);

  let projectQuery = supabase
    .from("projects")
    .select("id, name, client, status")
    .in("status", activeStatuses)
    .order("name", { ascending: true });
  if (projectFilter) {
    const ids = projectFilter
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    projectQuery = projectQuery.in("id", ids);
  }
  const { data: projects, error: projectError } = await projectQuery;
  if (projectError) {
    console.error(`Failed to fetch projects: ${projectError.message}`);
    process.exit(1);
  }
  if (!projects || projects.length === 0) {
    console.log(
      `No projects in status [${activeStatuses.join(", ")}] to check.`,
    );
    return;
  }

  const missing = [];
  for (const p of projects) {
    const { count, error } = await supabase
      .from("dprs")
      .select("id", { count: "exact", head: true })
      .eq("project_id", p.id)
      .eq("report_date", yesterday);
    if (error) {
      console.error(`Project ${p.name}: ${error.message}`);
      continue;
    }
    if ((count ?? 0) === 0) {
      // Surface the last DPR date so the Telegram message is informative.
      const { data: last } = await supabase
        .from("dprs")
        .select("report_date")
        .eq("project_id", p.id)
        .order("report_date", { ascending: false })
        .limit(1);
      missing.push({
        id: p.id,
        name: p.name,
        client: p.client,
        lastReportDate: last?.[0]?.report_date ?? null,
      });
    }
  }

  console.log(`${projects.length} active project(s), ${missing.length} missing yesterday's DPR`);

  if (missing.length === 0) {
    if (silentIfClear) return;
    await sendTelegram(
      tgToken,
      tgChat,
      `*AHC PM* - all ${projects.length} active projects filed a DPR for ${yesterday}.`,
    );
    return;
  }

  const lines = missing.map((m) => {
    const last = m.lastReportDate ? `last ${m.lastReportDate}` : "no DPR ever";
    return `- *${m.name}*${m.client ? ` (${m.client})` : ""} - ${last}`;
  });
  const text = [
    `*AHC PM* - missing DPRs for ${yesterday}`,
    "",
    ...lines,
    "",
    `${missing.length} of ${projects.length} active project(s).`,
  ].join("\n");

  await sendTelegram(tgToken, tgChat, text);
  console.log("Telegram alert sent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
