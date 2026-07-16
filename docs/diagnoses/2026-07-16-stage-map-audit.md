# Audit — GHL_STAGE_MAP vs GHL's live pipeline stage names

**Date:** 2026-07-16 · **Trigger:** follow-up to the `ghl_contact_id` link bug (`acbd101`).
**Question:** which stage-change webhooks fall through to the CONTACT branch instead of being applied in real time?
**Headline answer: NONE of the mortgage stages. `GHL_STAGE_MAP` needs no changes.**

Reproduce: `npx tsx scripts/stage-map-audit.ts`

## 1. Result — every live mortgage stage resolves EXACTLY

All **30** stage names across the three mortgage pipelines resolve via **exact match**, in **both** Moe's
(`PKEBK2NXDuug25VABQ61`) and Matt's (`84fCsPjMP7RHe8P6JEe0`) locations:

| Pipeline | Stages | Result |
|---|---|---|
| `1) Leads` | 10 | ✅ all exact |
| `2) Loans in Process` | 11 | ✅ all exact |
| `3) Not Ready` | 9 | ✅ all exact |

**Zero mis-maps.** The fragile step-2 partial-match loop (`lower.includes(key) || key.includes(lower)`)
**never fires** for any real stage — every name hits step 1. The specific worry raised (`Pre-Approved` vs
`Approved w/ Conditions`) is a non-issue: both match exactly at step 1, so the loop is never reached.
**Recommendation: leave the partial-match loop alone.** It's latent, not active — changing it now is risk
without benefit. The new audit script is the guard if that ever changes.

**Not checked:** Randy's location (`arZ4QDCzS0Vkj0ZvLZdv`) — `GHL_LOCATION_ID_2`/`GHL_API_KEY_2` are
prod-only and absent from `.env.local`. Worth re-running there.

## 2. The only fall-through: "My Credit Guy Pipeline" (both locations)

A 4th pipeline exists in both sub-accounts — a third-party **credit-repair** funnel, not the mortgage funnel:

```
❌ Referred · Didn't Enroll · Enrolled · Suspended for Non Payment · Follow Up/Re-Pull · Graduated  → null
```

**These must NOT be added to `GHL_STAGE_MAP`** — "Enrolled" is not a mortgage stage, and mapping it would
corrupt the pipeline. `resolveGHLStage` correctly returns null (verified: `"my credit guy pipeline"` doesn't
trip the pipeline-name fallback either — no `loan`/`process`/`not ready`/`funded` substring).

**Residual risk (theoretical — no evidence it fires):** if such a payload does reach the webhook, it falls to
CONTACT CREATE/UPDATE, where `findExistingDeal` can match the borrower's **mortgage** deal by
contact_id/email/phone and then write `raw_ghl_data` (clobbering the mortgage opp blob) and `last_contacted`.
The stage block is safely skipped (`whStage` is null). Low severity; flagged, not fixed.

## 3. Architecture discovery — the dedicated stage branch is ~dead code

The real path for these payloads is **not** the stage-change branch (`route.ts:406-465`). It's the CONTACT
fall-through plus the misspelled-key handler at **`route.ts:563-605`**:

```ts
const whStageName = pick(body, 'pipelineStageName', 'stageName', 'stage_name',
                         'pipelineStage', 'pipleline_stage', 'pipeline_stage')  // ← GHL's typo
```

The live GHL **Workflow** payload carries `id` (= the opp id), a stage **NAME**, and `pipelineId` — but **no
`contactId` and no `pipelineStageId`**. So it never satisfies the stage branch's entry condition
(`eventType`/`pipelineStageId`/`pipelineStageName`) and always lands here. Corroborated by data:
`to_stage_id`/`from_stage_id` are **null on every stage_events row**, because this block passes no
`fromStageId` and the payload has no `pipelineStageId`.

**This is what made the link bug bite:** line 592 logs `contactId: ghlContactId ?? …` while line 515 writes
`ghl_contact_id: ghlContactId || undefined` — so one bad `extractFields` value poisoned **both**
`deals.ghl_contact_id` and `stage_events.contact_id` **in the same request**.

## 4. Correction to the earlier "self-healing" claim

I previously wrote that the sync repaired a clobbered row "within ~15 min". **More precisely: it heals when
the opportunity NEXT CHANGES.** Lars's opp moved stage at 15:22, so the 15:30 incremental sync re-fetched it
and rewrote `ghl_contact_id` via `route.ts:959`. Three other deals clobbered at 15:09–15:15 sat through
**four** sync runs unrepaired, because their opps never changed again. The maintenance reconciliation
(`route.ts:1234`) is gated on `runMaintenance && oppFetchComplete && opportunities.length > 0` — no caller
passes `maintenance:false`, so `oppFetchComplete` is the likely reason it isn't reaching them. **Not chased —
flagged.** Pre-fix, a clobbered deal on a dormant opp could stay broken indefinitely, not 15 minutes.

## 5. "Never logged" statuses — inconclusive, NOT evidence of fall-through

9 mapped statuses have never appeared in `stage_events`. The audit proves they all resolve, so this is not a
mapping gap. Deals that moved into them since the log went live (~Jul 8):

| Status | deals now | moved-in since Jul 8 |
|---|---|---|
| Loan Finalized | 19 | **7** |
| Pre-Approved | 12 | 2 |
| Appointment Booked | 24 | 1 |
| Broker Check Received | 39 | 1 |
| Clear to Close | 1 | 1 |
| STOP | 4 | 1 |
| New Lead | 250 | 0 |
| Not Qualified - Income | 12 | 0 |
| Qualification | 0 | 0 |

`New Lead` = 0 is expected: it's the entry stage, never a *transition* (and the stage branch defers creation
to the sync). The other ~13 are **ambiguous and I can't resolve them from here**: only the webhook calls
`logStageEvent` — the sync updates `deals.status` silently — so `stage_changed_at` bumping proves only that
*something* changed the status, not that GHL fired a webhook then. Could be (a) the GHL workflow isn't
configured for those stages, or (b) the sync reconciled an older move. **Discriminating needs the GHL
workflow config** (which pipelines/stages does "LD stage matt" fire on?) — a UI check, not a code question.

## 6. Cleanup done / not done

- ✅ **`stage_events.contact_id`: 261 of 268 poisoned rows repaired** from `deals.ghl_contact_id`. (True count
  is **268 of 1,162 = 23%**, not the 109 first reported — that figure came from a 1,000-row capped sample and
  was flagged as a lower bound. Full pagination gives 268.) Column is write-only, so no report changed;
  the repair just stops it trapping future ad-hoc queries.
- ⏸️ **3 deals still hold an opp id in `ghl_contact_id`** — Chantico Martinez, Nina Nationalesta, Yvonne
  Ramirez (clobbered 15:09–15:15Z, opps dormant since). All 3 have live opps with resolvable contact ids.
  **Not repaired — needs explicit sign-off** (a `deals` write wasn't in the authorized cleanup scope).
  **Not urgent:** `ghlContactUrl`'s guard hides their GHL button, so nobody gets a dead link; they'll also
  self-repair whenever their opp next changes.

## Verdict

**No code change required.** The audit's premise — that unmapped stage names were causing real-time stage
moves to be dropped — is **not supported**: every mortgage stage resolves exactly. Shipped instead:
`scripts/stage-map-audit.ts`, so a future stage rename in the GHL UI gets caught instead of silently
degrading to sync-only updates.
