// The report registry: the ONE place a project report is declared.
//
// Reports used to be a single hard-coded destination (the Commodity Tracker
// tab). That worked while there was exactly one of them, but the tracker is
// only one of several things this project has to hand somebody on a schedule -
// the owner wants quantities, the CM wants field coverage, accounting wants
// billing backup. Each of those is a report, not a tab.
//
// So `Reports` is now a hub, and this array is its index. Adding a report is
// one object here plus the page it points at; the hub, the command palette
// search terms and the capability gate all read from this entry.
//
// Deliberately free of server-only imports so client components can use it.

import { Boxes, Briefcase, CalendarCheck, type LucideIcon } from "lucide-react";

import { can, type Capability, type EffectiveRole } from "./roles";

/** How a report is produced, which is what tells you what to expect of it. */
export type ReportKind =
  /** A live screen you read and edit in place. */
  | "interactive"
  /** A point-in-time document you generate, read, and hand off. */
  | "generated";

export type ProjectReport = {
  key: string;
  label: string;
  /** Path below /projects/[id]/reports. */
  path: string;
  /** The same capability the report page guards itself with server-side. */
  cap: Capability;
  icon: LucideIcon;
  /** One line of what the report is and who it is for. */
  blurb: string;
  /** Who reads it. Shown on the hub card so the list stays scannable. */
  audience: string;
  kind: ReportKind;
  /** Extra search terms for the command palette. */
  find?: string[];
};

export const PROJECT_REPORTS: ProjectReport[] = [
  {
    key: "ceo",
    label: "CEO Report",
    path: "ceo",
    // Progress, dates and site photographs - no internal cost - so this sits
    // behind the Schedule gate. It moves to `viewCosts` when the financial
    // half in `ceo-report-financials.ts` is switched on.
    cap: "viewSchedule",
    icon: Briefcase,
    blurb: "Where the job is against where it should be, when it lands, and what it looks like",
    audience: "AHC leadership",
    kind: "generated",
    find: [
      "ceo",
      "executive",
      "exec summary",
      "status",
      "progress",
      "ahead",
      "behind",
      "leadership",
      "board",
    ],
  },
  {
    key: "weekly-progress",
    label: "Weekly Progress Report",
    path: "weekly-progress",
    cap: "viewDailyProduction",
    icon: CalendarCheck,
    blurb: "Dimension's weekly form, filled from the field record",
    audience: "Dimension Energy",
    kind: "generated",
    find: [
      "weekly",
      "dimension",
      "progress report",
      "owner report",
      "look ahead",
      "lookahead",
      "swppp",
    ],
  },
  {
    key: "commodity-tracker",
    label: "Commodity Tracker",
    path: "commodity-tracker",
    cap: "viewDailyProduction",
    icon: Boxes,
    blurb: "Daily installed quantities by commodity, reported to the owner",
    audience: "Owner",
    kind: "interactive",
    find: ["production", "quantities", "commodities", "tracker", "daily production"],
  },
];

/** Every report this role may open, in registry order. */
export function visibleReports(role: EffectiveRole): ProjectReport[] {
  return PROJECT_REPORTS.filter((r) => can(role, r.cap));
}

export function reportHref(report: ProjectReport, projectId: string): string {
  return `/projects/${projectId}/reports/${report.path}`;
}

/** Which report a pathname is inside, if any. */
export function activeReport(pathname: string, projectId: string): ProjectReport | null {
  const base = `/projects/${projectId}/reports`;
  return (
    PROJECT_REPORTS.find((r) => {
      const href = `${base}/${r.path}`;
      return pathname === href || pathname.startsWith(`${href}/`);
    }) ?? null
  );
}
