/** Basin 2 relink, confirmed by Phil 2026-09-17.
 *  - Basin 2 Culvert Outflow starts alongside Basin 1 Culvert Outflow instead of
 *    waiting for Basin 1 to finish (CM logs 9/16-9/17: crew on Basin 2 while
 *    Basin 1's lined inlet and spillway were still open).
 *  - Basin 2 Embankment starts alongside Basin 2 Outflow, as Basin 1 is built.
 *  - County Inspection waits on every basin component: Outflow, Riser and
 *    Spillway for both basins, on top of what it already waits on.
 *  Array Layout stays on Site Grading (Phil: it starts when grading is complete).
 *  Dry run by default; --apply writes, after a backup. */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env={};
for(const l of raw.split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const PID="53cff193-21e4-45ff-833d-43813e8578a0";
const {data:tasks,error}=await sb.from("schedule_tasks").select("*").eq("project_id",PID);
if(error)throw error;
const by=new Map(tasks.map(t=>[t.wbs_code,t]));
const insp=by.get("5.1.1.11");
const add=["5.1.1.6.1","5.1.1.6.2","5.1.1.6.4","5.1.1.7.1","5.1.1.7.2","5.1.1.7.4"];
const have=String(insp.predecessors??"").split(",").map(s=>s.trim()).filter(Boolean);
const CHANGES={
  "5.1.1.7.1":"5.1.1.6.1SS",
  "5.1.1.7.5":"5.1.1.7.1SS",
  "5.1.1.11":[...have,...add.filter(w=>!have.includes(w))].join(", "),
};
console.log("Array Layout 5.2.1 predecessors (unchanged):",by.get("5.2.1").predecessors);
for(const [w,p] of Object.entries(CHANGES)){const t=by.get(w);if(!t)throw new Error("missing "+w);console.log(`${w} ${t.task_name}\n  ${t.predecessors} -> ${p}`);}
if(!process.argv.includes("--apply")){console.log("DRY RUN - --apply to write");process.exit(0);}
const file="scripts/_backups/relink-basin2-pre-2026-09-17.json";
writeFileSync(file,JSON.stringify(tasks,null,2));console.log("backup:",file);
for(const [w,p] of Object.entries(CHANGES)){const {error:e}=await sb.from("schedule_tasks").update({predecessors:p}).eq("project_id",PID).eq("wbs_code",w);if(e)throw e;}
console.log("applied",Object.keys(CHANGES).length);
