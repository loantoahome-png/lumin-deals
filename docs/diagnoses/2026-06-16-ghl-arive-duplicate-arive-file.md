# Diagnosis: GHL↔Arive duplicate rows sharing an arive_file_no slip past dedup

**Date:** 2026-06-16
**Reporter:** Efrain (spotted Marian Cooper showing the same loan twice on `/contacts/[id]`)
**Mode:** Fix

## Symptom
Marian Cooper's person page listed two `$280,000` loans that are actually one loan — one
attributed to Matt Park (with a GHL link), one to Moe Sefati (Arive link). Same loan, conflicting
LO, never merged.

## Root cause (grounded — live probe)
- Both rows carry the SAME `arive_file_no = 16057126`:
  - `4b479d31` — the **Arive import** (Moe Sefati, funded 2026-03-30, comp $4,701, subject
    6923 Standish Dr, loan_type Non-QM).
  - `28bdd70e` — the **GHL opportunity** for that same loan (opp `ASaQ…`, in **Moe's** GHL
    sub-account `PKEB…`, no funded_date, mailing addr 6121 41st Ave). The durable join stamped
    arive# 16057126 onto it — which is why its Arive link points to the same Moe file.
- They don't merge because **the only cross-source detector keys on `loan_officer + loan_amount`**,
  and the two LOs differ (`28bdd70e` is wrongly stamped "Matt Park"; every other signal — the
  Arive file, the comp, the GHL location — says Moe). The wrong LO defeats the dedup.
- email/phone/name detectors also miss it: they're **skipped when the rows share a `borrower_id`**
  (treated as "intentional separate loans"). Marian's two rows DO share a borrower_id — so the
  resolver-correct grouping is exactly what hid the duplicate.

## The gap
A **shared `arive_file_no` is a definitional same-loan key** — one Arive file = one loan. Now that
the durable join populates it on GHL rows too, it's the highest-confidence dup signal available,
but **nothing dedups on it.**

## Scope (live)
6 distinct `arive_file_no` values appear on >1 deal row: Marian, Rene Gonzalez, Henry Cardoza,
Jeffrey Kilgrow, Jong Oh (all GHL-row vs Arive-row dup pairs), plus one anomaly — arive `16893761`
on **two different people** (Cynthia $1.22M / Paul Southerby $122k), i.e. a bad arive# fill or
co-borrower, which a human must resolve (NOT auto-merge).

## Fix
Add a `arive_file_no` detector to `/duplicates`. Because shared arive# = same loan, it must bypass
the "separate loans" heuristics (`sharesBorrowerId`, `isLegitMultiLoan`) that legitimately gate the
other detectors. Surface for one-click HUMAN merge/dismiss (never auto-merge — the Southerby
anomaly is exactly why). Bonus: the existing primary-picker scores `funded_date`+`arive_file_no`,
so the Arive row wins primary → merging Marian's pair auto-corrects the LO to Moe.

## Known caveat (not in scope here)
Merge deletes the GHL-opp secondary; its `ghl_opportunity_id` isn't carried, so a future GHL sync
of that opp can re-create the row (the documented "cleanup, not prevention" treadmill). The
detector makes that cleanup high-precision and one-click; true prevention (merge-aware sync) is a
later item.
