# Webhook dead code — the real GHL payload, and the two branches that never fired

**Date:** 2026-07-16 · **Commit:** follow-up to `acbd101` (the `ghl_contact_id` link bug).
**Result:** removed 2 provably-dead code paths (−66 lines net) from `app/api/webhooks/ghl/route.ts`.

## The artifact this rests on: an ACTUAL webhook body

Three deals were clobbered 15:09–15:15Z and their opportunities then went dormant — so the sync never
overwrote `raw_ghl_data` with its own opp object, and their rows still hold **the real webhook body**
(`route.ts` writes `raw_ghl_data: body` on the contact path).

75 top-level keys. The ones that decide control flow, **identical for Moe's AND Matt's leads**:

```
id                : PA33xZmdSgbKPoZp6oIS   ← the OPPORTUNITY id
contact_id        : psgsm6qnjTVU4q5MmQvf   ← the REAL contact id (snake_case)
contactId         : (absent)
pipleline_stage   : "Ghosted"              ← GHL'S OWN TYPO, in their standard data
pipelineStageName : (absent)
pipelineStageId   : (absent)
pipelineName      : (absent)               (but `pipeline_name` IS present)
monetaryValue     : (absent)
type/event        : (absent)
nested contact obj: no
workflow          : {"id":"ea0f83d9-…","name":"LD stage matt"}
```

**The misspelling is GHL's, not ours.** It ships `pipleline_stage` in the standard payload. The original code
comment was right.

### The workflow's "Custom Data" is entirely inert

The UI's 4 custom fields do **not** arrive top-level. They land in a nested `body.customData`, which the code
never reads (it looks for `customFields`/`custom_fields`):

```json
{ "contactId": "psgsm6qnjTVU4q5MmQvf",
  "pipelineName": "1) Leads",
  "monetaryValue ": "0",       ← trailing space IN THE KEY
  "pipelineStageName": "" }    ← empty; {{opportunity.pipeline_stage}} doesn't resolve
```

Harmless — the code uses GHL's standard data (`contact_id`, `pipleline_stage`, `pipeline_name`) instead. But
it's a trap for the next reader, and worth deleting in the GHL UI.

## Removed #1 — the "OPPORTUNITY STAGE CHANGE" branch (was `route.ts:428-490`)

Entry required `eventType ∈ {OpportunityStageChange, opportunity.stageChange, OpportunityStatusChanged}` or
`body.pipelineStageId` or `body.pipelineStageName`. **None of those exist in the payload**, and with no
`type`/`event` key `eventType` always defaults to `'ContactCreate'`. So it never ran. Every stage move has
always been applied by the CONTACT path's `whStageName` block (`route.ts:563` pre-deletion), which reads the
misspelled key.

**Why removing it cannot lose behavior** — its stage handler is a strict **subset** of the surviving one:

| | dead branch | surviving path (`whStageName`) |
|---|---|---|
| stage-name keys read | `pipelineStageName, stageName, stage_name, pipelineStage` + `status` fallback | same **plus** `pipleline_stage`, `pipeline_stage` |
| Funded guard on the write | ❌ **none** (`.update(stage)`) | ✅ `.neq('pipeline_group','Funded')` |
| deal matching | oppId + contactId | oppId + contactId + email + phone |

Any payload it could have handled, the surviving path handles too. Its `status` fallback was useless
(`resolveGHLStage('open'/'won'/'lost')` → null). And it could have **demoted a Funded deal** — a latent bug
now gone.

**Evidence it never fired:** 0 of 1,162 `stage_events` rows have a non-null `from_stage_id` or `to_stage_id`
(only that branch passed `fromStageId`).

⚠️ **Honest caveat:** the 142 stored webhook bodies are a **biased sample** — only the contact path writes
`raw_ghl_data`, so payloads handled by other branches are invisible to it. That sample alone can NOT prove a
negative. The deletion rests on the subset argument above (which holds for *any* payload shape), not on the
sample.

## Removed #2 — the real-time `loan_amount` block (was `route.ts:556-582`)

This one **can** be proven from the sample, because it lives *inside* the contact path — those 142 bodies are
exactly its input. **0 of 142 carry a top-level `monetaryValue`**, and there's no `body.opportunity` either.
It never fired.

The old comment claimed loan_amount "IS set, in real time, from the opportunity monetaryValue … IF this
payload carries it." **It doesn't.** loan_amount is **sync-only** and always has been — corrected in place.

Not a loss: the 15-min sync already mirrors the opp value onto every non-funded deal
(`sync/ghl/route.ts:1223`), and Arive stays authoritative for funded. Also quietly fortunate — these lead opps
carry `monetaryValue: 0`, so had it fired it would have written **0** over real loan amounts.

**If real-time loan_amount is ever wanted:** fix the trailing space in the workflow's `"monetaryValue "` key,
make the merge field resolve, and read `body.customData`. Deliberately not done — no demand, and the sync
covers it.

## Also done

Repaired the last **3 deals** holding an opportunity id in `ghl_contact_id` (Chantico Martinez, Nina
Nationalesta, Yvonne Ramirez) — restored from each live opportunity's `contactId`, each verified to resolve to
the right person before writing. **0 deals now hold an opp id.**

## Net

`app/api/webhooks/ghl/route.ts`: **27 insertions, 93 deletions.** No behavior change — both paths were
unreachable. tsc unchanged (7 pre-existing errors, none in this file); `scripts/ghl-link-check.ts` 10/10.
