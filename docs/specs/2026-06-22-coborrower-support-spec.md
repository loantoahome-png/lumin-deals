# Spec: Co-Borrower Support

**Date:** 2026-06-22
**Status:** APPROVED
**Approach:** Co-borrower join table (`deal_contacts`) layered on the existing contacts entity, with dual linking (Arive auto + manual picker) and a card badge + deal-detail UI.

## Problem

A loan often has more than one borrower (a primary + a co-borrower spouse/partner). The
dashboard models only **one** person per loan: `deals.borrower_id` points at a single
contact, and the identity resolver (`lib/identityResolver.ts`) groups records into one
person by **shared strong key** (email/phone/GHL id) — it deliberately never links two
*different* people.

Co-borrowers are the opposite shape: **two different people on one loan.** They have
different emails/phones, so the resolver (correctly) keeps them separate — but there is no
way to express "both are on this loan." This causes two concrete failures:

1. **Stray duplicate deals.** When the co-borrower exists as their own GHL contact, they
   spin up a *second* deal for the same loan (or the loan deal ends up under the
   co-borrower's name entirely). The Cynthia/Paul Southerby case (2026-06-22) is exactly
   this: the loan deal lives under "Cynthia Southerby" while Arive's primary borrower on
   that loan is "Paul Dean Southerby."
2. **No co-borrower visibility.** You can't see who else is on a loan, and a person's
   profile can't show loans they're a co-borrower on.

## Solution

Add a **`deal_contacts` join table** that links additional people to a loan with a role.
`deals.borrower_id` stays the single source of truth for the **primary** borrower (no
migration of the existing primary path); the join table carries **co-borrowers**.

```
deal_contacts (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  role        text not null default 'co',   -- 'co' (v1); 'primary' reserved for future
  created_at  timestamptz not null default now(),
  unique (deal_id, contact_id)
)
```

- **Primary** borrower = `deals.borrower_id` (unchanged, already wired everywhere).
- **Co-borrowers** = `deal_contacts` rows with `role='co'`.
- The `role` column exists for forward-compat (promote/swap) but every v1 row is `'co'`.

### Linking (both paths in v1)

**A. Arive auto-link** — add co-borrower columns to the Arive export and consume them in
the importer (`lib/ariveCsv.ts` + `app/api/import/arive/route.ts`):
- New export columns (header names confirmed against Arive at build time; importer accepts
  a candidate list like existing `MAPPINGS`): `Co-Borrower First Name` / `Co-Borrower Last
  Name` (or a single `Co-Borrower Name`), `Co-Borrower Email`, `Co-Borrower Cell Phone`.
- On import, for each row with a co-borrower: **find-or-create** the co-borrower contact
  (reusing the resolver's strong-key matching so an existing GHL contact is reused, not
  duplicated), then upsert a `deal_contacts (deal_id, contact_id, role='co')` row.
- **Dedup guard:** if the co-borrower's email/phone already matches a *separate deal that
  points at the same Arive loan #*, flag it in the import preview as a likely duplicate
  rather than silently creating another deal.

**B. Manual picker** — a "Link co-borrower" control on the deal-detail page
(`app/deals/[id]/page.tsx`):
- Search existing contacts (by name/email/phone) and attach as co-borrower; or create a
  new contact inline if none exists.
- Remove a co-borrower; **promote** a co-borrower to primary (swaps `borrower_id` and moves
  the previous primary into a `deal_contacts` co row).

### Reporting / rollups (primary-only for $)

`computeContactRows` (`lib/identityResolver.ts`) and the contact profile:
- **$ totals** (`total_funded_volume`, `total_comp`, `funded_count`) count a loan **only
  for its primary** (`borrower_id`). A loan is never counted twice across two people.
- **Loan history** for a contact lists loans where they are primary **OR** co-borrower; co
  loans are visibly flagged "Co-borrower" and excluded from the $ rollups.

### Display (card badge + detail)

- **Escrow / pipeline cards** (`components/EscrowTracker.tsx`, `app/pipeline/page.tsx`):
  compact **`+1`** (or `+N`) badge next to the borrower name when co-borrowers exist. No
  inline names on the dense card.
- **Deal detail** (`app/deals/[id]/page.tsx`): full borrower list with roles (Primary /
  Co-borrower), each linking to its contact profile; plus the manual link/remove/promote
  controls.
- **Contact profile** (`app/contacts/[id]/page.tsx`, `components/LoanHistory.tsx`): loans
  where the person is primary or co, with the co ones flagged.

## Acceptance Criteria

- [ ] `deal_contacts` table exists (migration `supabase-add-deal-contacts.sql`), with
      FK cascades to `deals` and `contacts` and a unique `(deal_id, contact_id)`.
- [ ] A deal can have ≥1 co-borrowers; `deals.borrower_id` (primary) is unchanged.
- [ ] **Manual:** on deal detail I can link an existing contact as co-borrower, and it
      appears under the deal and on that contact's profile.
- [ ] **Manual:** I can remove a co-borrower and promote a co-borrower to primary (primary
      swaps; old primary becomes a co row); no orphaned/duplicate rows result.
- [ ] **Arive:** importing an export with co-borrower columns find-or-creates the
      co-borrower contact (reusing an existing match, not duplicating) and links it
      `role='co'` to the loan — visible in the import preview before commit.
- [ ] **Dedup:** when a co-borrower email/phone matches a separate deal on the same Arive
      loan #, the import preview flags it as a likely duplicate instead of creating a new
      deal.
- [ ] **Reporting:** a loan where a person is only a co-borrower does **not** add to that
      person's `total_funded_volume` / `total_comp` / `funded_count`; it still appears in
      their loan history flagged "Co-borrower." Aggregate funded volume across all contacts
      does not double-count shared loans.
- [ ] **Display:** cards show a `+N` co-borrower badge; deal detail lists all borrowers
      with roles; both link to contact profiles.
- [ ] Identity resolver behavior is unchanged — it still never merges two distinct people;
      co-borrower linking is independent of resolution.
- [ ] `npx tsc --noEmit` error count unchanged from baseline (7, all pre-existing).

## Out of Scope

- More than the primary + co distinction at the data level beyond `role` text (no separate
  guarantor/non-borrowing-spouse taxonomy in v1).
- Automatic detection of co-borrowers from GHL alone (no co-borrower signal there) — GHL
  contacts only link as co via the manual picker or an Arive co-borrower column.
- Back-filling co-borrowers onto historical loans (one-time cleanup is a separate task).
- Merging/auto-resolving pre-existing stray duplicate deals beyond the import-preview flag
  + manual promote (full duplicate-merge tooling lives on the `/duplicates` page already
  and is not expanded here).

## Dependencies / Notes

- **Arive export headers** for the co-borrower fields are not yet confirmed; the importer
  will accept a candidate-header list (same tolerance as existing `MAPPINGS`) and Efrain
  confirms the exact Arive column names when that export is generated. Not a blocker for
  the design — manual linking works without it.

## Open Questions

_None — all resolved._
