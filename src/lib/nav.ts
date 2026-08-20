// The navigation registry: the ONE place a destination is declared.
//
// Before this file, the list of project sections was hand-written JSX inside
// project-tabs.tsx. That made adding a section a markup edit in a bar that was
// already overflowing, and it meant every other surface that wants to list
// destinations (phone nav, command palette, breadcrumbs) had to repeat the
// list and drift from it.
//
// Now every nav surface maps over PROJECT_NAV and calls `can(role, item.cap)`.
// Adding a section is one object in the array and it appears in the desktop
// rail, the phone bar and sheet, the command palette, and the breadcrumb -
// all gated by the same capability the page itself guards with.
//
// This module is deliberately free of server-only imports (next/headers,
// Supabase) so client components can import it. Live counts are resolved
// server-side in `nav-counts.ts` and passed in as plain data.

import {
  Boxes,
  ClipboardList,
  CalendarRange,
  Coins,
  FileDiff,
  FileSpreadsheet,
  FolderOpen,
  HandCoins,
  LayoutDashboard,
  NotebookPen,
  ReceiptText,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";

import { can, type Capability, type EffectiveRole } from "./roles";

export type NavGroupKey = "overview" | "field" | "money" | "plan" | "records";

// Counts are keyed by NavItem.key so the resolver and the renderer can never
// disagree about which badge belongs to which destination.
export type NavCounts = Partial<Record<string, number>>;

export type NavItem = {
  key: string;
  label: string;
  group: NavGroupKey;
  /** Path below /projects/[id]. Empty string is the project root. */
  path: string;
  /** The same capability the page guards itself with server-side. */
  cap: Capability;
  icon: LucideIcon;
  /** One line of what the section is for. Shown in the command palette. */
  blurb: string;
  /** Extra search terms for the command palette (label is matched already). */
  find?: string[];
  /**
   * A count of things needing attention. Absent means this section has no
   * meaningful "awaiting you" number - do not invent one to fill the slot.
   */
  hasCount?: boolean;
  /**
   * Grids and money tables get the full window; forms and lists keep a
   * reading width. Declared here so a new section picks its own width instead
   * of inheriting one global max-width that was wrong for half the app.
   */
  wide?: boolean;
};

export const NAV_GROUPS: { key: NavGroupKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "field", label: "Field" },
  { key: "money", label: "Money" },
  { key: "plan", label: "Plan" },
  { key: "records", label: "Records" },
];

export const PROJECT_NAV: NavItem[] = [
  {
    key: "dashboard",
    wide: true,
    label: "Dashboard",
    group: "overview",
    path: "",
    cap: "viewDashboard",
    icon: LayoutDashboard,
    blurb: "Operations, financial and compliance at a glance",
    find: ["home", "overview", "summary"],
  },
  {
    key: "field-reports",
    wide: true,
    label: "Field Reports",
    group: "field",
    path: "field-reports",
    cap: "viewFieldReports",
    icon: ClipboardList,
    blurb: "Daily reports from subs, and the review board",
    find: ["dpr", "daily", "reports", "pins", "review board", "inspections", "qa", "qc"],
    hasCount: true,
  },
  {
    key: "cm-log",
    label: "CM Log",
    group: "field",
    path: "cm-log",
    cap: "viewAllReports",
    icon: NotebookPen,
    blurb: "The construction manager's own daily log",
    find: ["my daily log", "diary", "journal"],
  },
  {
    key: "production",
    wide: true,
    label: "Commodity Tracker",
    group: "field",
    path: "production",
    cap: "viewDailyProduction",
    icon: Boxes,
    blurb: "Daily installed quantities reported to the owner",
    find: ["production", "quantities", "commodities", "tracker"],
  },
  {
    key: "billing",
    wide: true,
    label: "Billing",
    group: "money",
    path: "billing",
    cap: "viewBilling",
    icon: FileSpreadsheet,
    blurb: "Schedule of values and what is billable this period",
    find: ["sov", "g703", "schedule of values"],
  },
  {
    key: "sub-billing",
    wide: true,
    label: "Sub billing",
    group: "money",
    path: "sub-billing",
    cap: "verifySubBilling",
    icon: HandCoins,
    blurb: "What subs billed, and whether the field record supports it",
    find: ["subcontractor billing", "verify", "recommend"],
    hasCount: true,
  },
  {
    key: "pay-apps",
    wide: true,
    label: "Pay apps",
    group: "money",
    path: "pay-apps",
    cap: "viewPayApps",
    icon: ReceiptText,
    blurb: "Applications for payment to the owner",
    find: ["afp", "g702", "application for payment", "invoice"],
    hasCount: true,
  },
  {
    key: "change-orders",
    wide: true,
    label: "Change orders",
    group: "money",
    path: "change-orders",
    cap: "viewChangeOrders",
    icon: FileDiff,
    blurb: "Contract changes and their effect on the contract value",
    find: ["co", "change order", "extras"],
    hasCount: true,
  },
  {
    key: "costs",
    wide: true,
    label: "Costs",
    group: "money",
    path: "costs",
    cap: "viewCosts",
    icon: Coins,
    blurb: "Internal cost, spend and margin",
    find: ["margin", "profit", "spend", "budget"],
  },
  {
    key: "schedule",
    wide: true,
    label: "Schedule",
    group: "plan",
    path: "schedule",
    cap: "viewSchedule",
    icon: CalendarRange,
    blurb: "Tasks, lookahead, constraints and schedule health",
    find: ["gantt", "lookahead", "tasks", "wbs"],
  },
  {
    key: "subs",
    label: "Subs",
    group: "plan",
    path: "subs",
    cap: "viewSubs",
    icon: Users,
    blurb: "Subcontractors, contacts and compliance paperwork",
    find: ["subcontractors", "vendors", "trades"],
  },
  {
    key: "procurement",
    wide: true,
    label: "Procurement",
    group: "plan",
    path: "procurement",
    cap: "viewProcurement",
    icon: Truck,
    blurb: "Purchase orders, deliveries and payment terms",
    find: ["po", "purchase orders", "deliveries", "equipment"],
  },
  {
    key: "documents",
    label: "Documents",
    group: "records",
    path: "documents",
    cap: "viewDocuments",
    icon: FolderOpen,
    blurb: "Drawings, specs and project files",
    find: ["files", "drawings", "specs", "uploads"],
  },
];

export function hrefFor(item: NavItem, projectId: string): string {
  const base = `/projects/${projectId}`;
  return item.path ? `${base}/${item.path}` : base;
}

/** Every destination this role may see, in registry order. */
export function visibleNav(role: EffectiveRole): NavItem[] {
  return PROJECT_NAV.filter((item) => can(role, item.cap));
}

/**
 * The same list bucketed by group, with empty groups dropped. A role that can
 * see nothing in Money never renders a Money heading.
 */
export function visibleGroups(
  role: EffectiveRole,
): { key: NavGroupKey; label: string; items: NavItem[] }[] {
  const items = visibleNav(role);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.group === group.key),
  })).filter((group) => group.items.length > 0);
}

/**
 * Which registry entry a pathname is inside. Longest path wins, so
 * /field-reports/new resolves to Field Reports rather than to the dashboard.
 */
export function activeItem(pathname: string, projectId: string): NavItem | null {
  const base = `/projects/${projectId}`;
  let best: NavItem | null = null;
  for (const item of PROJECT_NAV) {
    const href = hrefFor(item, projectId);
    const hit = item.path ? pathname === href || pathname.startsWith(`${href}/`) : pathname === base;
    if (hit && (!best || item.path.length > best.path.length)) best = item;
  }
  return best;
}

/**
 * The phone bar holds three destinations plus More. Take the first visible
 * entry from each of the first three non-empty groups, so Phil gets
 * Dashboard / Field Reports / Billing while a sub gets just Field Reports.
 */
export function mobilePrimary(role: EffectiveRole): NavItem[] {
  return visibleGroups(role)
    .map((group) => group.items[0])
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
// The command palette carries verbs as well as pages, so "file a field report"
// stops being a two-page journey. Same gating rule as destinations: the
// capability here is the one the target page guards itself with.

export type NavAction = {
  key: string;
  label: string;
  /** Path below /projects/[id]. */
  path: string;
  cap: Capability;
  find?: string[];
};

export const PROJECT_ACTIONS: NavAction[] = [
  {
    key: "new-field-report",
    label: "New field report",
    path: "field-reports/new",
    cap: "submitFieldReport",
    find: ["dpr", "daily report", "file"],
  },
  {
    key: "new-cm-log",
    label: "New CM log entry",
    path: "cm-log/new",
    cap: "viewAllReports",
    find: ["daily log", "diary"],
  },
  {
    key: "new-pay-app",
    label: "New pay application",
    path: "pay-apps/new",
    cap: "viewPayApps",
    find: ["afp", "g702", "billing"],
  },
  {
    key: "new-change-order",
    label: "New change order",
    path: "change-orders/new",
    cap: "viewChangeOrders",
    find: ["co", "extra"],
  },
  {
    key: "new-po",
    label: "New purchase order",
    path: "procurement/new",
    cap: "viewProcurement",
    find: ["po", "procurement", "order"],
  },
];

export function visibleActions(role: EffectiveRole): NavAction[] {
  return PROJECT_ACTIONS.filter((action) => can(role, action.cap));
}

export function actionHref(action: NavAction, projectId: string): string {
  return `/projects/${projectId}/${action.path}`;
}

/**
 * Substring match over the label plus the extra `find` terms. Deliberately
 * simple: with a few dozen entries anything cleverer is harder to predict than
 * it is useful.
 */
export function matchesQuery(
  entry: { label: string; find?: string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.label.toLowerCase().includes(q)) return true;
  return (entry.find ?? []).some((term) => term.toLowerCase().includes(q));
}

/**
 * Pull the project id out of a pathname. Lets a single palette mounted in the
 * app shell offer project-scoped rows when you are inside a project, and only
 * portfolio rows when you are not.
 */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  const id = match?.[1];
  return !id || id === "new" ? null : id;
}
