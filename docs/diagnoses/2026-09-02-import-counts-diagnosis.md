# 2026-09-02 Arive import — are "Will fill blanks 132 / Will overwrite 444" exaggerated?

**Import:** `DB Import - 2026-09-02T20_45_40.818Z.csv` (577 rows, 576 matched, 1 unmatched: Byron Elberts #17192504).
Committed ~20:48–20:50Z (309 Arive-linked deals updated).

## Verified findings

1. **The tiles count FIELDS, not rows.** `app/import/arive/page.tsx` (`recountedSummary`) increments once per
   `FieldChange`. 444 overwrites + 132 fills = 576 field writes across 309 deals (~1.9 fields/deal).
2. **No format noise.** Re-running the preview logic against the live DB after the commit — and again after the
   21:00Z GHL sync touched 244 Arive-linked deals — yields 0 fills / 0 overwrites. `sameFieldValue` round-trips cleanly.
3. **Arive's own day-over-day change is small.** 09-01 CSV → 09-02 CSV: 116 field changes across 31 loans
   (broker_corr 16, status 11, net_discount_points 10, loan_amount/ltv/payments 7 each). Even a month back
   (07-31 export vs today's DB) Arive's cumulative change is only ~160 fields / ~40 loans.
4. **10 loans were new to Arive since yesterday** but already existed as GHL-created deals (matched on
   arive_file_no). They carry 274 mapped non-blank fields between them — the bulk of the 132 fills, plus overwrites
   where the GHL sync had already populated a field from the opportunity (e.g. loan_amount = opp value).
5. **Remainder (~250–300 overwrites) was the DB restoring to Arive values that Arive did not change** — i.e. values
   written by other paths (GHL sync overlay / webhook / manual edits) between imports. Cannot be attributed field by
   field: `deals` keeps no history and the plan CSV was not downloaded before committing.

## Verdict — CORRECTED same day (second export, 22:10Z)
Efrain re-exported at 22:10Z (only 4 loans changed in Arive since 20:45) and the preview showed **334 overwrites
again: status 198, loan_amount 119**. Re-running the preview logic against the DB: every one of the 198 status
flips sits on a deal the DB rewrote at **21:30Z** (`ghl_maintenance_last` = the sync pass that rescans every
opportunity; 147 deals, 143 Arive-linked, 135 in `Not Ready`). Transitions are GHL stage → Arive stage
(`Not Ready - Timeframe → Non-Responsive/App Intake` 82, `Remove from All Automations → App Intake` 19,
`Disclosed → Non-Responsive` 21 …) and GHL opp value → Arive amount (`0 → 25000` …).

**So the ping-pong IS real** — my 21:00Z test missed it because that pass was *incremental* (it only touched
deals whose GHL opportunity had changed); the 21:30Z maintenance scan touches everything. By design
(`app/api/sync/ghl/route.ts` update path) the sync writes `status`/`pipeline_group` on EVERY touched deal and
`loan_amount` = the GHL opportunity value on every NON-FUNDED deal (see the loan-amount-provenance rule). An
overwrite-mode Arive import pushes Arive's status/amount onto ~300 in-process/lead deals; the next full sync
pass writes GHL's values back. Those ~300 "overwrites" will show on every overwrite preview and never stick.
The earlier 444 was the same thing plus the 10 new loans.

**Fix to propose:** the importer should not write `status` or `loan_amount` to non-funded deals at all (GHL owns
them in-process; Arive owns them only once funded) — surface them as "GHL-owned, skipped" instead of overwrite.
That drops this preview from 334 to ~13 real Arive changes.

## Next time
Click **Download plan CSV** before committing — it is the only per-field record of what an import changed.
