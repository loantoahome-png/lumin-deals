# /lead-roi — per-source state breakdown + Submission %

**Date:** 2026-09-21 · **Mode:** Build · **Requested by:** Efrain
**Page:** `app/lead-roi/page.tsx` · **Math:** `lib/leadRoi.ts` · **Report:** `app/lead-roi/report/page.tsx`

## Problem

Two gaps on /lead-roi:

1. **No per-source geography.** The "Per state" card aggregates every source together, so
   it can't answer "is Lendgo worth buying in Pennsylvania?" Sources genuinely differ:
   Lendgo spans 13 states, LMB 14, Lending Tree 14, OwnUp only 3.
2. **No mid-funnel conversion metric.** The lifecycle funnel jumps Responded → Became a
   loan → Funded. With funded rates of 1–3%, funded alone is too sparse a signal to judge
   a vendor on; submission is the earliest point a lead has produced real work.

## Decisions (Efrain, 2026-09-21)

| Question | Decision |
|---|---|
| What counts as a submission | **Submitted to underwriting** — status at/past `Submitted to UW`, **OR** an Arive file number exists |
| Where the state breakdown lives | **Both** — inside the source drill-down AND a standalone Source × State matrix |
| State breakdown columns | **Full money set** — leads, resp %, sub %, funded, fund %, spend, net revenue, net profit, ROI |
| Where Submission % appears | Source table, **lifecycle funnel**, **KPI band**, **printable report + CSV** |

## Definition: `isSubmitted(deal)`

```
isSubmitted(d) = statusRank(d.status) in [rank('Submitted to UW') .. rank('Loan Finalized')]
              || nonEmpty(d.arive_file_no)
```

**Why the Arive-file clause exists.** A deal stores only its CURRENT status. A loan that
reached underwriting and then died regresses into a Not-Ready status, erasing the fact
it was ever submitted. An Arive file number is issued for a real file and is never
rewritten when the lead goes cold.

**Measured live 2026-09-21, 5,222 priced leads — submitted = 345 (6.6%):**

| Clause | Count |
|---|---|
| status rank ≥ `Submitted to UW` | 108 |
| rescued by `arive_file_no` | 237 |

⚠️ **Correction to the estimate this spec was first written with.** An earlier draft
said the Arive clause rescues 64 leads (~23%). That figure was measured against a
different threshold (`App Intake`), not the one chosen. Against `Submitted to UW` the
clause contributes **237 of 345 — 69% of the metric** — and those 237 are two different
populations:

- **162 still in the Leads group** — 151 `App Intake`, plus `Disclosed`, `Pre-Approved`,
  `Arive Lead`, `Qualification`, `Loan Setup`. A file was **opened** in the LOS; whether
  it went to underwriting is not knowable from the status.
- **74 in Not Ready** — the genuine information-loss rescues.
- **1 in Loans in Process.**

**Open question for Efrain:** is an Arive file number issued at **application** or at
**submission to underwriting**? If it is issued at application, the honest label for
this metric is "application taken", not "reached UW". Not resolvable from the DB — it is
a fact about the workflow.

**Mitigation shipped:** `SUBMISSION_RULE` in `lib/leadRoi.ts` selects between three
readings, all fixture-pinned, so switching is one constant and the page, report, CSV and
funnel follow:

| Rule | Meaning | Count |
|---|---|---|
| `file_or_status` (current) | status ≥ UW **or** an Arive file | 345 · 6.6% |
| `status_only` | status ≥ UW only | 108 · 2.1% |
| `dead_file_or_status` | status ≥ UW, or a file on a **dead** deal | 182 · 3.5% |

**Funded implies submitted** — every funded status ranks past `Submitted to UW`, so the
rank clause covers it without a special case. Submission % is therefore always ≥ fund %.

## Scope

### 1. `lib/leadRoi.ts`

- `isSubmitted(d)` — the predicate above; the single chokepoint, never inlined.
- `SourceStats` gains `submitted: number; sr: number` (sr = 100 × submitted ÷ total).
- `RoiKpis` gains `submitted; sr`.
- `funnel()` gains a **Submitted** stage between *Responded* and *Became a loan*.
- **New `stateStats(deals, retainer)`** → per-state rows carrying the full money set.
  Retainer is allocated across a source's states **pro-rata by lead count** so per-state
  spend sums exactly to the source's spend. Disclosed in the UI footnote; today every
  `lead_source_costs` row is empty, so this is dormant but must not silently corrupt
  reconciliation if a retainer is ever set.
- **New `sourceStateMatrix(sources, metric)`** → rows × state columns for the matrix view.
- Existing `stateRows()` stays (the current Per state card + report use it) and gains
  `submitted`/`sr` for consistency.

### 2. `app/lead-roi/page.tsx`

- **`arive_file_no` MUST be added to `LEAD_COLS`.** The predicate is inert without the
  column fetched — the exact trap that bit `loan_type` on 2026-07-28.
- Source table: new **Sub %** column between *Resp %* and *Open*.
- Drill-down: a per-source **states table** (full money set) above `SourceDealsList`.
- New standalone **Source × State matrix** section with a metric picker.
- KPI band: a **Submission** card.
- CSV: `Submitted` + `Sub %` columns.

### 3. `app/lead-roi/report/page.tsx`

- Same `LEAD_COLS` addition (**both copies or the report silently reads 0**).
- Sub % in the source table, the funnel, and the Per state section.

### 4. `scripts/lead-roi-check.ts`

New fixtures: rank boundary at `Submitted to UW`; a dead-status deal WITH an Arive file
counts; a dead-status deal WITHOUT one does not; funded implies submitted; per-state
money reconciles to the source totals; retainer pro-rata allocation sums exactly.

## Acceptance criteria

1. `isSubmitted` returns true for status ≥ `Submitted to UW`, for any funded status, and
   for any deal with a non-empty `arive_file_no` regardless of status.
2. Submission % ≥ Fund % for every source, every filter combination.
3. Per-state spend / net revenue / net profit for a source sum to that source's row.
4. Matrix cell totals reconcile to the source table's column for the same metric.
5. `arive_file_no` present in `LEAD_COLS` in **both** page.tsx and report/page.tsx.
6. `npx tsc --noEmit` clean, `npm run build` clean, `scripts/lead-roi-check.ts` all pass.

## Out of scope

- Per-state retainer *configuration* (retainers stay a per-source setting).
- Stage-event-derived submission timing (`stage_events` is forward-only from ~Jul 2026;
  coverage would be too thin to report a submission date).
- Any change to the ROI / net-revenue / spend definitions.
