# Plan: arive_file_no duplicate detector

**Diagnosis:** `docs/diagnoses/2026-06-16-ghl-arive-duplicate-arive-file.md`
**Scope:** one file — `app/duplicates/page.tsx`. Reuses the existing detect → merge → dismiss flow
(`/api/deals/merge`, `/api/duplicates/dismiss`). No API or schema change.

## Tasks

### T1 — Add the detector
- Extend `MatchType` with `'arive'`.
- In `detectDuplicates`: build `byArive = Map<string, Deal[]>` keyed on the trimmed, non-blank
  `arive_file_no`; push every deal that has one.
- Run the arive pass FIRST (most authoritative label wins the group signature).

### T2 — Bypass the "separate loans" guards for arive only
- In `addGroup`: when `matchType === 'arive'`, do NOT apply `sharesBorrowerId` or `isLegitMultiLoan`
  skips — a shared Arive file # is the same loan regardless of borrower_id / distinct opp ids
  (those guards are precisely what hid these dups). Keep both guards for email/phone/name; keep the
  amount exception as-is.

### T3 — UI wiring
- `MATCH_LABELS.arive = { label: 'Same Arive file #', icon: <Hash/> }` (import `Hash` from lucide).
- Add `'arive'` to the filter-button list.
- Update the header copy to mention "or Arive file #".

### T4 — Verify
- `npx tsc --noEmit` — changed file adds no NEW errors (pre-existing set unchanged).
- `npm run build` — `/duplicates` compiles.
- Reason against live data: the 6 arive-shared groups now surface; Marian's pair shows under
  "Same Arive file #", primary = the Arive row (Moe) so a merge corrects the LO.

## Acceptance
- [ ] `/duplicates` shows a "Same Arive file #" group for each of the 6 shared-arive loans,
      including Marian (which `borrower_id` sharing previously hid).
- [ ] Merge picks the Arive row as primary (Moe), correcting the LO; dismiss still works (Southerby).
- [ ] email/phone/name detectors unchanged (still skip same-borrower_id / legit multi-loan).
- [ ] tsc clean (no new errors); build compiles.
