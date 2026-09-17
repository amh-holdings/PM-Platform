/** Back up and clear a project's baseline. Phil 2026-09-17: not ready for
 *  baselines yet; the 9/3 civil baseline carried 1-day basin placeholders.
 *  Dry run by default; --apply writes. Backup covers every task row, so dates
 *  from before the live-date sync are recoverable too. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID=process.argv.find(a=>/^[0-9a-f-]{36}$/.test(a))??"53cff193-21e4-45ff-833d-43813e8578a0";
const {data,error}=await sb.from("schedule_tasks").select("*").eq("project_id",PID);
if(error)throw error;
const withBaseline=data.filter(t=>t.baseline_start||t.baseline_end);
console.log(`${withBaseline.length} of ${data.length} tasks carry a baseline`);
if(!process.argv.includes("--apply")){console.log("DRY RUN - --apply to back up and clear");process.exit(0);}
const file=`scripts/_backups/schedule-pre-live-dates-${new Date().toISOString().slice(0,10)}.json`;
writeFileSync(file,JSON.stringify(data,null,2));console.log("backup:",file);
const {error:e2,count}=await sb.from("schedule_tasks")
  .update({baseline_start:null,baseline_end:null,baseline_duration_days:null,baseline_label:null,baseline_set_at:null},{count:"exact"})
  .eq("project_id",PID).or("baseline_start.not.is.null,baseline_end.not.is.null");
if(e2)throw e2;console.log("cleared",count);
