/** Backfill actual starts from approved field reports - the same rule report
 *  approval now applies (actualStartFromReport). Dry run by default; --apply
 *  writes. Backs up every touched row first. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { makeCalendar } from "@/lib/schedule-calendar";
import { actualStartFromReport } from "@/lib/schedule-edit";
const raw=readFileSync(".env.local","utf8");const env:Record<string,string>={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY=process.argv.includes("--apply");
const {data:proj}=await sb.from("projects").select("work_week").eq("id",PID).single();
const {data:exc}=await sb.from("project_calendar_exceptions").select("exception_date,kind").eq("project_id",PID);
const cal=makeCalendar((proj as any).work_week===6?6:5,(exc??[]) as any);
const {data:tasks}=await sb.from("schedule_tasks").select("*").eq("project_id",PID);
const all=tasks as any[];
const {data:pins}=await sb.from("inspections").select("id,schedule_task_id,task_new_pct,task_new_status,dpr_id,title").eq("project_id",PID).eq("origin","sub").eq("status","approved").not("schedule_task_id","is",null);
const {data:dprs}=await sb.from("dprs").select("id,report_date,work_narrative").eq("project_id",PID);
const dprById=new Map((dprs as any[]).map(d=>[d.id,d]));
const isSummary=(t:any)=>all.some(o=>o.wbs_code!==t.wbs_code&&o.wbs_code.startsWith(t.wbs_code+"."));
const changes:any[]=[];
for(const t of all){
  if(isSummary(t)) continue; // summary dates roll up from their children
  const mine=(pins as any[]).filter(p=>p.schedule_task_id===t.id&&(Number(p.task_new_pct??0)>0||p.task_new_status==="In Progress"||p.task_new_status==="Complete")&&p.dpr_id&&dprById.has(p.dpr_id));
  const sorted=mine.map(p=>({p,d:dprById.get(p.dpr_id).report_date})).sort((a,b)=>a.d.localeCompare(b.d));
  const first=sorted[0];
  if(!first) continue;
  const next=actualStartFromReport(t,first.d,cal);
  if(!next) continue;
  changes.push({t,next,first});
  console.log(`${t.wbs_code} ${t.task_name}: ${t.start_date}..${t.end_date} (${t.duration_days}d) -> ${next.start_date}..${next.end_date} (${next.duration_days}d)`);
  console.log(`   first report ${first.d}: pin "${first.p.title}" ${first.p.task_new_pct}% | ${String(dprById.get(first.p.dpr_id).work_narrative??"").replace(/\s+/g," ").slice(0,110)}`);
}
if(!APPLY){
  const {computeCpm}=await import("@/lib/schedule-cpm");
  const leaves=all.filter(t=>!isSummary(t));
  const W=["5.1.1.9","5.1.1.10","5.1.1.7.5","5.1.1.7.7","5.1.1.4","5.1.1.11","5.1.3.2","5.2.1","5.2.16"];
  const today=new Date().toISOString().slice(0,10);
  const before=computeCpm(leaves,{calendar:cal,dataDate:today});
  const after=computeCpm(leaves.map(t=>{const c=changes.find(x=>x.t.id===t.id);return c?{...t,...c.next}:t;}),{calendar:cal,dataDate:today});
  console.log(`\nprojected finish, as of ${today}:`);
  for(const w of W)console.log(`  ${w.padEnd(10)} ${before.byWbs.get(w)!.projectedEnd} -> ${after.byWbs.get(w)!.projectedEnd}   driven by ${after.byWbs.get(w)!.drivenBy??"-"}`);
  console.log(`\nDRY RUN - ${changes.length} task(s). --apply to write.`);process.exit(0);}
writeFileSync(`scripts/_backups/actual-starts-pre-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(changes.map(c=>c.t),null,2));
for(const c of changes){const {error}=await sb.from("schedule_tasks").update(c.next).eq("id",c.t.id);if(error)throw error;}
console.log(`\nApplied ${changes.length}.`);
