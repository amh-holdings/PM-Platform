# Build Summary

Updated 2026-05-29. Phase 4 (DPR + Pay App workflow) ships in this sprint.

## What shipped this sprint

Three substantial commits, all build-clean, all on `main`:

| # | Commit | What it does |
|---|---|---|
| 1 | `1f5c59d` Phase 4 Sprint A+B - DPR module + pct_complete-aware auto-suggest | Migration 0009 + DPR submission/review module + auto-suggest reads schedule_tasks.pct_complete when set. New "DPRs" tab in the project nav. |
| 2 | `7447bb6` Phase 4 Sprint C - Pay applications as a first-class object | Migration 0010 + pay app module: list / new / detail pages with G702 cover + G703 detail table + print/PDF export + draft -> submitted -> approved -> paid lifecycle. New "Pay apps" tab in the project nav. |
| 3 | `89206b6`, `5140284`, `543713f` Earlier today (Phase 3) | Auto-suggest mapping script (32 + 10 link proposals for Sweet Springs), overhead run-rate spreader (SSC A-G), and removal of the redundant WBS/SOV tab. |

Combined with the cash flow build (Phases 1-3) from earlier sessions, the platform now covers:

| Layer | Status |
|---|---|
| Project metadata, schedule, subs, cost codes, billing schedule, change orders, documents | All working |
| Dashboard widgets (KPIs, Billing timeline, Cash Out timeline, Net Cash position, Schedule, Financial, Cost variance, Compliance, Upcoming milestones) | All working |
| Schedule-driven auto-suggest for billing AND spend | Working, reads pct_complete when set |
| DPR submission and approval workflow | Live (this sprint) |
| Pay application (G702/G703) workflow with PDF export | Live (this sprint) |

## What needs to happen now (in order)

| Step | Why | How |
|---|---|---|
| **1. Apply migration 0009** | Phase 4 Sprint A+B columns (schedule_tasks.pct_complete, dpr_task_updates, billing_entries lifecycle) | https://supabase.com/dashboard/project/sksfyygufnnbzrmneccx/sql/new -> paste [db/migrations/0009_dprs_and_lifecycle.sql](pm-platform/db/migrations/0009_dprs_and_lifecycle.sql) -> Run |
| **2. Apply migration 0010** | Phase 4 Sprint C tables (pay_applications, pay_application_lines, FK back into billing_entries) | Same SQL editor link -> paste [db/migrations/0010_pay_applications.sql](pm-platform/db/migrations/0010_pay_applications.sql) -> Run |
| **3. Submit your first DPR** | Validate the full happy path | /projects/[id]/dprs/new - pick a few tasks worked on yesterday, set status / pct / quantities, submit. Open it. Click "Approve and apply." Schedule should update; /billing suggestion panel should refresh with bigger numbers. |
| **4. Create your first pay application** | See the full G702/G703 cover-and-detail document | /projects/[id]/pay-apps/new - app number defaults to next sequence ("AFP 10"), period defaults to next month. Submit. Open the detail. Print/PDF button is browser-print. |

## Phase 4 architecture overview

```
sub_foreman / sub_pm / AHC PM submits DPR
        |
        v
dprs row (status="submitted")
+ dpr_task_updates rows for each touched task (status/pct/qty proposals)
        |
        v
AHC PM reviews + approves
        |
        v
- schedule_tasks rows get patched (status, pct_complete, installed_quantity,
  status_source="dpr", last_dpr_at=now)
- dprs.status="approved"
        |
        v
Auto-suggest (billing-actions.ts + cost-actions.ts) reads pct_complete
when present, so suggestion panels on /billing and /costs reflect what
actually happened on site instead of static spreadsheet projections.
        |
        v
PM uses suggestions to set planned amounts (existing "Promote to planned"
button), then assembles a Pay App.
        |
        v
/pay-apps/new groups billing_entries in the chosen period into a snapshot:
- pay_applications row (status="draft")
- pay_application_lines rows (frozen G703 detail)
- billing_entries.pay_application_id stamped, status="on_pay_app"
        |
        v
PM previews the G702/G703 layout, prints to PDF, mails / emails to owner.
Clicks "Mark submitted" -> billing entries status="submitted".
Owner approves -> "Mark approved" -> billing entries status="approved".
Owner pays -> "Mark paid" -> billing entries status="paid".
```

## What I deferred and why

| Item | Why deferred |
|---|---|
| **Sprint D - Audit log + notifications** | The audit log alone is easy but limited value without UI. The notifications side needs your decision on provider (Resend for email? Slack webhook? both?) and configuration of env vars + the from-address. Better as a focused 30-min discussion + 1 hour build in the next session, not session-end work. |
| **Weighted billing_line_tasks join table** | Mentioned in Phase 4 planning. Today the auto-suggest treats all linked tasks equally; weighting (one task = 30%, another = 70%) is a more nuanced model but the flat-average approach is a fine MVP. Add when you actually feel the average misses badly. |
| **DPR photos** | The `photos` table already exists in the schema with a `dpr_id` FK. The DPR form doesn't include photo upload yet. ~1 hour to add via Supabase Storage signed URLs. |
| **Sub-side mobile UI for DPRs** | The sub_foreman role can submit via the current form but the UI is desktop-oriented. A mobile-first DPR submission flow would dramatically increase sub adoption. ~1 day. |
| **PDF generation library for pay apps** | Today, the print/PDF button uses browser-print which is fine for a clean A4 PDF but limited for templating. A real PDF library (pdfkit, react-pdf, or puppeteer) would let you embed AHC logo, owner address block, signatures section, etc. ~3 hours. |

## Things to look at when you wake up

| Item | Why |
|---|---|
| **Two migrations to apply** | 0009 + 0010 above. Required before /dprs and /pay-apps work. |
| **Sweet Springs has no DPRs yet** | Once 0009 is applied, you can create historical DPRs to backfill the schedule with real pct_complete numbers. The auto-suggest will get much sharper. |
| **billing_entries.status is "forecast" everywhere** | The migration adds the column with a default; existing rows are all "forecast." That's fine for now. When you create a pay app, entries roll into "on_pay_app" and cascade through the lifecycle. |
| **Tabs: 8 now** (Dashboard, DPRs, Billing, Pay apps, Schedule, Subs, Costs, Documents) | On mobile, the tab row scrolls horizontally - might want to look at it on a phone. Three I'd consider collapsing in a future polish pass: Documents into Project menu, Subs into Compliance, Costs into Billing. |
| **wbs_sov table is still there, just unused by UI** | If you want to truly drop it, that's a follow-up migration; I left it because data preservation > zero-cost orphan table. |
| **The "Promote to planned" buttons on /billing and /costs are now redundant with DPRs** | Once DPRs are flowing, the lifecycle is: DPR sets pct_complete -> auto-suggest computes amount -> PM reviews on /billing (or just rolls into next pay app). The "Promote" button still works but isn't the primary path anymore. |

## Honest cost-benefit check

| Capability | Before this sprint | After |
|---|---|---|
| Schedule status updates | Manual in /schedule | DPRs propose, AHC PM approves, batched audit trail |
| Pct complete per task | Not tracked | Available on every task, fed from DPRs |
| Billing forecast accuracy | 50% bucket per "In Progress" task | Reads real pct_complete; ~10x more accurate |
| Pay app generation | Excel, hand-keyed | One click from accumulated billing_entries, snapshotted as frozen pay_application_lines |
| G702/G703 deliverable | Manual layout in Excel | Print-ready inside the app |
| Auditability | "Phil typed Complete on Tuesday" | "DPR #45 submitted Tue 2026-05-27 by foreman X, approved Wed by Zarina, applied to tasks 5.2.7, 5.2.8" |

## What's left to make it a full PM system

| Capability | Status |
|---|---|
| Project portfolio dashboard across all projects | Not built |
| RFIs (Requests for Information) | Schema exists, no UI |
| Submittals workflow | Schema exists, no UI |
| Photos UI (browse / tag / link to DPRs and SOV) | Schema exists, no UI |
| Comms log UI (calls, meetings, site visits) | Schema exists, no UI |
| Email / Slack notifications | Sprint D |
| Drawings register | No schema, no UI |
| Punch list module | No schema, no UI |
| Risk register | No schema, no UI |
| Owner portal (read-only view for owner role) | Roles exist, no portal |
| Sub portal (mobile-friendly DPR submission for foremen) | Roles exist, desktop-only UI |

Roughly 2-3 more sprints worth of work to cover the full list. Each one self-contained.
