# Research — GHL webhook payload audit: what arrives, what we read, what we leave on the table

**Date:** 2026-07-16
**Question:** What do the GHL webhooks that connect Moe's and Matt's leads to the dashboard actually send,
and is there more information we could gather from them?

## Sources (all fetched/queried 2026-07-16)

- **146 real stored webhook bodies** — `deals.raw_ghl_data` rows written by the webhook's contact path
  (read-only paged scan of all 2,626 deals; classifier: `pipleline_stage`/`workflow`/snake-case-contact keys
  = webhook body vs the sync's opportunity object). This is ground truth, not docs.
- `app/api/webhooks/ghl/route.ts` @ `acbd101` (current handler).
- `docs/diagnoses/2026-07-16-ghl-link-opp-id-diagnosis.md`, `docs/diagnoses/2026-07-16-webhook-dead-code.md`.
- Live `stage_events` query (webhook health).
- Sample bias caveat (from the dead-code doc, still true): only the contact path stores `raw_ghl_data`, so
  payloads fully handled by earlier branches aren't in the sample. For the message branch this doesn't matter —
  the 17 reply-workflow bodies ARE in the sample, which proves they fell through to the contact path.

## Health: the webhook is live

- **144 webhook `stage_events` in the last 72h**, latest 2026-07-16 18:29Z. Measured latency 227ms
  (GHL move → our row, per the 07-16 diagnosis). Handoff open-thread #1 ("confirm the GHL webhook
  subscription") is answered: **it's flowing** for both Moe and Matt.
- Auth in use: shared secret (`?secret=`/`x-webhook-secret`) — the GHL *Workflow* path. The HMAC path exists
  in code but nothing GHL-side uses it today (no marketplace app).

## Who posts to us (by `workflow.name` across the 146 bodies)

| Workflow | n | Location | Purpose |
|---|---|---|---|
| Pipeline Stage Changed | 71 | Moe (`PKEBK2NX…`) | opp stage moves |
| LD stage matt | 54 | Matt (`84fCsPjM…`) | opp stage moves |
| Pipeline Stage Changed - Matt | 2 | Matt | second/older stage workflow |
| LD - replies | 10 | — | inbound customer reply |
| Customer Replied | 7 | — | inbound customer reply |
| LD stage | 1 | — | one-off/legacy |
| Push to CRM | 1 | — | lead-intake push |

Split: Moe location 80 bodies / Matt 66. **Randy: zero** — expected, his sub-account has no workflow
pointed at us.

## Payload anatomy (GHL Workflow webhook)

Five layers, all top-level in one flat JSON body:

1. **Standard contact envelope** (snake_case): `contact_id`, `first_name/last_name/full_name`, `email`,
   `phone`, `address1/city/state/postal_code/full_address`, `country`, `timezone`, `date_created`,
   `contact_type` (`lead`|`borrower`), `tags` (comma string), `contact_source`, `date_of_birth` (when set).
2. **Every CONTACT CUSTOM FIELD, keyed by its display name** (Title Case). This is the big lever: *any*
   custom field added to the contact in GHL automatically arrives here by name — no workflow edit needed.
3. **Opportunity block** (only when the trigger is an opp event; 128/146): `id` (**the OPPORTUNITY id** —
   GHL's polymorphic-id trap), `opportunity_name`, `opportunity_source`, `pipeline_id`, `pipeline_name`,
   **`pipleline_stage`** (GHL's own typo — stage NAME, no stage id), `status` (open/won/lost/abandoned),
   `source`, `owner`, `lead_value` (rare).
4. **`customData`** — merge fields configured per-workflow in the GHL UI (see below). Present 146/146.
5. **Context objects**: `location` {id, name…}, `user` (assigned user w/ name/email/phone), `workflow`
   {id, name}, and on reply events `message` {body, type}.

## Full field inventory (fill rate over the 146 bodies · read status)

### Read today → lands in a `deals` column

| Field (fill) | → column |
|---|---|
| `contact_id` (100%) | `ghl_contact_id` (post-`acbd101` resolution order) |
| names (100%) | `first/last/full_name` |
| `email`/`phone` (100%) | ✓ |
| `tags` (99%) | `ghl_tags` |
| `contact_source` (98%) / `Lead Source` (92%) / `source` (87%) | `source` via `cleanSource` + `lead_source_agg` |
| `user`/`owner` (97/87%) | `loan_officer` via `resolveLO` |
| `full_address`/`address1`/`city`/`state`/`postal_code` (85–94%) | property/city/state/zip |
| `Campaign` (92%) | `lead_source_agg` |
| `Credit Rating` (92%) / `Credit Score` (10%) | ✓ |
| `Loan Amount` (92%) | **deliberately NOT written** (unreliable intake number; loan_amount is sync-only — see webhook-dead-code doc) |
| `Loan Purpose`/`Property Type`/`Property Use`/`VA Loan`/`Veteran` (92%) | ✓ |
| `Property Value` (92%) | `estimated_value` |
| `First Mortgage Balance` (73%), `LTV` (62%), `Cashout` (79%), `Down Payment`, `Loan Type` (33%), `Loan Timeframe` (15%), `Found Home`/`Property Found` (4%) | ✓ |
| `pipleline_stage` + `pipeline_name` (88%) | `status`/`pipeline_group` via `resolveGHLStage` + `stage_events` log |
| `status` (88%) | `ghl_status` + lost/abandoned demotion |
| `date_created` (100%) | `date_added_ghl` |
| dnd/dndSettings (when present) | ✓ |

### Arriving but UNREAD (the "more information" answer)

| Field (fill) | What it is / why it matters |
|---|---|
| **`customData.contactId` (99%)** | The contact id, explicitly mapped in every stage workflow. The handler never reads `customData` at all. Adding it to the id-resolution chain is a one-line belt-and-suspenders against the polymorphic-`id` bug class that caused the 07-16 poisoning saga (3 incidents). |
| **`customData.event` = `inbound_message` + `customData.channel` (17/17 reply bodies)** | The reply workflows were BUILT to trigger the real-time "client waiting" branch (`comm_unread_count=1`), but that branch checks **top-level** `type/event/eventType/messageType` — and GHL nests workflow custom data under `customData`. Proof it never fires: all 17 reply bodies were stored by the *contact* path. Actual comm freshness today = `refreshConversations` every **30 min**, business hours only (`cron/ghl-sync` piggyback). Reading `customData.event/channel` would make the flag near-instant, incl. nights/weekends. |
| **`message.body` (17 bodies)** | The literal text the borrower just sent. Could be surfaced on /hot-leads ("what they said") — today it's discarded. |
| **`Lead ID` (92%)** | The VENDOR's lead id (Lendgo/FRU). Not stored anywhere. This is the key you'd need for bad-lead refund/dispute reconciliation with the vendor. |
| **`Lead Price` (92%)** | Already covered — the sync writes `deals.lead_price` from the opp custom field (`sync/ghl/route.ts:932`). Webhook capture would only improve freshness by minutes. Skip. |
| **`Response Date` / `Response Timestamp` (82%)** | Response timing stamped as contact CFs (likely by their own GHL automations — semantics unconfirmed). Could cross-check the stage_events/conversation-based speed-to-lead numbers. |
| **`Rate Quote` (89%)** | URL to a per-lead rate-quote artifact — hosted on the **lead-capture app's** Supabase project (`gpcqekdzdfmkbtfatfbn`, NOT the dashboard's `tkftvvocddbtymfuzzuo`) in a **public** storage bucket. |
| **`Lumin Lead ID` (93%)** | The website funnel's own UUID for the lead — a ready-made join key between GHL/dashboard and the lead-capture system (web-funnel → funded attribution). |
| **`timezone` (93%)** | Borrower's tz (America/Los_Angeles, America/Denver, …) — could power "don't text at 6am" call-window logic in triage. |
| **`contact_type` (100%)** | `lead` vs `borrower` — a GHL-native lifecycle flag we don't capture. |
| **`date_of_birth` (12%), `Employment Status` (2%)** | Sparse intake extras. |
| `opportunity_name`, `opportunity_source`, `lead_value`, `Mailing *` variants | Redundant with fields already captured. |

### ⚠️ PII flag

`Social Security Number` arrives **top-level on 2 bodies** and is stored **verbatim** inside
`deals.raw_ghl_data` (the handler saves the whole body). Combined with the public-bucket Rate Quote URLs,
this deserves a conscious decision: strip known-sensitive keys before storing the raw body, and/or remove the
SSN custom field from the GHL workflow payload. (DB exposure is limited — RLS blocks anon reads — but a
reporting DB is not where an SSN should live.)

### `customData` today (what the workflows are configured to send)

```
contactId          99%   ← the valuable one (unread)
pipelineName       88%
monetaryValue      49%   ← Moe's workflow: clean key (71 bodies)
"monetaryValue "   38%   ← Matt's workflows: TRAILING SPACE in the key (56 bodies)
pipelineStageName   0%   ← the {{opportunity.pipeline_stage}} merge tag never resolves
channel/event      12%   ← reply workflows only
```

## What GHL could additionally send (config-side, no code)

Because layer 2 forwards every contact custom field automatically, and `customData` accepts arbitrary merge
fields, the workflows could be enriched with:

- **`pipelineStageId`** (fix the broken merge tag) — would let stage moves key off stable UUIDs instead of
  the typo'd stage NAME (today a GHL stage rename silently degrades that stage to sync-only; see
  `scripts/stage-map-audit.ts` canary).
- **UTM/attribution merge fields** (ad id, utm_source/medium) — the native opp object shows real FB ad ids in
  `attributions` for ~200 opps; the workflow payload carries none of it today. Relevant for ad-ROI work.
- **An OUTBOUND-message workflow** — today only inbound replies post; the "we replied → clear waiting flag"
  half still waits for the 30-min conversations sync.
- **Won/lost reason** on the status workflows.
- Bigger lift: a **native marketplace-app webhook subscription** (typed events, HMAC-signed, clean
  `contactId` + stage UUIDs on every event). The endpoint's HMAC path already exists. Only worth it if the
  workflow route starts hurting.

## Open questions

1. `Response Date`/`Response Timestamp` semantics — set by which automation, meaning what exactly?
2. Does Efrain want reply text (`message.body`) surfaced in the dashboard (hot-leads)?
3. SSN handling: strip at the webhook, remove from GHL, or accept as-is?
4. Is vendor `Lead ID` capture wanted (refund/dispute workflow with Lendgo/FRU)?

## Recommended actions if/when Efrain says go (ranked)

1. **Read `customData`** — add `customData.contactId` to the contact-id resolution chain; route
   `customData.event/channel` into the message branch (makes "client waiting" real-time; today 30-min/business-hours).
2. **Capture vendor `Lead ID`** → new `deals` column (refund reconciliation).
3. **Strip `Social Security Number` (and similar) keys** before `raw_ghl_data: body`.
4. **Store `message.body`** as "last inbound message" for hot-leads.
5. GHL UI hygiene: fix `"monetaryValue "` trailing space + dead `pipelineStageName` merge tag (or delete the
   inert customData fields), per the dead-code doc.
6. Optional enrichment: `timezone`, `contact_type`, `Lumin Lead ID`, UTM merge fields.
