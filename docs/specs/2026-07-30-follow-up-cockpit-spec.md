# Spec: Per-LO Follow-Up Cockpit (`/follow-up/moe`, `/follow-up/matt`)

**Date:** 2026-07-30 · **Mode:** Build · **Research:** `docs/research/2026-07-30-followupboss-api.md`

## Problem

Moe and Matt each work two client pools: GHL (active lead flow + pipeline, synced into Lumin) and
FollowUpBoss (past funded clients + future prospects — 1,983 / 4,214 people, currently worked via
manual quarterly tags like `MOE - 2026 Q3 - Follow up` and memory). Nothing answers, per LO:
**"who do I contact today, in what order, and why?"** FUB is invisible to Lumin entirely.

## Goal (v1)

One bookmarkable page per LO that merges both systems into a prioritized daily queue with
one-click snooze / log-touch. Complements — never duplicates — `/hot-leads` (team lead triage):
the cockpit pulls GHL **due/urgent items** and owns the **FUB book lifecycle**.

## Addendum 2026-07-30 (b) — Section restructure + Done button (SHIPPED, `f250bda`)

Efrain: "this page looks like a mess … I want there to be separate sections." The page is now four
`Panel` cards, each holding collapsible `Drawer` groups (label + count + chevron), replacing the flat
scroll of headings:

1. **FollowUpBoss tasks** — Overdue / Due today / Next 7 days. Each row: **Done** (completes in FUB) +
   Open in FUB.
2. **GHL leads — Pitching & App Intake** — the deals actually in play, split by last activity:
   *Activity in the last 7 days* vs *No activity in over 7 days*. Activity coalesces
   communication/inbound/outbound/contacted (all 143 open rows have at least one), so a fresh inbound
   reply pulls a lead into the recent group even when our last outbound is old.
3. **Dashboard tasks** — this LO's own `deal_tasks` (`assignee` = full name), grouped Overdue / Due
   today / Upcoming / No due date. Completing writes `completed_at` **and** fires the same
   `notifyTask('completed')` email `/tasks` sends, so the two surfaces can't drift.
4. **More follow-ups** — collapsed: replies, new leads, check-ins, FUB nurture + past clients. Nothing
   from the earlier build was deleted. Reply-waiting also raises a header banner (time-critical).

**Done button:** `POST /api/fub/tasks/complete` → `PUT /v1/tasks/:id {isCompleted:true}`. The key is
chosen from the STORED task's `assigned_user_id` (tasks are per-key in FUB — Moe's key cannot write
Matt's task), and an id we don't hold is rejected 404 instead of forwarded. `fub_tasks` holds open
tasks only, so the row is deleted on success rather than waiting for the sweep.

## Addendum 2026-07-30 — FUB tasks (SHIPPED, `dd3bfe2`)

Efrain: "show the FUB tasks due within the next 7 days on that page, and include a button on the task
that will take you to that lead on FUB." Delivered as a fourth section (below Due today):

- **`fub_tasks` table** — OPEN tasks only (977). Full-replace each sweep: a task missing from the sweep
  was completed or deleted, so it's removed. Tasks are per-key in FUB → `loan_officer` unambiguous.
- **Three groups:** Overdue (preview 10 + show-all; sorted most-recently-due first — Matt's backlog is
  583 deep and a 2-day-late task beats one from last October), Due today, Next 7 days.
- **Row:** task text (real notes, e.g. "Aarons credit tanked…"), person name + stage, due label, and an
  **Open in FUB** button → `nova.followupboss.com/2/people/view/<personId>`.
- **Pull filter is now task-aware:** an open task overrides the stage/idle rules (a scheduled task IS
  intent to follow up) — restored 53 people, 2,040 → 2,093.
- **Dates compare as LOCAL YMD strings** — `Date.parse('2026-07-30')` is UTC midnight = "yesterday" in PT.

## Non-goals (v1)

- No write-back to FUB or GHL (phase 2; FUB notes are rate-limited 10/10s) — including completing a
  task from the dashboard (`PUT /v1/tasks/:id`), the obvious next step now that tasks are visible.
- No FUB webhooks (owner-only — polling integration, verified).
- No cadence-config UI (fixed sensible defaults; `sync_state` config later).
- No Randy page (architecture keeps the slot open; he's FUB user 35).
- No new cron jobs (piggybacks the existing ghl-sync cron — Efrain's standing preference).

## Data

**New table `fub_people`** (file `supabase-fub-people.sql`, applied via the GOTCHAS DDL recipe):
mirror of useful person fields (`fub_id` PK, name, stage, source, `assigned_user_id`,
resolved `loan_officer`, emails/phones JSONB + `primary_email`/`primary_phone` normalized via
`normEmail`/`normPhone`, tags, price, deal_* flattened, `last_activity_at`, `fub_created_at`/
`fub_updated_at`, `custom_fields` JSONB) **plus cockpit state**: `next_action_due`, `next_action`,
`last_touched_at`, `last_touch_note`, `matched_deal_id`, `matched_deal_active`, `seen_by_keys`,
`last_seen_at`, `missing_since`. RLS: authenticated read/update, service-role writes (mirrors deals).

**Sync `POST /api/sync/fub`** (`lib/followUpBoss.ts` client):
- Full sweep of both keys (`FUB_API_KEY_MOE`, `FUB_API_KEY_MATT`), `limit=100`, follow
  `_metadata.nextLink` keyset cursors, ~63 requests total, ~150ms pacing, honor 429 `Retry-After`.
- Dedupe by `fub_id` (books overlap); **ownership = `assignedUserId`** (72→Moe, 13→Matt, 35→Randy)
  via `resolveLO`-style mapping, NOT which key fetched the row.
- Upsert: insert new (500-chunk), update rows whose `updated`/`lastActivity`/stage changed.
  Ids in DB but absent from sweep → stamp `missing_since` (deleted/unshared in FUB); queue excludes.
- **GHL cross-match:** normalized email/phone against deals → `matched_deal_id`,
  `matched_deal_active` (open, non-lost). Matched-active FUB rows are SUPPRESSED from the queue
  (GHL flow owns them) — prevents double-drive of the same person.
- Trigger: piggyback in `/api/cron/ghl-sync` `after()` with a 55-min `sync_state` interval guard
  (`fub_sync_last`) + manual `?force=1`; "Sync now" button on the page.
- Excluded stages at sync-query time: none (store all); queue-time filtering decides visibility.

## Queue model (`lib/followUpQueue.ts`, pure + fixture-tested)

Per LO, sections in priority order:

1. **🔥 Reply waiting** — GHL: `stage_events` inbound (`webhook_msg`) last 48h, deal open + this LO,
   current status still pre-Responded (already-working statuses live in /hot-leads).
2. **⏱ New leads** — GHL: open Leads-group deals created ≤72h (this LO). FUB: stage
   Lead/Attempting Contact created ≤7d, unmatched.
3. **📅 Due today** — `deals.next_action_due` ≤ EOD (existing check-in field — same one
   /hot-leads writes) + `fub_people.next_action_due` ≤ EOD. Overdue flagged.
4. **🕳 Nurture & stale (FUB)** — open-ish stages (Lead, Attempting/In Contact, Nurture*, App Link
   Sent, App Review, Pre Approved, In Escrow, Contact), unmatched, no future `next_action_due`;
   idle = max(`last_activity_at`, `last_touched_at`); buckets **7–30d / 31–90d / 90d+**, capped
   display with counts (Moe has Jan-2025 leads — buckets stop the drown).
5. **💤 Past clients & closed (FUB)** — Past Client/Closed stages: refi-farming pool, same buckets.
6. **🧊 Cold** (Unresponsive/Inactive) — collapsed, off by default. Trash/Referred Out: excluded.

Ranking inside sections: overdue-first, then price desc, then idle-days desc. Every row shows a
plain-English reason chip ("replied 3h ago", "idle 42d, pre-approved, $510k").

## Page (`app/follow-up/[lo]/page.tsx`, client component like /hot-leads)

- `lo` ∈ {`moe`, `matt`} → LO name + `LO_COLORS` accent; else 404. `/follow-up` index = two cards
  with per-LO counts (manager glance) + sidebar item "Follow-Up" (pipeline group).
- Header: counts strip per section, "Synced Xm ago" from `sync_state`, Sync-now button,
  link to /hot-leads.
- Rows: name, system badge (GHL/FUB), stage pill, price, idle days, reason chip, actions:
  - **Snooze** 1d/3d/1w/2w/1m/custom → writes `next_action_due` (+ optional note) on the right
    table (deals vs fub_people) — GHL snoozes flow into the existing /hot-leads Check-ins tab too.
  - **✓ Touched** → FUB row: `last_touched_at=now` + optional note + quick next-due suggestion;
    GHL row: `stage_events` insert `source='cockpit'` (no schema change — TEXT column).
  - Deep links: GHL per-sub-account URL (existing pattern), FUB
    `https://app.followupboss.com/2/people/view/<fub_id>` (verify once live).

## Acceptance criteria

1. `/api/sync/fub?force=1` populates `fub_people` ≈ 1,983 + 4,214 minus overlap dedupe; re-run is
   idempotent (0 inserts on unchanged data); Moe/Matt attribution matches `assignedUserId` 72/13.
2. `/follow-up/moe` and `/follow-up/matt` render all sections with only that LO's rows; a FUB person
   matching an active GHL deal appears ONLY as the GHL row.
3. Snooze on a FUB row survives the next sync sweep (cockpit-state columns never overwritten by sync).
4. Snooze on a GHL row shows up in /hot-leads Check-ins (same field, no divergence).
5. `scripts/follow-up-check.ts` fixture suite passes; all 17 existing suites still pass;
   `tsc --noEmit` still exactly 7 pre-existing errors; `next build` clean.
6. Deployed to prod with FUB env vars in Vercel; visible sync timestamp on page.

## Risks

- **Sync-state overwrite**: sync must NEVER write the cockpit-state columns (explicit column list,
  like the GHL sync's maybeSet discipline). Covered by fixture + acceptance 3.
- **Agent-key visibility drift**: if FUB reassigns people, rows flip owner on next sweep — correct
  behavior, but counts will move; `seen_by_keys`/`missing_since` make it observable.
- **PII**: FUB rows are client PII — RLS mirrors deals (no anon reads); keys env-only.
