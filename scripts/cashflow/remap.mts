// Proposed SOV -> schedule remap for Sweet Springs. Dry run by default.
//   npx tsx scripts/cashflow/remap.mts           <- show what would change
//   npx tsx scripts/cashflow/remap.mts --apply   <- write it
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local","utf8"); const env:Record<string,string>={};
for (const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}) as any;
const APPLY=process.argv.includes("--apply");
async function q(t:string,s:string,fn:(b:any)=>any=(b)=>b){const{data,error}=await fn(sb.from(t).select(s));if(error)throw new Error(`${t}: ${error.message}`);return data??[];}
const n=(v:any)=>Number(v??0); const f=(v:number)=>"$"+Math.round(v).toLocaleString();
const pad=(s:any,w:number)=>String(s).padEnd(w); const rp=(s:any,w:number)=>String(s).padStart(w);
const projects=await q("projects","*"); const P=projects.find((p:any)=>/Sweet Springs/i.test(p.name)); const pid=P.id;
const W=(b:any)=>b.eq("project_id",pid);
const tasks=await q("schedule_tasks","id,wbs_code,task_name,end_date",W);
const byWbs=new Map(tasks.map((t:any)=>[t.wbs_code,t]));
const finish=(c:string)=>byWbs.get(c)?.end_date ?? null;
const mo=(d:string|null)=>d?d.slice(0,7):"NO DATE";
const chk=(codes:string[])=>codes.map(c=>byWbs.has(c)?c:`${c}<MISSING>`).join(",");

// ---- A. owner SOV: the old 5.3 electrical branch is now 5.5, substructure identical ----
const OWNER: Record<string,string[]> = {
  "7.01": ["5.5.12.2.6"],                            // was 5.3.12.2.6
  "7.02": ["5.5.1","5.5.2","5.5.3"],                 // was 5.3.1, 5.3.2, 5.3.3
  "7.03": ["5.5.12.2.4","5.5.12.2.5","5.5.12.2.8"],  // was 5.3.12.2.4/5/8
  "8.03": ["5.5.12.2","5.5.12.2.1"],                 // was 5.3.12.2, 5.3.12.2.1
  "7.04": ["5.5.10.3"],                              // POI Installed -> Final Connections at Transformer/Riser
  "5.08": ["5.2.16"],                                // 3rd Party QA/QC -> QA/QC Closeout
  "1.06": ["5.1.1.11"],                              // Electrical Design IFC -> County Inspection (Phil)
  "1.07": ["5.1.1.11"],                              // Civil Design IFC -> County Inspection (Phil)
  "1.08": ["5.1.1.11"],                              // Structural Design IFC -> County Inspection (Phil)
  "12.00":["5.4.8"],                                 // Final Completion, was 5.1.2.7/8
  "4.00": ["5.1.1.11"],                              // Construction Permits -> County Inspection
  "1.11": ["4.3.1.2"],                               // Pile procurement -> Piles Delivery
  "1.12": ["4.4.3.2"],                               // Transformer procurement -> Maddox Delivery
};
// ---- B. commodity -> schedule task ----
const COMMODITY: Record<string,string[]> = {
  site_prep:    ["5.1.1.3","5.1.3.1"],   // initial ESC clearing + full site clearing
  civil_work:   ["5.1.3.2"],             // site grading
  road_install: ["5.1.1.9"],             // Rough Road IS the entire road install (Phil)
  piles:        ["5.2.4"],               // pile driving
  racking:      ["5.2.9"],               // racking assembly
  modules:      ["5.2.14"],              // module installation
};
// ---- C. Hercules: explicit milestone ----
const HERCULES_MILESTONE = "5.1.2";      // Fencing Installation
// ---- D. task links for lines whose evidence method gives no date (method untouched) ----
const SUBLINK: Record<string,Record<string,string[]>> = {
  "Lumina Energy Services, LLC": {
    "2":["5.5.2"], "3":["5.5.8"], "4":["5.5.9"], "5":["5.5.10"],
    "6":["5.5.12.3.3"], "7":["5.5.14"],
  },
  "MATTHEWS POWER": {
    "1":["5.5.10.1"], "2":["5.5.10.1"], "3":["5.5.10.2"], "4":["5.5.10.3"],
    "5":["5.5.12.2.4"], "6":["5.5.14"],
  },
  "Pyramid Excavation LLC": {
    "7.03":["5.1.3.8"], "8.01":["5.1.3.8"], "8.02":["5.4.6"], "8.03":["5.4.6"],
  },
};

console.log(`${APPLY?"APPLYING":"DRY RUN"}\n`);
console.log("## A. OWNER SOV\n  item   value        old codes                       -> new codes                      lands");
const bl=await q("billing_lines","*",W);
const ownerWrites:any[]=[];
for (const [item,codes] of Object.entries(OWNER)){
  const line=bl.find((b:any)=>String(b.item_number)===item);
  if(!line){console.log(`  ${pad(item,6)} NOT FOUND`);continue;}
  const dates=codes.map(finish).filter(Boolean) as string[];
  console.log(`  ${pad(item,6)} ${rp(f(n(line.scheduled_value)),11)}  ${pad((line.linked_task_wbs_codes??[]).join(","),30)} -> ${pad(chk(codes),30)}  ${mo(dates[0]??null)}`);
  ownerWrites.push({id:line.id,codes});
}
console.log("\n## B. COMMODITY -> TASK LINKS\n  commodity        -> tasks                     latest finish");
const com=await q("commodities","*",W);
const comWrites:any[]=[];
for (const [key,codes] of Object.entries(COMMODITY)){
  const c=com.find((x:any)=>x.key===key);
  if(!c){console.log(`  ${pad(key,16)} COMMODITY NOT FOUND`);continue;}
  const ds=codes.map(finish).filter(Boolean) as string[];
  console.log(`  ${pad(c.label,16)} -> ${pad(chk(codes),24)}  ${mo(ds.sort().pop()??null)}`);
  for (const code of codes){ const t=byWbs.get(code); if(t) comWrites.push({commodity_id:c.id,schedule_task_id:t.id}); }
}
console.log("\n## C + D. SUB SOV LINES\n  sub                      item   value        -> target                    lands   method (unchanged)");
const subs=await q("subcontractors","id,company_name",W);
const nm=new Map(subs.map((s:any)=>[s.id,s.company_name]));
const ssov=await q("sub_sov_lines","*",W);
const subWrites:any[]=[];
for (const l of ssov){
  if(l.active===false) continue;
  const sub=String(nm.get(l.subcontractor_id));
  if(sub==="Hercules Fence" && l.verification_method==="milestone"){
    console.log(`  ${pad(sub,24)} ${pad(l.item_number,6)} ${rp(f(n(l.scheduled_value)),11)}  -> MS ${pad(HERCULES_MILESTONE,22)} ${mo(finish(HERCULES_MILESTONE))}  ${l.verification_method}`);
    subWrites.push({id:l.id,milestone:HERCULES_MILESTONE}); continue;
  }
  const codes=SUBLINK[sub]?.[String(l.item_number)];
  if(!codes) continue;
  const ds=codes.map(finish).filter(Boolean) as string[];
  console.log(`  ${pad(sub,24)} ${pad(l.item_number,6)} ${rp(f(n(l.scheduled_value)),11)}  -> ${pad(chk(codes),25)} ${mo(ds[0]??null)}  ${l.verification_method}`);
  subWrites.push({id:l.id,codes});
}
const touched=new Set(subWrites.map((w:any)=>w.id));
console.log("\n## STILL UNDATED AFTER THIS (nothing hidden)");
for (const l of ssov){
  if(l.active===false||touched.has(l.id)) continue;
  const hasMs=!!l.milestone_task_wbs_code, hasT=(l.linked_task_wbs_codes??[]).length>0;
  const hasCom=(l.linked_commodity_ids??[]).length>0;
  if(hasMs||hasT||hasCom||l.verification_method==="on_site") continue;
  console.log(`  ${pad(String(nm.get(l.subcontractor_id)),24)} ${pad(l.item_number,6)} ${rp(f(n(l.scheduled_value)),11)}  method=${l.verification_method}  ${String(l.description??"").slice(0,34)}`);
}
console.log(`\n  owner lines: ${ownerWrites.length}   commodity links: ${comWrites.length}   sub lines: ${subWrites.length}`);
if(!APPLY){ console.log("\n  no writes. re-run with --apply"); }
else {
  for (const w of ownerWrites){ const{error}=await sb.from("billing_lines").update({linked_task_wbs_codes:w.codes}).eq("id",w.id); if(error) throw new Error(error.message); }
  const{error:ce}=await sb.from("commodity_task_links").upsert(comWrites,{onConflict:"commodity_id,schedule_task_id"}); if(ce) throw new Error(ce.message);
  for (const w of subWrites){
    const patch = w.milestone ? {milestone_task_wbs_code:w.milestone} : {linked_task_wbs_codes:w.codes};
    const{error}=await sb.from("sub_sov_lines").update(patch).eq("id",w.id); if(error) throw new Error(error.message);
  }
  console.log("\n  APPLIED.");
}
