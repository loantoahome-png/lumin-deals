# GOTCHAS — Lumin Deals

### Co-borrowers split into separate GHL contacts → duplicate escrow cards for ONE loan (the "Southerby case")
**Tried:** Paul + Cynthia Southerby (one $1.22M loan, Arive #16895210) both showed on Active Escrows. Paul's card
was the worked one (lender/processor/lock/notes) but Arive-created with `ghl_opportunity_id = null`; Cynthia's was
a bare card carrying the real GHL opportunity (`ffkS…`).
**Failed because (two compounding things):** (1) The loan's borrowers each have their OWN GHL contact, and the GHL
*opportunity* was created under the CO-borrower's contact (Cynthia), not the main borrower's (Paul). The dashboard
builds a deal per opportunity and derives identity from the opp's contact → a second card. (2) **A FULL SYNC
surfaced it.** The incremental 3-min sync only processes CHANGED opps, so Cynthia's opp sat in GHL ~18 days with no
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

### A GHL contact RENAME doesn't reach the dashboard via the 3-min sync — only a FULL sync re-pulls it
**Tried:** A borrower was renamed in GHL (Espinoza opp: the contact `t2BK…` was changed Judith → Jesus). The
dashboard kept showing "Judith" for days, through many 3-min syncs and manual "Sync GHL" clicks.
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
only return a match when they resolve to **exactly one** deal (never guess a sibling). The 3-min sync
was never the culprit — it already keys by opportunity id.
**Also note:** the fix can't self-heal an already-corrupted row (funded-guard blocks the webhook from
demoting it; the sync never clears `funded_date`) — corrupted rows need a manual correction.
**Project:** lumin-deals
**Date:** 2026-06-24
