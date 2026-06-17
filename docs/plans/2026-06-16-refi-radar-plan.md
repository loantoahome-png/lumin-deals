# Plan: Refi Radar (Opportunity Radar v1)

**Spec:** `docs/specs/2026-06-16-refi-radar-spec.md`

## Tasks
1. **`lib/refiRadar.ts`** — pure, dependency-free scorer. `RadarDeal` input type, `ParRates`,
   `DEFAULT_PAR`, `scoreFundedBook(deals, par, asOf)` → `RefiCandidate[]` with
   `{ play, reason, score, eligible, tooNew, estMonthly, monthsSeasoned }`. Product→play mapping,
   seasoning gate (6mo), net-benefit threshold, $-ranking (loan_amount or fallback).
2. **`scripts/refi-radar-check.ts`** — fixtures: seasoned HELOC eligible; <6mo HELOC maturing; low-rate
   FHA not flagged; Conv 7.5%@par6.5 eligible delta 1.0; Conv 6.6% below threshold not flagged; Non-QM
   season-out; no-rate → skipped; ranking by score. Verify via tsc-compile-to-/tmp + node.
3. **`app/api/radar/par-rates/route.ts`** — GET/POST `sync_state` key `refi_par_rates` (service
   client), mirroring the dedupe-dismiss route.
4. **`app/radar/page.tsx`** — load funded deals + par rates; compute candidates; par-rate config bar
   (editable, save → POST); play filter tabs + counts; ranked table (client link, play badge, reason,
   est saving / "needs equity", last contact/DND, comp); actionable vs maturing summary.
5. **`components/Sidebar.tsx`** — add `/radar` ("Refi Radar", `Radar` icon) to the Pipeline group.
6. **Verify** — run fixtures (node); `npx tsc --noEmit` (no new errors); `npm run build` (`/radar`
   compiles). Mockup already approved.

## Notes
- Scorer is import-free so fixtures compile standalone. `asOf` param injects "today" for testability.
- Honest gates baked in: no-rate loans skipped; equity plays show "needs equity"; seasoning suppresses
  the ~65 too-new loans into a "maturing" count.
