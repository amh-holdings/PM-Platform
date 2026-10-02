// Set cost_codes.commitment_covered on the Sweet Springs codes whose scope is
// bought out. Requires migration 0068.
//   npx tsx scripts/cashflow/set_commitment_covered.mts           <- dry run
//   npx tsx scripts/cashflow/set_commitment_covered.mts --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local","utf8"); const env:Record<string,string>={};
for (const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}) as any;
const APPLY=process.argv.includes("--apply");
const n=(v:any)=>Number(v??0); const f=(v:number)=>"$"+Math.round(v).toLocaleString();
const pad=(s:any,w:number)=>String(s).padEnd(w); const rp=(s:any,w:number)=>String(s).padStart(w);

// Confirmed with Phil, 2026-10-01. The value is WHY, not just which.
const COVERED: Record<string,string> = {
  "SSC N": "Pyramid Excavation subcontract SOV",
  "SSC O": "Pyramid Excavation subcontract SOV",
  "SSC P": "Pyramid Excavation subcontract SOV",
  "SSC Q": "Hercules Fence subcontract SOV",
  "SSC R": "Sunstall subcontract SOV",
  "SSC S": "Lumina + Matthews subcontract SOVs (two subs, one budget line)",
  "SSC T": "the 15 active purchase orders (kept as one code, not split to T.x)",
};

const {data:ps,error:pe}=await sb.from("projects").select("id,name");
if(pe) throw new Error(pe.message);
const P=ps.find((p:any)=>/Sweet Springs/i.test(p.name));
const {data:cc,error:ce}=await sb.from("cost_codes").select("*").eq("project_id",P.id);
if(ce) throw new Error(ce.message);
if (!("commitment_covered" in (cc[0]??{}))) {
  console.log("migration 0068 has not been applied - commitment_covered does not exist yet.");
  console.log("Run db/migrations/0068_cost_code_commitment_covered.sql in the Supabase SQL editor first.");
  process.exit(1);
}
const {data:cf,error:fe}=await sb.from("cost_forecasts").select("*,cost_codes!inner(project_id)").eq("cost_codes.project_id",P.id);
if(fe) throw new Error(fe.message);
const fcOf=(id:string)=>cf.filter((r:any)=>r.cost_code_id===id)
  .reduce((s:number,r:any)=>s+(n(r.actual_amount)>0?n(r.actual_amount):n(r.planned_amount)),0);

console.log(`${APPLY?"APPLYING":"DRY RUN"}\n`);
console.log("  code     name                           forecast removed  now  ->  why");
let total=0; const ids:string[]=[];
for (const [code,why] of Object.entries(COVERED)){
  const c=cc.find((x:any)=>x.code===code);
  if(!c){ console.log(`  ${pad(code,8)} NOT FOUND`); continue; }
  const v=fcOf(c.id); total+=v; ids.push(c.id);
  console.log(`  ${pad(code,8)} ${pad(String(c.name).slice(0,28),30)} ${rp(f(v),16)}  ${pad(String(c.commitment_covered),5)} -> ${why}`);
}
console.log(`  ${pad("",39)} ${rp(f(total),16)}`);
const already=cc.filter((x:any)=>x.commitment_covered===true).map((x:any)=>x.code);
console.log(`\n  currently flagged: ${already.length? already.join(", "):"none"}`);
const shouldNot=cc.filter((x:any)=>x.commitment_covered===true && !COVERED[x.code]).map((x:any)=>x.code);
if (shouldNot.length) console.log(`  WARNING flagged but not in this list: ${shouldNot.join(", ")}`);

if (!APPLY) { console.log("\n  no writes. re-run with --apply"); }
else {
  const {error}=await sb.from("cost_codes").update({commitment_covered:true}).in("id",ids);
  if(error) throw new Error(error.message);
  const {data:after}=await sb.from("cost_codes").select("code,commitment_covered").eq("project_id",P.id);
  console.log(`\n  APPLIED. flagged: ${after.filter((x:any)=>x.commitment_covered).map((x:any)=>x.code).sort().join(", ")}`);
}
