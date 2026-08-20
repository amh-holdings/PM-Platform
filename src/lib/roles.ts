// Effective-role veneer. The database keeps its 7-value `user_role` enum and
// all RLS runs on those DB roles. For the UI, we collapse to three roles that
// match how the business actually works today:
//
//   full  -> Phil. Sees everything; can preview other roles via "view as".
//   cm    -> Construction Manager (the AHC reviewer: ahc_super / zarina).
//   sub   -> Subcontractor (sub_pm / sub_foreman). Files field reports only.
//
// This is a presentation/capability layer ONLY. It never changes RLS or
// server-action authorization - those still read the true DB role. The
// view-as cookie is honored only for a true `full` user, so it can only ever
// DE-SCOPE the view, never escalate privileges.
//
// This module is intentionally free of server-only imports (next/headers,
// Supabase) so client components can import `can` / types. The cookie- and
// DB-backed helpers live in `roles-server.ts`.

export type EffectiveRole = "full" | "cm" | "sub";

export const VIEW_AS_COOKIE = "fr_view_as";

// Collapse a raw DB role to an effective role.
export function toEffectiveRole(dbRole: string | null | undefined): EffectiveRole {
  if (dbRole === "phil") return "full";
  if (dbRole === "ahc_super" || dbRole === "zarina") return "cm";
  if (dbRole === "sub_pm" || dbRole === "sub_foreman") return "sub";
  // owner / counsel / unknown: most-restricted view (RLS still governs data).
  return "sub";
}

export const ROLE_LABEL: Record<EffectiveRole, string> = {
  full: "Full access",
  cm: "Construction Manager",
  sub: "Subcontractor",
};

// ---- Capability matrix: the one place features ask "can this role do X". ----
// Financials are split into granular capabilities so the Construction Manager
// can be given operational + billing visibility while internal costs, profit
// margin, and subcontractor pay applications stay Phil-only.
export type Capability =
  // --- operational / field ---
  | "viewAllReports" // see every sub's field reports, not just own
  | "submitFieldReport" // file a daily field report
  | "reviewPins" // open/verify sub work pins
  | "decidePins" // approve/reject (also gated server-side by the approver rule)
  | "addCmChecks" // drop CM own-check pins
  | "enterDailyProduction" // create/edit the daily commodity production report (Phil only)
  | "viewDailyProduction" // see commodity production figures
  // --- per-tab / per-view visibility ---
  | "viewDashboard" // project dashboard landing
  | "viewFieldReports" // Field Reports tab
  | "viewBilling" // Billing tab
  | "viewPayApps" // Pay apps tab + pages (Phil-only)
  // --- subcontractor billing (buy side) ---
  | "verifySubBilling" // Sub Billing tab + line-by-line verification (CM works here)
  | "viewSubBillingDollars" // see sub bill $ amounts, not just percentages (Phil-only)
  | "enterSubBill" // record a bill received from a sub (Phil-only)
  | "recommendSubBill" // CM signs off that the field record supports the bill
  | "approveSubBilling" // final approve/reject a sub bill for payment (Phil-only)
  | "viewChangeOrders" // Change orders tab
  | "viewSchedule" // Schedule tab
  | "viewSubs" // Subs tab
  | "viewProcurement" // Procurement tab
  | "viewCosts" // Costs tab + all internal cost/profit/margin figures (Phil-only)
  | "viewContractValue" // project contract $ totals; hidden from subs
  | "viewDocuments" // Documents tab
  | "viewAsToggle"; // the Phil-only "view as" switcher

const MATRIX: Record<EffectiveRole, Set<Capability>> = {
  full: new Set<Capability>([
    "viewAllReports",
    "submitFieldReport",
    "reviewPins",
    "decidePins",
    "addCmChecks",
    "enterDailyProduction",
    "viewDailyProduction",
    "viewDashboard",
    "viewFieldReports",
    "viewBilling",
    "viewPayApps",
    "verifySubBilling",
    "viewSubBillingDollars",
    "enterSubBill",
    "recommendSubBill",
    "approveSubBilling",
    "viewChangeOrders",
    "viewSchedule",
    "viewSubs",
    "viewProcurement",
    "viewCosts",
    "viewContractValue",
    "viewDocuments",
    "viewAsToggle",
  ]),
  // Construction Manager: operational visibility (schedule, subs, procurement,
  // documents, field reports) but NO financials - no dashboard Financial
  // section, no Billing, no Change orders, no Costs/margin, no Pay apps.
  //
  // Sub billing is the one deliberate exception. The CM is the only person who
  // knows whether a sub actually did the work they billed for, so he gets the
  // verification screen and the recommend action - but in PERCENTAGES ONLY.
  // `viewSubBillingDollars` stays with Phil, so the CM judges the work without
  // seeing what AHC pays for it, and cannot approve his own recommendation.
  cm: new Set<Capability>([
    "viewAllReports",
    "submitFieldReport",
    "reviewPins",
    "decidePins",
    "addCmChecks",
    "viewDailyProduction",
    "viewDashboard",
    "viewFieldReports",
    "verifySubBilling",
    "recommendSubBill",
    "viewSchedule",
    "viewSubs",
    "viewProcurement",
    "viewContractValue",
    "viewDocuments",
  ]),
  // Subcontractor: files field reports only. Commodity production is AHC's
  // deliverable to the owner, built FROM the sub's reports - the sub never
  // touches it.
  sub: new Set<Capability>(["viewFieldReports", "submitFieldReport"]),
};

export function can(role: EffectiveRole, cap: Capability): boolean {
  return MATRIX[role].has(cap);
}
