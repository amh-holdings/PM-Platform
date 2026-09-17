/** Basin 1 subtask starts, corrected from the field record (Phil 2026-09-17).
 *
 *  When Basin 1 ESC was split into subtasks on 9/9, Culvert Outflow and Riser
 *  inherited the basin's 8/13 start and Embankment an 8/19 start, and their
 *  durations were set to span those windows. None of the three began then:
 *  8/13-8/18 was grubbing. The pace forecast reads 60% over 24 days and pushes
 *  Outflow to October. Each start below is the first record of that work:
 *
 *    Embankment      8/28  DPR "install fill on damn of basin one"
 *    Culvert outflow 9/01  DPR "Lay pipe basin one" (pipe staged 8/31)
 *    Riser install   9/02  DPR "install pipe and structure in basin one"
 *
 *  Duration keeps the finish the 9/9 split planned for each (9/14, 9/10, 9/11),
 *  restated from the real start. The sync then forecasts from there.
 *  Dry run by default; --apply writes after a backup. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { computeCpm } from "@/lib/schedule-cpm";
import { durationInWorkingDays } from "@/lib/schedule-calendar";
import { planScheduleSync } from "@/lib/schedule-sync";
import { sisterDurationSuggestions } from "@/lib/schedule-sister-durations";
import { loadScheduleContext } from "@/lib/schedule-sync-server";
const raw=readFileSync(".env.local","utf8");const env:Record<string,string>={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const FIX:Record<string,{start:string;splitFinish:string}>={
  "5.1.1.6.5":{start:"2026-08-28",splitFinish:"2026-09-14"},
  "5.1.1.6.1":{start:"2026-09-01",splitFinish:"2026-09-10"},
  "5.1.1.6.2":{start:"2026-09-02",splitFinish:"2026-09-11"},
};
const ctx=(await loadScheduleContext(sb as any,PID))!;
const opts={calendar:ctx.calendar,dataDate:ctx.dataDate};
const tasks=ctx.tasks as any[];
const settle=(ts:any[])=>{const u=planScheduleSync(ts,opts);return ts.map(t=>{const x=u.find(y=>y.wbs===t.wbs_code);return x?{...t,start_date:x.start,end_date:x.end}:t;});};
const patches=Object.entries(FIX).map(([w,f])=>{const t=tasks.find(x=>x.wbs_code===w);
  return {w,id:t.id,name:t.task_name,before:{start:t.start_date,dur:t.duration_days},start_date:f.start,duration_days:durationInWorkingDays(f.start,f.splitFinish,ctx.calendar),
    // end_date restated to match, so the held-finish rule starts from the corrected window
    end_date:f.splitFinish};});
const before=settle(tasks);
const after=settle(tasks.map(t=>{const p=patches.find(x=>x.id===t.id);return p?{...t,start_date:p.start_date,end_date:p.end_date,duration_days:p.duration_days}:t;}));
const cb=computeCpm(before,opts), ca=computeCpm(after,opts);
for(const p of patches)console.log(`${p.w} ${p.name}: start ${p.before.start} -> ${p.start_date}, duration ${p.before.dur} -> ${p.duration_days}`);
console.log("\nforecast finish (before -> after):");
for(const w of ["5.1.1.6","5.1.1.6.1","5.1.1.6.2","5.1.1.6.5","5.1.1.6.3","5.1.1.6.7","5.1.1.7.1","5.1.1.11"]){
  const b=before.find(t=>t.wbs_code===w),a=after.find(t=>t.wbs_code===w);
  console.log(`  ${w.padEnd(10)} ${a.task_name.slice(0,26).padEnd(26)} ${b.start_date}..${b.end_date} -> ${a.start_date}..${a.end_date}  [${ca.byWbs.get(w)?.forecastBasis??"-"}]`);}
console.log("sister suggestions after:",JSON.stringify(sisterDurationSuggestions(after,{calendar:ctx.calendar})));
console.log("settles in one pass:",planScheduleSync(after,opts).length===0);
if(!process.argv.includes("--apply")){console.log("\nDRY RUN - --apply to write");process.exit(0);}
writeFileSync("scripts/_backups/basin1-starts-pre-2026-09-17.json",JSON.stringify(tasks.filter(t=>t.wbs_code.startsWith("5.1.1.6")),null,2));
for(const p of patches){const {error}=await sb.from("schedule_tasks").update({start_date:p.start_date,end_date:p.end_date,duration_days:p.duration_days}).eq("id",p.id);if(error)throw error;}
// settle the rest of the schedule now rather than waiting for a page load
const {syncScheduleDates}=await import("@/lib/schedule-sync-server");
console.log("\napplied 3; sync wrote",await syncScheduleDates(sb as any,PID),"rows");
