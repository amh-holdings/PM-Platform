/** Construction Entrance no longer waits on Basin 2 ESC.
 *   - 5.1.1.8 / 5.1.1.8.1 drop pred 5.1.1.7.7
 *   - culvert (added 8 Sep, underway) is re-anchored to 24 Aug, ahead of the
 *     ditch tie-in it feeds. pct_complete deliberately NOT set - Phil owes a number.
 *  Forward pass: an in-progress task past its finish forecasts from remaining work.
 *  County Inspection keeps its Basin 2 link - the inspection does need Basin 2 done.
 *  --apply to write. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env:Record<string,string>={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0", TODAY="2026-09-09";
const APPLY=process.argv.includes("--apply");
const D=86400000, iso=(d:Date)=>d.toISOString().slice(0,10), pd=(s:string)=>new Date(s+"T00:00:00Z");
const isWork=(s:string)=>{const g=pd(s).getUTCDay();return g>=1&&g<=5;};
const snap=(s:string)=>{let d=pd(s);while(!isWork(iso(d)))d=new Date(+d+D);return iso(d);};
const adv=(s:string,n:number)=>{let d=pd(snap(s));let k=0;while(k<n){d=new Date(+d+D);if(isWork(iso(d)))k++;}return iso(d);};
const endOf=(s:string,dur:number)=>adv(s,Math.max(0,dur-1));
const back=(e:string,dur:number)=>{let d=pd(snap(e));let k=0;while(k<Math.max(0,dur-1)){d=new Date(+d-D);if(isWork(iso(d)))k++;}return iso(d);};
const wd=(a:string,b:string)=>{let n=0,d=pd(a);const e=pd(b);while(+d<=+e){if(isWork(iso(d)))n++;d=new Date(+d+D);}return n;};
const mx=(a:string,b:string)=>pd(a)>pd(b)?a:b;

const {data}=await sb.from("schedule_tasks").select("*").eq("project_id",PID).order("sort_order");
const all=(data as any[]).map(t=>({...t}));
writeFileSync(`scripts/_backups/entrance-pre-${TODAY}.json`,JSON.stringify(data,null,2));
const orig=new Map((data as any[]).map(t=>[t.wbs_code,t]));
const G=(w:string)=>all.find(t=>t.wbs_code===w)!;

console.log("=== STEP 1: cut the Basin 2 link, re-anchor the culvert ===");
for(const w of ["5.1.1.8","5.1.1.8.1"]){const t=G(w);
  console.log(`  ${w} ${String(t.task_name).padEnd(32)} pred ${t.predecessors} -> (none)`); t.predecessors=null;}
const cul=G("5.1.1.8.1");
cul.start_date="2026-08-24"; cul.end_date="2026-08-24"; cul.status="In Progress";
console.log(`  5.1.1.8.1 re-anchored to 2026-08-24, status -> In Progress (pct left as ${cul.pct_complete??"null"} - needs your number)`);

const isSum=(t:any)=>all.some(o=>o.wbs_code!==t.wbs_code&&o.wbs_code.startsWith(t.wbs_code+"."));
const leaves=all.filter(t=>!isSum(t));
const byW=new Map(leaves.map(t=>[t.wbs_code,t]));
const parseLinks=(s:string|null)=>(s??"").split(",").map(x=>x.trim()).filter(Boolean).map(tok=>{
  const m=tok.match(/^([\d.]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i);
  return m&&byW.has(m[1])?{pred:m[1],type:(m[2]??"FS").toUpperCase(),lag:Number(m[3]??0)}:null;}).filter(Boolean) as any[];
const links=new Map(leaves.map(t=>[t.wbs_code,parseLinks(t.predecessors)]));
const indeg=new Map(leaves.map(t=>[t.wbs_code,links.get(t.wbs_code)!.length]));
const succ=new Map<string,string[]>(); leaves.forEach(t=>succ.set(t.wbs_code,[]));
for(const t of leaves) for(const l of links.get(t.wbs_code)!) succ.get(l.pred)!.push(t.wbs_code);
const q=leaves.filter(t=>indeg.get(t.wbs_code)===0).map(t=>t.wbs_code); const order:string[]=[];
while(q.length){const n=q.shift()!;order.push(n);for(const s of succ.get(n)!){indeg.set(s,indeg.get(s)!-1);if(!indeg.get(s))q.push(s);}}
if(order.length!==leaves.length) throw new Error("CYCLE");

const S=new Map<string,string>(), E=new Map<string,string>(); const workStart=snap(TODAY);
for(const wbs of order){
  const t=byW.get(wbs)!; const dur=Math.max(0,Number(t.duration_days??0)); const pct=Number(t.pct_complete??0);
  const complete=pct>=100||t.status==="Complete", started=pct>0||t.status==="In Progress";
  let dep:string|null=null;
  for(const l of links.get(wbs)!){ const ps=S.get(l.pred), pe=E.get(l.pred); if(!ps||!pe) continue;
    const c=l.type==="SS"?adv(ps,l.lag):l.type==="FF"?back(adv(pe,l.lag),dur):l.type==="SF"?back(adv(ps,l.lag),dur):adv(pe,1+l.lag);
    if(!dep||pd(c)>pd(dep)) dep=c; }
  if(complete){S.set(wbs,t.start_date);E.set(wbs,t.end_date);continue;}
  if(started){ const rem=Math.max(1,Math.ceil(dur*(1-pct/100)));
    // Recompute from the driving predecessor rather than max-ing with the stored
    // finish: that stored value may itself be the product of a link we just cut.
    let e:string;
    if(dep) e=endOf(mx(dep,workStart),rem);
    else e=pd(t.end_date)>=pd(workStart)?t.end_date:endOf(workStart,rem);
    S.set(wbs,t.start_date);E.set(wbs,e);continue;}
  const s=snap(dep?mx(dep,workStart):mx(t.start_date??workStart,workStart));
  S.set(wbs,s);E.set(wbs,endOf(s,dur));
}
for(const sm of all.filter(isSum)){
  const k=leaves.filter(l=>l.wbs_code.startsWith(sm.wbs_code+".")).filter(l=>S.has(l.wbs_code));
  if(!k.length)continue;
  S.set(sm.wbs_code,k.map(x=>S.get(x.wbs_code)!).sort()[0]);
  E.set(sm.wbs_code,k.map(x=>E.get(x.wbs_code)!).sort().pop()!);
}
console.log("\n=== STEP 2: entrance chain ===");
for(const w of ["5.1.1.8","5.1.1.8.1","5.1.1.8.2","5.1.1.9","5.1.1.10","5.1.1.11"]){const o=orig.get(w)!;
  console.log(`  ${w.padEnd(10)} ${String(o.task_name).padEnd(32)} ${o.start_date}..${o.end_date} -> ${S.get(w)}..${E.get(w)}`);}
const moves:any[]=[];
for(const t of all){ if(!S.has(t.wbs_code))continue;
  const o=orig.get(t.wbs_code)!, s=S.get(t.wbs_code)!, e=E.get(t.wbs_code)!;
  const dur=isSum(t)?wd(s,e):Number(t.duration_days);
  const ch:string[]=[];
  if(o.start_date!==s)ch.push("start"); if(o.end_date!==e)ch.push("end");
  if(Number(o.duration_days)!==dur)ch.push(`dur->${dur}`);
  if((o.predecessors??null)!==(t.predecessors??null))ch.push("pred");
  if((o.status??null)!==(t.status??null))ch.push("status");
  if(ch.length)moves.push({t,s,e,dur}); }
console.log(`\n${moves.length} rows move.`);
console.log(`Phase 1: ${S.get("5.1.1")}..${E.get("5.1.1")}  (was ${orig.get("5.1.1")!.start_date}..${orig.get("5.1.1")!.end_date})`);
console.log(`Phase 2: ${S.get("5.1.3")}..${E.get("5.1.3")}  (was ${orig.get("5.1.3")!.start_date}..${orig.get("5.1.3")!.end_date})`);
console.log(`Project finish: ${[...E.values()].sort().pop()}`);
if(APPLY){for(const m of moves){const p:any={start_date:m.s,end_date:m.e,duration_days:m.dur,predecessors:m.t.predecessors,status:m.t.status};
  const {error}=await sb.from("schedule_tasks").update(p).eq("id",m.t.id);if(error)throw error;}console.log("\nAPPLIED.");}
else console.log("\nDRY RUN - rerun with --apply.");
