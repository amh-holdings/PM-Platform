// Sanity checks on the registry every nav surface renders from.
import {
  PROJECT_NAV,
  activeItem,
  hrefFor,
  mobilePrimary,
  matchesQuery,
  projectIdFromPath,
  visibleActions,
  visibleGroups,
  visibleNav,
} from "../../src/lib/nav";
import type { EffectiveRole } from "../../src/lib/roles";

const PID = "abc-123";
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name}${detail ? "  " + detail : ""}`);
}

// 1. Keys are unique - counts are keyed by them.
const keys = PROJECT_NAV.map((i) => i.key);
check("keys unique", new Set(keys).size === keys.length);

// 2. Every role sees a coherent, non-overlapping grouped list.
for (const role of ["full", "cm", "sub"] as EffectiveRole[]) {
  const flat = visibleNav(role);
  const grouped = visibleGroups(role).flatMap((g) => g.items);
  check(`[${role}] grouped == flat`, grouped.length === flat.length,
    `${flat.length} destinations`);
  check(`[${role}] no empty group headings`,
    visibleGroups(role).every((g) => g.items.length > 0));
  check(`[${role}] mobile bar <= 4 slots`, mobilePrimary(role).length <= 3,
    `${mobilePrimary(role).map((i) => i.label).join(" / ") || "(none)"} + More`);
}

// 3. The sub really is confined to field reports.
const subKeys = visibleNav("sub").map((i) => i.key);
check("sub sees only field reports", subKeys.length === 1 && subKeys[0] === "field-reports",
  JSON.stringify(subKeys));

// 4. The CM never reaches a money screen other than sub billing.
const cmMoney = visibleNav("cm").filter((i) => i.group === "money").map((i) => i.key);
check("cm money == sub-billing only", cmMoney.length === 1 && cmMoney[0] === "sub-billing",
  JSON.stringify(cmMoney));
check("cm cannot see costs", !visibleNav("cm").some((i) => i.key === "costs"));
check("cm cannot see pay-apps", !visibleNav("cm").some((i) => i.key === "pay-apps"));

// 5. Active resolution: deep routes must land on their section, not the root.
const cases: [string, string | null][] = [
  [`/projects/${PID}`, "dashboard"],
  [`/projects/${PID}/field-reports`, "field-reports"],
  [`/projects/${PID}/field-reports/new`, "field-reports"],
  [`/projects/${PID}/field-reports/xyz/print`, "field-reports"],
  [`/projects/${PID}/sub-billing/s1/a1`, "sub-billing"],
  [`/projects/${PID}/edit`, null],
];
for (const [path, want] of cases) {
  check(`active ${path}`, (activeItem(path, PID)?.key ?? null) === want,
    `-> ${activeItem(path, PID)?.key ?? "null"}`);
}

// 6. hrefs are well formed (the dashboard must not end in a slash).
check("dashboard href has no trailing slash",
  hrefFor(PROJECT_NAV.find((i) => i.key === "dashboard")!, PID) === `/projects/${PID}`);
check("all hrefs under the project",
  PROJECT_NAV.every((i) => hrefFor(i, PID).startsWith(`/projects/${PID}`)));

// 7. Actions are gated too - a sub can file a report and do nothing else.
check("sub actions == file a field report",
  visibleActions("sub").length === 1 && visibleActions("sub")[0].key === "new-field-report",
  JSON.stringify(visibleActions("sub").map((a) => a.key)));

// 8. Palette scoping: project rows only when the URL is inside a project.
const scope: [string, string | null][] = [
  [`/projects/${PID}/billing`, PID],
  [`/projects/${PID}`, PID],
  ["/projects", null],
  ["/projects/new", null],
  ["/", null],
];
for (const [path, want] of scope) {
  check(`scope ${path}`, projectIdFromPath(path) === want, `-> ${projectIdFromPath(path)}`);
}

// 9. Search matches labels and the extra terms, and rejects non-matches.
const payApps = PROJECT_NAV.find((i) => i.key === "pay-apps")!;
check("search 'pay' finds Pay apps", matchesQuery(payApps, "pay"));
check("search 'g702' finds Pay apps", matchesQuery(payApps, "g702"));
check("search 'gantt' finds Schedule",
  matchesQuery(PROJECT_NAV.find((i) => i.key === "schedule")!, "gantt"));
check("search 'zzz' finds nothing",
  !PROJECT_NAV.some((i) => matchesQuery(i, "zzz")));
check("empty search matches everything", PROJECT_NAV.every((i) => matchesQuery(i, "  ")));

console.log(failures === 0 ? "\nAll nav checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
