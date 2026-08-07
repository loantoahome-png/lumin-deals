# Matt's Lead ROI revenue dropped after the 2026-08-07 Arive import

**Date:** 2026-08-07
**Reported:** "I imported Arive and Matt's comp dropped"
**Verdict: NOT a dashboard bug.** Arive's own export changed one loan's compensation.
The importer read it correctly.

## The number

Lead ROI · Matt Park · All time · **Agg leads**:

| | Before the import | After | Delta |
|---|---|---|---|
| Revenue | **$90,015.53** | **$88,515.53** | **−$1,500.00** |
| ROI | 2.82× | 2.77× | −0.05× |
| Funded | 16 | 16 | 0 |
| Spend | $31,938 | $31,938 | 0 |

Verified by service-role query of `deals` + `lib/comp.totalComp` over Matt's 16
funded agg-lead deals; the recomputed "now" figure reproduces the $88,516 on screen
exactly, and reverting the single changed field reproduces $90,015.53.

## Root cause — one loan, one field

**David Mutschler · Arive 17248386 · Lending Tree · funded 2026-07-29 · $300,000**

Straight from the raw Arive exports in `~/Downloads` (columns
`Primary Borrower, ARIVE Loan Id, Lead Source, Interest Rate, Total Loan Amount,
Compensation Amount, Channel, Net Discount Points, ...`):

| Export | Compensation Amount | Net Discount Points | Stage |
|---|---|---|---|
| 2026-07-31 | 7500 | — | — |
| 2026-08-03 | 7500 | 2.5 | — |
| 2026-08-04 | 7500 | 2.5 | — |
| 2026-08-06 | 7500 | 2.99 | Broker Check Received |
| **2026-08-07** | **6000** | **2.49** | **Loan Finalized** |

Comp went 2.50% → 2.00% of the loan amount (−0.50), and net discount points fell by
the same 0.50, in the same export where the stage advanced **Broker Check Received →
Loan Finalized**. He is **Broker** channel, so the points are not in the dashboard's
math ([[non-del-total-comp]] gates the Final Price credit to Non-Del) — the entire
−$1,500 is the `Compensation Amount` field itself.

⚠️ **The business reason lives in Arive / the broker check, not in this repo.** The
stage-advance correlation is suggestive but unconfirmed — do not assert a cause
without asking Matt or checking the lender's settlement. Per
[[dont-invent-meaning-on-real-data]], the money fact comes from the person who
received the check.

## Everything else the import did (full audit)

Diffed the 2026-08-06 and 2026-08-07 exports keyed on `ARIVE Loan Id` across
`Compensation Amount / Channel / Net Discount Points / Total Loan Amount /
Loan Funded / Primary Loan Officer Name / Lead Source / Stage Name`.
**403 rows, 8 changed, 2 new, 0 removed:**

| Loan | LO | Change |
|---|---|---|
| 17248386 David Mutschler | Matt | comp 7500 → **6000**, pts 2.99 → 2.49, Broker Check Received → Loan Finalized |
| 17175441 Cheyne Inman | Matt | **Loan Funded ← 2026-07-31**, Docs Signed → Loan Funded |
| 17017052 Marian Cooper | Matt | comp 2482 → **2615**, Loan Funded → Loan Finalized |
| 17128993 Barbara Sauber | Matt | stage Clear To Close → Docs Out |
| 17374513 W. F. Raleigh | Randy | comp 5700 → 6500, pts 2.5 → 0 |
| 17316832 Michael Nouguier | Randy | pts 1.25 → 1.395 |
| 17270213 Wendy Muir | Moe | amount 68349 → 68349.12 |
| 17354141 Michael T Rugley | Moe | stage Loan Setup → Submitted to UW |
| 17398098 Loretta Powell | Randy | NEW (App Intake) |
| 17396577 Beverly Williams | Matt | NEW (App Intake) |

No funded deal left the Funded group, no `source` moved, no LO reassignment, no
`Channel` flipped. The 617 rows the import wrote were overwhelmingly `broker_corr` /
`net_discount_points` backfills onto old non-funded loans (money-neutral — revenue is
gated on funded).

## Why it reads as a drop only on the Agg-leads tab

The import was a **net gain** for Matt overall — Cheyne Inman funded that day
(+$6,746.28) and Marian Cooper gained +$133.

| Matt, all time | Before | After | Delta |
|---|---|---|---|
| **Agg leads** (the screenshot) | $90,015.53 | $88,515.53 | **−$1,500** |
| **All sources** | $214,352.81 (27 funded) | $219,732.09 (28 funded) | **+$5,379.28** |

Inman's source is **"Others"** and Cooper's is **"Referral - Business Contact"** —
neither is one of `PURCHASED_SOURCES` (FRU, Lendgo, LMB, Lending Tree, LeadPoint,
OwnUp), so the two gains land outside the Agg-leads scope while Mutschler's loss
(Lending Tree) lands inside it. Flip the scope toggle to **All sources** and the same
import reads as +$5.4k.

## Action

**No code change.** If the $6,000 is wrong, the fix is in Arive → re-export → re-import;
the dashboard will track it. If it's right, Matt's Lending Tree ROI genuinely moved
2.82× → 2.77×.

**Optional, deferred:** an import summary that reports net revenue delta per LO
("this import moved Matt −$1,500 on 1 funded loan") would have answered this in one
glance instead of a CSV diff. Not built — logging as an idea, not a plan.

See also [[non-del-total-comp]], [[loan-amount-provenance]],
[[arive-import-funded-guard]], [[lead-roi]].
