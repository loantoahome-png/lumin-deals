# Diagnosis — "Open in GHL" link 404s ("Contact not found") until the sync repairs it

**Date:** 2026-07-16
**Reporter:** Efrain — clicked the GHL button on the auto-created "2nd call-back — Lars Rosene" task,
landed on GHL's "Contact not found" page; looked the lead up manually and found it alive in
**Attempted Contact**. Asked: *is there a way to avoid the bad link, or do we just wait for the sync?*

## Symptom

The dashboard's GHL button renders a URL whose contact-id segment is actually an **opportunity id**.
GHL correctly reports "Contact not found. This contact may have been deleted or you may not have
permission to view it." The link starts working ~15–30 min later with no user action.

## Evidence (verified, not inferred)

| # | Artifact | Finding |
|---|---|---|
| 1 | Efrain's open Chrome tabs | Broken tab: `/v2/location/84fCsPjMP7RHe8P6JEe0/contacts/detail/**4jHxP2JJCpRXom8s7No0**`. Working tab (manual lookup): `…/contacts/detail/**6zsx1K9Og2afEjB06Iee**`. |
| 2 | Live GHL API | `GET /contacts/6zsx1K9Og2afEjB06Iee` → **200** (Lars Rosene). `4jHxP2JJCpRXom8s7No0` is the **opportunity** id — `GET /opportunities/4jHxP2JJCpRXom8s7No0` → 200, `contactId: 6zsx1K9Og2afEjB06Iee`. |
| 3 | `deals` row `77a74939-…` | `ghl_contact_id` is **correct now**; `ghl_location_id` = `84fCsPjMP7RHe8P6JEe0` (Matt) = correct. `created_at` 15:00:37Z, `updated_at` **15:30:17Z**. |
| 4 | `deal_tasks` | Task `due_at`/`created_at` = **15:04:50Z**. Its `deal_id` resolves to the same (now-correct) row — no duplicate/pruned row involved. |
| 5 | `stage_events` for contact `6zsx…` | **ZERO rows.** `logStageEvent` fires on every stage-change webhook, so **no stage webhook ever arrived** for this lead. |
| 6 | Table-wide scan | 33/33 checkable recent deals' `ghl_contact_id` resolve to real contacts; 1/2531 rows have a NULL `ghl_location_id`. **Not** widespread data rot — it's a transient, self-healing window. |

**Location was never the problem.** Only the contact id was wrong.

## Timeline

| Time (UTC) | Event |
|---|---|
| 12:02:51 | Lead enters GHL (`date_added_ghl`). Sync window is 8am–6pm PT, so the dashboard doesn't know it exists yet. |
| 15:00:37 | First sync of the day **creates** the row — with the **correct** contact id (`route.ts:789` reads the opportunity's embedded contact). |
| ~15:00–15:04 | **A webhook overwrites `ghl_contact_id` with the opportunity id.** No `stage_events` row → it did not take the stage branch. |
| 15:04:50 | 45-min rule creates the task. Efrain clicks → **404**. |
| 15:30:17 | Maintenance sync's contact-id reconciliation repairs the column → link works again. |

## Root cause

`app/api/webhooks/ghl/route.ts` → `extractFields()`:

```ts
const contact = (body.contact as Record<string, unknown>) || body   // ← falls back to body ITSELF
const ghlContactId =
  pick(contact, 'id', 'contact_id', 'contactId') ||                 // ← 'id' checked BEFORE 'contact_id'
  pick(body, 'id', 'contact_id', 'contactId')
```

GHL's `id` is **polymorphic**: on a contact payload it's the contact id; on an opportunity payload it's
the **opportunity** id. When an opportunity-shaped payload arrives with no nested `contact` object,
`contact` collapses to `body`, and `body.id` (opp id) is picked **ahead of the correct `body.contact_id`
sitting right beside it**. It is then written to `ghl_contact_id` at `route.ts:494`.

The stage-change branch (`route.ts:406-465`) is **safe** — it writes only `stage` and returns early. So this
only fires when a payload falls through to the CONTACT CREATE/UPDATE path, i.e. when `resolveGHLStage()`
returns null (unrecognized stage/pipeline) or the payload carries no stage fields at all. That fall-through
also explains the zero `stage_events`.

**Not observable:** the offending webhook body itself. The 15:30 sync overwrote `raw_ghl_data` with its own
opportunity object (`sync/ghl/route.ts:908`), and Vercel's log stream doesn't reach back 40 min. The
opp-id-in-the-link is proven by artifact #1; the precise payload shape is inferred from the code path.

## Why it self-heals (and why it stayed invisible)

`sync/ghl/route.ts:1234-1238` reconciles `ghl_contact_id` from the live opportunity on maintenance runs.
Its own comment already names this exact failure: *"an opportunity id ends up stored there, breaking the
'open in GHL' link."* The bug was previously patched **downstream** instead of at the write site, so every
occurrence silently repairs itself within ~15 min and never gets reported.

## Fix

1. **Write site** — `extractFields`: prefer explicit `contact_id`/`contactId`; trust a bare `body.id` **only**
   when the payload is not an opportunity. Hoist the existing opp-payload detection (currently inline at
   `route.ts:481`) into a reusable `isOpportunityPayload()`.
   When no contact id can be determined, return `null` → `route.ts:494`'s `|| undefined` leaves the existing
   (correct) value untouched. Strictly better than writing a known-wrong id.
2. **Render site** — `lib/ghlLinks.ts`: return `null` when `ghl_contact_id === ghl_opportunity_id`. A
   known-bad id renders **no button** instead of a dead link, whatever writes it in future.
   Also replaces the duplicated inline URL builder at `app/deals/[id]/page.tsx:545-571`.

## Separate finding (not fixed here)

**No stage-change webhook arrived for this lead at all** (evidence #5). Lars's New Lead → Attempted Contact
move only landed at 15:30 via the sync's stage reconciliation — a 30-min stale-stage window on what is
supposed to be the real-time path. That is a distinct issue from the link bug and needs its own
investigation (webhook not firing in GHL vs. firing with a stage name `resolveGHLStage()` can't resolve —
the latter would also explain the fall-through in this very diagnosis).
