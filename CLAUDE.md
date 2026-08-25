@AGENTS.md

---

# Project Overview — Lumin Deals Dashboard

## What It Is
An internal mortgage pipeline management dashboard for **Lumin Lending** (two LOs: Moe Sefati and Matt Park). It syncs from GoHighLevel (GHL), stores data in Supabase, and adds deal tracking, team tooling, and automated alerts on top. GHL drives stage/contact/messaging; **Arive (the LOS) is the source of truth for the loan AMOUNT** (and funded $).

## Loan amount source — GHL opportunity value (SHIPPED 2026-06-26)
The dashboard AMOUNT = the **GHL opportunity value** (`monetaryValue` — the figure shown ON the opp card in
GHL) for every **in-process** loan; NOT the unreliable GHL stored "Loan Amount" custom field. **Funded**
(`pipeline_group === 'Funded'`) is the ONLY Arive-authoritative line. Efrain's rule: opp value always for
in-process, Arive for funded.

**Shipped 2026-06-26:** both sync guard sites dropped the Arive lock (upsert `fundedOwnsAmount =
existingIsFunded`; maintenance reconcile dropped the `!d.arive_file_no` condition). The **webhook** now also
writes `loan_amount` from the opp `monetaryValue` in real time (presence-gated, non-funded only — fed by the
GHL "LD stage" workflow's `monetaryValue → {{opportunity.lead_value}}` custom field). Full provenance in the
`loan-amount-provenance` memory + `~/.claude/handoffs/lumin-deals.md`. NOTE: visible on the next "Sync GHL";
the opp value may not always equal the loan amount (GHL data quality — watch the in-process volume).

## Recent Changes (2026-08-25) — 4th LO + a reporting-only role

**Daniel McGrail-Granger is live** as the 4th LO (636 deals synced, 61 Arive rows
imported and reconciled to the dollar against the CSV). Behind a new **`reporting`
role** — `lib/roles.ts` now has `admin | processor | reporting` with a per-role
allow/deny table and `homeFor()`.

A `reporting` account reaches **`/reports`, `/monthly-reports`, `/lead-roi`** and
nothing else. `/reports/escrows` is **explicitly denied** because matching is
prefix-based and `/reports` would otherwise cover it. `/lead-cohorts` was in the
list and was removed 2026-08-25 — his sub-account isn't on the stage webhook, so
it would report his response rates as a flat 0.0%: wrong data, not missing data.

**The "no `role` key = ADMIN" default is unchanged.** New: an *unrecognised* role
string also falls through to admin, so a typo can't lock someone out.

⚠️ **`/lead-roi` is NOT a read-only page** — it rewrites `deals.source` one at a
time AND in bulk across every deal from a source, unscoped by LO, plus edits the
retainer costs feeding every ROI figure. All three are now admin-only (`canEdit`).
**Grep any page for writes before granting it to a restricted role.**

`matchesLO` in `lib/leadReport.ts` and `lib/cohortReport.ts` is now
`Record<Exclude<LO,'All'>, RegExp>` — adding a 5th LO is a **compile error** until
its pattern exists, replacing the ternary whose else-branch silently rendered
another LO's leads. Matt's and Moe's patterns deliberately left narrow.

`roles-check` 79 → 127 fixtures. Runbook: `docs/runbooks/add-a-user.md`.

## Recent Changes (2026-08-04 → 08-05) — GHL tasks are on the board, two-way
- **`ghl_tasks` mirror (SHIPPED).** GHL's own per-contact tasks now render alongside `deal_tasks` on
  **`/tasks`, both Follow-Up cockpits, a new Dashboard-home widget, and the deal page** — 65 open GHL tasks
  vs 20 dashboard tasks, so the board was showing about a quarter of the real workload. Open tasks only,
  full-replace each sweep (same shape as `fub_tasks`), swept inside `runGhlSync` AFTER the deal sync so
  `deal_id` resolves. Adapter `lib/ghlTasks.ts` puts a GHL row into the `DealTask` shape (id namespaced
  `ghl:`), so every existing filter/chip/column/bucket/sort works untouched.
- **Two-way.** Complete → `PUT /contacts/{cid}/tasks/{id}/completed`; delete → `DELETE` the same path;
  create → "New GHL Task" on `/tasks` + "GHL task" on the deal card.
- **Completed GHL tasks are visible + reopenable (SHIPPED 2026-08-04).** The mirror keeps NO completed
  history — completing DELETES the row — so a mis-click used to leave no trace. The **Completed** chip on
  `/tasks` now also asks GHL live (`GET /api/ghl/tasks/completed?days=90`, one keyset search per location,
  200-row cap). Rows are namespaced `ghl:` like any mirror row and **reopen** on click
  (`POST /api/ghl/tasks/reopen` → `PUT …/completed {completed:false}`, then re-mirrored so the board updates
  without waiting for the sweep). `completed_at` is GHL's **`dateUpdated` = last modified**, not a true
  completion stamp; the UI says so. A completed row shows WHEN it was done instead of its due date.
- **REASSIGN is the one edit a mirrored row supports (SHIPPED 2026-08-05).** Click any GHL row on `/tasks`,
  a Follow-Up cockpit, or the deal card → inline picker → `POST /api/ghl/tasks/reassign`. GHL's task update
  takes a **PARTIAL** body, so sending only `assignedTo` leaves title/due/description untouched (verified).
  Options come from the task's OWN sub-account via `lib/ghlUsers.ts` (shared with create). Still **no
  title/description edit** — that text lives in GHL. ⚠️ `components/DealTasks.tsx` has its own local
  `TaskRow`, so it does NOT inherit board changes; wire it separately.
- **⚠️ GHL task writes take ~2s — every UI write must be OPTIMISTIC.** Measured: `/complete` 2644ms end to
  end (~2000ms is GHL's own PUT), `/reopen` 3779ms. Handlers used to await the round-trip before touching
  state, so the row sat on screen the whole time. Complete/reopen/delete now drop the row immediately and
  restore only on a real refusal, on all three surfaces (row gone in 460ms after).
- **⚠️ `tasks/search` is EVENTUALLY CONSISTENT — it will report a working write as failed.** A first reopen
  probe concluded the endpoint was a no-op returning a lying 200; the index was still showing the previous
  state, and a just-created task appeared in NEITHER bucket. **The single-task
  `GET /contacts/{cid}/tasks/{id}` is read-your-write and the only ground truth.** One task per method when
  probing. Both write routes re-read the single task rather than trusting the 200.
- **⚠️ CORRECTION — the search payload DOES carry `body`.** The old "no body, only the single-task GET" claim
  was generalised from a sample of tasks that had no description. 8 of 94 real rows carry one today, and it's
  **HTML**. Descriptions are therefore mirrorable at zero extra API cost — not built (needs a column).
- **Column tab "Future" → "Due this week"** (rolling 7 days, same window as the page's "This week" chip,
  excluding anything already in Overdue & today; longer-dated tasks stay in **All**). ⚠️ The `'future'` KEY
  is unchanged on purpose — it's persisted in `localStorage` (`tasks:columnViews`).
- **⚠️ Endpoint map — every obvious guess 404s.** Use `POST /locations/{id}/tasks/search` (keyset-paged on
  each row's `searchAfter`). NOT `/tasks/search`, `/contacts/tasks/search`, `GET /tasks?locationId=`, or v1.
- **⚠️ A deleted GHL task is a TOMBSTONE** — it stays in the search index with `deleted:false` and its
  `contactId` stripped. `mapGhlTask` drops contact-less rows; without that the ghost re-mirrors every sweep
  as a row nobody can complete or delete.
- **⚠️ GHL users are per-location** and Matt is **"Matthew Park"** there — `resolveLO` folds it. Get it wrong
  and 29 tasks land silently in "Unassigned & other". `dueDate` is **required** on create (422 without one).
- **Undated tasks no longer hide.** They surface in **Overdue & today** (dashboard tasks) and **Due today**
  (FUB tasks), at the TOP of that bucket, while the **All** view stays in strict urgency order.
- ⚠️ `ghl_tasks` RLS is `TO authenticated` → the `LOCAL_AUTH_BYPASS` dev server renders it empty, so **open
  GHL rows cannot be clicked locally**. Verify on prod or via a service-role script. The `/completed` route
  is the exception — it uses a service client + the GHL API, so it works fine on the local bypass server.
  Full detail: `docs/specs/2026-08-03-ghl-tasks-two-way-spec.md`.

## Recent Changes (2026-06-30)
- **Lender List** (`/lenders`) — editable directory of ~82 approved lenders. `lib/lenders.ts` (from
  `scripts/parse_lenders.py`) is the SEED; live team list in `sync_state 'lenders_list'` via `app/api/lenders`
  (like /api/tools). ✏️/Add/Delete via `LenderEditModal`. Don't re-propose live Google-Sheet pull.
- **Cron GHL sync hardened** — `app/api/cron/ghl-sync` returns instantly + runs the sync in `after()`. Root cause
  of stale-dashboard/lost-not-reflecting bugs was **cron-job.org's 30s request-timeout** killing heavy runs (it's
  the trigger; not a Vercel cron). cron-job.org pass/fail is no longer meaningful — use LastSyncBadge/logs.
- **Next-step LOG** on the escrow card — `next_action` is now a timestamped history (`next_action_log` jsonb).
  `components/NextStepLog.tsx`: prominent current step + **+**-opens-a-popup. `next_action` mirrors the latest
  entry. **Migration `next_action_log` RUN.** Dashboard "Next Steps" shows latest + "· Xago".
- **Full Sync button** in the sidebar (`/api/sync/ghl?full=1`) — use after renaming a GHL contact (incremental
  won't catch contact renames; a full sync re-pulls all contacts). NOTE: a full sync can surface a co-borrower's
  dormant opp as a duplicate card.
- **Removed Past-SLA notifications** from `NotificationBell` (kept lock-expiry + tasks).
- **Borrower override REVERTED** — built `borrower_locked` then removed it; borrower identity is GHL-owned, fix at
  the GHL source (reassign the contact/opp). **`borrower_locked` migration NOT run.**

## Recent Changes (2026-06-26)
- **Loan amount = GHL opp value for in-process loans** (see section above); the **webhook** now writes it in
  real time too.
- **Loan Officer:** `LOAN_OFFICERS` enum is the canonical `'Matt Park'` (was `'Matt'` → blank dropdowns on
  711 deals); `resolveLO` shared in `lib/loanOfficer.ts` (sync + webhook + Arive importer); 94 `Matthew Park`
  rows normalized to `Matt Park`.
- **Notes/Bulletin** (`/tasks`): card grid → vertical list rows + a pop-out modal that opens in VIEW mode with
  an Edit button (`components/NotesBoard.tsx`).
- **Dashboard:** removed the date-range filter (All Time/MTD/QTD/YTD/Custom) — it's a current-escrow snapshot.

## Recent Changes (2026-06-22)
- **`loan_amount` is Arive-authoritative.** GHL no longer writes/overwrites `loan_amount` on any Arive-backed (`arive_file_no`) or funded deal — only fills pre-Arive leads from the opp value. Dropped the unreliable GHL `customField('Loan Amount')` source (it once put $610k on a $150k loan).
- **Dashboard redesign** — hero metric, depth, metrics-first hierarchy.
- **Active Escrows card** (`EscrowTracker.tsx`) — grey box = Lender·Amount·LO; added "Subbed on teams" (`subbed`) + "Processor Handoff" (`processor_handoff`, new col) checkboxes; follow-up moved into Next Step; removed In-Stage + Waiting-On.
- **Labels renamed** Investor→Lender, Investor File #→Lender Loan # (display only; columns unchanged).
- See `~/.claude/handoffs/lumin-deals.md` — next session: which Arive export fields to add for a daily import.

## Tech Stack
- **Framework**: Next.js 16 (App Router, TypeScript)
- **Database**: Supabase (Postgres via PostgREST)
- **Auth**: Supabase Auth
- **Deployment**: Vercel (`lumin-deals.vercel.app`, project: `loantoahome-pngs-projects/lumin-deals`)
- **Email**: Brevo transactional API (env: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`)
- **Deploy command**: `vercel --prod` from this directory

## GHL Accounts
**Four** GHL sub-accounts synced in parallel by `getAccounts()` in
`app/api/sync/ghl/route.ts`. Every slot is guarded on BOTH its env vars, so an LO
whose credentials aren't configured is simply absent from the sync — inert, not
broken. (That inertness is why the first Randy attempt looked like a bug.)
- **Primary** (Moe Sefati): `GHL_API_KEY` + `GHL_LOCATION_ID`
- **Matt Park**: `GHL_API_KEY_MATT` + `GHL_LOCATION_ID_MATT`
- **Extra** (Randy Mathis): `GHL_API_KEY_2` + `GHL_LOCATION_ID_2` — `arZ4QDCzS0Vkj0ZvLZdv`
- **Daniel** (Daniel McGrail-Granger): `GHL_API_KEY_3` + `GHL_LOCATION_ID_3` — `Nt66emmbEuBZVmti60nJ`

⚠️ **Daniel is spelled differently in the two systems**: GHL says **"Danny
Granger"**, Arive says **"Daniel McGrail-Granger"** (the canonical board name).
`resolveLO` folds both via the `'granger'` key. If anything of his ever comes up
empty, check that first.

⚠️ The sync stamps its cursor **per account** as `ghl_sync_last:<locationId>` in
`sync_state`, not one global key. No cursor for a location = the sync never saw
the account (env/deploy problem). A cursor with zero deals = it authenticated and
found nothing (token scope problem). `scripts/daniel-sync-report.ts` prints both.

## Sync Architecture
Driven by an **external cron on cron-job.org** — schedule is `*/15 8-18 * * 1-5` (every 15 min, 8 AM–6 PM, Mon–Fri). **CONFIRMED set to 15 min as of 2026-06-17** (Efrain verified the cron-job.org setting). This is the authoritative ping cadence — ignore any older code comments suggesting "1–2 min." Do not assume a tighter cadence when reasoning about Fluid CPU.

Per ping behavior (controlled by intervals in `app/api/cron/ghl-sync/route.ts`):
- **Every ping**: Incremental GHL sync — only fetches opportunities changed since last run
- **Every 30 min** (`CONV_REFRESH_INTERVAL_MS`): Conversations refresh — last message timestamps, unread counts, inbound/outbound direction for active leads
- **Every 3 h** (`MAINTENANCE_INTERVAL_MS`): Full opportunity fetch for orphan pruning, loan amount + contact ID reconciliation (widened from 60 min on 2026-06-17 to cut Fluid Active CPU)
- **Every 3 h** (`IDENTITY_RESOLVE_INTERVAL_MS`, widened from 30 min on 2026-06-17 to cut Fluid Active CPU): Identity resolver (`lib/identityResolver.ts`) — collapses split `borrower_id`s into the canonical person (guarded-transitive union-find over `ghl_contact_id ∪ email ∪ phone ∪ borrower_id`, never name) AND maintains the `contacts` table (one row per person, keyed by canonical `borrower_id`). Non-fatal; safety caps (component>20 / >200 rewrites) + reversible `sync_state` backup; `?full=1` forces it. Manual/dry-run: `POST /api/resolve-identities` (dry-run default)
- **Every 5 min** (`CALLBACK_CHECK_INTERVAL_MS`): Auto-creates a task for Brianne when a new lead sits in "New Lead" or "Attempted Contact" for ~45 min
- Overlap guard via `sync_state` table lock (5 min TTL)

Manual sync button in sidebar calls `POST /api/sync/ghl`.

## Contacts / Identity (Phase 1-2, 2026-06-16)
The dashboard owns the **unified person** (`contacts` table) that no upstream system can — GHL has two sub-accounts (a person = a different contact id per account) and Arive has no API. `contacts.id` = the canonical `borrower_id`, so `deals.borrower_id` is already the FK (no deals migration). Built + maintained by the identity resolver above. Pages: `/contacts` (people list) + `/contacts/[id]` (person + their loans). DDL: `supabase-contacts.sql` (needs the RLS policy in that file to be readable by the logged-in app). Long-run roadmap (per-person LTV, referral, lead-spend person-dedup) in vault `architecture-direction` + `docs/specs/2026-06-16-contacts-table-spec.md`.

**Shipped 2026-06-16 (Phase 3 + Radar):** FUB-style `/contacts` list (avatar, source sub-line, lifecycle Stage pill, sortable columns, source filter, book-of-business stats strip, Copy emails / CSV export), rich `/contacts/[id]` (read-only Details panel + milestone timeline + per-sub-account GHL links + reachability), the `/duplicates` "Same Arive file #" detector, and **Refi Radar** `/radar` (product-segmented scorer `lib/refiRadar.ts` + user-set par rates in `sync_state`). Contacts source/lifecycle are derived client-side, not in the resolver. NEXT: `/duplicates` Arive merges, curated tags + a "Refi?" pill on contacts (reuse `refiRadar`), equity capture for the gated radar plays. Full state in `~/.claude/handoffs/lumin-deals.md`.

**Shipped 2026-06-30 (Reports + Channel):** Lender List **BCC email picker** (`components/LenderEmailModal.tsx`); NEW **printable per-LO Active Escrows report** `/reports/escrows` (`app/reports/escrows/page.tsx` — LO toggle, stage groups, rate-lock/next-step/processor/Channel/loan details, top "Locks expiring ≤7d" callout, print-to-PDF; reachable via a Report button + Insights sidebar link); **Channel field** (`broker_corr` = Broker/Non-Del) — Arive "Channel" column mapped in `lib/ariveCsv.ts`, deal-form relabeled "Broker / Non-Del" + "Waiting On" field removed, Channel added to the escrow card (2×2 stats) + report ("{Channel} - {Amount}"). A CTC+Non-Del funding-alert cron was built then removed (Efrain prefers an on-demand button — pending). Fluid-CPU tuning (LastSyncBadge 30s→15min + visibility-gated; middleware skips `/api/sync-status`). Full state in `~/.claude/handoffs/lumin-deals.md`.

**Shipped 2026-07-30 (Reply inbox — 6 commits, `d7a9cc1`→`4126938`, prod `lumin-deals-brnm1xpe7`):**
"Replied — waiting on you" was showing **Inbox zero for BOTH LOs** while GHL showed unread. Two causes:
(1) `isReplyWaiting` excluded `HOT_WORKING_STATUSES` — **the exact statuses a lead is in when they reply**
(GHL moves them to `Responded` first); measured over 2,994 deals the predicate matched **0/0**, without the
clause Matt 2 / Moe 3. (2) `deals.last_inbound_at`/`last_outbound_at` are written ONLY by the 30-min
conversations refresh and ONLY for the lead stages — **the webhook never writes them** — so everything past
App Intake is frozen (Scot Gordon: unread today, `last_inbound_at` 15 days stale). The section is now
`lib/followUpQueue.ts::buildReplyInbox`, merging **three** sources: the LIVE `/api/ghl/unread` feed (all
stages, per-LO, Not-Ready excluded) + the synced-deals predicate + NEW **`/api/fub/unanswered?lo=`**.
Rows >7 days old go to their own drawer. ⚠️ **FUB unread is NOT reachable directly**: `/v1/threads` +
`/v1/conversations` are **403** for agent keys, `/me.unreadConversationCount` is one integer, and the
per-message `read` flag was `false` on **300/300** inbound (a delivery receipt, not the inbox) — unanswered is
reconstructed from `toNumber`/`fromNumber` text feeds keyed on the LO's own `/me.callingPhoneNumber`
(`fetchFubUnanswered`). ⚠️ A FUB row is **not** suppressed by `matched_deal_active` here (unlike the book) —
a text to the FUB number is a different thread and GHL has no record of it. Live after: Matt 0 → 8 waiting
(4 GHL, 4 FUB) + 11 older; Moe 0 → 7 (2 GHL, 5 FUB) + 15 older.
Diagnosis: `docs/diagnoses/2026-07-30-replied-waiting-empty-diagnosis.md`. Fixtures: **177**.
**Four follow-up passes the same day:**
(a) **A false "unanswered"** — the FUB feeds were paged by PAGE COUNT, giving the higher-volume outbound feed a
SHALLOWER time horizon (300 in = 62d, 300 out = 52d); Tami Boteilho was flagged ignored when Moe had replied 98
seconds later. Both directions now page to a **time cutoff** (`INBOX_LOOKBACK_DAYS = 90`) with the outbound
window forced to reach the oldest inbound kept; anything beyond the horizon is **unproven, not unanswered** and
is verified per person (`threadShowsReply` / `emailsShowReply`).
(b) **Dead buttons** — writes landed but the section reads LIVE feeds, so nothing moved. Every action now has a
suppression rule in `buildReplyInbox` + an optimistic dismissal. ⚠️ Also found: an **RLS-blocked Supabase write
returns `{error: null}` with ZERO rows**, so every client update here carries `.select()`; corollary, the
`LOCAL_AUTH_BYPASS` dev server cannot exercise ANY client-Supabase read or write.
(c) **Inbound CALLS + EMAIL.** One normalised touch timeline: INBOUND = inbound texts + missed calls; RESPONSES
= outbound texts + outbound calls + **answered** inbound calls. ⚠️ A missed call is `outcome === 'No Answer'`,
NOT `duration === 0` (13/100 had duration up to 278s of voicemail), and `/v1/calls` **silently ignores**
`userId`/`isIncoming` — only `toNumber`/`fromNumber`/`personId` are honored. EMAIL has **no account-wide feed**
at all: discovery runs on the hourly sweep (already fetches `fields=allFields` → zero extra API calls) into
`sync_state.fub_email_waiting`, verified live per person; `/v1/emails` direction is `status: 'Sent'|'Received'`.
(d) **A real "check it off"** — NEW **Done** on every row, storing the message it cleared so only a NEWER inbound
brings it back. GHL → `comm_read_acks`; FUB → NEW `sync_state.fub_inbox_acks` (`lib/fubInboxAcks.ts` +
`/api/fub/inbox-ack`), keyed on `fub_id` ALONE and server-side, which is what gives buttons to the people the
sweep doesn't store. **"Touched" was removed from this section.** Plus: the cockpit task list now defaults to
**Overdue & today**, and the past-client book is **three drawers, coldest first** (90+/never → 31–90 → last 30).

**Shipped 2026-07-30 (Follow-Up Cockpit + FollowUpBoss integration) — 17 commits, `335b6af`→`493f56b`:**
NEW per-LO pages `/follow-up/moe` + `/follow-up/matt` (+ `/follow-up` manager index, sidebar "Follow-Up") — six
sections: **Tasks** (this LO's `deal_tasks` in the shared /tasks card: complete/edit/delete + "Add task for
Efrain/Brianne") · **Replied — waiting on you** (unanswered inbound ≤48h; EXCLUDES the Not Ready pipeline) ·
**FollowUpBoss tasks** (Overdue/Due today/Next 7 days, per-row **Done** writes back to FUB + Open in FUB, plus
New FUB task) · **GHL leads — Pitching & App Intake** (split by last activity ≤7d / >7d) · **Past clients &
closed (FUB)** (bucketed by days since anyone actually talked, each row showing inbound/outbound dates) ·
**More follow-ups** (collapsed). NEW **FollowUpBoss integration**: `fub_people` + `fub_tasks` tables,
`/api/sync/fub` sweeping both agent keys hourly **piggybacked on the ghl-sync cron (no new cron job)**,
`/api/fub/tasks/complete` + `/create`. Keys `FUB_API_KEY_MOE`/`FUB_API_KEY_MATT`. ⚠️ FUB people pull is
**Past Client + Closed ONLY** (+ anyone with an open FUB task, so task rows show a name) — 851 stored of 5,212
visible; do NOT widen without asking. ⚠️ NEVER use FUB `lastActivity` to mean "someone talked" (opens/marketing/
record edits — it was >30d newer than any real conversation for 116 of 224 past clients). `components/TaskBoard.tsx`
NEW = the single definition of the task card, column AND form, imported by BOTH `/tasks` and the cockpit.
Docs: `docs/research/2026-07-30-followupboss-api.md` + spec/plan same date. Fixtures: `scripts/follow-up-check.ts`
(116). Full state in `~/.claude/handoffs/lumin-deals.md`.

**Shipped 2026-07-28 (Lead attribution + purpose + Old Deals + sync rescue) — 17 commits, `7bd5095`→`0528b99`, prod `lumin-deals-8oqwwou6f`:**
- **Lead source, three stacked bugs.** The sync declared its OWN `cleanSource()` that filtered junk but NOT "Arive", shadowing the `lib/utils` guard — the 7/08 fix was recorded as "sync guarded" and never was, so the bucket regrew **1 → 200**. The candidate chain also coalesced BEFORE cleaning, letting a present-but-rejected "Arive" shadow the real vendor one slot down. Now: one canonical `cleanSource` + `resolveLeadSource()` cleaning **each candidate**. **Attribution now credits the vendor on the OPPORTUNITY** (Efrain: an opp = one purchased lead = one spend event); Moe's Lending Tree **77 → 70**, an exact match to GHL's export. Manual overrides via **`lib/sourcePins.ts`** (`sync_state.source_pins`, keyed by opp id, no schema change) because the sync rewrites `source` every pass. Webhook no longer writes `source` on UPDATE.
- **Loan purpose.** `normalizeGhlLoanPurpose` returned null for anything but purchase/refi, so it **discarded every HELOC** (the webhook writes raw, hence a stable 49-kept/26-lost split), and later **"Cash Out"** too. Moved to `lib/utils.normalizeLoanPurpose`, now reads the purpose off the **OPPORTUNITY** (`lib/ghlOpportunityFields.ts`) since the contacts LIST endpoint omits custom fields. Repo-wide blank purposes **571 → 130**; every LO's tabs now add up.
- **Old Deals** — 98 historical Arive-only loans (no opp id, no lead_price, Funded/Not Ready) parked via `pipeline_group='Old Deals'`, excluded centrally in **`lib/fetchAllDeals.ts`**, surfaced on **`/old-deals`** (last sidebar item). Arive importer preserves parking. Reversible: `scripts/park-old-deals.ts undo`.
- **Sync rescue** — a missed opportunity was missed FOREVER: maintenance runs fetch the full opp list only for the PRUNE, so creation still obeyed the cursor (11 of Randy's leads unseen for 4 days). `lib/syncCursor.ts` now processes any opp with **no deal** on maintenance ticks.
- **⚠️ NEVER dedupe lead spend** — every opportunity's `lead_price` is a real separate charge (rule recorded inline in `lib/leadRoi.ts`). Full state + the two open threads in `~/.claude/handoffs/lumin-deals.md`.

## Vercel Built-in Crons (`vercel.json`)
- `contingency-alerts` — daily 3 PM UTC: emails LOs at 3-day, 1-day, day-of for purchase contingency dates. Deduped via `contingency_alerts_sent` JSONB column.
- `lock-alerts` — daily 3 PM UTC: emails LOs at 5, 3, 1, 0 days before rate lock expiration on in-escrow loans. Deduped via `lock_alerts_sent` JSONB column.

## Pages
- `/` — Dashboard: KPI cards, Escrows by Stage chart, Loan Types donut, LO Performance, Needs Attention, Today's Follow-ups, Team Notes. Date filter: All Time / MTD / QTD / YTD / Custom.
- `/pipeline` — Kanban deal board
- `/hot-leads` — 4 tabs (`?view=` deep-links): **Triage** (default — 7-day decision clock on every undecided open lead: tiers 0–4 / 5–7 / 8–30 / 30d+ backlog, per-row + bulk dispositions into App Intake / Not Ready - Timeframe [required check-in date] / Remove from All Automations), **Responded/Pitching** + **App Intake** (reply-recency buckets, unread count), **Check-ins** (Not Ready - Timeframe leads resurfacing on their check-in date, stored in `next_action_due` — no dedicated column). Logic in `lib/triage.ts` (fixtures: `scripts/triage-check.ts`); auto-tasks via `app/api/cron/triage-tasks/route.ts`, called in-process by the ghl-sync cron (6h throttle). Spec: `docs/specs/2026-07-14-lead-triage-spec.md`.
- `/unread` — GHL conversations with unread messages
- `/deals` — Active Escrows table
- `/funded` — Closed/funded deals
- `/old-deals` — historical Arive-only loans (no GHL opportunity), parked OUT of every report via `pipeline_group='Old Deals'`. Exclusion is enforced in `lib/fetchAllDeals.ts`, so new pages inherit it; this page is the only caller passing `{ includeOld: true }`.
- `/contacts` — People list (FUB-style: avatar, source, lifecycle stage, sortable, source filter, CSV export, book stats strip) + person detail `/contacts/[id]` (identity, read-only Details panel, loans, activity timeline)
- `/radar` — Refi Radar: product-segmented refinance scoring over the funded book (`lib/refiRadar.ts`); user-set par rates in `sync_state`
- `/reports` — Charts and analytics
- `/lead-roi` — Lead ROI (merged Lead Performance + Lead Spend 2026-07-13): per-LO tabs ONLY (never combined), one metric set (ROI = rev÷spend ×, spend incl. retainers, funded = isFunded), lifecycle funnel, monthly trend, printable report route `/lead-roi/report`. Math in `lib/leadRoi.ts` (fixtures: `scripts/lead-roi-check.ts`). Old URLs 308-redirect.
- `/deals/new` — Manual deal creation
- `/tasks` — **Bulletin/Tasks**: team task management on top + the Notes/Bulletin board below (one page; `/notes` redirects here)
- `/follow-up` + `/follow-up/[lo]` — **Follow-Up Cockpit** (per LO: Moe/Matt): the daily "who do I contact today" queue merging GHL deals with the FollowUpBoss past-client book and FUB tasks. Queue logic is pure in `lib/followUpQueue.ts`; FUB client in `lib/followUpBoss.ts`.
- `/tools` — Utilities incl. the **PDF Tools** hub (compress/merge/split/rotate, 100% in-browser)
- `/import/arive` — Import from Arive LOS
- `/health` — Data quality dashboard
- `/duplicates` — Detect and merge duplicate deals

## Deal Detail Page (`/deals/[id]`)
Sections: File Numbers (Arive + Investor, with Arive deep-link), Loan Details, Property Details, Lock & Appraisal, Borrower Info, Team (LO, Processor, Waiting On). Tabs/panels: Loan History, Real Estate Owned, Communications Log, Conversation Thread (GHL SMS/email), Deal Tasks, Document Checklist. Push-to-GHL button syncs stage changes back to GHL.

## Recently Removed
- 10-year Treasury chart widget (dashboard)
- Rate Watch section (deal detail pages)
- Rate Watch Alerts Banner (dashboard)
- `rate-watch` and `treasury-refresh` Vercel crons

---

# Working rules (do not skip)

## No guessing — verify before you respond
Before stating a cause, fix, or "what changed," gather the facts first. Do the
research, then answer. Specifically:

- **Diagnose from evidence, not hunches.** Read the actual code, query the real
  data (Supabase), check `vercel logs`, the GHL API, or reproduce the issue
  before naming a root cause. If a claim can be checked, check it.
- **Don't assert a fix worked unless it was verified** (tsc passes, build
  passes, data confirmed, logs/response observed). "Should work" is not done.
- **Separate fact from hypothesis.** If something genuinely cannot be verified
  yet, say so explicitly ("I haven't confirmed this — here's how I'll find
  out") instead of presenting a guess as the answer.
- **When a fix doesn't hold, stop and instrument/investigate** (logs, repro,
  data) rather than shipping another guess. One verified fix beats three
  plausible ones.
- **Prefer reading the source of truth** (the code, the DB row, the API
  response, the log line) over inferring from symptoms or memory.

## Deploy policy — AUTO-DEPLOY enabled (Efrain, 2026-06-23)
**Deploy without asking.** After a change is verified (tsc clean + `npm run build` passes + any
fixtures), **commit → push → `vercel --prod` from this directory**, then report the prod URL +
readyState. Do NOT ask "want me to deploy?" for ordinary code/UI changes.
**Still confirm** only for genuinely destructive/irreversible actions (a migration that drops or
rewrites rows, anything outward-facing, anything that spends money) — a normal deploy is reversible
(revert + redeploy). History: auto-deploy was tried 2026-06-16, reverted same day, then re-enabled
2026-06-23 after per-deploy confirmation created friction.
