// Exhibit S: the catalog and the file names it produces.
import {
  CATALOG_BY_KEY,
  EXHIBIT_S,
  deliverableFileName,
  deviceIdProblem,
  isDone,
} from "../../src/lib/exhibit-s";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name}`);
}
const item = (name: string) => {
  const c = EXHIBIT_S.find((x) => x.item === name);
  if (!c) throw new Error(`no catalog item ${name}`);
  return c;
};
const SPV = "Sussex CSG 1 LLC";
const D = "2026-11-03";

check("every key is unique", CATALOG_BY_KEY.size === EXHIBIT_S.length, `${CATALOG_BY_KEY.size} vs ${EXHIBIT_S.length}`);
check("all three parts present", ["I", "II", "III"].every((p) => EXHIBIT_S.some((c) => c.part === p)));
check("no item carries a character a file name can't", EXHIBIT_S.every((c) => !/[\\/:*?"<>|]/.test(c.item)));

check("plain document", deliverableFileName({ spv: SPV, item: item("IFP Civil"), versionDate: D }) === "Sussex CSG 1 LLC_IFP Civil_v2026-11-03");
check("signed certificate carries PX", deliverableFileName({ spv: SPV, item: item("MC Certificate"), versionDate: D }) === "Sussex CSG 1 LLC_MC Certificate_PX_v2026-11-03");
check("per-device photo puts the GG ID in parentheses",
  deliverableFileName({ spv: SPV, item: item("Inverter ID Label"), versionDate: D, deviceId: "IN 1.1.1" }) === "Sussex CSG 1 LLC_Inverter ID Label (IN 1.1.1)_v2026-11-03");
check("road is its own segment",
  deliverableFileName({ spv: SPV, item: item("Pre-Existing Conditions"), versionDate: D, deviceId: "Old Racetrack Rd" }) === "Sussex CSG 1 LLC_Pre-Existing Conditions_Old Racetrack Rd_v2026-11-03");
check("a slash in the SPV can't break the name",
  deliverableFileName({ spv: "A/B LLC", item: item("IFP Civil"), versionDate: D }) === "A-B LLC_IFP Civil_v2026-11-03");

check("IN 1.1.1 is a GG inverter", deviceIdProblem("IN", "IN 1.1.1") === null);
check("Inverter 1 is not", deviceIdProblem("IN", "Inverter 1") !== null);
check("MVT 1 is a GG transformer", deviceIdProblem("MVT", "MVT 1") === null);
check("new customer pole counts as switchgear", deviceIdProblem("MVSG", "New Customer Pole #2") === null);
check("1.1.MS is a GG met station", deviceIdProblem("MS", "1.1.MS") === null);
check("free text is never refused", deviceIdProblem("equipment", "Recloser") === null);
check("blank device is refused", deviceIdProblem("road", " ") !== null);
check("N/A counts as done", isDone("not_applicable") && isDone("accepted") && !isDone("in_progress"));

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
