# GOTCHAS — Lumin Deals

### A NULL column in a UNIQUE index silently disables dedupe — Postgres treats NULL as DISTINCT
**Tried:** Relying on `calls_dedupe_uniq (call_ts, contact_phone, dialer_number_phone)` plus an upsert with `ignoreDuplicates` to make the automated call import idempotent. It was tested and genuinely worked — replaying a window inserted 0 rows.
**Failed because:** it only works while every column in the key is non-null. GHL returned two just-finished calls with `from` and `to` **empty**, so they stored with `dialer_number_phone = NULL`; a later fetch returned the same calls complete, and **both inserted again** — `NULL != NULL` in a unique index, so the index could never see them as the same row. The damage landed exactly where it hurt most: the two calls were Brianne's, on a page whose entire purpose is tracking her call volume, so she was double-counted AND a phantom "Unknown" dialer appeared. Nothing errored. It surfaced only because Efrain sent a screenshot with an "Unknown" row in it.
**What works:** never write NULL into a column that participates in a unique index — the mapper emits `''` for a missing dialer number, which collides properly. Belt and braces: the sweep now holds its right edge back 5 minutes (`SETTLE_MS` in `lib/callsSync.ts`) so a call is only ever read once GHL has finished populating it, which removes the incomplete read at the source. Both fixture-locked.
**⚠️ Generalises:** any "idempotent upsert" claim in this repo is only as strong as the nullability of its conflict target. Check every column in the index for nullability before trusting it — and prefer a sentinel over NULL for anything that can legitimately be absent.
**Project:** lumin-deals
**Date:** 2026-08-12

### `channel=Call` on GHL's message export returns ringless voicemail drops as if they were dials
**Tried:** Automating the call import with `GET /conversations/messages/export?channel=Call`. The filter is named `Call`, the rows come back with `messageType` starting `TYPE_CALL…`, and the obvious move is to store everything the filter returns.
**Failed because:** the feed mixes **`TYPE_CALL`** (a real dial) with **`TYPE_CAMPAIGN_VOICEMAIL`** (an automated ringless voicemail drop). In one 5-day window that was **615 campaign rows against 713 real calls** — storing them would have inflated dial counts ~45% and destroyed dials/lead, the per-LO effort metric. Nothing errors; the page just quietly reports that the team dials twice as much as it does. The tell that they don't belong: the GHL **Call report CSV excludes them**, and API `TYPE_CALL` alone matched the stored CSV row count for the window **exactly, 713 = 713**.
**What works:** filter `messageType === 'TYPE_CALL'` in the mapper and reject everything else, including on the way in from any future channel. Fixture-locked as the first assertion in `scripts/calls-api-check.ts`.
**⚠️ Neighbouring trap in the same payload:** `meta.call.duration` is in **SECONDS**, not the milliseconds the field's bare name suggests — verified on 393 calls where both the CSV and the API report non-zero (ratio 1.000 at p10/p50/p90). And `sortBy` accepts only `createdAt`/`updatedAt`; `dateAdded` 422s.
**Project:** lumin-deals
**Date:** 2026-08-12

### Two exports of the SAME GHL call disagree on whether it connected — 27% of the time
**Tried:** Treating GHL's Call report CSV and the API's message feed as two views of one fact, so the automated import could seamlessly continue where the manual uploads stopped.
**Failed because:** on **189 of 712** paired calls the two sources disagree about whether the call connected **at all** — 105 where the API reports a duration and the CSV says 0, and 84 the other way (including a CSV row of 4,839s the API calls 0). Where both report a duration they agree exactly. Since `isConnected()` is `duration_sec > 0`, that means the same call can read as a conversation from one source and a no-answer from the other. I tested and **rejected** the obvious explanation — that Brianne dialing into both sub-accounts creates cross-account mispairs — by re-pairing strictly within one account (identical split), confirming no call appears under both labels in the window, and confirming no duplicate API rows. **Which source is right is not determinable from our side.**
**What works:** don't pick a winner, and don't let the choice leak into history. The sweep is **forward-only** — each account resumes from its own newest stored call and never rewrites a CSV row — and `source_file` marks which source produced each row so the seam stays auditable. The aggregates were measured before committing to this: like-for-like outbound connect rate is **69% on both** sides, so the rollups are unaffected even though individual calls differ.
**⚠️ Second reason backfilling is banned:** the API's second-truncated timestamp lands **±1s** from the CSV's on ~16% of rows, so those slip past the `(call_ts, contact_phone, dialer_number_phone)` unique index and would DUPLICATE the call. API rows are idempotent against each other (same message → same truncated second), which is what makes re-runs safe.
**Project:** lumin-deals
**Date:** 2026-08-12

### A GHL *Workflow* webhook can only send extra fields NESTED under `customData` — this has now killed two branches
**Tried:** Writing webhook branches that read their inputs from the top level of the body (`body.note`, `body.event`, `body.channel`). That's correct for GHL's **native** marketplace events, and the code reads naturally.
**Failed because:** the account doesn't use native events — every webhook here is fired by a GHL **Workflow**, and a workflow can only attach extra data through its **Custom Data** block, which GHL nests under `customData`. Anything the branch needs that isn't part of the standard contact envelope arrives one level down. The branch then finds nothing and rejects the event **with a success-shaped 200**, so nothing ever errors and nothing gets reported.
- **2026-07-16:** the message branch checked top-level `type/event/messageType`. The reply workflows were sending `customData.event = inbound_message`. The branch had never fired — proven only because all 17 reply bodies were sitting in the *contact* path's `raw_ghl_data`.
- **2026-08-11:** the NoteCreate branch read `pick(body, 'note', …)`. A Note Added workflow can only send `customData.note`, so it would have rejected 100% of real notes as "No note content" — found by reading the code before recommending the workflow, not by a bug report, because **there was no workflow yet to generate one.**
**What works:** any branch fed by a workflow reads **top-level first, then `customData`** — `resolveWebhookEventType` and now `noteText()` both do. When adding a branch, ask "could this field only come from a Custom Data row?" — if yes, read both.
**⚠️ Related trap in the same family:** a Custom Data value that references a merge tag GHL can't resolve is delivered as the **literal `{{…}}` string**, not empty — `pipelineStageName` came back unresolved on 146/146 audited bodies. `cleanGhlId` already rejected that for ids; `noteText` now rejects it for text, because a literal `{{note.body}}` pasted onto a deal is worse than no note.
**Project:** lumin-deals
**Date:** 2026-08-11

### `.single()` on a contact-keyed lookup is a silent dropper — 479 contacts own more than one deal
**Tried:** Resolving "the deal for this contact" with `.eq('ghl_contact_id', id).single()` in the webhook's note branch — reasonable-looking, since most contacts do have exactly one loan.
**Failed because:** PostgREST's `.single()` **errors** ("Cannot coerce the result to a single JSON object") when the filter matches more than one row. Measured against live data: **479 contacts own multiple deals**. The error was destructured away (`const { data: existing }` with no error check), so `existing` was simply `undefined` and the branch returned "Contact not found for note" — meaning notes would have been dropped for precisely the multi-loan borrowers where they matter most, with no error surfaced anywhere.
**What works:** `.order('created_at', {ascending:false}).limit(1)` and take `[0]` — newest deal wins, the same rule `buildContactDealMap` already uses to attach GHL tasks. Whenever a lookup is keyed on **contact**, assume multiple deals ([[multi-loan-opportunity-matching]] is the standing rule) and never use `.single()`.
**Project:** lumin-deals
**Date:** 2026-08-11

### A contact-less GHL task is NOT a deleted tombstone — it's alive, and `/locations/{loc}/tasks/{id}` can delete it
**Tried:** Clearing 12 leftover `ZZ TEST — … (auto-deleted)` tasks Efrain could still see in his GHL UI. The comment in `app/api/ghl/tasks/delete/route.ts` says deleting a task doesn't evict it from the search index and the row "keeps coming back with its contactId stripped" — so a search row with `contactId: null` reads like a tombstone of something already deleted. All 12 had `contactId: null`, which seemed to confirm it, and the route's own fallback agrees: *"A row with no contact can't be deleted in GHL (there's no URL for it)"* — it drops the mirror row and gives up.
**Failed because:** both readings were wrong, and the second one is why the junk accumulated in the first place. The full search row carries **`"deleted": false`** — these were live tasks that had merely lost their contact association (the throwaway *contacts* were cleaned up, orphaning the tasks). And there IS a URL for them: **`/locations/{locationId}/tasks/{taskId}` supports GET and DELETE**, no contact required. The contact-scoped path is not the only one. Every time that fallback branch fired, a real task was silently abandoned in GHL while the board pretended it was handled.
**What works:** `DELETE /locations/{locationId}/tasks/{taskId}` → `200 {"succeded":true}` (GHL's typo, not ours). All 12 deleted and verified gone from both locations, open and completed.
**⚠️ Second trap, stacked on the first:** GHL answers a re-read of a **deleted** task with **`400 {"message":"The task id is invalid."}`**, *not* 404. My verifier only treated 404 as gone, so the very first delete — which had genuinely worked — was reported as `FAIL`. Checking the search index afterwards is what proved it (8 ZZ rows → 7). **Any "is it gone?" check against GHL tasks must accept 400-invalid-id as success**, or a working delete looks broken and you delete it again.
**Fixed 2026-08-05:** the route now deletes via the location endpoint **always** — the contact-scoped call and the give-up branch are both gone, so there is one path instead of two. Verified that the location endpoint also deletes a task that DOES have a contact (throwaway task created and deleted), which is what makes the single path safe. `isTaskGoneResponse()` in `lib/ghlTasks.ts` centralises the 400-vs-404 rule and is fixture-locked, including the negatives — a *different* 400, a 401 and a 500 must NOT read as "gone", or a bad key would look like a successful delete.
**Project:** lumin-deals
**Date:** 2026-08-05

### GHL's `tasks/search` index is EVENTUALLY CONSISTENT — it will tell you a working write failed
**Tried:** Probing whether a completed GHL task can be reopened, and checking the result the obvious way: call `PUT /contacts/{cid}/tasks/{id}/completed {completed:false}`, then re-run `POST /locations/{id}/tasks/search` to see which bucket the task lands in.
**Failed because:** the search index lags the write by seconds. A task that had just been created and completed showed up in **neither** the open nor the completed bucket, and after the reopen the index still reported `completed:true` — so the probe concluded the endpoint was a no-op that returns a lying 200. It isn't. The next call in the same script (a different method) then "succeeded" purely because by then the index had caught up with the *earlier* write. Sequencing several methods against one task makes this worse: every verdict is attributed to the wrong call.
**What works:** the single-task **`GET /contacts/{cid}/tasks/{id}`** is the ground truth — it's read-your-write. Give each method its **own** task so results can't be attributed to a previous call, and put a beat between the write and the read. Re-probed that way, all three reopen methods work. The reopen route bakes this in: it re-reads the single task and only reports success if the flag actually flipped, never on the 200 alone.
**Note:** this is the same family as the FUB silently-ignored-params trap, with a twist — there the response lied, here the *verification source* lied. It also explains why a just-deleted task still looks open in the index for a while, on top of the separate tombstone behaviour below.
**Project:** lumin-deals
**Date:** 2026-08-04

### Merging namespaced `ghl:` rows into the board arms a bulk delete that runs on `deal_tasks.id`
**Tried:** Adding completed GHL tasks to the same `tasks` array `/tasks` already renders, which is what makes every existing filter, chip, column and sort work on them for free.
**Failed because:** `clearCompleted()` was written as `tasks.filter(t => t.completed_at).map(t => t.id)` back when a GHL row could never carry a `completed_at` (the mirror stores open rows only). The moment completed GHL rows join that array, the id list contains `ghl:<id>` strings — and PostgREST casts the whole `.in('id', …)` list against `deal_tasks.id`, a **uuid**. One bad value fails the cast and aborts the **entire** delete, so "Clear completed" silently stops working whenever the Completed chip is open.
**What works:** bulk operations read the SOURCE array (`dealTasks`), never the merged board. The merged array is for rendering; anything that writes must start from the table it writes to. Fixture-locked: `ghl-tasks-check` asserts a completed board id is not a uuid, so the trap fails loudly if the id scheme ever changes.
**Project:** lumin-deals
**Date:** 2026-08-04

### FUB email has NO account-wide feed — discover it from the person payload, not an endpoint
**Tried:** Pulling inbound emails the way texts and calls are pulled, with a bulk `/v1/emails` query.
**Failed because:** `/v1/emails` returns **400** unless you pass `id list, inboxThreadId, personId or personId and threadId` — there is no filter that yields "all inbound email for this user", and `toNumber`-style tricks don't apply to email. `/v1/events` is no help either: its type vocabulary is lead-source only (Registration / Seller Inquiry / Viewed Page / Property Inquiry), with no email types.
**What works:** the **person payload** carries per-channel timestamps including `lastReceivedEmail` — and the hourly sweep already fetches every person with `fields=allFields`, so discovery costs **zero extra API calls** if you do it there. `emailWaitingFromPeople()` computes the candidates on the sync into `sync_state.fub_email_waiting`; the live route reads that list and re-verifies each candidate with `/v1/emails?personId=` so a reply sent since the sweep doesn't leave a stale row. Two details that matter: direction on `/v1/emails` is **`status: 'Sent' | 'Received'`** (there is NO `isIncoming` field on that endpoint, unlike texts and calls), and responses must stay **personal channels only** — counting `lastSentBatchEmail` / `lastSentActionPlanEmail` / `lastDeliveredMarketingCampaign` would let a marketing blast mark a real inbound email "answered".
**Project:** lumin-deals
**Date:** 2026-07-30

### FUB `/v1/calls`: `toNumber`/`fromNumber` are honored, `userId`/`isIncoming` are SILENTLY IGNORED
**Tried:** Fetching one LO's inbound calls with `/v1/calls?userId=72&isIncoming=true`.
**Failed because:** both params are ignored and the response comes back **unfiltered** — `_metadata.total` stayed at 5,193 (Moe) / 9,393 (Matt) and the rows contained both directions. No error, no warning. Same family as the documented FUB trap, and the reason to re-check every param rather than assume the pattern from `/textMessages`. What IS honored: **`toNumber`** (→ 100/100 incoming), **`fromNumber`** (→ 100/100 outgoing) and **`personId`** (→ both directions for one person). Direction must be established by WHICH number filter you use, never by a query param.
**What works:** verify every filter by comparing `_metadata.total` against the unfiltered call before building on it. A filter that changes nothing is the tell.
**Project:** lumin-deals
**Date:** 2026-07-30

### A missed FUB call is `outcome === 'No Answer'` — duration is NOT the signal
**Tried:** Classifying incoming calls as missed when `duration === 0`.
**Failed because:** **13 of 100** of Moe's incoming "No Answer" calls had a duration **greater than zero** — up to **278 seconds** of voicemail recording. A duration test silently reclassifies an eighth of the missed calls as "answered", i.e. as work already handled. Incoming calls carry exactly two outcomes (verified across both LOs): `null` = someone picked up, `'No Answer'` = missed.
**What works:** `isMissedInboundCall()` tests `outcome`, not duration. Corollary for the reply inbox: an **answered** inbound call belongs on the RESPONSE side of the ledger — they rang, someone picked up, the conversation happened — and an **outbound** call answers an inbound text, so phoning someone back clears their unanswered message.
**Project:** lumin-deals
**Date:** 2026-07-30

### "Clear this from my list" needs its own ack store — a column on the synced table can't hold it
**Tried:** Using `fub_people.last_touched_at` as the dismiss signal for the reply inbox.
**Failed because:** two things. (1) Semantics — "Touched" claims *we reached out*, but Efrain's actual need is "sometimes a reply doesn't need a reply from us, can we check it off". Those are different facts and conflating them corrupts the past-client idle math. (2) Coverage — the FUB sweep stores **Past Client + Closed + task-holders only**, so a texter who isn't in `fub_people` has **no row to write to**. Those were exactly the rows that rendered with *no buttons at all* (Joey Kiamco, Eutah Modegoren, Rose Luttrell, Clara).
**What works:** a standalone ack keyed on `fub_id` alone, in `sync_state.fub_inbox_acks` (`lib/fubInboxAcks.ts` + `/api/fub/inbox-ack`) — the same contract `comm_read_acks` already provides for GHL: **store the timestamp of the message you cleared**, and let a strictly NEWER inbound bring the row back. Server-side with the service role, so it works for unstored people and regardless of RLS, and needs no migration. Never move an ack backward, or a stale client replaying an old timestamp un-clears a newer message.
**Project:** lumin-deals
**Date:** 2026-07-30

### Paging two feeds by PAGE COUNT gives them different TIME horizons — anchor to a cutoff instead
**Tried:** Reconstructing "who texted and nobody answered" from FollowUpBoss by pulling 3 pages (300 messages) of inbound and 3 pages of outbound, then comparing the newest of each per person.
**Failed because:** outbound volume is far higher than inbound (drips, mass sends), so equal page counts span **unequal time**. Measured live on Moe: 300 inbound reached **62 days** back, 300 outbound only **52**. Every reply older than that 52-day horizon was invisible, so anyone whose inbound landed in the 52–62 day gap was reported as ignored forever. **Live proof:** Tami Boteilho showed as "texted 59d ago, nobody answered" when Moe had in fact replied — with a 😂 — **98 seconds later**. The failure is silent and one-directional: it can only ever invent work, never hide it, so nothing looks broken.
**What works:** page each direction to a **time cutoff** (`fetchTextsUntil`, `INBOX_LOOKBACK_DAYS = 90`), and make the outbound window reach at least as far back as the oldest inbound kept — that equality IS the correctness argument for the comparison. Because a page cap can still bite, anything whose inbound predates the outbound horizon is treated as **unproven, not unanswered**, and verified against that person's own `/textMessages?personId=` thread (`threadShowsReply`). Generalizes: whenever two paginated streams are compared, equal page counts are not equal coverage.
**Project:** lumin-deals
**Date:** 2026-07-30

### A Supabase write blocked by RLS returns SUCCESS WITH ZERO ROWS — `error` is null
**Tried:** `await supabase.from('fub_people').update({...}).eq('fub_id', id)` from the browser, checking only `if (error)`.
**Failed because:** PostgREST applies RLS as a row **filter**, not a permission error. A blocked update matches nothing, updates nothing, and returns `{ error: null }` — byte-identical to a successful write. The button appears to work and silently does nothing (Efrain: *"this touched button does not do anything"*). Verified directly: an anon-key `update` on `fub_people` returned `error: null` with **0 rows**, while the same write from a logged-in session persisted fine. It also means **the local `LOCAL_AUTH_BYPASS` dev server cannot exercise any client write path** — there's no Supabase session behind the bypass, so every browser-side write silently no-ops locally while working in prod.
**What works:** append **`.select('id')`** to every client-side update and treat `!data?.length` as failure, same as an error — that is the only way to distinguish "saved" from "silently filtered". Verify write paths against prod state (or a service-role script), never against a bypassed local session.
**Project:** lumin-deals
**Date:** 2026-07-30

### An action button on a LIVE-fed list must feed its result back, or it looks broken
**Tried:** Reusing the cockpit's shared `rowActions` (Task / Touched / Snooze) for the reply-inbox section.
**Failed because:** every other section is built from Supabase state the page already holds, so a write plus a local `setState` visibly updates the row. The reply inbox is built from **live upstream reads** (`/api/ghl/unread`, `/api/fub/unanswered`), which those writes don't touch — so Touched wrote `last_touched_at` correctly and the row just sat there. Correct data, zero feedback.
**What works:** give each action an explicit suppression rule in the builder AND an optimistic session dismissal. `buildReplyInbox` now drops a FUB row whose `last_touched_at` is at/after their last inbound (a touch from BEFORE their message must NOT clear it — that's the reply they're waiting on), drops anything with a future `next_action_due` (snooze), and honors a `dismissed` key set for the current session. GHL rows get **Done**, which writes `comm_read_acks` — the ack `/api/ghl/unread` already respects — and is only offered where a `conversationId` exists, since without one the dismissal couldn't persist.
**Project:** lumin-deals
**Date:** 2026-07-30

### A "leave that to the other page" exclusion can cancel a feature outright — check what's LEFT, not what's removed
**Tried:** The Follow-Up cockpit's "Replied — waiting on you" skipped deals whose status was in `HOT_WORKING_STATUSES` (Responded / Pitching / Appointment Booked / App Intake), reasoning that /hot-leads already works those tabs. Sensible in isolation, reviewed as such, shipped.
**Failed because:** those are **exactly the statuses a lead occupies when they reply** — GHL's workflow moves a replying lead to `Responded` before the message reaches us. Everything the filter left behind was either parked in `Not Ready` (also excluded, correctly) or a New Lead/Ghosted row with no inbound. The section therefore matched **0 rows for BOTH LOs**, and read as a cheerful "Inbox zero — no unanswered replies" while GHL showed 5 unread. A filter that removes 100% of the population looks identical to an empty population.
**What works:** when adding an exclusion, run the predicate over the real table with and without it and compare counts (`scripts/`-style probe, 30 seconds). Here: with 0/0, without Matt 2 / Moe 3. Fixtures now assert all four hot statuses DO count as reply-waiting.
**Project:** lumin-deals
**Date:** 2026-07-30

### `deals.last_inbound_at` / `last_outbound_at` are stale outside the lead stages — the webhook never writes them
**Tried:** Treating those columns as the live "who messaged last" signal for any deal.
**Failed because:** they are written by **one** path — `app/api/sync/conversations` on the 30-min tick — and only for `['Responded','Pitching','App Intake']` plus the early triage stages bounded to 10 days. The GHL webhook writes `last_communication_at`, `last_communication_type`, `comm_unread_count` and `last_inbound_message`, and **nothing else**. So every deal past App Intake (Loans in Process, Funded, Pre-Approved, an older Appointment Booked) has frozen inbound/outbound timestamps. Live: Scot Gordon had `comm_unread_count` 1 with `last_communication_at` = today and `last_inbound_at` = **15 days earlier**.
**What works:** for a "who is waiting on us" question spanning all stages, use the LIVE feed `/api/ghl/unread` (one conversations-search per account, `status=unread`, already powering the dashboard inbox) and keep the synced columns as a supplementary source. `last_communication_at` is fresh everywhere; the directional pair is not.
**Project:** lumin-deals
**Date:** 2026-07-30

### FollowUpBoss: the unread inbox is owner-only, and the per-message `read` flag is a lie
**Tried:** Reading FUB "unread messages" with the agent-level API keys (`FUB_API_KEY_MOE` / `FUB_API_KEY_MATT`).
**Failed because:** `GET /v1/threads`, `/v1/conversations` and `/v1/notifications` all return **403 "You do not have access to this API endpoint"** for agent keys. `/v1/me` exposes only `unreadConversationCount` — a single integer with no drill-down. And the message-level `read` boolean is worthless: across 300 inbound texts per LO it was `false` on **300/300** (including weeks-old, certainly-read ones) and `true` on 300/300 outbound — it is a delivery receipt, not the inbox. Building on it would have marked every inbound message forever unread.
**What works:** `/v1/textMessages` requires one of `personId, threadId, phone, toNumber, fromNumber, sharedInboxId, groupTextId, participants, id` — and **`toNumber` / `fromNumber` with the LO's own calling number (`/v1/me.callingPhoneNumber`) are honored** (verified 300/300 correctly directional). Page both, group by `personId`, and a person whose newest inbound has no newer outbound is waiting on you. That's `fetchFubUnanswered()` in `lib/followUpBoss.ts`. Also note FUB may redact bodies to the literal string `* Body is hidden for privacy reasons *` — strip it (`messagePreview`) rather than render it. Not reachable this way: FUB email (`/v1/emails` also demands a personId/threadId); inbound calls ARE listable account-wide via `/v1/calls` with `isIncoming`.
**Project:** lumin-deals
**Date:** 2026-07-30

### An opportunity missed ONCE by the incremental sync is missed FOREVER — the maintenance pass does not rescue it
**Tried:** Assumed the ~3-hourly maintenance pass would pick up any opportunity the 15-min incremental sync had skipped, since maintenance sets `needFullOpps` and fetches the COMPLETE opportunity list.
**Failed because:** fetching everything is not the same as processing everything. `changedOpps` is filtered by the cursor whenever `isFullSync` is false (`app/api/sync/ghl/route.ts:648-659`), and **the create/update loop iterates `changedOpps`, not `opportunities`** (`:782`). Maintenance runs pull the full list only so the PRUNE has the live set — creation still obeys the cursor. So an opportunity whose `updatedAt` slipped below the cursor once (GHL's opportunity SEARCH index lags the live record, and the only protection is `INCREMENTAL_OVERLAP_MS = 10 min`, `:618`) is filtered out on every subsequent run forever, because its `updatedAt` never moves again. **Live proof 2026-07-28:** 11 of Randy's leads created 7/24–7/28 — one at *Appointment Booked*, several priced — were absent from the dashboard for four days across dozens of incremental AND maintenance runs. A single `?full=1` ingested all 11 immediately, with correct source, purpose and lead price.
**What works:** **FIXED 2026-07-28 (`5c00dce`, prod `lumin-deals-8oqwwou6f`).** Maintenance runs now load every stored `ghl_opportunity_id` and process any opportunity with **no deal**, regardless of its `updatedAt` — logged as `Rescued N`. So a miss self-heals within ~3 hours instead of never. The predicate is `shouldProcessOpportunity()` in [lib/syncCursor.ts](lib/syncCursor.ts) (extracted so it is testable — this file's own top entry explains why), fixtures in `scripts/sync-cursor-check.ts`. Cost is bounded: the id scan runs on the ~3-hourly maintenance tick, not the 15-min ping, and the extra processing is exactly the set of opportunities with no deal — normally empty. Verified live: a real maintenance run rescued 0 and still skipped 2 028 by the cursor, 9.6 s. `?full=1` remains the manual escape hatch.
**Project:** lumin-deals
**Date:** 2026-07-28

### A route-local helper that SHADOWS a lib helper by name defeats review — the guard looks present at the call site
**Tried:** Verifying the 2026-07-08 source-drift fix by reading the sync's call site, `source: cleanSource(...)`. It reads as guarded, so the sync was recorded as fixed and the webhook was blamed as the sole leak.
**Failed because:** `app/api/sync/ghl/route.ts` declared its **own** `cleanSource()` (`:250`) that rejected only `loan-audit-reconciliation:*` junk and passed **"Arive"** straight through — while `lib/utils.ts` had the real guard that rejects the LOS name. Same identifier, different function, no import to give it away. The sync re-stamped "Arive" over real vendors on **every 15-min pass** (`source` is in the update field list, `:986`), so the July backfill's 17→1 regrew to **200 by 2026-07-28** — a row landed mid-investigation. A self-healing-looking bug that generates no error and reverts every manual fix within 15 minutes.
**What works:** ONE exported definition; delete route-local copies and fold their extra filtering into the shared one. When auditing a guard, `grep -n "function <name>"` across the repo before trusting a call site — a bare call proves nothing about *which* function runs. Fixtures now pin it (`scripts/lead-source-check.ts`).
**Project:** lumin-deals
**Date:** 2026-07-28

### `cleanSource(a ?? b ?? c)` is a bug shape — coalesce-then-clean lets a rejected value shadow a good one
**Tried:** Resolving a lead source from GHL's candidate chain with `cleanSource(customField ?? contact.source ?? opp.source)`.
**Failed because:** `??` picks the first **non-null** candidate and only the winner is cleaned. Arive writes its name into the contact-level `source` on sync-back, so `"Arive"` won the coalesce, cleaned to `null`, and the real vendor one position down (`opp.source = "FRU"` on Garry Swatzel) was never consulted. Combined with `maybeSet` skipping nulls, the deal kept its stale value indefinitely — no error, no log line.
**What works:** clean each candidate **individually** and take the first survivor — `resolveLeadSource(...)` in `lib/utils.ts`. Applies to any filter-plus-fallback chain, not just sources: if a value can be *rejected*, rejecting it must fall through to the next candidate rather than ending the search.
**Project:** lumin-deals
**Date:** 2026-07-28

### A GHL opportunity STATUS flip (open→lost/won) is NOT caught by the 15-min incremental sync — only the 3-hourly maintenance pass
**Tried:** Assumed a "lost" flip would demote to Not Ready within ~15 min (next incremental sync).
**Failed because:** the 15-min cron ping runs a pure **incremental** sync (`fetchOpportunitiesSince`, `app/api/sync/ghl/route.ts:495`) that pages GHL opps by `updatedAt` DESC and **early-stops** once it passes the last cursor (`if (ms < sinceMs) break`). A GHL **status change does NOT bump `updatedAt`** — only `lastStatusChangeAt` moves — so the changed opp stays in its old (older) position, below the cursor, and the scan stops before ever reaching it. The `?? lastStatusChangeAt` fallback in the comparison is moot: discovery is by updatedAt order, so it never gets there. **Live-test proof (2026-07-10):** marked Laurie Shore lost at 20:33Z; the 20:45 incremental ran (sync_state stamped; only 3 deals touched) and did NOT demote her — still `Leads/open` 15+ min later. `ghl_maintenance_last` was 18:15, so no full pass ran at 20:45.
**What works:** lost/won demotion happens only on (a) the **~3-hourly maintenance full-opp scan** (`MAINTENANCE_INTERVAL_MS = 3h`, `cron/ghl-sync/route.ts:31` → `fetchAllOpportunities` reads every opp's `status`), (b) a **manual full "Sync GHL"** / `?full=1`, or (c) the **webhook** — but the webhook only helps if GHL is configured to POST status changes to it (today it is NOT). Net real latency for a lost loan to leave Active Escrows: **up to ~3 hours**, not 15 min. Fix = wire the real-time lost webhook (deployed & ready) to a GHL "Opportunity Status Changed → Webhook" workflow.
**Project:** lumin-deals
**Date:** 2026-07-10

### `raw_ghl_data` on deals is SYNC-written, not webhook-written — don't treat captured payloads as proof of real-time webhook delivery
**Tried:** To learn what GHL POSTs to our webhook on a status change, I read `deals.raw_ghl_data` (the webhook stores `raw_ghl_data: body`). Found native GHL opportunity objects with `status:"lost"` and assumed the webhook receives them in real time.
**Failed because:** the **sync also writes `raw_ghl_data: opp`** (`app/api/sync/ghl/route.ts:908`). The tell: 30+ deals all stamped within the same 1-second `updated_at` batch = a sync run, not individual webhook POSTs. So a native-opportunity-shaped `raw_ghl_data` proves what the sync *fetched from GHL's API*, NOT what GHL *pushed to our endpoint*. Whether GHL fires a real-time webhook on opportunity status change is a GHL-side workflow/subscription config, invisible from the DB and the codebase.
**What works:** to check real-time delivery, read Vercel function logs for `/api/webhooks/ghl` (live POSTs), or inspect the GHL Workflow/webhook config directly. To learn payload *shape*, `raw_ghl_data` is fine — just don't infer *delivery* from it.
**Project:** lumin-deals
**Date:** 2026-07-10

### GHL opportunity "lost" arrives as status=lost with the stage as a pipelineStageId UUID (no stage NAME) — name-based resolution silently skips it
**Tried:** The webhook demoted lost opps only inside `if (whStage)`, where `whStage = resolveGHLStage(stageName, ...)` needs a stage NAME. Reasonable, since stage-change events carry names.
**Failed because:** GHL separates opportunity **status** (open|won|lost|abandoned) from **stage**. When the team marks a loan "lost" they LEAVE the stage, and GHL's native opportunity payload carries only `pipelineStageId` (a UUID) — never a `pipelineStageName`. So `resolveGHLStage` got no name, returned null, `whStage` was falsy, and the lost demotion was skipped entirely (fell through to the 15-min sync). Confirmed against 48 real dead payloads: every one had `status` but only a stage UUID. Bonus trap: the stage-change branch's `resolveGHLStage("lost")` *partial-matches* the key "lost to competitor" and would relabel the stage to "Lost to Competitor" — silently rewriting the real last stage.
**What works (2026-07-10):** demote off `status` DIRECTLY, independent of stage — `isDead = status==='lost' || startsWith('abandon')` → set `pipeline_group:'Not Ready'` + `ghl_status`, keep the stage label, guard Funded. Mirrors the sync's isDead rule (`sync/ghl/route.ts:806`), which never had this bug because it reads `opp.status` directly.
**Project:** lumin-deals
**Date:** 2026-07-10

### Supabase auth email links: the PKCE `code` flow CANNOT work for a dashboard-sent link
**Tried:** Building the password reset around `/auth/callback` + `exchangeCodeForSession(code)` — the pattern most
Next.js + Supabase examples show.
**Failed because:** PKCE writes a **code verifier into the originating browser's local storage** when the flow starts.
Supabase's own docs: *"the code exchange must be initiated on the same browser and device where the flow was started."*
A link sent from the **Supabase dashboard** ("Send password recovery" / "Send magic link") is server-initiated — no
verifier exists anywhere — so the exchange can never succeed. Same failure if the user opens the email on their phone
after requesting the reset on their laptop. The `code` path silently half-works: fine when you test it yourself in one
browser, broken for every real user.
**What works:** the `token_hash` + `verifyOtp({token_hash, type})` path. `VerifyTokenHashParams` takes only
`{token_hash, type}` — no email, no verifier — so it is cross-browser and works for dashboard-sent links. Requires
editing the email template to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`;
the default `{{ .ConfirmationURL }}` hands back a `code`, not a hash.
**Also:** in the route handler you must build the `NextResponse.redirect(...)` **before** calling `verifyOtp`, so
`setAll` can write session cookies onto it. Copying the read-only client from `app/api/underwriting/route.ts`
(`setAll: () => {}`) verifies the token and then throws the session away — you land on the reset page logged out.
**Project:** lumin-deals
**Date:** 2026-07-09

### A new unauthenticated page renders wrapped in the authed sidebar (AppShell hardcoded `=== '/login'`)
**Tried:** Adding `/forgot-password` and `/reset-password`, adding them to `isPublic` in `middleware.ts`, assuming done.
**Failed because:** `components/AppShell.tsx` decided chrome with `const isLoginPage = pathname === '/login'`. Any other
public page therefore rendered with the full sidebar — nav links, "Sync GHL", and a **Sign Out button** — around a
"Link expired" card, for a visitor with no session. `tsc` and `npm run build` both pass clean; only loading the page
in a browser shows it.
**What works:** `CHROMELESS_PATHS` set in `AppShell.tsx`, kept in step with `isPublic` in `middleware.ts`. Two
allowlists, two files — when you add a public page, edit both.
**Project:** lumin-deals
**Date:** 2026-07-09

### The GHL sync is triggered by cron-job.org (free), which has a hard 30s timeout → heavy runs were cut off
**Tried:** A loan marked "Lost" in GHL stayed on Active Escrows for ~3h. The sync DOES demote lost opps
(`effectiveGroup → 'Not Ready'`), so why didn't it apply?
**Failed because:** the GHL sync is NOT a Vercel cron (vercel.json only has the 2 daily alert crons). It's pinged
by **cron-job.org**, whose request timeout maxes at **30 seconds** (free tier). Light incremental runs finish in
~6s (200 OK), but the periodic heavy runs (maintenance reconcile + identity resolver, which catch status drift
like lost/won) exceed 30s → cron-job.org logs "Failed (timeout)" and cuts the connection, so the heavy reconcile
never completes. Net: status changes that depend on the heavy pass linger until a manual "Sync GHL".
**What works (2026-06-29):** decouple the HTTP response from the work. `app/api/cron/ghl-sync/route.ts` now
acquires the lock, returns a sub-second `{ok:true, queued:true}`, and runs the whole sync + sub-tasks in
**`after()`** (`next/server`, stable in Next 16). cron-job.org always sees a fast 200 (never times out); the sync
runs to completion in the background up to `maxDuration=300`. SAME trigger + SAME work → **no new Vercel cron, no
added usage** (rejected a `*/5` Vercel cron because it adds ~288 metered runs/day). Verified locally: response 68ms,
and the background run completed (`synced 1, 1 updated, 794ms` in the logs). The lock self-heals via its 5-min TTL
if `after()` ever fails, and the manual Sync buttons (`/api/sync/ghl`) are unchanged as a fallback.
**Trade-off:** cron-job.org now reports success even if the background sync errors (its 200 is just the ack) —
sync health is in the server logs + LastSyncBadge, not cron-job.org's pass/fail.
**Project:** lumin-deals
**Date:** 2026-06-29

### Co-borrowers split into separate GHL contacts → duplicate escrow cards for ONE loan (the "Southerby case")
**Tried:** Paul + Cynthia Southerby (one $1.22M loan, Arive #16895210) both showed on Active Escrows. Paul's card
was the worked one (lender/processor/lock/notes) but Arive-created with `ghl_opportunity_id = null`; Cynthia's was
a bare card carrying the real GHL opportunity (`ffkS…`).
**Failed because (two compounding things):** (1) The loan's borrowers each have their OWN GHL contact, and the GHL
*opportunity* was created under the CO-borrower's contact (Cynthia), not the main borrower's (Paul). The dashboard
builds a deal per opportunity and derives identity from the opp's contact → a second card. (2) **A FULL SYNC
surfaced it.** The incremental 15-min sync only processes CHANGED opps, so Cynthia's opp sat in GHL ~18 days with no
dashboard deal; the manual `?full=1` sync (run for an unrelated fix) processed ALL opps and CREATED the card. So
running a full sync can spawn "new" duplicate cards from long-dormant opps — expect it.
**What works:** fix at the GHL source, then consolidate the dashboard. (a) In GHL you CAN reassign an
opportunity's primary contact (contradicting the earlier assumption) — Efrain moved the opp to Paul's contact;
verified via `GET /opportunities/{id}` that `contactId` flipped to Paul and Cynthia's contact had 0 opps. (b) Then
attach the now-correct opp to the WORKED card (`ghl_opportunity_id = ffkS…`), DELETE the bare duplicate, and clean
co-borrowers. Keeping the worked card (vs. merging into the bare one) avoids losing fields the merge route doesn't
carry (it has no `deal_contacts`/`ghl_opportunity_id` handling and a fixed MERGEABLE_FIELDS list). Durable because
the survivor now owns the opp (sync matches it, never recreates) and the co-borrower's contact has no opps.
**Side note found:** a deal can end up with its OWN primary listed as a `role='co'` in `deal_contacts` (inflates
the "+N" co-borrower badge) — `linkCoborrower` guards against it but old data had it; delete the self-link.
**Project:** lumin-deals
**Date:** 2026-06-29

### A GHL contact RENAME doesn't reach the dashboard via the 15-min sync — only a FULL sync re-pulls it
**Tried:** A borrower was renamed in GHL (Espinoza opp: the contact `t2BK…` was changed Judith → Jesus). The
dashboard kept showing "Judith" for days, through many 15-min syncs and manual "Sync GHL" clicks.
**Failed because:** the incremental sync only re-pulls a CONTACT when its OPPORTUNITY changed —
`fetchContactsForOpps(changedOpps)`, and `changedOpps` is filtered by opportunity `updatedAt`. Renaming a contact
doesn't bump the opportunity, so the opp isn't in `changedOpps`, so the new contact name is never fetched. The
manual "Sync GHL" button and the cron are BOTH incremental (no `?full=1`); the 3-h maintenance pass re-pulls all
*opps* but contacts are gated on `isFullSync`, so it doesn't help either. Net: a pure contact rename only
propagates on a real full sync (`isFullSync` → `fetchAllContacts`).
**What works:** force a full sync — `POST /api/sync/ghl?full=1` (or the cron URL `?full=1`). It re-pulls all
contacts and `deals.name` updates from `fullContact.name` (here → "Jesus Espinoza"). Verified 2026-06-29: full
sync = 1670 synced, the deal flipped to Jesus. NOTE: this does NOT touch `borrower_id` (sync never syncs it), so
the linked CONTACT record / "View Contact" can still read the old name until the identity resolver reconciles.
**Self-serve:** the sidebar has a **Full Sync** button (the small link under "Sync GHL") that hits
`?full=1` — use it after renaming a contact in GHL.
**Project:** lumin-deals
**Date:** 2026-06-29

### React reuses a DOM node across two ternary branches of the same type → contentEditable leftover doubles
**Tried:** A modal body rendered `{mode === 'edit' ? <div ref contentEditable/> : <div><NoteMarkdown/></div>}`
with NO `key` on either branch. The editor's content is set imperatively (`ed.innerHTML = markdownToHtml(...)`),
which React doesn't track.
**Failed because:** both branches are a `<div>` at the same position, so React **reuses the same DOM node**
across the toggle instead of unmounting/remounting. When switching edit→view, React rendered `NoteMarkdown`'s
children INTO the reused node while the editor's imperatively-set `innerHTML` was still there → the note
content rendered **twice** (visible doubling after an Edit→Done cycle). Data was never affected — `updated_at`
stayed put because the markdown round-trip is idempotent, so no save fired; purely a DOM-reuse render glitch.
Caught only by browser-verifying with a DOM eval (`Abraham's States` count went 1 → 2 after Edit→Done).
**What works:** give the two branches **distinct `key`s** (`key="note-edit"` / `key="note-view"`) so React
treats them as different elements and fully swaps the node (no leftover innerHTML). The original NoteCard had
`key="note-editor"/"note-view"` for exactly this reason; a rewrite dropped them. Rule: any conditional branch
that imperatively writes innerHTML (contentEditable) MUST have a stable, distinct key vs its sibling branch.
**Project:** lumin-deals
**Date:** 2026-06-25

### GHL webhook must match by opportunity id, not contact
**Tried:** The GHL webhook handler matched an incoming opportunity event to a dashboard deal via
`findExistingDeal({ ghlContactId, email, phone })` — by contact/email/phone.
**Failed because:** one GHL **contact** can hold **multiple opportunities** (a borrower with >1 loan).
With two loans on one contact, the FUNDED loan's "Loan Funded" workflow webhook matched the borrower's
*other* (withdrawn/adverse) loan — same contact/email — and the stage-apply marked it funded. The
`.neq('pipeline_group','Funded')` guard didn't save it because the sibling wasn't funded *yet*.
Symptom: John Winn showed 2 funded loans when one was Adverse/Lost. Tell-tale in the row:
`ghl_opportunity_id` (its own) ≠ `raw_ghl_data.id` (the funded opp), and raw payload was webhook-shaped.
**What works:** `findExistingDeal` matches by **opportunity id first**; contact/email/phone fallbacks
only return a match when they resolve to **exactly one** deal (never guess a sibling). The 15-min sync
was never the culprit — it already keys by opportunity id.
**Also note:** the fix can't self-heal an already-corrupted row (funded-guard blocks the webhook from
demoting it; the sync never clears `funded_date`) — corrupted rows need a manual correction.
**Project:** lumin-deals
**Date:** 2026-06-24

### "Arive" (the LOS) showing as a lead source in reports — one of THREE `source` writers bypassed the guard
**Tried:** After `cleanSource` (sync) + `isRealLeadSource` (Arive CSV) were both added to reject "Arive",
purchased leads STILL showed `source="Arive"` in `/lead-cohorts` + `/lead-performance`. A prior memory said
the overwrite lived in `lib/ariveCsv.ts`, so that's where I'd have looked.
**Failed because:** `ariveCsv.ts` was already guarded. The leak was the **GHL webhook**
(`app/api/webhooks/ghl/route.ts`), the THIRD writer of `deals.source`, writing it RAW —
`maybeSet('source', fields.contactSource)` (:481) and an insert default of `|| 'GHL'` (:264), no `cleanSource`.
Arive stamps its own name into GHL's **native `source` attribute** on sync-back; the webhook fell through to
it. And the sync's update path never overwrites an existing source with null (to protect manual categories),
so once written the bad value **froze** — the sync could never self-heal it.
**What works:** guard EVERY writer identically — wrapped the webhook's source writes in `cleanSource()` too
(nulls "Arive" → `maybeSet` skips → the existing real vendor is preserved). The true vendor was NOT lost: it
lives in the GHL contact **"Lead Source" custom field** (not the native `source`), so a one-time service-role
backfill re-attributed 16/17. Lesson: when guarding a derived column, grep for EVERY writer
(`grep -rn "source:" app/api lib`) before trusting a "the bug is in file X" note — a single unguarded path
silently poisons the whole column.
**Project:** lumin-deals
**Date:** 2026-07-08

### "Stuck" spinner on dashboard/pipeline = slow Supabase reads, not hung code
**Tried:** Suspected a code bug / broken deploy when pages sat on their loading spinner indefinitely
(2026-07-14, ~9:15–9:19am PT). Checked error boundaries, chunk staleness, client-error beacons — all clean.
**Failed because:** Nothing was hung. `performance.getEntriesByType('resource')` in the live tab showed the
pipeline's `deals?select=*` page-1 query took **133 s** (page 2: 66 s) vs the normal ~0.2 s. The window started
right at the 09:15 GHL sync (`last_synced_at` 16:15:09Z) and recovered ~4 min later — DB-side slowness after
the sync's bulk writes. The page finished loading by itself once reads recovered.
**What works:** Diagnose from the tab, not the code: read resource timings via Control Chrome
(status + duration per Supabase call) and compare against `/api/sync-status`. If durations are 100×
normal and recover, it's a DB slow-window, not a bug. Chronic aggravator: /pipeline and /deals use
`fetchAllDeals` with `select=*`, which drags the full `raw_ghl_data` JSON blob for every deal
(Dashboard.tsx already switched to an explicit column list for exactly this reason — its comment says
"never raw_ghl_data"). Narrowing those selects would shrink the blast radius of any future slow window.
**Project:** lumin-deals
**Date:** 2026-07-14

### Bare supabase-js .select() silently caps at 1000 rows — census/analysis scripts undercount
**Tried:** A one-off service-role census script (`.from('deals').select(...).in('status', [...])`) to size the
lead-triage backlog before building; reported 881 undecided leads / 115 Not Ready - Timeframe.
**Failed because:** PostgREST returns at most 1000 rows per request unless you paginate with `.range()`. The
query matched ~1,600+ rows, so the script got an arbitrary 1000-row slice — every per-status count was wrong
(real numbers, verified on the paginated live page: 1,444 undecided, 174 NRT). The lib already knew this —
`fetchAllDeals` exists precisely to walk pages — but ad-hoc scripts bypass it.
**What works:** In any offline script that counts or aggregates deals, either loop `.range(offset, offset+999)`
until short page (copy the fetchAllDeals loop), or use `.select('...', { count: 'exact', head: true })` when only
counts are needed. Treat any round ~1000 total in a script result as a red flag.
**Project:** lumin-deals
**Date:** 2026-07-14

### GHL's `id` is polymorphic — a `body.contact || body` fallback silently stores the OPPORTUNITY id as the contact id
**Tried:** `extractFields` in the GHL webhook resolved the contact with the reasonable-looking
`const contact = (body.contact as Record<string, unknown>) || body` then
`pick(contact, 'id', 'contact_id', 'contactId')` — "read the nested contact if present, else read the body."
**Failed because:** GHL's `id` field means different things per payload: the CONTACT id on a contact webhook,
the OPPORTUNITY id on an opportunity webhook. On a flat opportunity payload (no nested `contact` object) the
`|| body` fallback makes `contact === body`, so `pick(contact, 'id', …)` returns the **opportunity id** — and
because `'id'` was listed before `'contact_id'`, it beat the correct `contact_id` sitting right beside it in
the same payload. That value got written to `deals.ghl_contact_id`, so the dashboard's "open in GHL" button
rendered `/contacts/detail/<OPPORTUNITY_ID>` and GHL answered "Contact not found."
**Why it hid for so long:** the 15-min sync's maintenance pass reconciles `ghl_contact_id` from the live
opportunity, so every occurrence self-repaired within ~15–30 min. The bug was only ever visible if you
clicked the link inside that window — and the sync's own code comment already described the symptom, meaning
it had been patched downstream instead of at the write site. A self-healing bug generates no bug reports.
**What works:** Never trust a bare `id` on a polymorphic payload. Resolve in this order: nested `contact`
object → explicit `contact_id`/`contactId` → bare `id` **only when the payload is not an opportunity**
(`isOpportunityPayload()`). If nothing resolves, return `null` and let the caller's `|| undefined` leave the
stored value alone — writing nothing always beats writing a known-wrong id. Belt-and-suspenders at the render
site: `ghlContactUrl` returns `null` when `ghl_contact_id === ghl_opportunity_id`, so the whole class is
unrenderable. Locked by `scripts/ghl-link-check.ts`.
**Broader lesson:** when a downstream reconciler's comment describes a data corruption, that's a signal the
write site is still broken — fix the source, don't just widen the repair.
**Project:** lumin-deals
**Date:** 2026-07-16

### A hand-sorted Arive export rotates a COLUMN BLOCK against the borrowers
**Tried:** Importing a funded export that had been sorted in Excel to group the Non-Del loans at the bottom.
**Failed because:** the sort covered only part of the range, so `Loan Purpose` / `Loan Funded` / `Lender` /
`Lock Date` / `Lock Expiration` / `Loan Product` ended up shifted **exactly one row** against
`Primary Borrower`. Each borrower carried the PREVIOUS borrower's values, wrapping cleanly at both ends —
10 of 16 loans would have taken another loan's funded date and lender. Nothing about the file looks wrong:
every row is individually plausible, every column is populated, and the money columns (comp, percentage,
channel, net discount points) were correctly aligned, so a spot-check of the numbers passes.
**What works:** dry-run the plan against live data before committing and read the `funded_date` / `investor`
changes as a **chain**, not as individual diffs. A rotation announces itself as `B gets A's value, C gets B's
value, ...` with a wrap — that pattern is impossible from real data drift. Caught 2026-08-03 only because the
proposed dates lined up one-for-one with the DB's existing ones. The fix is a clean re-export from Arive, not
a code change. Also: Fadel's screenshot showed Rocket Pro / VA Jumbo while his export row said Change Mortgage /
NON-QM — a single cross-check against a source screen is enough to catch it.
**Broader lesson:** corrupted data that is internally consistent per-row is invisible to per-row validation.
Look for structure ACROSS rows.
**Project:** lumin-deals
**Date:** 2026-08-03

### Arive's "Compensation Amount" is only HALF the comp on a Non-Del loan
**Tried:** Treating `compensation_amount` as what a funded loan earned. It is the column Arive exports, it is
labelled "Compensation Amount", and every revenue number in the dashboard summed it — lead ROI, contacts
`total_comp`, the funded tracker, the refi radar.
**Failed because:** that column carries only the **Originator Compensation** line of Arive's Rate Lock screen. A
**Non-Delegated** lock also carries a **Final Price** rebate, which we earn too. Edward Fadel (Arive 16541057):
originator comp 0.750% = $8,212.35, Final Price 1.210% = $13,249.26. The dashboard reported $8,212.35 on a loan
that earned $21,461.61 — **the invisible half was the bigger one**. It never showed up as a bug because the
number that was there looked entirely reasonable.
**What works:** `lib/comp.ts` `totalComp()` = `compensation_amount` + (`net_discount_points`/100 x `loan_amount`),
the credit gated on `broker_corr === 'Non-Del'`. Never read `compensation_amount` for revenue again — the fixture
`scripts/comp-check.ts` anchors on Fadel. **The gate is load-bearing:** Arive exports net discount points on
broker loans too, but there the rebate already sits inside the lender-paid comp, so ungating it would inflate 76
of the 86 live funded loans.
**Broader lesson:** the dollar figure existed in **no** export column — not the 10-col funded report, not the
49-col DB Import, not GHL's opportunity custom fields. A field being absent from every feed is not evidence it
doesn't matter; it's the reason nobody noticed. When a screen shows two money numbers and the export has one,
ask which one the export is.
**Project:** lumin-deals
**Date:** 2026-08-03

### Running DDL against prod Supabase without psql/CLI (hosted dashboard)
**Tried:** `POST supabase.com/dashboard/api/pg-meta/{ref}/query` (404 "Endpoint not supported on hosted"), then
`api.supabase.com/platform/pg-meta/{ref}/query` with dashboard cookies (401) and with the dashboard Bearer
token (500 "Cannot call proxy query without connection string").
**Failed because:** hosted Studio's internal pg-meta proxy needs an encrypted connection-string header the page
derives separately; cookies alone never authenticate api.supabase.com.
**What works:** the public Management API — `POST https://api.supabase.com/v1/projects/{ref}/database/query`
with `Authorization: Bearer <access_token>`, body `{"query":"…"}`. The token lives in the dashboard's
localStorage under `supabase.dashboard.auth.token` (field `access_token`) on any logged-in supabase.com tab —
usable via Control Chrome `execute_javascript` from Efrain's session, keeping the token inside the page
(`window.__tok`, never echoed back). Multi-statement SQL incl. ALTER/COMMENT works (returns the last SELECT's
rows). Clean up the window globals afterwards. Used 2026-07-16 to add `deals.vendor_lead_id` +
`deals.last_inbound_message`.
**Project:** lumin-deals (works for any Supabase project ref)
**Date:** 2026-07-16

### Control Chrome `execute_javascript` runs in the ACTIVE tab, not the one you just opened
**Tried:** the DDL recipe above. `open_url` the dashboard, read the token into `window.__tok` (worked — the
result came back with the supabase.com href), then `fetch` the Management API from the page. Every follow-up
call died on `TypeError: Failed to fetch`, which reads exactly like a CORS/CSP block on api.supabase.com.
**Failed because:** it wasn't CORS. Between calls Chrome's active tab had moved to an unrelated tab, and
`execute_javascript` follows the ACTIVE tab, not the tab `open_url` created. So the fetch was firing from
`https://www.google.com` with `window.__tok` undefined — a cross-origin request with `Bearer undefined`. The
tell was cheap and I should have checked it first: return `location.origin` alongside the result. It said
`https://www.google.com` while I was assuming supabase.com.
**What works:** grab the tab id from `list_tabs` and pass `tab_id` on EVERY `execute_javascript` call, not just
the first. Also: an `async` IIFE returns a promise that marshals back as the useless string
`"JavaScript executed"` — assign the result to a global (`window.__res`) and read it in a second call.
Cheap invariant for any multi-call page session: have each call return `location.origin` and
`typeof window.__yourGlobal` so a silent tab switch shows up immediately instead of as a fake network error.
**Project:** any (Control Chrome generally)
**Date:** 2026-08-05

### An unverified claim written as a code comment becomes load-bearing and blocks real work
**Tried:** the GHL task mirror shipped with `// ⚠️ The search row has NO body/description — only the
single-task GET does.` On that basis, task descriptions were scoped out **twice** as "an extra GET per task per
sweep" — a cost nobody wanted.
**Failed because:** the comment was generalised from a handful of tasks that simply had no description set. A
live re-probe of both locations (105 rows) found `body` sitting in the payload all along, non-empty on 10. The
feature had been priced as expensive for months on the strength of a sentence no one re-checked, and the fix
turned out to be one field carried through the mapper — the render already existed.
**What works:** probe before pricing. A comment asserting what an API does NOT return is a claim with a
shelf-life, not a fact; when it's the reason something isn't built, re-verify it against the live payload
before accepting the tradeoff. Note the shape of the mistake: a *negative* claim ("X is not in the response")
generalised from a small sample is the easiest kind to get wrong and the least likely to be re-tested, because
nothing ever fails because of it. Same failure mode as the `tasks/search` "reopen is impossible" call on
2026-08-04 — both were beliefs about an endpoint, held without a probe, that cost a feature.
**Project:** lumin-deals
**Date:** 2026-08-05

### GHL workflow-builder edits can NOT be automated via Control Chrome
**Tried:** (1) driving the workflows UI by JS — it lives in a CROSS-ORIGIN iframe
(`client-app-automation-workflows.leadconnectorhq.com`), unreachable from the parent frame; (2) opening that
iframe URL standalone — blank, it only boots via a Postmate handshake from the shell; (3) the shell's
`refreshedToken` JWT against `backend.leadconnectorhq.com/workflow/*` and `services.leadconnectorhq.com/workflows/`
— 401 on every endpoint/header combo (wrong token audience; the iframe exchanges its own token, which lives in
module closures); (4) CDP — not enabled; (5) System Events/screencapture — permission-gated.
**Failed because:** GHL intentionally isolates the builder micro-frontend; the public API's workflow surface is
read-only (list only, no actions).
**What works:** workflow action edits are a HUMAN step in the GHL UI (20 seconds), or grant the harness
screen-automation permissions first (Accessibility — Screen Recording alone is NOT enough; the CLI binary needs
the grant, and real clicks need `cliclick`/CGEvents because System Events' `click at` resolves the AX element
without delivering an event Chrome's JS acts on). NOTE: driving the UI steals the one physical cursor — it
fights the user for the machine. The only non-disruptive path is Chrome launched with `--remote-debugging-port`
(CDP `Input.dispatchMouseEvent` targets a tab's renderer with no OS focus, and can also evaluate JS INSIDE the
cross-origin iframe) — but that flag is startup-only, so it needs a Chrome relaunch. Public API CAN list
workflows (id/name/status/**version**/**updatedAt**) — enough to verify a save landed, not what changed.
**Project:** lumin-deals / any GHL automation work
**Date:** 2026-07-16

### `vercel --prod` prints `ETIMEDOUT` but the deploy SUCCEEDS — on a delay (2026-07-16)
**Tried:** `vercel --prod` → `Error: request to https://api.vercel.com/v13/deployments... read ETIMEDOUT`. Retried.
Retried again. Pivoted to `--archive=tgz`. Every attempt printed the same error.
**Failed because:** only the RESPONSE to the create-deployment POST times out. The upload completes and the
deployment IS created server-side — but it can take **a minute or more to appear in `vercel ls`**. Checking
immediately shows nothing new, which reads as "genuine failure" and invites another retry. Six attempts across
two commits created **seven** redundant production deployments of identical code. (Plain reads are fine:
`vercel ls` / `inspect` respond in ~100-400ms, so this isn't general network trouble.)
**What works:** treat the error as **no information**. After ONE attempt, wait ~60-90s, then `vercel ls --prod`
and `vercel inspect https://lumin-deals.vercel.app` (shows the deployment the prod alias actually serves).
Only re-run if nothing appears after the wait. **The pile-up is not free:** the concurrent same-tree deployments
race, and one of the three (`7nnai1c7u`) went to **status Error** — its build compiled fine in 29s and it died at
"Deploying outputs...", i.e. lost the race, not a code fault. Prod was unaffected (the alias took a Ready one),
but an errored deployment in the list is a retry artifact, not a signal to go bug-hunting. **Also: the `vercel-deploy succeeded` / `build-passed` session hooks
fire on the COMMAND, not the outcome — they say "succeeded" on a failed deploy. Never use them as a result signal.**
**Project:** lumin-deals (Vercel CLI 48.x, 2026-07-16 — may be transient Vercel-side)
**Date:** 2026-07-16

### Browser-pane preview renders NOTHING at viewport 0x0 (looks exactly like a hydration bug)
**Tried:** `preview_start` → page showed only the app shell, stuck on the Suspense spinner. Spent ~10 min
diagnosing: read console (clean), network waterfall (all chunks 200/304), curl'd the SSR HTML (content present,
`$RC("B:0","S:0")` swap call present) — every layer said the app was fine.
**Failed because:** the preview tab had **viewport 0x0**. Nothing lays out, so nothing renders or hydrates.
`read_page` reports it (`Viewport: 0x0`) — but only if you look. Calling `resize_window` at START does NOT
reliably fix it, and `innerWidth/innerHeight` keep reporting `[0,0]` even after rendering starts, so the JS
probe lies too.
**What works:** take a **screenshot** — that forces a layout pass and the page renders immediately. Do that
FIRST on any "blank" preview, before touching a debugger. Tell: `document.body.innerText.length` is tiny
(~299 = nav only) while `querySelectorAll` still FINDS the elements — DOM present, layout absent.
**Broader lesson:** when every diagnostic layer says the code is fine, suspect the harness, not the code. A
`git stash` isolation test (does it reproduce WITHOUT my change?) answers it in 30 seconds and prevents
"fixing" working code.
**Project:** lumin-deals / any Browser-pane verification
**Date:** 2026-07-16

### `deals.updated_at` is NOT "when a webhook arrived" — the sync touches it (false-negative machine)
**Tried:** verifying a GHL workflow config change by querying `deals` for rows with
`updated_at >= <edit time>` and inspecting their `raw_ghl_data.customData` keys. Reported "the edit did not take
effect — post-edit payloads still have the old key." **That verdict was WRONG.**
**Failed because:** the 15-min `ghl-sync` cron writes `updated_at` on every row it touches WITHOUT rewriting
`raw_ghl_data`. So a row can carry a fresh `updated_at` and a payload captured hours earlier. The "post-edit
dirty payloads" were the 15:30 PT sync run touching rows whose bodies predated the edit. Tell: the arrival
cluster lines up exactly with a `*/15 8-18 * * 1-5` sync slot. Corroborating tell: `raw_ghl_data.workflow.name`
showed BOTH an old and current name for the same workflow id interleaved within 90s — stale stored bodies, not
stale GHL definitions.
**What works:** `raw_ghl_data` holds only the LATEST body per deal and has no arrival timestamp, so detect a
real webhook by CONTENT CHANGE — fingerprint `sha1(raw_ghl_data)` per deal, poll, and treat a changed hash (or
a new deal in the set) as the fresh-webhook signal. For stage moves specifically, `stage_events.created_at`
(`source='webhook'`) IS a true webhook arrival time, written by the webhook itself.
**Broader lesson:** before using a column as a proxy for an event time, check every writer of that column. Same
class of error as the opp-id bug (querying a column the bug itself poisons).
**Project:** lumin-deals
**Date:** 2026-07-16

### PostgREST timestamptz format breaks string-compare diffs
**Tried:** Sync differ compared stored vs freshly-mapped timestamps as strings to detect changed rows.
**Failed because:** PostgREST returns timestamptz as `2026-07-30T18:04:51+00:00`; `new Date().toISOString()` emits `2026-07-30T18:04:51.000Z`. Same instant, different strings → every row "changed" (re-sweep updated 5,212/5,212).
**What works:** Compare `Date.parse()` epochs (null/NaN-safe) — `tsEq()` in `lib/followUpBoss.ts`; fixture "pg timestamp format is not a change" locks it.
**Project:** lumin-deals
**Date:** 2026-07-30

### FollowUpBoss API: undocumented params are SILENTLY wrong, not errors
**Tried:** `GET /v1/people?updatedAfter=…` for incremental sync; `/v1/tasks?assignedUserId=…&status=…` for task filtering.
**Failed because:** FUB ignores/misapplies undocumented params without erroring — `updatedAfter` returned `total: 0` (looks like "no changes"!), tasks filters returned the identical unfiltered total. Both would corrupt logic silently.
**What works:** Only documented params (`lastActivityAfter`, `assignedUserId` on /people, `sort=-updated` + cursor walk for incremental). Verify every new param against a known-count probe first. Also: webhooks are account-OWNER-only (agent/broker keys 403) — polling is the only option with Moe/Matt keys; rate limit 125 req/10s unregistered.
**Project:** lumin-deals
**Date:** 2026-07-30

### FUB /tasks filters DO work — an earlier "silently ignored" verdict was wrong param names
**Tried:** `GET /v1/tasks?assignedUserId=72&status=incomplete&dueDateFrom=…&dueDateTo=…` → every variant returned the unfiltered 6,949, so tasks were written off as unfilterable (and left out of v1 of the cockpit).
**Failed because:** `status`, `dueDateFrom`, `dueDateTo` are NOT FUB parameters. Undocumented params are ignored silently, so a wrong name looks exactly like a broken filter.
**What works:** the documented set — `isCompleted=false`, `due=today|overdue|upcoming`, `dueStart=`/`dueEnd=`, `personId`, `type`. With those: Moe 277 open tasks, Matt 698. Lesson: before concluding "the API ignores filters", diff your param names against the docs — `docs.followupboss.com/llms.txt` indexes every endpoint as markdown.
**Project:** lumin-deals
**Date:** 2026-07-30

### Sorting a paginated FUB sweep by a non-unique column re-serves rows
**Tried:** `GET /v1/tasks?limit=100&isCompleted=false&sort=dueDate`, walking `_metadata.nextLink`, then bulk-upserting the result.
**Failed because:** sorting by a non-unique column drops FUB off keyset pagination onto offsets; pages drift and the same task comes back twice. Postgres then rejects the ENTIRE batch: `ON CONFLICT DO UPDATE command cannot affect row a second time` — one duplicate, zero rows written.
**What works:** sweep in the default id-descending order (keyset-stable) and sort locally; plus `dedupeTasks()` as a guard, since a row created mid-sweep can still double up. Same risk applies to any `sort=` on a paginated FUB collection.
**Project:** lumin-deals
**Date:** 2026-07-30

### GHL templates: the "required" originId param must be OMITTED
**Tried:** `GET /locations/{locationId}/templates?type=sms&originId={locationId}` — the
OpenAPI spec marks `originId` as `required: true`, so passing it looked mandatory.
**Failed because:** with `originId` set, GHL returns `{"templates":[],"totalCount":0}` and
**HTTP 200**. No error, no 400 — just a silent empty list that reads identically to
"this sub-account has no snippets."
**What works:** omit `originId` entirely. Both sub-accounts then return all 22 SMS
snippets. Verified live 2026-07-31 against Moe's and Matt's keys.
**Also:** templates use `Version: 2021-07-28` (the `ghlHeaders` default), NOT the
`2021-04-15` that `/conversations/*` uses. Wrong version → wrong shape.
**Project:** lumin-deals (`app/api/ghl/snippets/route.ts`)
**Date:** 2026-07-31

### GHL location custom values can hold secrets — never ship the list to the browser
**Tried:** fetching `/locations/{id}/customValues` client-side to resolve
`{{ custom_values.* }}` in snippets.
**Failed because:** the list is not just branding. Moe's location stores a **Monday API
token** as a custom value, alongside the company name and Zillow review links. Sending
all 30 to the page would put a live credential in the DOM of every deal page.
**What works:** resolve location tokens server-side in the snippets route and return only
the substituted body; the raw list never leaves the server. Contact/user tokens
(`{{contact.first_name}}`, `{{user.first_name}}`) are resolved client-side, where there's
nothing secret. `lib/mergeFields.ts` splits the two on purpose.
**Project:** lumin-deals
**Date:** 2026-07-31

### Supabase `app_metadata` cannot be edited from the dashboard any more
**Tried:** documenting "Authentication → Users → click the user → **Raw App Meta Data**
→ add `{"role":"processor"}`", which is how it worked in older Supabase dashboards.
**Failed because:** current dashboards removed that editable box. The user panel now shows
`Overview | Logs | Raw JSON`, and the Raw JSON tab is **read-only**. There is no field to
type into — Efrain went looking for it and it isn't there.
**Why it's actually correct:** `app_metadata` is writable only with the service-role key.
That's the entire reason the app's role gate reads from it instead of `user_metadata` —
`supabase.auth.updateUser()` lets any signed-in browser rewrite user_metadata, so a role
stored there could be self-promoted to admin from the console.
**What works:** `npx tsx scripts/set-user-role.ts <email> [processor|admin] ["Name"]`
(Admin API, `auth.admin.updateUserById`). Run it with no role argument to read current
state without changing anything.
**⚠️ MERGE, never replace.** `app_metadata` also holds `provider` / `providers`, which
Supabase uses for sign-in. A script that assigns a fresh object clobbers them and the
account can no longer log in. The script spreads the existing object.
**Project:** lumin-deals (`lib/roles.ts`, `docs/runbooks/add-a-user.md`)
**Date:** 2026-08-10
