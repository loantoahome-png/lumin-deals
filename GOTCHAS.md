# GOTCHAS — Lumin Deals

### Borrower identity is GHL-owned — Arive import & manual edits can't swap the primary borrower
**Tried:** To make Jesus the sole borrower (was Judith), Efrain changed the borrower in **Arive** and re-imported
the Arive CSV, expecting the dashboard to swap Judith → Jesus. Nothing changed.
**Failed because:** the borrower name/email/phone are NOT driven by Arive. (1) The Arive importer (`lib/ariveCsv.ts`)
has **no mapping for the borrower name** — `__borrower_name` is a carrier field used only for matching and is
skipped by every write loop; `borrower_id` is never written on update; co-borrower linking only ever *adds* a
`role='co'` row (never promotes). (2) The GHL sync (`app/api/sync/ghl/route.ts`) matches by `ghl_opportunity_id`
and **unconditionally re-writes `deals.name`** (line ~946) + `first/last/email/phone` from the **GHL contact on the
opportunity** every 3 min. So the displayed borrower = the GHL contact on the opp. A manual edit to the hero name
input (`deals.name`) is reverted within ~3 min by the next sync. `borrower_id` is the one identity field NOT synced.
**What works:** fix the borrower at the **GHL source** (the opportunity's contact). The dashboard's
`promoteToPrimary` (★ in CoborrowerManager) swaps `borrower_id` only — it does NOT update `deals.name/email/phone`,
so it's cosmetically ineffective on GHL-synced deals unless we also (a) copy the promoted contact's name/email/phone
onto the deal and (b) mark them "manual" so the sync's `name`/`maybeSet` writes respect a lock. That override
doesn't exist yet — co-borrower→primary swaps will keep reverting until it's built.
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
only return a match when they resolve to **exactly one** deal (never guess a sibling). The 3-min sync
was never the culprit — it already keys by opportunity id.
**Also note:** the fix can't self-heal an already-corrupted row (funded-guard blocks the webhook from
demoting it; the sync never clears `funded_date`) — corrupted rows need a manual correction.
**Project:** lumin-deals
**Date:** 2026-06-24
