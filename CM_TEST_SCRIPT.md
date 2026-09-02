# PM Platform - Construction Manager Test Script

A one-sitting walkthrough of the daily field-report loop. Do it in order; the
whole thing takes ~15 minutes. Use the **Test Project - Cash Flow** project.

## Logins (demo accounts)

| Role | Email | Password | What they can do |
|------|-------|----------|------------------|
| Construction Manager | `cm-demo@ahc.test` | `CMdemo2026!` | Review & approve field reports, file own daily log |
| Subcontractor (Civil) | `sub-civil@ahc.test` | `SubCivil2026!` | File a daily field report |
| Subcontractor (Pyramid) | `sub-pyramid@ahc.test` | `SubPyramid2026!` | File a daily field report |

Change these passwords after the test. Sign out fully between roles (top-right).

---

## Step 1 - Sub files a daily field report
Sign in as **sub-civil@ahc.test**.
1. Open the project -> **Field Reports** tab -> **New Field Report**.
2. Fill Day details: report date (today), crew count, hours per day (man-hours auto-calc), weather, work narrative.
3. Under **Work done - mark it on the map**, tap the site plan where the crew worked. A pin drops.
4. In the pin editor pick the **WBS / schedule item** (e.g. CIV-1.1), a **status**, **% complete**, **installed qty**, and attach at least one **photo**. Click **Save pin**.
5. (Optional) add Equipment / Deliveries / Delays / Safety.
6. Click **Submit Field Report**. It now shows **Submitted**.

**Expect:** the report appears on the Review Board as an amber (pending) dot.

## Step 2 - CM reviews and approves
Sign out, sign in as **cm-demo@ahc.test**.
1. Open the project -> **Field Reports**. The Review Board shows the pending report.
2. Open the report, click the pending work item.
3. **Attach an AHC verification photo** (Approve stays disabled until you do - this is intentional).
4. Add an optional note, click **Approve**. (Try **Reject** with a reason on a second pin to see it bounce back to the sub.)

**Expect:** report flips to **Approved**; the approved pin's % complete / quantity pushes onto the schedule.

## Step 3 - Confirm it drove the schedule
Still as CM: open the **Schedule** tab and find the task you pinned.

**Expect:** its % complete / installed quantity now matches the approved report, and the source shows it came from a field report.

## Step 4 - CM files own daily log
Still as CM: **My Daily Log** tab -> **New CM Daily Log**. Fill weather, site conditions, progress, safety, optional photos -> **Save daily log**. This is the CM's independent record; it is not part of the sub review cycle.

---

## Things to try to break it (please do)
- File two reports on the same task on **different dates**, approve the **newer** one, then approve the **older** one. The schedule must hold the **latest-dated approved** value and must NOT drag backward.
- Approve a report, then file a later report that **lowers** the % (a correction). The schedule should follow the correction down.
- Reject a pin and confirm the schedule does **not** move until an approval.
- Try approving without a verification photo (should be blocked).

## What to write down for each issue
Report name/date, which role you were in, what you clicked, what you expected, what happened. Screenshots help.
