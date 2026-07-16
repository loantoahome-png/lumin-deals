# Diagnosis — /lead-roi's opt-out timing sees 5.7% of opt-outs

**Date:** 2026-07-16 · **Trigger:** Efrain, "fix the opt-out gap" (found while auditing Matt/Moe's webhooks).

## Correction first — the scare was overstated

I initially reported *"your opt-out data is missing 83% of opt-outs"* and warned it would corrupt the
in-flight *"% of opt out"* work. **That was wrong, and the correction matters:**

`lib/leadRoi.ts:153` counts opt-outs with `isOptout(d)` → `isOptoutStatus(d.status)` — read straight from
**`deals.status`**. That is **complete**. The opt-out **count and rate (`optout`, `orate`) are accurate**, and
any "% of opt out" built on them is fine.

Only **`optout7dStats`** (`lib/leadRoi.ts:315`) uses `stage_events`, and only for **timing**.

## The real defect (narrower, but worse than the headline suggested)

```
optouts  (from deals.status — COMPLETE) : 473
timed    (has a stage_event)            :  27
within 7d                               :  10
withinPct = within/timed                : 37.0%   ← the headline on the card
coverage  = timed/optouts               :  5.7%   ← the page already shows this
```

The card's **37.0% is computed from 27 of 473 opt-outs**. To its credit the page reports `coverage` and never
claims completeness. But the sample isn't just thin — it's **biased**:

Those 27 are all `source='webhook'`, i.e. opt-outs that originated **in GHL**. Every opt-out applied from the
**dashboard** (the triage dispositions) is missing. Triage dispositions fire on the **day 5–7** clock by
design, so the excluded population skews *late* — meaning the surviving 37% "opted out within 7 days"
systematically **overstates** how fast opt-outs happen.

## Root cause

Dashboard stage changes write `deals.status` **first**, then push to GHL:

```ts
// app/hot-leads/page.tsx:123-135
const { error } = await supabase.from('deals').update(patch).eq('id', id)   // status written HERE
...
if (typeof patch.status === 'string') void pushStageToGHL(id, patch.status) // then pushed to GHL
```

GHL then echoes the change back through the stage webhook. By that point `deals.status` **already equals** the
new value, so the webhook's echo-guard does exactly what it was designed to do:

```ts
// app/api/webhooks/ghl/route.ts — the guard
.neq('status', whStage.status)                                  // update affects 0 rows
if (cur && cur.pipeline_group !== 'Funded' && cur.status !== whStage.status)  // → false, no log
```

That guard exists to stop workflow echoes inflating the log. It also silently swallows **every legitimate
dashboard-origin move**. Nothing was broken — two correct behaviours composed into a blind spot.

**Measured:** of 126 moves into an opt-out status in the last 7 days, only **22** were logged; **104 invisible**.

## Fix — log at the choke point

`lib/pushStage.ts` is the single funnel: **all 11** dashboard stage-change call sites (pipeline ×4, deals ×3,
hot-leads ×2, deals/[id], funded) go through it → `POST /api/deals/[id]/push-stage`. That route is server-side,
holds the service client, and knows the deal + target status. Logging there covers every origin at once.

Added to `app/api/deals/[id]/push-stage/route.ts`:

- `logStageEvent(..., source: 'dashboard')` — a **new source value** alongside `webhook` / `backfill_comm`, so
  the log stays honest about origin and readers can filter.
- **`oppStatus='lost'` is skipped** — that's a won/lost flip that deliberately leaves the stage alone
  (`handleMarkLost` passes the *current* status), so logging it would invent a move that never happened.
- **2-minute dedup** on (deal_id, to_status) — guards double-clicks and bulk re-applies.
- **`from_status: null` by construction** — the client overwrote `deals.status` before this route runs, so the
  prior value isn't recoverable here. The opt-out and first-responded readers key on
  `to_status`/`event_at`/`opportunity_id`, never `from_status`.

**Also fixed in the same route:** `opportunityId` now prefers the **`ghl_opportunity_id` column** over
`raw_ghl_data.id`. `/lead-roi` keys `firstOptout` by that column, so logging the blob's id could silently fail
to join. It also means the GHL push itself now works for rows whose `raw_ghl_data` is null (96 deals) — those
previously no-op'd, so their dashboard changes never reached GHL at all.

## Scope / caveats

- **Forward-only.** Historical coverage stays at 5.7%; this fixes opt-outs from now on. A backfill from
  `deals.stage_changed_at` is possible for deals *currently* sitting in an opt-out status (that timestamp is
  when they entered it, provided it was their last move) — **not done, needs sign-off**, since it inserts
  synthetic history.
- **`/lead-cohorts` will see more events.** Dashboard-origin moves into responded/other statuses now log too.
  Those are real stage moves that were previously invisible, so the numbers should get *more* correct — but
  they **will shift**. Flagged, not hidden.
- Deliberately **did not touch `/lead-roi`** — another session is live in that page.

## Verification

`scripts/push-stage-log-check.ts` (10 fixtures: opp-id resolution incl. the column-over-blob join-key rule,
the mark-lost guard, dedup). tsc unchanged (7 pre-existing, none in this route). End-to-end confirmation needs
a real dashboard disposition to occur — watching for the first `source='dashboard'` row rather than
manufacturing one against production.
