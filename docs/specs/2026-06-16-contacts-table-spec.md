# Spec: Contacts Table + Person View (Phase 2 + minimal Phase 3)

**Date:** 2026-06-16
**Status:** APPROVED
**Approach:** Contacts keyed by the canonical `borrower_id`; resolver-maintained; thin person UI

## Problem
Phase 1 made `borrower_id` a stable, canonical "this is one person" key, but there is no person
*entity* — the dashboard still can't show a person and their loans together, which is the whole
point of the contacts architecture (refi radar, per-person LTV, repeat/referral later).

## Solution
A `contacts` table with **`id` = the canonical `borrower_id`** (so `deals.borrower_id` is already
the FK — no deals migration, no second key). One row per person, holding best-current identity
(name/email/phone, all per-sub-account GHL contact ids) and rollups (loan/funded counts, funded
volume, comp, first/last loan date).

**Maintenance:** the existing identity-resolution pass (`runIdentityResolutionPass`, already run
every 30 min by the maintenance cron and on `/api/resolve-identities` apply) is extended to UPSERT
one contacts row per person and delete orphaned rows. No new cron, no dual-write in sync/import.

**Minimal Phase 3 UI (so the result is visible):**
- `/contacts` — searchable list of people: name, # loans, # funded, total funded volume, comp.
- `/contacts/[id]` — person header (identity + rollups) and the list of their loans.
- A nav link to `/contacts`.

## Acceptance Criteria
- [ ] `supabase-contacts.sql` creates the `contacts` table (id = borrower_id PK).
- [ ] After a resolver apply, `contacts` has exactly one row per distinct `deals.borrower_id`
      (counts match), and no orphan rows (every `contacts.id` exists as a `deals.borrower_id`).
- [ ] A contact's rollups match its deals (loan_count, funded_count, Σ funded loan_amount, Σ comp).
- [ ] Marian Cooper appears as ONE contact with her 3 loans.
- [ ] `/contacts` lists people and links to `/contacts/[id]`, which shows that person's loans.
- [ ] Re-running the resolver is idempotent for contacts too (no churn beyond changed data).

## Out of Scope (later phases)
- Refi radar, per-person LTV scoring, repeat/referral detection, lead-spend person-dedup (Phase 4).
- Editing contacts by hand (contacts are derived, not hand-edited).
- Merging UI / un-merge (Phase 1's backup-restore covers a bad merge).

## Open Questions
_None._ `contacts.id = canonical borrower_id` (decided 2026-06-16 — simpler and lower-risk than a
separate `contact_id` FK the Phase 1 doc sketched). Table DDL is a one-time manual run in the
Supabase SQL editor (same pattern as the existing triggers).
