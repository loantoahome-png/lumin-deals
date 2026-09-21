# Plan — /lead-roi per-source states + Submission %

Spec: `docs/specs/2026-09-21-lead-roi-states-and-submission-spec.md`
Branch: `main` (deploy policy: verify → commit → push → `vercel --prod`)

## Task 1 — `lib/leadRoi.ts`: the submission predicate
**Files:** `lib/leadRoi.ts`
- Import `LOAN_STATUSES` from `./types`; build a frozen `STATUS_RANK` map once.
- `SUBMITTED_RANK = rank('Submitted to UW')`, `FINAL_RANK = rank('Loan Finalized')`.
- Export `isSubmitted(d: Pick<Deal,'status'|'arive_file_no'>): boolean`.
- Header comment: why the Arive clause exists (64 dead-status leads with real files).
**Verify:** fixtures — rank boundary, dead status + file, dead status no file, funded.

## Task 2 — `lib/leadRoi.ts`: wire submitted into stats
**Files:** `lib/leadRoi.ts`
- `SourceStats` += `submitted; sr`; accumulate in `buildSourceStats`; derive `sr`.
- `RoiKpis` += `submitted; sr`; sum in `rollupKpis`.
- `funnel()` += Submitted stage between Responded and Became a loan.
- `StateRow` += `submitted; sr`.
**Verify:** fixtures — sr arithmetic, funnel order and monotonicity (sub ≥ funded).

## Task 3 — `lib/leadRoi.ts`: `stateStats()` full money set
**Files:** `lib/leadRoi.ts`
- `StateStats` = state, n, responded, rr, submitted, sr, funded, fr, fundedVolume,
  leadCost, retainer, spend, revenue, netRevenue, netProfit, roi, costPerFunded.
- `stateStats(deals, retainer = 0)` — retainer split pro-rata by lead count.
- Sort by leads desc.
**Verify:** fixture — per-state spend/net/revenue sum to the source row; retainer
allocation sums exactly (no rounding drift).

## Task 4 — `lib/leadRoi.ts`: `sourceStateMatrix()`
**Files:** `lib/leadRoi.ts`
- `MatrixMetric = 'leads'|'submitted'|'funded'|'spend'|'netProfit'|'roi'|'sr'|'fr'`
- Returns `{ states: string[]; rows: { source, cells: (number|null)[], total }[] }`
  with states ordered by total leads desc.
**Verify:** fixture — cell totals reconcile to the source table column.

## Task 5 — `app/lead-roi/page.tsx`
**Files:** `app/lead-roi/page.tsx`
- **`arive_file_no` → `LEAD_COLS`** (do this FIRST — predicate is inert otherwise).
- Sub % column in the source table + totals row.
- Per-source states table in the drill-down.
- Source × State matrix section with a metric picker.
- Submission KPI card.
- CSV: `Submitted`, `Sub %`.
**Verify:** `npx tsc --noEmit`; dev:bypass render is blocked by RLS, so verify numbers
with a service-role report script instead.

## Task 6 — `app/lead-roi/report/page.tsx`
**Files:** `app/lead-roi/report/page.tsx`
- **`arive_file_no` → its own `LEAD_COLS`** (second copy — the report reads 0 without it).
- Sub % in the source table, the funnel, and the Per state section.
**Verify:** `npx tsc --noEmit`.

## Task 7 — fixtures + live verification
**Files:** `scripts/lead-roi-check.ts`, `scripts/lead-roi-state-report.ts` (new)
- All fixtures from tasks 1–4.
- New read-only live report: per-source submission % and the state breakdown, straight
  from the DB, so the page's numbers can be checked without a browser.
**Verify:** `npx tsx scripts/lead-roi-check.ts` all pass; `npm run build` clean;
live report matches the spec's 345 / 6.6% baseline.

## Task 8 — ship
- `VERIFICATION-LOG.md` entry, commit, push, `vercel --prod`.
