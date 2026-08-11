# Runbook — Add the missing GHL → Dashboard webhook workflows

**Date:** 2026-08-11 · **Who can do this:** Efrain or Brianne (needs admin access to both GHL
sub-accounts) · **Time:** ~10 minutes per sub-account.

## Why

The dashboard learns about GHL changes two ways: a 15-minute sync (business hours only) and
instant webhook pushes. Webhooks only fire when a **workflow inside GHL** posts to the dashboard.
Today the stage-move and customer-reply workflows exist; the status-change one does not. Result:
a lead marked **Lost/Won without a stage move** never posts — the dashboard catches it only on the
~3-hour maintenance scan (or Monday, if it happens on a weekend), so dead leads linger in active
views.

The dashboard side is already deployed and waiting (`/api/webhooks/ghl`, death/status branch,
echo-guarded, never touches Funded). This is purely GHL-side clicking.

**Do this in BOTH sub-accounts** (Moe's/primary and Matt's). Randy's is deliberately excluded
(Efrain's standing decision).

---

## Part 1 — "Opportunity Status Changed → Dashboard" (the one that matters)

Repeat in each sub-account.

1. In the sub-account, go to **Automation → Workflows**.
2. Open the existing stage workflow — **"Pipeline Stage Changed"** in Moe's account,
   **"LD stage matt"** in Matt's. Click its **Webhook** action and **copy the full URL**
   (it ends in `?secret=…`). Also glance at its **Custom Data** rows — you'll mirror them.
   ⚠️ Don't edit anything here, and don't paste that URL anywhere public — the secret is in it.
3. Go back to **Workflows → + Create Workflow → Start from Scratch**.
   Name it: **`LD status → Dashboard`**.
4. **Add New Trigger → "Opportunity Status Changed"** (it's under Opportunities).
   - ⚠️ **A status filter is REQUIRED** — the trigger refuses to save without one (red banner:
     *"Opportunity Status filter is required"*). Set **Moved to status = Lost**.
   - ⚠️ **The value picker is single-select, so you need TWO triggers.** Save this one, then back
     on the canvas click **Add new trigger** and build an identical second one with
     **Moved to status = Abandoned**. Both triggers feed the same webhook action below.
   - ⚠️ **Do NOT add a "Moved from status" filter.** Filters within one trigger are ANDed, so
     `Moved to = Lost` + `Moved from = Open` fires *only* on Open→Lost and silently skips every
     other path into Lost (e.g. Abandoned→Lost).
   - Optional: **In Pipeline = the main mortgage pipeline** ("1) Leads" / "2) Loans in Process").
     Skipping it is safe — extra events are matched by opportunity id and unknowns are dropped.
5. **Add Action → Webhook** (a.k.a. Custom Webhook):
   - Method: **POST**
   - URL: **paste the URL you copied in step 2** (same sub-account's URL — they may differ).
   - **Custom Data:** add the same rows the stage workflow has. The one that matters:
     - key `contactId` → value = the **Contact ID** merge field (`{{contact.id}}` via the picker).
6. **Save**, then flip the workflow to **Publish/Active**.

### Test it (per sub-account)

Pick a junk/test lead (never a funded loan). On its opportunity card, change **Status → Lost**
**without moving its stage**. Within ~1 minute the deal should flip to **Not Ready** on the
dashboard. Then flip it back (Lost → Open) in GHL; the next sync pass restores it. Ask Claude to
confirm from the DB side: a new `stage_events` row with `source='webhook_status'`,
`to_status='(lost)'`.

**STATUS — Matt's sub-account: DONE and verified 2026-08-11.** Damon Hunnicutt, status-only flip →
`(lost)` event in **264ms**, deal demoted to Not Ready with his stage label preserved.
**Moe's sub-account: workflow published, not yet exercised** — no event from that location yet.

---

## Part 2 (optional) — "Outbound Call → Dashboard"

GHL **cannot** fire a workflow when a user sends a manual text or email (no native trigger —
it's an open feature request; see references below). Outbound **calls** are the exception,
via the Call Status trigger. This workflow makes an LO's outbound call instantly clear the
"client waiting" flag and log an `(outbound Call)` activity event.

Repeat in each sub-account.

1. **Workflows → + Create Workflow → Start from Scratch.** Name: **`LD outbound call → Dashboard`**.
2. **Add New Trigger → "Call Status"**.
   - Filter: **Direction = Outgoing** (label may read "Call direction"). No status filter —
     let all outgoing call completions through.
3. **Add Action → Webhook**: Method **POST**, URL = the same one from Part 1 step 2.
   **Custom Data** rows (all three matter — they route the event on the dashboard side):
   - `contactId` → Contact ID merge field (`{{contact.id}}`)
   - `event` → the literal text `outbound_message`
   - `channel` → the literal text `Call`
4. **Save → Publish**.

### Test it

Call a test contact from GHL (a few seconds is fine, hang up). Within ~1 minute the deal should
log an `(outbound Call)` event and its unread/waiting flag should clear.

---

---

## Part 3 — "Note Added → Dashboard" · ⚠️ DECLINED — DO NOT BUILD OR RE-PROPOSE

**Efrain declined this 2026-08-11** (*"I dont think I need the note workflow either"*). The steps
below are kept only so nobody has to re-derive them if that ever changes. **Do not pitch this again.**

The handler-side fix shipped anyway (`noteText()` + the multi-deal lookup) because both were genuine
latent defects — the branch would also have failed for a native `NoteCreate` event on any contact
owning more than one loan. It is dormant and costs nothing; leave it in place.

Puts notes the team types on a contact in GHL straight onto that loan's LO Notes on the dashboard.
**Handler support shipped 2026-08-11** — before that commit a workflow-sent note would have been
rejected as "No note content" (see GOTCHAS: workflow data arrives nested under `customData`).

Repeat in each sub-account.

1. **Workflows → + Create Workflow → Start from Scratch.** Name: **`LD note → Dashboard`**.
2. **Add New Trigger → "Note Added"**. No filters needed (a Has Tag filter is available if you ever
   want to scope it).
3. **Add Action → Webhook**: Method **POST**, URL = the same one from Part 1 step 2.
   **Custom Data** rows:
   - `event` → the literal text `NoteCreate`
   - `contactId` → Contact ID merge field (`{{contact.id}}`)
   - `note` → the **note body** merge field from the picker (whatever the Note Added trigger
     exposes — pick the note/body field, don't type the tag by hand)
   - `user` → the user **name** merge field (`{{user.name}}`) — optional but recommended; without
     it the note is credited to a generic "LO", and mapping a raw user *id* here would print the
     id in the note header.
4. **Save → Publish.**

⚠️ If the note body merge field doesn't resolve, the dashboard **rejects the note on purpose**
rather than pasting a literal `{{…}}` onto the loan. So "note never appeared" = check that row's
merge field first.

### Test it

Open a test contact in GHL, add a note ("test from GHL"), wait ~1 min, and check that loan's
**LO Notes** on the dashboard. It prepends `[Aug 11, 2026 — Name] test from GHL` above any existing
notes. On a borrower with several loans the note lands on the **most recently created** one.

---

## What workflows still can't cover

| Gap | Why | Path |
| --- | --- | --- |
| Outbound **texts/emails** in real time | No native GHL workflow trigger exists (open feature request) | 30-min conversations sync covers it today; full real-time needs the marketplace-app webhooks (`OutboundMessage`) |
| Randy's location | No workflows configured — deliberate | Marketplace app would cover it with zero workflow config, if ever wanted |

## References

- GHL help: [Workflow Trigger — Opportunity Status Changed](https://help.gohighlevel.com/support/solutions/articles/155000003252-workflow-trigger-opportunity-status-changed)
- GHL ideas board (outbound trigger = still a feature request):
  [Workflow Trigger for Manual Outbound Messages](https://ideas.gohighlevel.com/automations/p/workflow-trigger-for-manual-outbound-messages-user-sent-message),
  [New Workflow Trigger for Outbound SMS](https://ideas.gohighlevel.com/automations/p/new-workflow-trigger-for-outbound-sms)
- Dashboard-side context: 2026-08-11 GHL capability audit (memory: `webhook-payload-shape`,
  `call-report`); handler = `app/api/webhooks/ghl/route.ts` (status branch + message branch).
