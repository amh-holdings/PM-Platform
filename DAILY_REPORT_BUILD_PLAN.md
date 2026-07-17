# Daily Report Build Plan - CM + Subcontractor

Turns the daily-report audit into a sequenced, buildable plan. Each phase is a
self-contained slice that ships and gets used before the next starts. Grounded in
the current schema (migrations through `0025`) and the existing form/actions.

Legend: lift = rough build size (S = <1 day, M = 1-3 days, L = 3-6 days).

---

## Sequencing at a glance

| Phase | Theme | Why it is in this order | Sprints |
|-------|-------|-------------------------|---------|
| 0 | Foundation + debt paydown | Unblocks weather and solar; fixes the "lost my report" trust killer | 1 |
| 1 | P0 field adoption (weather, copy-day, offline) | Nothing else matters if subs will not fill it out | 2-3 |
| 2 | Solar differentiator (quantities, MW, weather holds) | This is how we beat Procore/Raken, not just match them | 2 |
| 3 | AI + capture speed (voice, AI summary) | Biggest adoption lever after the P0 basics | 1-2 |
| 4 | Table-stakes close-out (e-sign, distribution, cost, audit) | Claims defense and completeness | 2 |

Hard dependency chain: **0 (project lat/long) -> 1a (weather) and 2a (MW rollup)**.
Email provider account is required before 4b (auto-distribution).

---

## No-API build is the default

Only three items call a third-party API, and each has a no-key fallback that keeps
the value. The default build path skips all external calls until you choose to turn
them on:

| Item | Phase | No-API fallback |
|------|-------|-----------------|
| Auto-weather | 1a | Keep the structured weather fields (conditions, hi/lo, precip) but fill them manually. Wire the fetch later - same fields |
| AI daily summary | 3b | Skip; the narrative stays manual. Nothing else in Phase 3 depends on it |
| Auto-distributed PDF email | 4b | Keep the existing print/download-to-PDF and send it yourself |

Voice-to-text (3a) looks like an API but is not - it uses the browser's built-in
Web Speech API (free, no key). Everything else in every phase is fully self-contained.

## External accounts / keys needed (only when you turn on the API-optional items)

| Item | Used by | Notes |
|------|---------|-------|
| Weather API key (OpenWeather One Call or Visual Crossing) | Phase 1a | Visual Crossing has generous free tier and is what Fieldwire uses. Store as `WEATHER_API_KEY` in Vercel env |
| Geocoding (can reuse the weather provider or Google) | Phase 0 backfill | One-time: zip -> lat/long per project |
| Anthropic API key on the server | Phase 3b AI summary | This is a SEPARATE server-side key in Vercel env, not the Claude Code subscription. The extract/chat features already use one - reuse that same key |
| Email provider (Resend recommended) | Phase 4b | For auto-distributed PDF. `RESEND_API_KEY` |

---

## Phase 0 - Foundation + debt paydown  (1 sprint)

Goal: stop losing reports, harden inputs, and add the project location that weather
and MW rollups both need.

### 0a. Project location  (lift: S)
- Migration `0026_project_location.sql`: `alter table projects add column latitude numeric(9,6), add column longitude numeric(9,6), add column timezone text;`
- One-time backfill script `scripts/backfill-project-geo.ts`: geocode `zip_code` -> lat/long/timezone for existing projects.
- Add lat/long/timezone to the project edit form ([edit/](src/app/(app)/projects/[id]/edit/)) with a "look up from zip" button.
- Acceptance: every active project has coordinates; new projects prompt for them.

### 0b. Autosave / draft  (lift: S)
- In [dpr-form.tsx](src/app/(app)/projects/[id]/dprs/new/dpr-form.tsx): persist the full form state to `localStorage` keyed by the existing `draftId` + projectId, debounced. Restore on mount if a draft exists (with a "restore unsaved report?" prompt). Clear on successful submit.
- Acceptance: fill half a report, refresh the page, the data is still there.

### 0c. Input validation  (lift: S)
- Report date: required, not in the future, warn on duplicate (same sub + date already submitted).
- Numeric fields (crew, hours, headcount, hours-lost, installed qty): reject negatives, enforce sane maxima, show inline errors instead of silent `|| 0/1` coercion.
- Acceptance: bad input blocks submit with a clear message next to the field.

### 0d. Remove the 200-row task cap + unify units  (lift: M)
- Replace the `.slice(0, 200)` schedule-task table with a virtualized/paginated list so every task is reachable.
- Make delivery UoM use the same `UNIT_OPTIONS` dropdown as pins (drop the free-text field).
- Acceptance: task 201 is selectable; units are consistent across the form.

Deferred debt (track, do not block): consolidate the two man-hour truths and the
two photo uploaders. Note in code, revisit after Phase 1.

---

## Phase 1 - P0 field adoption  (2-3 sprints)

### 1a. Auto-weather  (lift: M)  [needs 0a]
- Migration `0027_dpr_weather.sql`: `alter table dprs add column weather_temp_high numeric, weather_temp_low numeric, weather_precip_in numeric, weather_source text, weather_fetched_at timestamptz;` (keep existing free-text `weather_conditions` as the human summary).
- New `src/lib/weather.ts`: `getDailyWeather(lat, lng, date)` server util hitting the weather API; normalize to {conditions, hi, lo, precip}.
- Server action `fetchReportWeather(projectId, date)` in a new `weather-actions.ts`.
- In dpr-form: on date/project select, auto-fetch and prefill conditions + hi/lo (editable), and auto-suggest a "weather" delay row when precip or extreme temp crosses a threshold.
- Acceptance: opening a new report auto-fills conditions and hi/lo from the site location; the value is editable and stored on the report and print/PDF.

### 1b. Copy-previous-day  (lift: M)
- Server action `getPreviousReportScaffold(projectId, subId)`: returns the last submitted report's equipment rows, crew roster, and sub list, plus a skeleton of still-open pins.
- "Copy yesterday" button in the form header: brings those forward with headcount/hours/quantities zeroed so numbers are re-verified (Procore's model).
- Acceptance: one tap pre-fills the equipment and crew skeleton with counts blanked.

### 1c. Real offline capture  (lift: L)
- Replace the shell-only [sw.js](public/sw.js) with a Workbox setup.
- Queue the `submitFieldReport` payload and staged photo blobs in IndexedDB when offline; background-sync on reconnect.
- Photos: stage to IndexedDB, upload to storage on sync, then write metadata rows.
- UI: a "pending sync (N)" indicator; per-report "queued / synced" state.
- Acceptance: fill and submit a full report with photos in airplane mode; it queues; on reconnect it uploads and appears normally with no data loss.

---

## Phase 2 - Solar differentiator  (2 sprints)

### 2a. Solar quantity primitives + MW rollup  (lift: M)  [leans on existing schedule_tasks quantity columns]
- Extend `UNIT_OPTIONS` in dpr-form with solar-first units: `PILE`, `MODULE`, `ROW`, `STRING`, `MW`, `MWdc`, plus keep `LF`, `EA`.
- Migration `0028_solar_production.sql`: `alter table projects add column dc_capacity_mw numeric, add column module_watts numeric;` and `alter table dprs add column mw_installed_today numeric;` (or derive from module pins x module_watts).
- New dashboard component `dashboard-production.tsx`: MW installed to date vs plan (sum approved module/MW quantities), plus piles/rows/strings to-date counters. Wire into [page.tsx](src/app/(app)/projects/[id]/page.tsx).
- Tie approved pin `installed_quantity` to the SOV/billing line via the existing `schedule_tasks` link so production rolls into earned value.
- Acceptance: dashboard shows MW-to-date vs plan and component counters; pins accept solar units; approved quantities move the MW number.

### 2b. Weather-hold + heat/lightning/wind logging  (lift: M)
- Migration `0029_weather_holds.sql`: `create table dpr_weather_holds (id, dpr_id, hold_type text check (hold_type in ('heat','lightning','high_wind','ground','other')), started_at, ended_at, lost_hours numeric, notes text, created_at);`
- New "Safety holds" section in the form: pick type, start/stop, auto-compute lost hours, optional radius/notes. Auto-mirror lost hours into a delay row for claims.
- Surface holds on the report, print/PDF, and a project-level "lost hours by cause" tile.
- Acceptance: log a lightning hold 13:00-14:30; 1.5 lost hours auto-computed, shows in delays and on the PDF.

---

## Phase 3 - AI + capture speed  (1-2 sprints)

### 3a. Voice-to-text  (lift: S)
- Add a mic button to the work narrative, pin notes, and safety fields using the browser SpeechRecognition API; graceful fallback where unsupported.
- Acceptance: dictate a narrative on a phone and it fills the field.

### 3b. AI daily summary  (lift: M)  [reuses existing AI infra]
- Server action `summarizeReport(dprId)` reusing the Anthropic client already behind [extract-actions.ts](src/app/(app)/projects/[id]/extract-actions.ts): compile pins + weather + manpower + delays + holds into a clean narrative.
- Migration `0030_dpr_ai_summary.sql`: `alter table dprs add column ai_summary text, add column ai_summary_at timestamptz;`
- "Summarize my day" button; store and show on detail + print/PDF.
- Acceptance: one click turns the structured entries into an owner-ready paragraph.

---

## Phase 4 - Table-stakes close-out  (2 sprints)

### 4a. E-signature sign-off  (lift: M)
- Migration `0031_dpr_signatures.sql`: `create table dpr_signatures (id, dpr_id, role text, signer_id, signer_name, signed_at, signature_svg text);`
- Signature pad for sub foreman on submit and CM on approval; lock the report once both sign; show signatures on the PDF. Upgrade the existing `sub_acknowledged_at` flag into a real signature.
- Acceptance: signed reports are immutable and the PDF carries both signatures.

### 4b. Auto-distribution PDF  (lift: M)  [needs email provider]
- Migration `0032_project_distribution.sql`: `create table project_distribution_lists (id, project_id, email, role, active);`
- Server-render the print route to PDF on approval and email it via Resend to the distribution list.
- Acceptance: approving a report emails a branded PDF to the configured recipients.

### 4c. Labor-hours to cost  (lift: M)
- Map `dpr_manpower` rows to `cost_codes` + a rate; compute daily labor cost; feed the Costs tab.
- Migration `0033_manpower_cost.sql`: add `cost_code_id`, `bill_rate` to `dpr_manpower`.
- Acceptance: a report with 5 workers x 8 hrs x rate shows a daily labor dollar in Costs.

### 4d. Equipment operating vs idle hours  (lift: S)
- Migration `0034_equipment_hours.sql`: add `operating_hours`, `idle_hours` to `dpr_equipment`.
- Acceptance: equipment rows capture operating vs idle time.

### 4e. Structured safety + toolbox talk  (lift: S)
- Replace the single-line safety narrative with: toolbox-talk topic, observations (repeatable), and safety-tagged photos.
- Acceptance: a report can log a toolbox talk and multiple observations with photos.

### 4f. Immutable change history  (lift: M)
- Migration `0035_dpr_audit.sql`: `dpr_audit_log` table + triggers capturing every edit with user + timestamp; render a change-history panel.
- Acceptance: every edit to a report is logged and viewable; signed reports cannot be silently altered.

### 4g. Internal vs external visibility  (lift: S)
- Per-entry `visibility` flag (internal / owner-visible) on notes, photos, and holds; filter the owner PDF accordingly.
- Acceptance: an internal note is excluded from the owner-facing PDF.

---

## What we protect (do not regress)

The winning core, confirmed in the audit, must survive every refactor:
1. Sub self-reports the full daily (manpower + production), which Procore cannot do.
2. Work pinned on the site drawing and tied to WBS schedule tasks.
3. Mandatory CM verification photo before approval.
4. Approved production auto-drives schedule %-complete with latest-dated-approved-wins.

---

## Suggested first cut

Ship Phase 0 + Phase 1a + 1b in the first two sprints. That alone (autosave,
validation, auto-weather, copy-previous-day) removes the top adoption blockers and
is low risk. Offline (1c) and the solar layer (Phase 2) follow once the basics are
proven in the field.
