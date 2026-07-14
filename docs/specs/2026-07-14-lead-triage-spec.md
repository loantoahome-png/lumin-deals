# Lead Triage System — 7-Day Decision Clock + Check-in Resurfacing

**Date:** 2026-07-14 · **Requested by:** Efrain · **Status:** Approved (directions confirmed via Q&A)

## Goal

No lead falls through the cracks. Every new lead gets a **direction within its first 7 days**:
1. **App Intake** (push forward),
2. **Not Ready - Timeframe** (nurture, with a REQUIRED check-in date), or
3. **Remove from All Automations** (dead).

And Not Ready - Timeframe leads must **resurface when their check-in date arrives** so they're never forgotten.

## Confirmed directions (Efrain, 2026-07-14)

- **Scope:** every new lead — clock starts at lead creation (`date_added_ghl || created_at`).
- **Reminders:** in-dashboard triage queue + auto-created tasks (deal_tasks, like the 2nd-callback rule).
- **Placement:** new tabs on the Hot Leads page.
- **Check-ins:** required date when moving to Not Ready - Timeframe; resurfacing queue.

## Grounding census (prod DB, 2026-07-14, read-only service-role)

> CORRECTION (post-launch): the census script hit PostgREST's 1000-row cap, so these figures were undercounts.
> Live page (paginated, verified on prod DOM 2026-07-14): **1,444 undecided open leads** — 64 on-clock (0–4d),
> 65 decision-due (5–7d), 542 overdue (8–30d), 773 backlog (>30d) — and **174 open Not Ready - Timeframe leads,
> all with no check-in date**. Direction of all conclusions unchanged, magnitudes larger.

- Undecided open leads: ~~881~~ (truncated; see correction above).
- Not Ready - Timeframe open with a check-in date set: **0** (confirmed — live "No date set" = all 174).

Consequences: (a) the triage tab must split the current cohort from the >30d backlog and offer **bulk disposition**;
(b) auto-tasks fire only for leads aged **5–8 days** (forward-looking), never the backlog, else the first cron run
creates hundreds of tasks/emails.

## Definitions

- **Undecided** (on the 7-day clock): `ghl_status` open AND status ∈
  `New Lead, Attempted Contact, Ghosted, Responded, Pitching, Appointment Booked`.
- **Decided:** status = App Intake or beyond (Arive Lead, Qualification, Pre-Approved, Loans in Process, Funded),
  OR any Not Ready status, OR `ghl_status` lost/abandoned.
- **Clock anchor:** `date_added_ghl || created_at`. Day tiers: 0–4 on-clock · 5–7 decide-now · 8–30 overdue ·
  >30 backlog.
- **Check-in date:** stored in the EXISTING `next_action_due` (+ `next_action` text `Check in: …`) on the deal —
  the sync/webhook never write these fields, so no DB migration is needed. Check-in tiers for open
  Not Ready - Timeframe leads: no-date · overdue · due ≤7d · scheduled.

## UI — Hot Leads page, 4 tabs

1. **Triage (first 7 days)** — NEW, first tab. All undecided leads (LO filter applies), grouped by tier,
   most urgent first. Row: name, GHL link, status badge, day counter ("Day 5 of 7" / "Day 23 ⚠"), source,
   LO, last inbound/outbound, unread + DND badges. Per-row disposition buttons: **App Intake**,
   **Not Ready - Timeframe** (opens required-date modal), **Remove from Automations** (confirm), plus a
   "more" menu (Ghosted, Appointment Booked, other statuses). Bulk select → same three dispositions
   (bulk NRT modal applies one date to all). Backlog (>30d) section collapsed by default.
2. **Responded / Pitching** — existing tracker, unchanged.
3. **App Intake** — existing tracker, unchanged.
4. **Check-ins** — NEW. Open Not Ready - Timeframe leads in sections: **Overdue**, **Due this week**,
   **Scheduled**, **No date set** (the 115 backlog — button to set a date). Row actions:
   **Re-engage** (→ Responded, clears check-in), **Reschedule** (date modal), **App Intake**,
   **Remove from Automations**.

Required-date modal (shared): presets +1/+2/+3/+6 months, custom date, optional note. Writes
`{status:'Not Ready - Timeframe', pipeline_group:'Not Ready', next_action:'Check in…', next_action_due}` and
pushes the stage to GHL (existing `pushStageToGHL`).

## Auto-tasks (no new cron job — piggybacks on the 15-min ghl-sync, like `runSecondCallbackCheck`)

`runTriageTaskCheck()` in `app/api/cron/triage-tasks/route.ts`, invoked from the ghl-sync route:

- **Decision task:** undecided + open + age **5–8 days** → task `Triage decision — {name}`, due = day-7 date,
  assignee = deal LO, priority high. Dedup: skip deals that already have a task with that exact title.
  Cap 25 creations/run. (Randy's leads included — task assignee "Randy…" has no email mapping, so the task is
  created without an email; emails go out for Matt/Moe per the existing `notifyTaskEmail` mapping.)
- **Check-in task:** open Not Ready - Timeframe + `next_action_due` within [now−3d, now+24h] → task
  `Check in — {name} (due M/D)`, assignee = deal LO. Dedup on exact title. Cap 25/run.
  (Rescheduling produces a new title → a new task when the new date arrives.)

Also exposed as an authed GET (CRON_SECRET) for manual runs, same as second-callback.

## Data / fetch

The page currently fetches only the 3 hot statuses (with `raw_ghl_data`, which the tracker's stage-time fallback
needs). Add a second paginated fetch for the extra statuses (`New Lead, Attempted Contact, Ghosted,
Appointment Booked, Not Ready - Timeframe`) using `DEAL_COLUMNS` (no blob — triage/check-ins only need real
columns). Merge client-side; LO filter + lost/abandoned exclusion apply to all tabs.

## Out of scope (v1)

- No NotificationBell / email-digest changes (not selected).
- No %-decided-within-7d analytics (needs decided-at history; revisit with stage_events once webhook coverage grows).
- GHL-side automation removal is GHL's job — moving the stage to "Remove from All Automations" triggers whatever
  workflow Efrain has wired there; the dashboard only moves the stage.

## Known edges (accepted)

- A re-engaged check-in lead (→ Responded) re-enters the triage clock anchored to its ORIGINAL creation date, so it
  shows as overdue/backlog. Truthful (it IS an old lead) but slightly noisy; revisit if it bothers the team.
- The 557-lead >30d backlog stays until the team bulk-cleans it from the Backlog section.
