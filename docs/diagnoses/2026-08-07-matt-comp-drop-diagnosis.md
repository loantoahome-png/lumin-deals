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

✅ **ANSWERED by Efrain, same day: it is a SPLIT PAYMENT.** "They are getting paid
$6,000 today and the other $1,500 later." So the loan earned the full **$7,500**;
Arive's `Compensation Amount` reports the check that *settled*, not the total
earned — which is why the drop landed exactly as the stage hit *Loan Finalized*.
The dashboard is temporarily $1,500 light on this loan.

**Efrain also confirmed the mechanism: Arive catches up.** When the rest posts, its
Compensation Amount rises to $7,500 and the next import writes it. **That is why no
"pending comp" field was built** — a manually tracked $1,500 would double-count the
moment Arive updated, reporting $9,000 on a $7,500 loan. The correct handling is to
wait for the next import.

(The original correlation was recorded here as suggestive-but-unconfirmed rather
than asserted as cause — per [[dont-invent-meaning-on-real-data]], the money fact
comes from the person receiving the checks. It did, and it was right.)

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

## Was this a pattern? — the whole archive, swept

Peak-vs-current compensation across all 22 archived exports (6/22 → 8/07), against
the live book: **15 of 88 funded loans sit below their peak.** Two clean populations:

- **Settlement noise — 8 loans, $3–$200.** All at *Broker Check Received → Loan
  Finalized*, comp settling 2.500% → ~2.40%. The check landed a hair under the
  estimate. ~$960 total across all three LOs. Nothing to do.
- **Large drops — 6 loans.** Two are already handled correctly and are NOT
  shortfalls: **Lory Ruiz** (−$4,291) and **Fabian Burrage** (−$2,344) were
  re-splits into points, and the Non-Del credit adds that money back — Ruiz now
  totals $9,000.84, above her old peak ([[non-del-total-comp]]). Of the remaining
  four, **Efrain confirmed only Mutschler is a split payment**; Cynthia Southerby
  (Moe, −$4,606), Marian Cooper (Matt, −$1,507) and Judith Colin (Matt, −$1,047)
  are **genuine reductions and the lower figure is correct**.

⚠️ **A gap is NOT a receivable.** Comp legitimately drops. "Below its historical
peak" is a detection signal for review, never a number to report as revenue.

## Action

**No change to the revenue math, by decision.** Arive is authoritative and catches
up on its own; the dashboard tracks no pending comp. Mutschler self-heals on the
first import after the second check posts, and the other 14 are correct today.

**Built instead (2026-08-07):**
- **Revenue impact panel** on the import preview — net revenue delta **per loan
  officer**, all-sources and agg-leads side by side, with a per-loan breakdown.
  `lib/importRevenue.ts`, 52 fixtures. This is what would have answered the
  original question in one glance instead of a CSV diff.
- **`scripts/comp-drift-report.ts`** — the sweep above, on demand. Bare gives the
  review list; with an Arive id it prints that loan's full export-by-export
  timeline (Mutschler: $7,500 flat from 7/17 through 8/06, then $6,000 exactly as
  the stage hit *Loan Finalized*). ⚠️ Deliberately not named `*-check.ts`: the
  fixture runner globs that pattern and this needs `.env.local` plus the local
  export archive.
- **`re-priced ↓` flag** in the panel on any funded loan losing compensation,
  tooltipped with the split-payment explanation and the drill-down command.

See also [[non-del-total-comp]], [[loan-amount-provenance]],
[[arive-import-funded-guard]], [[lead-roi]].
