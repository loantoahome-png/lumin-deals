# Plan: Contacts Table + Person View (Phase 2 + minimal Phase 3)

**Date:** 2026-06-16
**Mode:** Build
**Source:** docs/specs/2026-06-16-contacts-table-spec.md
**Status:** APPROVED

### Task 1: Contacts table DDL — DONE
`supabase-contacts.sql` (id = borrower_id PK, rollups, indexes). Manual run in Supabase SQL editor.
**Status:** [x]

### Task 2: Resolver maintains contacts
**Files:** `lib/identityResolver.ts`, `lib/types.ts`
**Do:**
1. Extract the union-find into `export function buildComponents(deals: ResolverDeal[]): ResolverDeal[][]`
   (returns ALL components, every person). Refactor `resolveIdentities` to use it.
2. `ResolverDeal` already has the fields needed for rollups? It has id/created_at/borrower_id/
   ghl_contact_id/email/phone. ADD `name`, `loan_amount`, `compensation_amount`, `pipeline_group`,
   `updated_at` to `ResolverDeal` and to the `select` in `runIdentityResolutionPass`.
3. `export function computeContactRows(deals): ContactRow[]` — per component: canonical id
   (oldest borrower_id, same rule), display_name/email/phone from the most-recently-updated member
   with a value, `ghl_contact_ids` = distinct non-null, rollups (loan_count, funded_count, Σ funded
   loan_amount, Σ comp, min/max created_at).
4. In `runIdentityResolutionPass`, on APPLY only and AFTER the borrower_id writes: upsert all
   contact rows (chunked) and delete `contacts` rows whose id is not in the canonical set.
5. `lib/types.ts`: add `Contact` type mirroring the table.
**Test:** resolver apply → `contacts` count == distinct borrower_id count; Marian = 1 contact, 3 loans.
**Skills:** lint-and-validate
**Commit:** "Contacts: resolver upserts one contact per person (Phase 2)"
**Status:** [ ]

### Task 3: /contacts list page  [P]
**Depends on:** Task 2
**Files:** `app/contacts/page.tsx`
**Do:** client page; `fetchAllDeals`-style read of `contacts` (paginate), search box (name/email),
table: name · #loans · #funded · funded volume · comp; row links to `/contacts/[id]`. Match the
styling of `app/funded/page.tsx`.
**Test:** page renders, search filters, links work (preview).
**Skills:** lint-and-validate, ui-ux-pro-max
**Commit:** "Contacts: /contacts list page"
**Status:** [ ]

### Task 4: /contacts/[id] person page  [P]
**Depends on:** Task 2
**Files:** `app/contacts/[id]/page.tsx`
**Do:** read the contact by id + its deals (`borrower_id=eq.id`); header with identity + rollups;
list the person's loans (name/amount/stage/funded_date/arive#). Reuse deal-row styling.
**Test:** open a known contact (Marian) → shows her 3 loans (preview).
**Skills:** lint-and-validate, ui-ux-pro-max
**Commit:** "Contacts: /contacts/[id] person page"
**Status:** [ ]

### Task 5: Nav link + verify + ship
**Depends on:** Task 3, Task 4
**Files:** nav component (find the sidebar/nav), then verify + commit + deploy.
**Do:** add a "Contacts" nav link; run the resolver apply to populate `contacts`; preview both
pages; commit; deploy.
**Test:** acceptance criteria from the spec; preview screenshots.
**Skills:** lint-and-validate
**Commit:** "Contacts: nav link"
**Status:** [ ]
