# Research: FollowUpBoss API — Follow-Up Cockpit integration

**Date:** 2026-07-30
**For:** Per-LO follow-up pages (`/follow-up/moe`, `/follow-up/matt`) merging GHL deals + FUB people.

## What

FollowUpBoss (FUB) REST API — capabilities, auth model, account topology, and data shape for syncing
Moe's and Matt's FUB books (past funded clients + future prospects, per Efrain 2026-07-30) into Supabase.

## Sources

- **Live API probes 2026-07-30** against account `1376431815` using Moe's and Matt's real API keys
  (keys in `.env.local` as `FUB_API_KEY_MOE` / `FUB_API_KEY_MATT` — never commit). Probed: `/me`,
  `/users`, `/people` (+filters), `/stages`, `/customFields`, `/smartLists`, `/tasks`, `/events`,
  `/webhooks`, rate-limit headers, pagination behavior. Probe scripts in session scratchpad.
- Official docs (fetched 2026-07-30, markdown mirrors):
  - https://docs.followupboss.com/reference/authentication.md
  - https://docs.followupboss.com/reference/rate-limiting.md
  - https://docs.followupboss.com/reference/pagination.md
  - https://docs.followupboss.com/reference/people-get.md
  - https://docs.followupboss.com/llms.txt (full endpoint index)

## Key findings

### 1. Account topology — ONE shared account, overlapping visibility
- Both keys belong to the **same FUB account `1376431815`** (West Capital Lending / "What's a
  Mortgage" team, 21 users). Moe = user **72** (`msefati01@gmail.com`), Matt = user **13**
  (`matt.park@luminlending.com`), **Randy = user 35** (also in this account — door open for a 3rd page later).
- Keys are **agent-level** (`role: user`). Per docs: an agent key sees only people **assigned to them
  or where they collaborate** (+ pond/unclaimed). Verified live:
  - Moe's key: 1,983 visible / 1,081 actually `assignedUserId=72`; sees 6 of Matt's.
  - Matt's key: 4,214 visible / 3,218 `assignedUserId=13`; sees **84 of Moe's** and 3 of Randy's.
- ⚠️ **Ownership truth = `assignedUserId` (72 Moe / 13 Matt), NOT which key fetched the record.**
  Pull with both keys → dedupe by FUB person `id`.

### 2. Auth
HTTP **Basic** over HTTPS, API key as username, blank password. Key carries the full privileges of
the user it belongs to — treat like a password (env vars only). Expired accounts 403 most endpoints.

### 3. Stage census (live 2026-07-30)
Account-wide stages (17): Lead, Attempting Contact, In Contact, Nurture, Nurture - Credit,
Nurture - Income, App Link Sent, App Review, Pre Approved, In Escrow, Closed, Past Client, Contact,
Trash, Unresponsive, Inactive, Referred Out.

| Stage | Moe (key-visible) | Matt (key-visible) |
|---|---|---|
| Lead | 814 | 1,855 |
| Attempting Contact | 252 | 476 |
| In Contact | 207 | 215 |
| Nurture | 146 | 673 |
| Nurture - Credit | 9 | 16 |
| Nurture - Income | 2 | 7 |
| App Link Sent | 112 | 167 |
| App Review | 67 | 145 |
| Pre Approved | 14 | 51 |
| In Escrow | 8 | 7 |
| Closed | 4 | 59 |
| Past Client | 143 | 48 |
| Unresponsive | 108 | 167 |
| Inactive | 95 | 320 |
| Referred Out | 1 | 0 |

Reality check: Moe has Lead-stage people with `lastActivity` from **Jan 2025** (18 months idle).
Any "stale" section MUST bucket by age or it drowns (814/1,855 raw Leads).

### 4. Person payload — fields that matter
`id, name, firstName, lastName, stage, stageId, source, sourceUrl, sourceId, createdVia,
assignedUserId, assignedTo, assignedLenderId/Name, assignedPondId, collaborators, tags,
created, updated, lastActivity, contacted, price, timeframeId/Status/DateRange,
dealName/dealStage/dealStatus/dealPrice/dealCloseDate, emails[] {value,type,isPrimary,status},
phones[] {value,type,status}, addresses[], websiteVisits, picture`.

- **Tags encode their current MANUAL cadence**: e.g. `MOE - 2026 Q2 - Follow up`,
  `MOE - 2026 Q3 - Follow up`, `client-wam`, `RoundRobin`, `ManyChat`, state tags (`CA`).
  The cockpit replaces/absorbs this quarterly-tag system.
- **Custom fields** (account-wide, 25): Homebot suite incl.
  **`customHomebotLikelyToMoveScoreRange`** (refi/move propensity — future ranking signal),
  WAM webinar fields, `customLPLoanNumber`, `customManagerPipeNotes`, `customInitialNotes`,
  `customInContactDate`, `customCity`. Sample records had customFields empty — coverage unknown,
  treat as opportunistic enrichment, not load-bearing.

### 5. Pagination
Default **descending by id**, default limit 10, **max limit 100**. Keyset cursor via
`_metadata.next` / `nextLink` (enforced over `offset` for deep pages — always follow `nextLink`).
`_metadata.total` gives counts cheaply (`limit=1` probe pattern).

### 6. Filters / sorts on `/people` (documented)
- Filters: `assignedUserId`, `assignedTo`, `assignedPondId`, `stage`, `lastActivityAfter`,
  `lastActivityBefore`, `includeTrash`, `includeUnclaimed`, `fields` (or `fields=allFields`).
- Sorts: `id, created, updated, name, price, stage, lastActivity, lastCommunication, lastCall,
  lastText, nextTask, …` (long list; custom fields sortable too).
- ⚠️ **GOTCHA:** undocumented `updatedAfter=` param returned `total: 0` (not an error, not ignored —
  silently wrong). Never pass undocumented params. **Incremental sync = `sort=-updated` walk until
  past the stored cursor** — same pattern as `lib/syncCursor.ts` for GHL.

### 7. Rate limits (verified live: headers show 125)
- Unregistered (no `X-System-Key`): **global 125 req / sliding 10s**; GET events 10/10s; PUT people
  25/10s; notes 10/10s. Registered systems: global 250/10s (registration = email FUB, phase 2 if needed).
- 429 responses carry `Retry-After` (seconds) and MUST be honored even if `X-RateLimit-Remaining > 0`.
- Full both-key sweep ≈ (20 + 43) pages ≈ **63 requests** → comfortably inside one window budget with
  modest pacing (~1 req/100ms is plenty).

### 8. Webhooks — NOT available to us
`GET /v1/webhooks` with agent keys → `{"errorMessage":"Only the account owner may access webhooks."}`
Admin(Broker) can't either, per docs — **owner only**. → This is a **polling integration**. Real-time
would need the account owner's cooperation; not planned.

### 9. Tasks & events
- `/tasks` works with agent keys: 6,949 tasks visible via Moe's key. Fields:
  `id, name, type, dueDate, dueDateTime, isCompleted, personId, assignedUserId, AssignedTo, created,
  updated, remindSecondsBefore`. Their EXISTING follow-up tasks can feed a "Due today" section —
  filter params (assignedUserId/isCompleted/due-window) need one probe before relying on them.
- `/events` = lead activity log (inquiries, site visits: `pageTitle/pageUrl/propertySearch`).
  Calls/texts live at `/calls`, `/textMessages` (not probed). For v1 staleness, person-level
  `lastActivity` is the cheap, sufficient signal.

## Open questions (→ spec decides)

1. Stage → cockpit-section mapping (which stages are "open pipeline" vs "nurture pool" vs excluded:
   Trash/Referred Out/Closed?). Spec proposal: exclude Trash; Past Client/Closed → nurture-only sections.
2. Suppress a FUB row when the same person (email/phone match) has an ACTIVE GHL deal? (Proposed: yes —
   GHL drives it; badge the deal row instead.)
3. FUB deep-link URL shape — verify `https://app.followupboss.com/2/people/view/<id>` resolves for
   this account (one manual click during build).
4. Write-back (log touches as FUB notes/tasks) — **phase 2**; note the 10/10s notes limit.
