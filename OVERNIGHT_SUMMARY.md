# Build Summary

Updated 2026-05-28 (second sprint, follow-up to 2026-05-27 dashboard build).

## What shipped this sprint

Twelve commits on top of the original dashboard work, all build-clean:

| # | Commit | What it does |
|---|---|---|
| 1 | `fceb553` Add billing / change-order / cost-forecast schema + cash-flow importer | Migration 0006 adds `change_orders`, `billing_lines`, `billing_entries`, `cost_forecasts` + RLS + three rollup views. Migration 0007 fixes the v_project_billing_summary join-multiplication. `scripts/import-cashflow.mjs` reads the cash-flow.xlsx Cash-In sheet into the new tables (39 lines, 108 entries, 3 change orders for Sweet Springs). |
| 2 | `eefad28` Rewire dashboard KPIs to read from billing_entries | KPI strip uses `v_project_billing_summary`; adds a "Future planned" card. Grid expands to 6 cards. |
| 3 | `9ea79b5` Rewire Financial widget to use billing_lines + view | Billed vs contract progress + donut by line type (LNTP / Procurement / Site Work / etc.) instead of the old wbs_sov.trade. |
| 4 | `7251bb8` Rewire Cost widget to use cost_forecasts via view | Actual spend now sums cost_forecasts.actual_amount via v_cost_code_totals instead of the never-populated cost_codes.actual_cost. |
| 5 | `08bc94a` Add Billing timeline widget | Per-month bar chart (green=billed, blue=planned) Jun 2024 - Nov 2026 + This/Next/+2 month callouts. Exactly mirrors the Cash-In sheet for Phil. |
| 6 | `0646568` Add Billing sub-page with schedule-task linking + auto-suggest | New /billing tab, per-line "Linked schedule tasks" editor saving to `billing_lines.linked_task_wbs_codes`, and a Schedule-based Suggestion panel that computes next-month billing from linked task status and offers "Promote to planned." |
| 7 | `3cf579b` Correct CO-04 importer comment | CO-04 is real ($364k OH&P, paid Jan 2026 per Phil). Importer still skips it because the spreadsheet's monthly CO-04 cells are misleading; CO-04 was reinstated via the one-off `scripts/_restore-co04.mjs`. |
| 8 | `a5721a9` Phase 1 cash flow: Cash-Out import + Cash Out timeline + Net Cash widget | New `scripts/import-cash-out.mjs` reads the Cash-Out sheet (single Actual columns through Jun 2025, paired Projected/Actual columns Jul 2025 - Dec 2026). Two new dashboard widgets: DashboardCashOut (red/orange bars + this/next/+2 callouts) and DashboardNetCash (per-month net bars + cumulative cash line + Cash-to-date / Final cumulative / Lowest cash point summary cards). |
| 9 | `f8193f6` Phase 2 cash flow: schedule -> spend linking + auto-suggest | Migration 0008 adds `cost_codes.linked_task_wbs_codes`. Three new server actions (updateCostCodeLinks, computeSpendSuggestions, promoteSpendSuggestionsToPlanned) mirror the billing-side equivalents. /costs sub-page gains a Schedule-based Spend Suggestion panel and an inline link editor per cost code row. |

## Status of Phil's stated goal

> "Cash flow of this entire project ... adjusted per the schedule so we know how everything is working on a daily, weekly and monthly basis off of the schedule and what has been completed by subs"

| Layer | Status |
|---|---|
| 1. Monthly cash flow snapshot (Cash In / Cash Out / Net + cumulative) | **Shipped.** All three timeline widgets live on the dashboard. Net Cash widget shows the running cumulative position and flags the lowest point. |
| 2. Schedule-driven forecast (link tasks -> auto-suggest billing AND spend) | **Code shipped; data not yet populated.** Migration 0008 needs to be applied (one ALTER). Then Phil links his schedule WBS codes per billing line and per cost code, and the dashboard auto-fills next-month projections. |
| 3. Daily / weekly granularity | **Not built. Deferred deliberately - see why below.** |
| 4. Driven by what subs have actually completed (DPRs) | **Not built. Deferred deliberately - see why below.** |

## Why I stopped instead of finishing Phases 3 and 4

I started Phase 3 (granularity toggle) and stepped back. **Spreading monthly buckets evenly across days is just cosmetic** - the "daily cash flow" curve would be linear interpolation, not actual cash events. The data needed to make daily/weekly views meaningful is when schedule tasks complete and when DPRs post billings - which is Phase 4. So Phase 3 is more useful AFTER Phase 4, not before.

Phase 4 (DPR module) is a real sprint, not session-end scope. The minimum-viable version is:
1. A DPR submission form (pick schedule tasks, set status changes, add narrative)
2. A review queue for AHC
3. On approve, schedule_tasks status updates -> the existing auto-suggest cascade picks it up automatically

That's 1-2 days of focused work and deserves its own thinking, not a tired late-evening commit. The schema is already in place (`dprs`, `dpr_quantities`) from the initial migration; the workflow is what's missing.

## What Phil needs to do

| Step | Why | How |
|---|---|---|
| **Apply migration 0008** | Phase 2 code references `cost_codes.linked_task_wbs_codes` which doesn't exist in your Supabase project yet | Paste contents of [db/migrations/0008_cost_codes_linked_tasks.sql](pm-platform/db/migrations/0008_cost_codes_linked_tasks.sql) into https://supabase.com/dashboard/project/sksfyygufnnbzrmneccx/sql/new and click Run. |
| **Visit /projects/[id]/billing** | See the 39-line billing schedule + this/next month forecast | Click "Link schedule tasks" on each line that maps to a milestone, paste the relevant WBS codes |
| **Visit /projects/[id]/costs** | Same idea for the spend side | Same flow, link cost codes to the schedule tasks that drive their spend |
| **Click "Promote to planned" on both sub-pages** | Lets the auto-suggest fill in next-month planned amounts based on current schedule status | One click each; safe to re-run, won't overwrite cells you've already touched |

## Things to look at when you wake up

| Item | Why it matters |
|---|---|
| **Sweet Springs contract is now $3,950,152.08** (was $3,586,152 after the brief CO-04 removal) | CO-04 was re-added per your "paid in January" statement. The dashboard, contract KPI, and Net Cash widget all reflect this. |
| **Cash-Out sheet importer rebuilds cost_forecasts from scratch every run** | Re-running it will wipe and re-import. If you (or anyone) hand-edits cost_forecasts in the UI before the next run, those edits get lost. Worth tracking when DPR module gets built. |
| **Net Cash widget's "Lowest cash point" is the early-warning indicator** | If that number goes negative, your cumulative cash flow dips into the red at some point on the forecast horizon. Glance at it after every schedule change. |
| **Reconciliation script lives at `scripts/_reconcile-cashflow.mjs`** | Run it after each spreadsheet update to confirm Supabase still ties out cell-for-cell. CO-04 will show up as an intentional "mismatch" since it's manually maintained, not auto-imported. |
| **One-off scripts (prefixed `_`) are gitignored** | They include `_restore-co04.mjs`, `_remove-co04.mjs`, `_breakdown-month.mjs`, `_reconcile-cashflow.mjs`, `_verify-import.mjs`, `_verify-migration-0006.mjs`. They're useful for debugging but not part of the platform; if you need them shared, rename them without the underscore prefix. |
| **Recharts bundle still adds ~120kB to the dashboard route first-load** | Was 96kB before Recharts. If you want it leaner, lazy-load the chart components via `next/dynamic({ ssr: false })`. Not blocking. |

## Next session scope (when ready)

1. **Phase 4 - DPR submission + approval workflow.** Build the form, the review queue, and the status-update side-effect. After this, Phase 3 becomes trivially useful.
2. **Phase 3 - granularity toggle** on the three cash flow widgets, driven by linked schedule task durations (not naive spreading).
3. **Retainage integration** - import the Cash-In sheet's Less Retainage row, subtract from billing actuals for proper "Total Cash In" numbers in the Summary widget.
4. **Multi-project cash flow rollup** - once a second project exists, a top-level page showing AHC's total cash position across all active projects.
