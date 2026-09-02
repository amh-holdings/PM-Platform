// Run the real incident scanner over every CM log and field report Sweet
// Springs has, to see what it would raise. The CM uses safety_notes as a
// general notepad, so this is the honest test of whether the candidate list
// is readable or noise.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { deriveIncidentCandidates } from "../src/lib/monthly-manpower";

const raw = readFileSync(".env.local", "utf8"); const env: Record<string,string> = {};
for (const l of raw.split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const i=t.indexOf("="); env[t.slice(0,i)]=t.slice(i+1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const P = "53cff193-21e4-45ff-833d-43813e8578a0";

const { data: dprs } = await sb.from("dprs")
  .select("id, report_date, status, subcontractor_id, crew_count, total_man_hours, safety_incident, near_miss, safety_narrative, work_narrative")
  .eq("project_id", P).eq("status", "approved");
const { data: logs } = await sb.from("cm_daily_logs")
  .select("log_date, safety_notes, progress_summary").eq("project_id", P);
const { data: subs } = await sb.from("subcontractors").select("id, company_name, trade").eq("project_id", P);

const notes = (logs ?? []).filter(l => l.safety_notes?.trim());
console.log(`${dprs?.length ?? 0} approved reports, ${logs?.length ?? 0} CM logs (${notes.length} with safety notes)\n`);

const r = deriveIncidentCandidates(dprs as never, logs as never, subs as never);
console.log(`RAISED: ${r.value.length}`);
for (const c of r.value) console.log(`  ${c.occurredOn}  ${c.flagged ? "FLAGGED" : "wording"}  ${c.sourceLabel}\n     ${c.narrative.slice(0,150).replace(/\n/g," ")}`);

const raisedDays = new Set(r.value.map(c => c.occurredOn));
console.log(`\nNOT raised - a sample of what the scanner is passing over:`);
for (const l of notes.filter(l => !raisedDays.has(l.log_date)).slice(0, 8))
  console.log(`  ${l.log_date}: ${l.safety_notes!.slice(0,120).replace(/\n/g," ")}`);
