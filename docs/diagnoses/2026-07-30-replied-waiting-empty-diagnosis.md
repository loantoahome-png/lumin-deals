# Diagnosis — "Replied — waiting on you" is always empty (2026-07-30)

**Reported:** Matt's `/follow-up/matt` shows "Inbox zero — no unanswered replies" while his GHL
team inbox shows 5 unread conversations.

**Verdict:** two independent defects. The section is not "empty because nothing is waiting" —
it is **structurally incapable of showing anything**, for both LOs.

---

## Evidence (live, `scratchpad/_probe-reply-waiting.ts`, 2,994 deals)

| LO | `isReplyWaiting` (shipped) | same predicate **minus** the hot-status clause |
|---|---|---|
| Matt Park | **0** | 2 (Leo Scholz `Responded`, Richard Lewis `Pitching`) |
| Moe Sefati | **0** | 3 (William Mitchell `Pitching`, Shante Barnes `Responded`, Rocky Ciarmoli `App Intake`) |

The 5 unread conversations in Matt's GHL screenshot resolve as:

| Person | Our row | Why it never rendered |
|---|---|---|
| Leo Scholz | Matt · `Responded` · in 20:23:50 > out 20:23:32 | **hot-status exclusion** |
| Richard Lewis | Matt · `Pitching` · in 7/29 20:37 > out 20:36 | **hot-status exclusion** |
| Scot Gordon | Matt · `Docs Signed` / Loans in Process · unread today, `last_inbound_at` = **7/15** | **stale timestamps** |
| Yvonne Schell | Matt · `Responded` · out 20:55 **after** in 19:05, 3 days old | correctly excluded (we answered; GHL keeps the thread flagged unread until someone *opens* it) |
| Shante Barnes | **Moe's** deal (`ghl_location_id` = Moe's) · answered 1 min later | not Matt's, and answered |

---

## Root cause 1 — the hot-status exclusion cancels the section

`lib/followUpQueue.ts::isReplyWaiting` skipped every deal whose status is in
`HOT_WORKING_STATUSES = ['Responded','Pitching','Appointment Booked','App Intake']`, on the
reasoning that /hot-leads already works those tabs.

Those are **exactly the statuses a lead is in when they reply.** A lead who answers a text moves
to `Responded` by GHL workflow *before* the reply reaches us. Everything left over is either
parked (`Not Ready`, also excluded — correctly, per Efrain) or a `New Lead`/`Ghosted` row.
Net effect: the predicate matched 0 rows for both LOs.

## Root cause 2 — `last_inbound_at` / `last_outbound_at` are stale outside the lead stages

Those two columns are written **only** by `app/api/sync/conversations` (30-min tick), and only for
`['Responded','Pitching','App Intake']` + the early triage stages bounded to 10 days. The GHL
**webhook never writes them** — it writes `last_communication_at`, `last_communication_type`,
`comm_unread_count`, `last_inbound_message` and nothing else.

So any deal past App Intake (Loans in Process, Funded, Pre-Approved, an old Appointment Booked)
has frozen inbound/outbound timestamps. Scot Gordon: `comm_unread_count = 1`,
`last_communication_at` = today 22:01, `last_inbound_at` = **7/15**.

The two causes compound: the deals with *fresh* timestamps are precisely the ones cause 1 threw
away, and the deals cause 1 kept have *stale* timestamps.

---

## FollowUpBoss unread — what the API actually allows

Probed live with both agent keys (`scratchpad/_probe-fub-unread*.ts`):

- `GET /v1/threads`, `/v1/conversations`, `/v1/notifications` → **403** "You do not have access to
  this API endpoint" (owner-only; we hold agent keys).
- `GET /v1/me` → `unreadConversationCount`, a **single integer** (0 for both LOs at probe time).
  No drill-down.
- `GET /v1/textMessages` requires one of `personId, threadId, phone, toNumber, fromNumber,
  sharedInboxId, groupTextId, participants, id`.
- ⚠️ The per-message **`read` flag is useless**: across 300 inbound messages per LO it was `false`
  on 300/300 (including messages weeks old and certainly read), and `true` on 300/300 outbound.
  It tracks delivery-side read receipts, not the FUB inbox.

**Usable path:** `toNumber=<the LO's own FUB calling number>` and `fromNumber=<same>` are honored
(verified: 300/300 correctly directional). Paging both and comparing the newest inbound vs newest
outbound per `personId` reconstructs "they messaged and nobody has answered" without threads access.

Live result at probe time — Moe 20 unanswered people, Matt 18 (Matt's newest: Rovien Platon 1 h,
Rocio Valencia 2 h, Marian Cooper 4 h, Francis Rojas 8 h).

Not covered: FUB **email** (`/v1/emails` also needs a personId/threadId) and inbound **calls**
(`/v1/calls` *is* listable account-wide with `isIncoming` — available if we want it later).

---

## Fix shipped

1. Drop the hot-status clause from `isReplyWaiting` (keep `Not Ready` + `isOpenLead` + the 48 h
   window + outbound-older-than-inbound).
2. Stop trusting the stale columns as the only source: merge in the **live** GHL unread feed
   (`/api/ghl/unread`, already used by the dashboard — one conversations-search call per account,
   all stages) filtered to this LO and to non-parked pipelines.
3. New `/api/fub/unanswered?lo=` reconstructs FUB's unanswered inbound from the text feeds above.
4. `lib/followUpQueue.ts::buildReplyInbox` merges the three sources, dedupes GHL rows by deal id,
   and splits ≤7 days (shown) from older (drawer).
