# GHL tasks on the dashboard board — two-way

**Date:** 2026-08-03
**Ask (Efrain):** "is there a way we can display tasks from GHL on our dashboard task list" → "lets do two way"

## Problem

GoHighLevel keeps its own per-contact tasks. They were invisible on the dashboard,
so `/tasks` showed roughly a quarter of the team's real workload: **65 open GHL
tasks** (18 primary + 47 Matt) against 20 open `deal_tasks` at build time.

## API research (all verified live, not from docs)

| Endpoint | Result |
|---|---|
| `POST /locations/{locationId}/tasks/search` | **201** — location-wide, `searchAfter` keyset cursor, includes `assignedToUserDetails` (names) + `contactDetails`. The one to use. |
| `GET /locations/{locationId}/tasks?isLocation=true` | 200 — thinner, `assignedTo` is a raw user id |
| `PUT /contacts/{contactId}/tasks/{taskId}/completed` `{completed:true}` | **200** — the write-back |
| `POST` / `DELETE /contacts/{contactId}/tasks[/{id}]` | 201 / succeeded (used to test, then cleaned up) |
| `POST /tasks/search`, `POST /contacts/tasks/search`, `GET /tasks?locationId=`, v1 `/tasks` | 404 — the obvious guesses are all wrong |

`completed:false` genuinely filters (18 open + 8 completed = 26 unfiltered on primary;
47 + 11 = 58 on Matt's) — checked rather than trusted, per the FUB silent-param lesson.

⚠️ The search row carries **no body/description** — only the single-task GET does.
Titles are full sentences, so v1 renders the title alone rather than paying one extra
GET per task per sweep.

## Design

- **`ghl_tasks` table** (`supabase-ghl-tasks.sql`) — OPEN tasks only, full-replace per
  sweep, exactly like `fub_tasks`. A task that leaves the sweep was completed or deleted
  in GHL; either way it leaves the board. No completed history — GHL owns that.
- **Sweep** (`lib/ghlTaskSync.ts`) runs inside `runGhlSync` *after* the deal sync, so a
  task on a brand-new contact resolves its `deal_id` on the same pass. A location whose
  fetch fails is **never pruned** — one bad response must not wipe an LO's task list.
- **Deal resolution:** a GHL task points at a CONTACT, and a contact can own several
  deals, so there is no correct answer — the rule is *most recently created deal*.
  65/65 matched at build time.
- **Assignee:** `resolveLO(assignedToUserDetails)`. GHL says "Matthew Park", the board
  column is "Matt Park" — getting this wrong doesn't error, it silently dumps 29 tasks
  into "Unassigned & other". Covered by a fixture.
- **Board integration:** `toBoardTask()` adapts a row into the `DealTask` shape the
  board already renders (`BoardTask = DealTask & {source:'ghl', …}`), with the id
  namespaced `ghl:<taskId>` so it can never collide with a `deal_tasks` uuid. Every
  existing filter, chip, column, bucket and sort works unchanged.
- **Two-way:** the checkbox POSTs `/api/ghl/tasks/complete`, which reads OUR row (never
  trusting the client), picks the API key from the row's `location_id` (Efrain's and
  Matt's sub-accounts have separate keys), PUTs `…/completed`, then deletes the mirror
  row so the board updates instantly instead of waiting 15 minutes.
- **Read-only otherwise:** GHL rows show a `GHL` badge, the contact name when there is
  no deal to link, and offer complete + open-in-GHL. No edit, no delete — those belong
  in GHL. "Clear completed" only ever touches `deal_tasks`.

## Not in scope (v1)

- The Follow-Up cockpit's task column and the Dashboard home widget still show
  `deal_tasks` only.
- Creating a GHL task from the dashboard (the POST endpoint is verified and works).
- Task descriptions (needs one extra GET per task).

## Verification

- `scripts/ghl-tasks-check.ts` — 27 fixtures over real captured payloads.
- Live sweep: 65 stored, 65/65 matched a deal, assignees Brianne 30 / Matt 29 /
  Efrain 4 / Moe 2.
- Write-back proven end-to-end on a throwaway task (created → completed → deleted).
