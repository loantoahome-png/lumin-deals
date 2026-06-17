# Spec: Rich Person View (Contacts Phase 3)

**Date:** 2026-06-16
**Status:** APPROVED (Efrain picked this direction over Opportunity Radar / money analytics)
**Approach:** Enrich `/contacts/[id]` only — no schema change, no resolver change. Read the
person's `deals` (already fetched) and surface what's there richly.

## Problem
The person page exists but is thin: a 4-stat header and a bare loan table. When you land on a
person you can't (a) see their history at a glance, (b) jump to them in the right GHL sub-account,
or (c) tell if they're even contactable. It's an address-book entry, not a call-prep surface.

## What the data supports (probed 2026-06-16, live)
- `ghl_contact_id` 94% · `ghl_location_id` 94%, exactly **2 sub-accounts** → per-sub-account
  GHL deep-links work (a person can exist in BOTH — that's the cross-account value).
- `dnd`/`dnd_settings` ~72% · **237 hard-DND deals** → reachability badge is real and useful.
- `stage_changed_at` 84% · `date_added_ghl` 94% · `funded_date` (funded loans) 95% · `signing_date`
  → a milestone timeline is feasible.
- **`communications` JSONB = 0% populated** → NO message timeline. Timeline is milestone-only.
- **67 people have >1 loan** → the interleaved timeline matters most for them; single-loan people
  still gain the links, reachability, and richer loan detail.

## Solution — enrich `/contacts/[id]` with four things
1. **Reachability + jump bar** (header): a DND badge when any of the person's loans is DND
   (reuse `dndLabel`/`dndSummary` from `lib/utils`), "last contacted" (max `last_contacted` across
   loans), and **one GHL link per distinct sub-account** (reuse `ghlContactUrl`), labeled by LO.
2. **Activity timeline**: interleaved milestone events across ALL the person's loans, newest first —
   lead created (`date_added_ghl`), stage moves (`stage_changed_at` + `status`), docs signed
   (`signing_date`), funded (`funded_date`). Each event links to its loan.
3. **Enriched loans list**: replace the bare table — per loan show status badge (`STATUS_COLORS`),
   pipeline group, LO, loan type/purpose, property (address + state), amount, rate, funded date,
   and per-loan links: internal `/deals/[id]`, GHL contact, Arive (when `arive_file_no`).
4. **Header polish**: title-case the name (`titleCase`), keep the 4 rollup stats, add first-seen /
   last-activity.

## Acceptance Criteria
- [ ] A person with loans in two GHL sub-accounts shows TWO GHL links (one per sub-account).
- [ ] A person with any DND loan shows a DND badge with the blocked channels; a fully-contactable
      person shows none.
- [ ] The timeline lists milestone events across all the person's loans, newest first, each linking
      to the right loan; a multi-loan person (e.g. Rene Gonzalez) interleaves correctly.
- [ ] Each loan row shows property + rate + type and links to `/deals/[id]`, GHL, and (when present)
      Arive.
- [ ] No `communications`-array timeline is shown (data is empty) — milestone timeline only.
- [ ] Changed file is type-clean under `npx tsc --noEmit` (no NEW errors vs the pre-existing set).

## Out of Scope
- Opportunity Radar / rate-delta scoring (separate direction, deferred).
- Equity / LTV (data-gated — `current_balance` 14%).
- Editing the contact (contacts are resolver-derived).
- Syncing `communications` for funded/all stages (would unlock a real comms timeline later).
