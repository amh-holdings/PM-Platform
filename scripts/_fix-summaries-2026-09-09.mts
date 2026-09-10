/** The reflow button skips summary rows (computeCpm drops them, so `drifted`
 *  never sees them). This spans each summary over its leaf descendants.
 *  Pass --apply to write. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env:Record<string,string>={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY=process.argv.includes("--apply");
const D=86400000, iso=(d:Date)=>d.toISOString().slice(0,10);
const isWork=(s:string)=>{const g=new Date(s+"T00:00:00Z").getUTCDay();return g>=1&&g<=5;};
const wd=(a:string,b:string)=>{let n=0,d=new Date(a+"T00:00:00Z");const e=new Date(b+"T00:00:00Z");while(+d<=+e){if(isWork(iso(d)))n++;d=new Date(+d+D);}return n;};
const {data:tasks}=await sb.from("schedule_tasks").select("*").eq("project_id",PID).order("sort_order");
const all=tasks as any[];
const kidsOf=(s:any)=>all.filter(o=>o.wbs_code!==s.wbs_code&&o.wbs_code.startsWith(s.wbs_code+".")&&!all.some(g=>g.wbs_code!==o.wbs_code&&g.wbs_code.startsWith(o.wbs_code+".")));
const summaries=all.filter(t=>all.some(o=>o.wbs_code!==t.wbs_code&&o.wbs_code.startsWith(t.wbs_code+".")));
writeFileSync("scripts/_backups/summaries-pre-2026-09-09.json",JSON.stringify(summaries,null,2));
const rows:any[]=[];
for(const s of summaries){
  const k=kidsOf(s).filter(x=>x.start_date&&x.end_date);
  if(!k.length) continue;
  const st=k.map(x=>x.start_date).sort()[0], en=k.map(x=>x.end_date).sort().pop()!;
  const dur=wd(st,en);
  if(s.start_date===st&&s.end_date===en&&Number(s.duration_days)===dur) continue;
  rows.push({s,st,en,dur});
}
console.log(`${rows.length} summary rows need spanning:\n`);
for(const r of rows) console.log(`  ${r.s.wbs_code.padEnd(9)} ${String(r.s.task_name).slice(0,34).padEnd(34)} ${r.s.start_date}..${r.s.end_date} d${r.s.duration_days}  ->  ${r.st}..${r.en} d${r.dur}`);
if(APPLY){for(const r of rows){const {error}=await sb.from("schedule_tasks").update({start_date:r.st,end_date:r.en,duration_days:r.dur}).eq("id",r.s.id);if(error)throw new Error(`${r.s.wbs_code}: ${error.message}`);}console.log("\nAPPLIED.");}
else console.log("\nDRY RUN - rerun with --apply.");
