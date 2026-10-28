# Email sweep: schedule events from Sussex email

The weekday Email Sweep on the Mac Mini reads Sussex mail and writes what it
finds to the Email updates page. This folder is the app side. The sweep's own
steps live on its Notion runbook card, which points here for the event format.

## Run

```
npm run email:ingest -- --file /path/to/events.json --dry-run   # see what would happen
npm run email:ingest -- --file /path/to/events.json             # write it
```

Needs `.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (already on the Mac Mini). Optional `APP_URL` puts
a link to the page in the Chat message.

The script prints a JSON report. If `chat` is not null, post it to the
Google Chat DM. If the exit code is not 0, log the run as failed.

## Event format

One event per thing an email reports. Two kinds today.

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
| Same email and change already recorded | No-op |
