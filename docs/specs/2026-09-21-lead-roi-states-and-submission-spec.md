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
| What counts as a submission | **Submitted to underwriting** — status at/past `Submitted to UW`. ⚠️ The *OR an Arive file* half was removed 2026-09-21: the file number is issued at application (see the correction below) |
| Where the state breakdown lives | **Both** — inside the source drill-down AND a standalone Source × State matrix |
| State breakdown columns | **Full money set** — leads, resp %, sub %, funded, fund %, spend, net revenue, net profit, ROI |
| Where Submission % appears | Source table, **lifecycle funnel**, **KPI band**, **printable report + CSV** |

## Definition: `isSubmitted(deal)`

```
isSubmitted(d) = statusRank(d.status) in [rank('Submitted to UW') .. rank('Loan Finalized')]
```

**Status rank only. It deliberately does NOT read `arive_file_no`.**

### Correction — the first cut of this was wrong

The spec originally defined submission as *status ≥ `Submitted to UW` **OR** an Arive
file number exists*, on the theory that a file number proved the loan had gone to
underwriting and so rescued loans that were submitted and then died (a deal stores only
its CURRENT status, so a dead loan regresses into a Not-Ready stage and erases its
history).

**Efrain, 2026-09-21: the Arive file number is created at APPLICATION, not at submission
to underwriting.** That invalidates the theory. A file number proves an application was
taken and nothing more.

Impact of the wrong definition, measured across 5,222 priced leads:

| | Count | % |
|---|---|---|
| status ≥ `Submitted to UW` (correct) | 108 | 2.1% |
| …with the file clause (wrong) | 345 | 6.6% |

The clause added 237 leads, **162 of which were still in the Leads group — 151 at
`App Intake`.** Those are open applications, not loans in underwriting.

It also retired a third reading (`status ≥ UW, or a file on a dead deal`). Its premise
was that a file implies submission; once the file means application, a dead deal holding
one only proves the borrower applied before going cold, so it mixed two milestones under
one label. Removed rather than left in the enum for someone to pick.

### What the correct metric looks like

Sub % now sits very close to Fund %, because most loans that reach underwriting go on to
fund:

| LO · source | Sub % | Fund % |
|---|---|---|
| Moe · Lendgo | 1.3% | 1.1% |
| Moe · LMB | 2.6% | 2.1% |
| Moe · OwnUp | 4.4% | 3.1% |
| Matt · LeadPoint | 1.8% | 1.8% |

⚠️ **The UW rate is a floor, not a true rate.** A loan submitted and then declined reads
as Not-Ready, and nothing in the schema recovers that. The UI tooltip says so.

### The application milestone is kept, unused

`SubmissionRule` retains an `'application'` branch (adds the file clause — 345 · 6.6%),
fixture-pinned and ready for an **App %** column. It has far more spread across vendors
than the UW rate (OwnUp 13.1% / LMB 7.0% / Lendgo 3.3%, where UW is 4.4 / 2.6 / 1.3%),
so it is the better vendor-comparison signal — it is just not "submitted".
`SUBMISSION_RULE = 'status_only'` is what ships; `SUBMISSION_DESC` derives the UI copy
from it so a label cannot drift from the arithmetic.

**Funded implies submitted** — every funded status ranks past `Submitted to UW`, so the
rank clause covers it without a special case. Submission % is always ≥ fund %.

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
