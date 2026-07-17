# Diagnosis — Arive import: "why does it still show 166 overwrites right after I imported?"

**Date:** 2026-07-17
**Reporter:** Efrain — re-imported an already-applied Arive CSV as a no-op check; preview showed 166 overwrites
(103 `status`, 58 `loan_amount`, + 5 one-offs) despite `WILL FILL BLANKS` now correctly reading 0.
**Verdict:** **NOT A BUG. Working as designed.** The 166 are real Arive-vs-dashboard differences on fields where
**GHL — not Arive — is the authority**. Applying them is futile: the 15-min sync reverts them. They will
regenerate on every preview, forever.

## What was measured (live DB + live GHL API, CSV = `DB Import - 2026-07-17T00_40_23.809Z.csv`)

351 rows, 351 matched, 0 unmatched. After the `lock_expiration` fix: **fills 0**, **overwrites 166**.

### 1. `status` — 103 diffs. GHL owns it, unconditionally.

`app/api/sync/ghl/route.ts:954` builds the update patch with `status: dealData.status` — **not** behind
`maybeSet`, so it is written on **every sync pass**, every 15 min (comment: *"Sync status/pipeline always"*).
The dashboard's status IS the GHL pipeline stage, by design.

**Verified against the GHL API** (resolved `pipelineStageId` → stage name via `/opportunities/pipelines`):

| borrower | dashboard | GHL live stage | Arive CSV says |
|---|---|---|---|
| Pwint Thet Zaw | App Intake | **App Intake** ✅ | Pre-Approved |
| Nestor Santiago | Approved w/ Conditions | **Approved w/ Conditions** ✅ | Non-Responsive |
| Karanveer Mann | Disclosed | **Disclosed** ✅ | Non-Responsive |
| Antonio Aramburu | Pre-Approved | **Pre-Approved** ✅ | App Intake |

**dashboard mirrors GHL live stage: 4/4, differs: 0.** The dashboard is correct; the CSV disagrees because
**Arive's status is a different concept** — its own LOS/lead disposition, not the GHL sales pipeline stage. They
are not the same field with drifted values; they are two different fields that happen to share a name.

⚠️ **Overwriting `status` from Arive is actively harmful, briefly:** it would set Nestor Santiago
(*Approved w/ Conditions* — a live, approved loan) to **Non-Responsive**, stranding it in the "Not Ready" tab
until the next sync repairs it. This is exactly why `status` sits in the UI's `PROTECTABLE` list.

**Safety check — nothing is being lost:** rows where Arive says FUNDED but the dashboard does not = **0**.
No funded loan is hidden by this.

### 2. `loan_amount` — 58 diffs. GHL owns it *while in process*.

Distribution of the 58: **0 on funded deals, 58/58 on in-process deals** — exactly the population the sync writes.

`app/api/sync/ghl/route.ts:967-991`, Efrain's rule of 2026-06-25:
> *"the dashboard AMOUNT shows the GHL OPPORTUNITY value (monetaryValue) for every IN-PROCESS loan — Arive-backed
> or not. Arive is authoritative ONLY for FUNDED loans … the guard is funded-only: an `arive_file_no` no longer
> locks `loan_amount` while the loan is still in process."*

`fundedOwnsAmount = existingIsFunded`, and for everything else `patch.loan_amount = dealData.loan_amount ?? null`
— written **even when the opp value is 0/empty**, deliberately, so stale figures get cleared. Hence
`Kerry Anderson: dashboard=0 → arive=600000`: GHL's opportunity value is 0, so the dashboard shows $0 and the
sync re-asserts 0 every pass. Arive's 600000 cannot stick while the loan is in process.

### 3. The 5 one-offs — same story, one deal

`credit_score`, `ltv`, `estimated_value`, `city`, `zip` (all on David Mutschler) are all in the sync's `maybeSet`
list, so GHL re-asserts them whenever GHL has a value.

## Why the counts looked "impossible"

At import time the preview showed `WILL OVERWRITE 0` (nothing shielded — `protectedFields` defaults to empty),
so the overwrite genuinely applied. The sync then reverted these fields within 15 minutes, and the next preview
re-reported them. Not drift *in* the data — a **tug-of-war between two systems with different authorities**.

Note: `stage_changed_at > CSV export time` for **103/103** status rows is NOT evidence of a GHL-side change — the
import's own write updates it too. That check cannot discriminate; only the live GHL stage comparison can.

## Recommendation

**No code change required.** The importer is telling the truth. Options:

1. **Use "Fill blanks only" (already the recommended mode)** — a re-import is now a genuine no-op (verified:
   fills 0 / overwrites 0 in that mode).
2. **Shield `status` (and optionally `loan_amount`) via the existing "Protect from overwrite" chips** if using
   overwrite mode. The UI already shows the counts (`Status / stage 103`).
3. **Optional enhancement (NOT built — needs Efrain's call):** teach the planner that GHL owns `status` always,
   and `loan_amount` while in-process, the same way it now knows the DB owns `lock_expiration` on funded deals —
   i.e. don't propose writes another system will revert. Trade-off: it would also *hide* a genuine
   Arive-vs-GHL disagreement Efrain might want to see. The current UI surfaces the diff and lets him choose,
   which is arguably the better default.

## Corrected memory

`memories/projects/lumin-deals/loan-amount-provenance.md` said GHL "never writes loan_amount on
`arive_file_no`/funded deals (fixed 2026-06-22)". **That is stale** — the 2026-06-25 rule narrowed the guard to
**funded-only**. An `arive_file_no` does NOT protect `loan_amount` on an in-process loan. Memory updated.
