/**
 * Manhour-weighted rule of credit for SOV 6.03, per Matt Clark's 2026-08-25 ask:
 * "a proposal in line with proportional manhour weighting is appreciated."
 *
 * Crew sizes for work ALREADY PERFORMED are calibrated to the CM daily logs
 * (Aug 4 - Aug 31, 21 finalized logs, observed crews of 4-10, mean ~7). Crew
 * sizes for FUTURE work are planned crews. 8-hour days throughout.
 *
 * Deliberately conservative where it costs us: the shared Pyramid crew splits
 * its day between 6.02 clearing/debris and 6.03 basin ESC, so basin activities
 * are credited at a PARTIAL crew, not the full 7-8 on site.
 *
 * Read only.
 */
const HRS = 8;
// [wbs, activity, days, crew, bucket, basis]
const T = [
  ["5.1.1.1","Partition off Limits of Disturbance",  2, 4, "ESC","observed, LOD layout"],
  ["5.1.1.5","Silt/Rock Fence Install",              1, 4, "ESC","observed 8/07-8/08"],
  ["5.1.1.6","Construct Basin 1 ESC",                7, 5, "ESC","partial of 7-8 crew, shared with 6.02"],
  ["5.1.1.7","Construct Basin 2 ESC",                7, 5, "ESC","partial of 7-8 crew, shared with 6.02"],
  ["5.1.2",  "Fencing Installation (permanent)",     4, 5, "FENCE","planned Hercules crew"],
  ["5.1.3.5","Basin 1 Final Grading / Stab / Seed",  2, 5, "ESC","planned"],
  ["5.1.3.6","Basin 2 Final Grading / Stab / Seed",  2, 5, "ESC","planned"],
  ["5.1.3.7","Convert Basins to Stormwater Ponds",   6, 6, "ESC","planned"],
  ["5.1.3.8","Permanent Seeding",                    2, 4, "ESC","planned"],
];
const SV = 203835.79, CT = 54, BILLED = 43.64;
const r1=n=>Math.round(n*10)/10, r2=n=>Math.round(n*100)/100;
const usd=n=>"$"+r2(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

const rows=T.map(([wbs,act,d,c,b,basis])=>({wbs,activity:act,days:d,crew:c,hours:d*c*HRS,bucket:b,basis}));
const tot=rows.reduce((s,r)=>s+r.hours,0);
console.table(rows.map(r=>({...r,"share":r1(r.hours/tot*100)+"%"})));
const F=rows.filter(r=>r.bucket==="FENCE").reduce((s,r)=>s+r.hours,0);
const E=tot-F;
console.log(`\n  fence ${F} hr   erosion control ${E} hr   total ${tot} hr`);
console.log(`  MANHOUR SPLIT:  fence ${r1(F/tot*100)}%   erosion control ${r1(E/tot*100)}%`);

console.log("\n=== sensitivity: how big would the fence crew have to be? ===");
console.table([3,4,5,6,8,10,14].map(c=>{
  const f=4*c*HRS, t=E+f;
  return {"fence crew":c,"fence hr":f,"fence share":r1(f/t*100)+"%",
    "ESC share":r1(E/t*100)+"%","6.03 earned at CT 54%":r2(E/t*CT)+"%",
    "vs 43.64% billed":E/t*CT>=BILLED?"supports":"short"};
}));

console.log("\n=== what the line earns this period under each proposal (Dimension's own CT reading, SWPPP 54%) ===");
const scen=[["Dimension 70/30",30],["AHC committed value 34/66",65.84],[`AHC manhours ${r1(F/tot*100)}/${r1(E/tot*100)}`,E/tot*100]];
console.table(scen.map(([label,escW])=>({proposal:label,"ESC weight":r1(escW)+"%",
  "6.03 earned":r2(escW/100*CT)+"%",dollars:usd(SV*(escW/100)*(CT/100)),
  "vs billed $88,953.94":usd(SV*(escW/100)*(CT/100)-SV*BILLED/100)})));
