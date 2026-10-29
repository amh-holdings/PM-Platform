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

One event per thing an email reports. Nine kinds today: three schedule kinds (completed, started, planned date), sub pay applications, COI and W-9, AFP status, AFP paid, inspection results and change orders.

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
    },
    {
      "project": "Sussex",
      "kind": "schedule_complete",
      "basis": "invite",
      "task_hint": "90% page turn",
      "wbs_code": "1.2.1.3.3",
      "date": "2026-10-28",
      "evidence": "Civil 90% Page Turn - Sussex CSG 1 LLC (DE), Wed Oct 28 1:00-2:00 PM",
      "source": { "message_id": "1a1559f9657556de", "from": "jmerriman@dimension-energy.com", "subject": "Civil 90% Page Turn - Sussex CSG 1 LLC (DE)" }
    },
    {
      "project": "Sussex",
      "kind": "schedule_start",
      "basis": "invite",
      "task_hint": "90% design internal review",
      "wbs_code": "1.2.1.3.2",
      "date": "2026-10-29",
      "evidence": "Civil 90% page turn held 10/28, internal review starts the next business day",
      "source": { "message_id": "1a1559f9657556de", "from": "jmerriman@dimension-energy.com", "subject": "Civil 90% Page Turn - Sussex CSG 1 LLC (DE)" }
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
- **change_order**: only when there is documentation that calls it a change
  order: a change order request, a CO proposal, a signed CO, or a directive
  issued as a CO. Put the document's name or number in `reference` and the
  sentence that names it in `evidence`. New scope, extra work that "may be
  required", a revised proposal or an offer to draft a CO is **not** a change
  order yet: write nothing. The script refuses a change order whose reference
  and evidence never say "change order" or CO. Never include a price. CO
  pricing stays manual.

## Rules for writing events

- **schedule_complete** only when the email says it already happened:
  a permit issued, a page turn held, a design package submitted or returned,
  NTP or LNTP issued, equipment delivered to site, an inspection passed.
  The date is the day it happened, as the email states it. If there's no
  date in the email, use the date the email was received.
- **Page turns from meeting invites.** Every run also searches Gmail for
  `subject:"page turn" newer_than:30d`, because the invite usually arrives a
  week or more before the meeting. Read the invite's "When:" line (forwards
  carry it inside the forwarded message). A page turn whose meeting ended in
  the last 2 days is a `schedule_complete` with `"basis": "invite"`, dated
  the meeting day, `source.message_id` the invite's message id and
  `source.from` the organizer from the forwarded "From:" line. Skip
  "Canceled:" invites, automatic replies and accept/decline notices, and use
  the latest invite when a meeting was moved. It is only proposed: an invite
  does not prove the meeting was held. Use the subject's discipline and
  package (civil 90%, electrical IFP) and set `wbs_code` to the matching DE
  Page Turn or IFP Page Turn task under that discipline and package.
- **schedule_start** when work on a task has begun. A page turn held starts
  that package's internal review the next business day: write a
  `schedule_start` for the review task in the same package (for the civil
  90% page turn, `1.2.1.3.2 90% Design - Internal Review`), dated the next
  business day after the page turn, or today if that is earlier. Same basis
  and source as the page turn. Only proposed.
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
| Completion read from a meeting invite | Proposed, waits for a person to confirm it was held |
| Start, one match | Proposed. Approving it marks the task In Progress from that date |
| Start on a task already started or complete | Skipped, reported |
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
| Change order with CO documentation | Waits for a person. Raise the CO by hand in Change orders |
| Change order with no CO documentation | Skipped, reported |
| Same email and change already recorded | No-op |
