/**
 * Rule of credit for Sweet Spring SOV 6.02 and 6.03.
 *
 * Dimension rejected AFP 12 (2026-08-21) and asked us to "provide a rule of
 * credit so we can reference for future progress measurement." This builds one
 * from money we actually committed, not from days on a bar chart.
 *
 * Weighting basis, in priority order per WBS task:
 *   1. Subcontract buyout. Each sub_sov_line's value is spread across the WBS
 *      tasks it is mapped to, pro rata on duration. The fencing subcontract is
 *      a whole separate agreement with no SOV lines loaded, so its contract
 *      value lands on 5.1.2 Fencing Installation entire.
 *   2. Duration fallback, priced at the line's own average dollars-per-day, for
 *      self-performed tasks no buyout covers. Flagged in the output so the
 *      client can see which rows are estimated rather than bought.
 *
 * Earned % for a line = sum(weight x pct_complete) / sum(weight).
 *
 * Read only. Prints the table; writes nothing.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const FENCE_TASK="5.1.2";
const r2=n=>Math.round(n*100)/100;
const usd=n=>"$"+r2(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

const {data:bl}=await sb.from("billing_lines")
  .select("item_number,description,scheduled_value,linked_task_wbs_codes").eq("project_id",PID).in("item_number",["6.02","6.03"]);
const {data:tasks}=await sb.from("schedule_tasks")
  .select("wbs_code,task_name,duration_days,pct_complete").eq("project_id",PID);
const byWbs=new Map(tasks.map(t=>[t.wbs_code,t]));
const {data:subs}=await sb.from("subcontractors").select("id,company_name,trade,contract_value").eq("project_id",PID);
const {data:ss}=await sb.from("sub_sov_lines").select("*").eq("project_id",PID);

// ---- 1. buyout dollars per WBS task ----
const buyout=new Map();      // wbs -> $
const source=new Map();      // wbs -> [labels]
const add=(w,amt,label)=>{ buyout.set(w,(buyout.get(w)??0)+amt); source.set(w,[...(source.get(w)??[]),label]); };
for(const l of ss??[]){
  const codes=l.linked_task_wbs_codes??[];
  if(!codes.length) continue;
  const days=codes.map(c=>byWbs.get(c)?.duration_days??0);
  const tot=days.reduce((s,d)=>s+d,0);
  codes.forEach((c,i)=>{
    const share=tot>0?days[i]/tot:1/codes.length;
    add(c,Number(l.scheduled_value??0)*share,`${l.item_number} ${String(l.description).slice(0,34)}`);
  });
}
const fenceSub=(subs??[]).find(s=>/fenc/i.test(s.trade??""));
if(fenceSub) add(FENCE_TASK,Number(fenceSub.contract_value??0),`${fenceSub.company_name} subcontract, whole agreement`);

// ---- 2. build each line ----
for(const item of ["6.02","6.03"]){
  const l=bl.find(b=>b.item_number===item);
  const codes=l.linked_task_wbs_codes??[];
  const sv=Number(l.scheduled_value??0);
  const bought=codes.map(w=>buyout.get(w)??0);
  const boughtTotal=bought.reduce((s,x)=>s+x,0);
  const boughtDays=codes.reduce((s,w,i)=>s+(bought[i]>0?(byWbs.get(w)?.duration_days??0):0),0);
  const perDay=boughtDays>0?boughtTotal/boughtDays:0;

  const rows=codes.map((w,i)=>{
    const t=byWbs.get(w);
    const est=bought[i]===0;
    const weight=est?(t?.duration_days??0)*perDay:bought[i];
    return {wbs:w,task:t?.task_name??"?",days:t?.duration_days??0,weight,est,
            pct:Number(t?.pct_complete??0),src:est?"duration @ line avg $/day":(source.get(w)??[]).join("; ")};
  });
  const W=rows.reduce((s,r)=>s+r.weight,0);
  const earnedPct=W>0?rows.reduce((s,r)=>s+r.weight*r.pct,0)/W:0;

  console.log(`\n===== SOV ${item}  ${l.description}  |  scheduled value ${usd(sv)} =====`);
  console.table(rows.map(r=>({wbs:r.wbs,task:r.task.slice(0,42),days:r.days,
    weight:usd(r.weight),"weight %":r2(W>0?r.weight/W*100:0)+"%",basis:r.est?"estimated":"buyout",
    "% cplt":r.pct,"earned":usd(sv*(r.weight/W)*(r.pct/100))})));
  console.log(`  weight base ${usd(W)}   (${usd(boughtTotal)} bought, ${usd(W-boughtTotal)} estimated)`);
  console.log(`  EARNED ${r2(earnedPct)}%  ->  ${usd(sv*earnedPct/100)}`);
  if(item==="6.03"){
    const f=rows.find(r=>r.wbs===FENCE_TASK);
    console.log(`  permanent fence share of this line: ${r2(f.weight/W*100)}% by buyout value  |  ${r2(f.days/rows.reduce((s,r)=>s+r.days,0)*100)}% by duration  |  Dimension asserts 70%`);
  }
}
