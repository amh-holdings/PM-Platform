/** Reflow: push the CPM projection into the working dates for every incomplete
 *  task, then roll summary rows up to span their children. Baseline untouched.
 *  Mirrors applyProjectedDates. Pass --apply to write. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { computeCpm } from "@/lib/schedule-cpm";
const raw=readFileSync(".env.local","utf8");const env:Record<string,string>={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const TODAY="2026-09-09";
const APPLY=process.argv.includes("--apply");
const D=86400000, iso=(d:Date)=>d.toISOString().slice(0,10);
const isWork=(s:string)=>{const g=new Date(s+"T00:00:00Z").getUTCDay();return g>=1&&g<=5;};
const wd=(a:string,b:string)=>{let n=0,d=new Date(a+"T00:00:00Z");const e=new Date(b+"T00:00:00Z");while(+d<=+e){if(isWork(iso(d)))n++;d=new Date(+d+D);}return n;};

const {data:tasks}=await sb.from("schedule_tasks").select("*").eq("project_id",PID).order("sort_order");
const all=tasks as any[];
writeFileSync(`scripts/_backups/reflow-pre-${TODAY}.json`,JSON.stringify(all,null,2));
const isSummary=(t:any)=>all.some(o=>o.wbs_code!==t.wbs_code&&o.wbs_code.startsWith(t.wbs_code+"."));
const leaves=all.filter(t=>!isSummary(t));
const cpm=computeCpm(leaves as any,{calendar:5,dataDate:TODAY});
if((cpm as any).cycle) throw new Error("cycle: "+JSON.stringify((cpm as any).cycle));

const done=(t:any)=>Number(t.pct_complete??0)>=100||t.status==="Complete";
const newDates=new Map<string,{s:string,e:string}>();
for(const t of leaves){
  if(done(t)){ if(t.start_date&&t.end_date) newDates.set(t.wbs_code,{s:t.start_date,e:t.end_date}); continue; }
  const c=cpm.byWbs.get(t.wbs_code)!;
  newDates.set(t.wbs_code,{s:c.projectedStart,e:c.projectedEnd});
}
// summaries span their leaf descendants
for(const s of all.filter(isSummary)){
  const kids=leaves.filter(l=>l.wbs_code.startsWith(s.wbs_code+".")).map(l=>newDates.get(l.wbs_code)!).filter(Boolean);
  if(!kids.length) continue;
  newDates.set(s.wbs_code,{s:kids.map(k=>k.s).sort()[0],e:kids.map(k=>k.e).sort().pop()!});
}
const rows=all.map(t=>{const n=newDates.get(t.wbs_code);if(!n)return null;
  const dur=wd(n.s,n.e);
  const ch:string[]=[];
  if(t.start_date!==n.s)ch.push(`start ${t.start_date} -> ${n.s}`);
  if(t.end_date!==n.e)ch.push(`end ${t.end_date} -> ${n.e}`);
  if(isSummary(t)&&Number(t.duration_days)!==dur)ch.push(`dur ${t.duration_days} -> ${dur}`);
  return ch.length?{t,n,dur,ch}:null;}).filter(Boolean) as any[];

console.log(`${rows.length} of ${all.length} rows move.\n`);
for(const r of rows) console.log(`${r.t.wbs_code.padEnd(11)} ${String(r.t.task_name).slice(0,40).padEnd(40)} ${r.ch.join(" | ")}`);
if(APPLY){
  for(const r of rows){
    const patch:any={start_date:r.n.s,end_date:r.n.e};
    if(isSummary(r.t)) patch.duration_days=r.dur;
    const {error}=await sb.from("schedule_tasks").update(patch).eq("id",r.t.id);
    if(error) throw new Error(`${r.t.wbs_code}: ${error.message}`);
  }
  console.log("\nAPPLIED.");
} else console.log("\nDRY RUN - rerun with --apply.");
