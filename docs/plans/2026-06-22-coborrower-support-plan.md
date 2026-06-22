# Plan: Co-Borrower Support
**Date:** 2026-06-22
**Mode:** Build
**Source:** docs/specs/2026-06-22-coborrower-support-spec.md
**Status:** APPROVED

> Baseline: `npx tsc --noEmit` reports **7 pre-existing errors** (build-ignored). Every task's
> tsc check means "error count still 7, none in files I touched." Deploys are gated — do NOT
> `vercel --prod` without Efrain's explicit OK (deploy-policy). SQL migrations are run by Efrain
> in the Supabase SQL Editor, not by an agent.

## Tasks

### Task 1: DB migration — `deal_contacts` table
**Files:** `supabase-add-deal-contacts.sql` (NEW)
**Do:**
1. Create the migration (mirror the style of `supabase-add-pi-payment.sql` — header comment +
   idempotent DDL):
   ```sql
   CREATE TABLE IF NOT EXISTS deal_contacts (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     deal_id     uuid NOT NULL REFERENCES deals(id)    ON DELETE CASCADE,
     contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     role        text NOT NULL DEFAULT 'co',
     created_at  timestamptz NOT NULL DEFAULT now(),
     UNIQUE (deal_id, contact_id)
   );
   CREATE INDEX IF NOT EXISTS deal_contacts_deal_idx    ON deal_contacts(deal_id);
   CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts(contact_id);
   ```
2. Do NOT run it — leave a note in the task output that Efrain must run it before runtime tests.
**Test:** File parses as valid SQL (eyeball); `contacts` + `deals` tables exist (they do).
**Skills:** lint-and-validate
**Commit:** "Add deal_contacts table migration for co-borrowers"
**Status:** [ ]

### Task 2: Types — `DealContact` + co-borrowers on `Deal` [P]
**Files:** `lib/types.ts`
**Do:**
1. Add after the `Contact` type:
   ```ts
   export const BORROWER_ROLES = ['primary', 'co'] as const
   export type BorrowerRole = (typeof BORROWER_ROLES)[number]
   export type DealContactLink = {
     id: string
     deal_id: string
     contact_id: string
     role: BorrowerRole
     created_at: string
   }
   // Lightweight contact shape for embedding on a loaded deal.
   export type CoborrowerLite = { contact_id: string; name: string | null; email: string | null; phone: string | null }
   ```
2. Add to the `Deal` type (near `borrower_id`): `coborrowers: CoborrowerLite[] | null  // role='co' links, loaded join (null when not loaded)`.
**Test:** `npx tsc --noEmit` (count still 7).
**Skills:** lint-and-validate
**Commit:** "Add DealContact types + Deal.coborrowers"
**Status:** [ ]
(Can run parallel with Task 1)

### Task 3: Data-access lib — `deal_contacts` CRUD + find-or-create contact
**Depends on:** Task 2
**Files:** `lib/dealContacts.ts` (NEW)
**Do:**
1. Export async helpers taking a Supabase service client (import `createServiceClient` from
   `@/lib/supabase` at call sites; pass the client in so it's testable):
   - `listCoborrowers(sb, dealId): Promise<CoborrowerLite[]>` — join `deal_contacts`→`contacts`, role='co'.
   - `linkCoborrower(sb, dealId, contactId): Promise<void>` — upsert on `(deal_id, contact_id)`, role='co'.
   - `unlinkCoborrower(sb, dealId, contactId): Promise<void>`.
   - `promoteToPrimary(sb, dealId, contactId): Promise<void>` — read deal's current `borrower_id`;
     set `deals.borrower_id = contactId`; delete the new primary's co row; insert the OLD primary
     as a co row (skip if old primary was null).
   - `findOrCreateContact(sb, { name, email, phone }): Promise<string /* contact_id */>` — reuse the
     resolver's strong-key matching from `lib/identityResolver.ts` (`normEmail`/`normPhone`,
     `isWeakEmail`/`isWeakPhone`); match an existing contact by non-weak email then phone; only
     insert a new `contacts` row when no strong-key match exists. NEVER match on name.
2. Guard against linking a contact as its own deal's primary (no-op if `contactId === deals.borrower_id`).
**Test:** `npx tsc --noEmit`; write a throwaway `tsx` script (delete after) that calls
`findOrCreateContact` logic against in-memory fixtures to confirm weak email/phone are not used as keys.
**Skills:** lint-and-validate, sanitize-pii (handles contact email/phone)
**Commit:** "Add deal_contacts data-access helpers + find-or-create contact"
**Status:** [ ]

### Task 4: API route — manual link / unlink / promote
**Depends on:** Task 3
**Files:** `app/api/deals/[id]/coborrowers/route.ts` (NEW)
**Do:**
1. `POST` body `{ action: 'link'|'promote', contactId }` or `{ action: 'link', newContact: {name,email,phone} }`
   → for `link`+newContact call `findOrCreateContact` then `linkCoborrower`; for `link`+contactId call
   `linkCoborrower`; for `promote` call `promoteToPrimary`. Return the refreshed `listCoborrowers`.
2. `DELETE` body `{ contactId }` → `unlinkCoborrower`, return refreshed list.
3. Use `createServiceClient` (matches `app/api/import/arive/route.ts`). Validate inputs; 400 on missing fields.
**Test:** `npx tsc --noEmit`; after Efrain runs Task 1's migration, `curl` POST/DELETE against `npm run dev`.
**Skills:** lint-and-validate, owasp-security (input validation, PII write)
**Commit:** "Add co-borrower link/unlink/promote API route"
**Status:** [ ]

### Task 5: Deal-detail UI — borrower list + link picker + remove/promote
**Depends on:** Task 4
**Files:** `app/deals/[id]/page.tsx`
**Do:**
1. In the BORROWER section, render the primary (existing) plus a **Co-borrowers** list from
   `form.coborrowers`, each row: name + email, "Make primary" and "Remove" buttons (call the Task 4 API).
2. Add a "**+ Link co-borrower**" control: a contact search (by name/email/phone) against `contacts`,
   with an inline "create new contact" fallback (name/email/phone) → POST to the Task 4 API.
3. Load `coborrowers` when the deal loads (add to the deal fetch, or a follow-up fetch to the GET side
   of the Task 4 route — add a `GET` returning `listCoborrowers` if simpler).
**Test:** Visual via preview (auth-bypass pattern from prior sessions); link a contact, see it appear,
remove it, promote it; confirm primary swaps.
**Skills:** lint-and-validate, verification-workflow (visual proof)
**Commit:** "Add co-borrower management UI to deal detail"
**Status:** [ ]

### Task 6: Card `+N` co-borrower badge [P]
**Depends on:** Task 2
**Files:** `components/EscrowTracker.tsx`, `app/pipeline/page.tsx`
**Do:**
1. Where the borrower name renders on the escrow card and pipeline rows, append a compact
   `+N` badge when `deal.coborrowers?.length` > 0 (title attr lists the names). No inline names.
2. Ensure the deal queries feeding these views select enough to know co-borrower count (a count is
   fine — extend the select or add a lightweight `coborrower_count`; coordinate with the data load).
**Test:** Visual via preview with a deal that has ≥1 co-borrower (mock or seeded).
**Skills:** lint-and-validate, verification-workflow
**Commit:** "Show +N co-borrower badge on cards"
**Status:** [ ]
(Can run parallel with Task 5)

### Task 7: Contact profile + LoanHistory — co loans flagged; rollups stay primary-only
**Depends on:** Task 3
**Files:** `app/contacts/[id]/page.tsx`, `components/LoanHistory.tsx`, `lib/identityResolver.ts`
**Do:**
1. In the contact's loan list, UNION loans where `deals.borrower_id = contact.id` with loans where
   `deal_contacts.contact_id = contact.id AND role='co'`. Flag the co ones with a "Co-borrower" chip.
2. Verify `computeContactRows` in `lib/identityResolver.ts` aggregates `$` (`total_funded_volume`,
   `total_comp`, `funded_count`, `loan_count`) **only** over primary (`borrower_id`) deals — co loans
   must NOT inflate the rollups. Add/adjust a comment making this explicit; change only if it currently leaks.
**Test:** `npx tsc --noEmit`; throwaway script or visual: a contact who is co-borrower on one loan shows
that loan in history (flagged) but their funded volume/comp is unchanged.
**Skills:** lint-and-validate, verification-workflow
**Commit:** "Show co-borrower loans on contact profile (rollups stay primary-only)"
**Status:** [ ]

### Task 8: Arive importer — co-borrower columns, find-or-create + link, dedup flag
**Depends on:** Task 3
**Files:** `lib/ariveCsv.ts`, `app/api/import/arive/route.ts`
**Do:**
1. In `lib/ariveCsv.ts`: parse co-borrower fields from the row (accept a candidate-header list like
   `MAPPINGS`: `['Co-Borrower First Name'+'Co-Borrower Last Name', 'Co-Borrower Name']`,
   `['Co-Borrower Email']`, `['Co-Borrower Cell Phone','Co-Borrower Home Phone']`). Stash on the patch
   as `__coborrower = { name, email, phone }` (carrier field, like `__borrower_name`).
2. Extend `RowPlan` with optional `coborrower?: {name,email,phone}` and a `dedupWarning?: string`.
   In `buildPlan`, when a row has a co-borrower, surface it on the plan; set `dedupWarning` when the
   co-borrower email/phone matches a DIFFERENT existing deal that shares this row's Arive loan #.
3. In `app/api/import/arive/route.ts` commit path: for matched/updated and created deals that carry a
   co-borrower, call `findOrCreateContact` + `linkCoborrower` (from `lib/dealContacts.ts`). Do NOT
   create a second deal for the co-borrower.
**Test:** Extend the throwaway `tsx` harness (pattern from the adverse verification) with a synthetic
CSV row containing a co-borrower → assert the plan carries the co-borrower and the dedup flag fires
on a colliding fixture. `npx tsc --noEmit`.
**Skills:** lint-and-validate, sanitize-pii, mortgage-advisor (loan/borrower domain)
**Commit:** "Import: parse + link Arive co-borrowers with dedup flag"
**Status:** [ ]

### Task 9: Import preview UI — co-borrower + dedup warning
**Depends on:** Task 8
**Files:** `app/import/arive/page.tsx`
**Do:**
1. In the per-row preview, when `plan.coborrower` exists, show a "Co-borrower: <name>" line and a
   "will link" chip. When `plan.dedupWarning` is set, show an amber warning chip with the message.
**Test:** Visual via preview with a CSV containing a co-borrower row + a colliding row.
**Skills:** lint-and-validate, verification-workflow
**Commit:** "Show co-borrower link + dedup warning in import preview"
**Status:** [ ]

### Task 10: Acceptance-criteria verification + VERIFICATION-LOG
**Depends on:** Task 5, Task 6, Task 7, Task 9
**Files:** `VERIFICATION-LOG.md`
**Do:**
1. Walk every acceptance criterion in the spec; record CHANGED/VERIFIED with the proof method used.
2. Confirm `npx tsc --noEmit` count is still 7. Confirm identity-resolver matching is unchanged
   (no new merges) by running its existing fixtures if present.
3. Summarize for Efrain: what needs the Task 1 migration run, and what (if anything) to deploy.
**Test:** All acceptance criteria checked; tsc 7/7.
**Skills:** verification-workflow
**Commit:** "Log co-borrower support verification"
**Status:** [ ]

## Dependency / parallelism summary
- **Wave 1 (parallel):** Task 1, Task 2
- **Wave 2:** Task 3 (after 2)
- **Wave 3 (parallel):** Task 4, Task 6, Task 7, Task 8 (all after 3; 6 also needs 2)
- **Wave 4:** Task 5 (after 4), Task 9 (after 8)
- **Wave 5:** Task 10 (after 5, 6, 7, 9)
