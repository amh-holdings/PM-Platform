# Email sweep: schedule events from Sussex email

The weekday Email Sweep on the Mac Mini reads Sussex mail and writes what it
finds to the Email updates page. This folder is the app side. The sweep's own
steps live on its Notion runbook card, which points here for the event format.

## Run

```
npm run email:ingest -- --file /path/to/events.json --dry-run   # see what would happen
npm run email:ingest -- --file /path/to/events.json             # write it
```

Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, from
`.env.local` on the Mac Mini or from the environment's variables in a cloud
session (where there is no `.env.local`). Optional `APP_URL` puts
a link to the page in the Chat message.

The script prints a JSON report. If `chat` is not null, post it to the
Google Chat DM. If the exit code is not 0, log the run as failed.

## Event format

One event per thing an email reports. Eight kinds today: two schedule kinds, sub pay applications, COI and W-9, AFP status, AFP paid, inspection results and possible change orders.

```json
{
  "events": [
    {
      "project": "Sussex",
      "kind": "schedule_complete",
      "task_hint": "building permit",
      "date": "2026-10-27",
      "evidence": "Building Permit BP-2026-0412 has been issued.",
      "source": {
        "message_id": "1a17e94b88d897b0",
        "url": "https://mail.google.com/mail/u/0/#all/1a17e94b88d897b0",
        "from": "landmark@sussexcountyde.gov",
        "subject": "Permit Issued - BP-2026-0412",
        "received_at": "2026-10-27T14:02:00Z"
      }
    },
    {
      "project": "Sussex",
      "kind": "schedule_constraint",
      "task_hint": "electrical IFC page turn",
      "date": "2026-11-14",
      "constraint_type": "FNLT",
      "evidence": "We will hold the electrical IFC page turn no later than 11/14.",
      "source": { "message_id": "...", "from": "mhopwood@purepower.com", "subject": "RE: Page turn" }
    }
  ]
}
```

### Sub pay applications

When a sub emails a pay application, read the G702 and G703 from the
attachment and write one `sub_pay_app` event.

```json
{
  "project": "Sussex",
  "kind": "sub_pay_app",
  "subcontractor": "Southern Commercial Solutions",
  "bill": {
    "app_number": 3,
    "period_start": "2026-10-01",
    "period_end": "2026-10-31",
    "invoice_number": "SCS-1031",
    "billed_this_period": 12500.00,
    "billed_to_date": 48200.00,
    "retainage_this_period": 1250.00,
    "retainage_to_date": 4820.00,
    "amount_due": 11250.00,
    "lien_waiver_received": true
  },
  "lines": [
    { "item_number": "1", "this_period": 10000.00 },
    { "item_number": "2", "this_period": 2500.00, "stored": 0 }
  ],
  "source": { "message_id": "...", "from": "redwards@scsofga.com", "subject": "SCS Pay App 3" }
}
```

- `lines` holds only the G703 lines with a this-period or stored figure, each
  under the item number exactly as printed on the G703.
- Copy figures exactly. Leave a header figure out if it can't be read. Never
  work one out.
- The script enters the bill as **Received**, the same as Record a bill, and
  runs the checks. That only starts the review: the bill still needs the CM's
  recommendation and an approval. It does this only when the sender is the
  sub's own domain, the company matches one sub, every line is on the sub's
  SOV, the lines add up to the G702 this-period figure within $1, and the
  application number isn't already on file. Otherwise the email waits on the
  page as Needs a match, with the reason, for a person to enter by hand.
- Undo removes the bill, as long as nobody has recommended or decided it yet.

### COI and W-9, AFP status and payment, inspections, change orders

```json
{ "kind": "compliance_doc", "project": "Sussex", "subcontractor": "Pyramid Excavation",
  "doc": "coi", "expires_on": "2027-10-01", "source": { "...": "..." } }

{ "kind": "afp_status", "project": "Sussex", "afp_number": "AFP 13",
  "note": "Received, under review", "source": { "...": "..." } }

{ "kind": "afp_paid", "project": "Sussex", "afp_number": "AFP 13",
  "paid_on": "2026-10-24", "amount": 212400.00,
  "evidence": "Payment for AFP 13 was released 10/24.", "source": { "...": "..." } }

{ "kind": "inspection_result", "project": "Sussex", "task_hint": "electrical rough inspection",
  "result": "passed", "date": "2026-10-27", "inspector": "Sussex County",
  "evidence": "Inspection result: APPROVED", "source": { "...": "..." } }

{ "kind": "change_order", "project": "Sussex", "title": "Fence relocation",
  "reference": "Revised proposal 10/25", "evidence": "...", "source": { "...": "..." } }
```

- **compliance_doc**: a COI or W-9 sent for a sub. `doc` is `coi` or `w9`.
  Write it even when it comes from an insurance broker. The script holds a
  broker's email for a person rather than dropping it.
- **afp_status**: the owner saying where an AFP stands. `note` is their words,
  one line.
- **afp_paid**: the owner saying an AFP was paid. `paid_on` is the payment
  date and `amount` is the amount paid, if the email gives one.
- **inspection_result**: a third-party or owner inspection, `passed` or
  `failed`, on the date of the inspection.
- **change_order**: anything that reads like new scope, a directive or a
  revised proposal. Never include a price. CO pricing stays manual.

## Rules for writing events

- **schedule_complete** only when the email says it already happened:
  a permit issued, a page turn held, a design package submitted or returned,
  NTP or LNTP issued, equipment delivered to site, an inspection passed.
  The date is the day it happened, as the email states it. If there's no
  date in the email, use the date the email was received.
- **schedule_constraint** when the email commits to a future date, such as a
  page turn set for a date or a permit expected by a date. Pick the
  constraint type that fits the wording: "no later than" is FNLT, "on" is
  MFO, "not before" is SNET.
- **Never** write an event from a daily report, a percent complete, a price,
  or an opinion. Daily progress comes from field reports only.
- `task_hint` uses the email's own words for the task, kept short. Don't guess
  a WBS code. Set `wbs_code` only if the email quotes one.
- `evidence` is the exact sentence that says so, copied, not paraphrased.
- `source.from` is the **original** sender. Mail forwarded from
  `phorwitch@americanhelios.com` has the real sender inside the forward
  ("From:" line of the forwarded message). If it can't be found, leave the
  forwarder as the sender and the script will skip it.
- When unsure, still write the event. The script decides. It only applies a
  completion that matches exactly one deliverable, procurement or inspection
  task. Everything else becomes a proposal or an unmatched row for a person.

## What the script does with each event

| Event | Result |
|---|---|
| Sender not on the project list (`config/email-sweep.json`) | Skipped, reported |
| No single task matches | Unmatched row, waits for a person |
| Completion, one match, passes the checks | Applied now, with Undo |
| Completion on a construction task, a future date, or already done | Skipped, reported |
| Planned date, one match | Proposed, waits for a person |
| Pay app, all checks pass | Entered as Received, checks run, with Undo |
| Pay app, any check fails | Needs a match, with the reason |
| Pay app number already on file | Skipped, reported |
| COI or W-9, sender on the list or the sub's own domain | Marked received, with Undo |
| COI or W-9 from anyone else (a broker) | Waits for a person, saying who sent it |
| COI or W-9 already on file | Skipped, reported |
| AFP status note | Added to the AFP's notes, with Undo |
| AFP paid | Waits for a person, with any short pay called out. Approving it marks the AFP and its billing entries paid |
| Inspection passed | Waits for a person. Approving it marks the inspection task complete |
| Inspection failed | Waits as a heads-up. Nothing changes |
| Possible change order | Waits for a person. Raise the CO by hand in Change orders |
| Same email and change already recorded | No-op |
