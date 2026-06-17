# Spec: Refi Radar (Opportunity Radar v1)

**Date:** 2026-06-16
**Status:** APPROVED — Efrain chose a dedicated `/radar` page, start with the no-equity plays.
**Grounding:** cross-tab of the funded book (probe 2026-06-16) — the high-rate book is HELOCs
(59 funded, avg 9.60%, 28 of 30 loans ≥9% are HELOCs), NOT non-QM/bridge. Firsts mostly closed at
good rates (Conv 6.23%, FHA 5.64%, VA 5.75%). 65/148 funded are <6mo (seasoning gate); ~43 are
actionable today.

## Problem
The funded book is full of refinance/consolidation opportunity, but nothing surfaces "who to call,
and why." A naïve "rate > par" list would be wrong here (it'd flag good FHA/VA loans and treat a
variable HELOC like a first).

## Solution
A dedicated `/radar` page driven by ONE pure, product-segmented scoring function over funded deals:
- **second-lien** (HELOC/HELOAN ≥ ~8.5%) → consolidate/convert to a fixed first
- **first-lien** (Conv/Fixed, rate ≥ conv par + 0.5%) → classic rate-and-term, ranked × balance
- **non-qm** (Non-QM/DSCR paying a premium, seasoned) → season-out to conventional
- **fha-mip** (FHA + ≥20% equity, or rate ≥ fha par + delta) → drop lifetime MIP / streamline
- **va-irrrl** (VA, rate ≥ va par + delta)
Gated by **seasoning ≥ 6 months** (too-new loans are counted as "maturing," not shown as actionable)
and a **net-benefit threshold**. Equity-dependent sizing (HELOC consolidation $, FHA MIP) shows
"needs equity" when value/balance are missing (14–34% populated) — the flag still fires.

**Par rates** (per product: conv/fha/va/nonqm) are user-set — there is no live rate in the DB. Stored
in `sync_state` via a small API route (same pattern as `/api/duplicates/dismiss`), editable on the page.

## Acceptance Criteria
- [ ] `/radar` lists funded clients ranked by opportunity, each with a play badge + reason
      (product, rate, months seasoned) + est. monthly saving (when loan_amount known) or "needs equity".
- [ ] A <6-month HELOC is NOT in the actionable list (counted as maturing); a seasoned 9.6% HELOC is.
- [ ] A 5.25% FHA is NOT flagged as a rate refi; a 7.5% Conv (par 6.5) IS, with delta 1.0%.
- [ ] Par rates load from `sync_state` (defaults if unset) and persist on save.
- [ ] Play filter tabs + counts; rows link to the person (`/contacts/[borrower_id]`).
- [ ] Pure scorer covered by fixtures (`scripts/refi-radar-check.ts`); page type-clean + builds.

## Out of Scope (later)
- The contacts-list "Refi?" pill + person-page callout (same scorer; add next).
- Auto-refreshing par rates from a feed. Equity-based cash-out sizing until value/balance fill.
