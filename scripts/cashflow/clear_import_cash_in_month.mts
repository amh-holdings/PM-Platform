// billing_entries.cash_in_month was loaded equal to period_month by the owner
// cash-flow spreadsheet import, which reads as "Dimension pays in the month we
// perform". It is the HIGHEST priority in billing-cash-date.ts, so it beats
// Net 30 AND beats any real payment date entered later - the AFP receipt dates
// being collected now would have been silently ignored on these entries.
//
// Clears only rows where cash_in_month == period_month. A value a person
// actually chose would differ from the work month, and is left alone.
//   npx tsx scripts/cashflow/clear_import_cash_in_month.mts           <- dry run
//   npx tsx scripts/cashflow/clear_import_cash_in_month.mts --apply
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local","utf8"); const env:Record<string,string>={};
for (const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}) as any;
const APPLY=process.argv.includes("--apply");
const n=(v:any)=>Number(v??0); const f=(v:number)=>"$"+Math.round(v).toLocaleString();
const pad=(s:any,w:number)=>String(s).padEnd(w); const rp=(s:any,w:number)=>String(s).padStart(w);
const day=(v:any)=>v?String(v).slice(0,10):null;

const {data:ps,error:pe}=await sb.from("projects").select("id,name,owner_payment_terms_days");
if(pe) throw new Error(pe.message);
console.log(`${APPLY?"APPLYING":"DRY RUN"}\n`);
for (const P of ps){
  const {data:en,error}=await sb.from("billing_entries")
    .select("id,period_month,cash_in_month,paid_at,planned_amount,actual_amount,billing_lines!inner(project_id)")
    .eq("billing_lines.project_id",P.id);
  if(error) throw new Error(error.message);
  const same=en.filter((e:any)=>e.cash_in_month && day(e.cash_in_month)===day(e.period_month));
  const diff=en.filter((e:any)=>e.cash_in_month && day(e.cash_in_month)!==day(e.period_month));
  const amt=(e:any)=>n(e.actual_amount)>0?n(e.actual_amount):n(e.planned_amount);
  console.log(`${P.name}  (Net ${n(P.owner_payment_terms_days)})`);
  console.log(`  entries ${en.length}, cash_in_month set on ${same.length+diff.length}`);
  console.log(`  == period_month (import default, to clear) : ${rp(same.length,3)}  ${f(same.reduce((s:number,e:any)=>s+amt(e),0))}`);
  console.log(`  != period_month (a real override, keeping) : ${rp(diff.length,3)}  ${f(diff.reduce((s:number,e:any)=>s+amt(e),0))}`);
  if (APPLY && same.length){
    const {error:ue}=await sb.from("billing_entries").update({cash_in_month:null}).in("id",same.map((e:any)=>e.id));
    if(ue) throw new Error(ue.message);
    console.log(`  -> cleared ${same.length}`);
  }
  console.log();
}
if(!APPLY) console.log("no writes. re-run with --apply");
