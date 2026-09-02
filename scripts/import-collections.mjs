// Load real owner-payment (collection) dates for AFP1-8 from the Summary
// Billing & Payments tab of cash-flow-20260529.xlsx into billing_entries.paid_at.
// These 8 historical billing months map 1:1 to the AFPs and reconcile to the
// dollar against billing_entries.actual_amount. Purely additive (fills nulls).
// Backs up billing_entries first. AFP9 / 2026-05 / 2026-06 are intentionally
// NOT touched (unresolved invoice/collection reconciliation).
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const DRY=process.argv.includes("--dry-run");

// period_month (YYYY-MM) -> { paid_date, afp }  (from Summary tab, verified)
const MAP={
 "2024-07":{d:"2024-07-08",afp:"AFP 1"},
 "2024-08":{d:"2024-08-06",afp:"AFP 2A/2B"},
 "2024-09":{d:"2024-09-30",afp:"AFP 3R"},
 "2024-11":{d:"2024-11-29",afp:"AFP 4R"},
 "2025-01":{d:"2025-01-31",afp:"AFP 5R"},
 "2025-03":{d:"2025-03-31",afp:"AFP 6"},
 "2025-07":{d:"2025-07-29",afp:"AFP 7"},
 "2025-12":{d:"2025-12-05",afp:"AFP 8"},
};

const bl=await sb.from("billing_lines").select("id").eq("project_id",PID);
const blIds=bl.data.map(r=>r.id);
const be=await sb.from("billing_entries").select("*").in("billing_line_id",blIds);

// backup
const ts=new Date().toISOString().replace(/[:.]/g,"-");
const bkp=`scripts/_backups/billing_entries_${ts}.json`;
writeFileSync(bkp, JSON.stringify(be.data,null,1));
console.log(`Backed up ${be.data.length} billing_entries -> ${bkp}`);

const targets=be.data.filter(r=>{ const m=(r.period_month||"").slice(0,7); return MAP[m] && Number(r.actual_amount||0)>0; });
console.log(`\nRows to mark paid (${targets.length}):`);
const byMonth={};
for(const r of targets){ const m=(r.period_month||"").slice(0,7); byMonth[m]=byMonth[m]||{n:0,amt:0}; byMonth[m].n++; byMonth[m].amt+=Number(r.actual_amount||0); }
Object.keys(byMonth).sort().forEach(m=>console.log(`  ${m} -> paid ${MAP[m].d} (${MAP[m].afp})  rows=${byMonth[m].n}  $${byMonth[m].amt.toFixed(0)}`));
const totalPaid=targets.reduce((s,r)=>s+Number(r.actual_amount||0),0);
console.log(`  TOTAL marked collected: $${totalPaid.toFixed(2)}`);

if(DRY){ console.log("\n[dry-run] no writes."); process.exit(0); }
let ok=0,err=0;
for(const r of targets){ const m=(r.period_month||"").slice(0,7);
  const {error}=await sb.from("billing_entries").update({paid_at:MAP[m].d, afp_number:MAP[m].afp, status:"paid"}).eq("id",r.id);
  if(error){err++; console.log("ERR",r.id,error.message);} else ok++;
}
console.log(`\nUpdated ${ok} rows (${err} errors).`);
