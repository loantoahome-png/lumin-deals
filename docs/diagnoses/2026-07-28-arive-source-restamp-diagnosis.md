# Diagnosis — the 15-min sync re-stamps "Arive" over real lead sources

**Date:** 2026-07-28
**Reported by:** Efrain — "I just imported arive export… one of the loans in my dashboard has a source of Arive and it should be FRU, why did this not update when I pressed overwrite?"
**Subject:** Garry Swatzel, Arive #17063141, Randy Mathis, funded 2026-07-27.

## Symptom

The Arive CSV says the lead source is FRU. An **overwrite** import ran. The deal page's
Source dropdown still read **"Arive"**.

## What was actually true

The import worked. It wrote FRU — to a different column than the dropdown reads. And the
"Arive" was not a stale leftover: the sync was actively rewriting it every 15 minutes.

Live row at time of diagnosis:

| column | value |
|---|---|
| `lead_source_agg` | `FRU` ← the import landed here |
| `source` | `Arive` ← what the dropdown renders |
| `raw_ghl_data.source` | `FRU` ← the right answer was on the opportunity the whole time |

## Three independent causes, stacked

### 1. The importer never writes `deals.source` on an existing deal — by design

`lib/ariveCsv.ts:254` maps the CSV's "Lead Source" column to **`lead_source_agg`**. Only
`buildNewDealFromPatch` (`:538`) copies it into `source`, and only when the row creates a
brand-new deal. On an update, `source` is never in the patch — so no import mode, including
overwrite, can move it. Meanwhile the deal page's dropdown binds to `source`
(`app/deals/[id]/page.tsx:799`). Two columns, one label, silently disagreeing.

### 2. The sync's `cleanSource` was a shadowing copy that never filtered "Arive"

The 2026-07-08 source-drift fix added `cleanSource()` to `lib/utils.ts`, rejecting
`"Arive"` and `"unknown"`, and wired the **webhook** to it. It was recorded at the time
that the sync was "already guarded". It was not.

`app/api/sync/ghl/route.ts:250` declared its **own** function, also named `cleanSource`,
that rejected only `loan-audit-reconciliation:*` junk — **"Arive" passed straight through**.
Because the call site read `cleanSource(...)` either way, the missing guard was invisible at
the point of use and survived a review that was explicitly looking for it.

`source` is in the sync's update field list (`:986`), so this ran on **every pass**, not just
at deal creation. Any manual correction or backfill reverted within 15 minutes.

**Blast radius:** the July 8 backfill took the bucket 17 → 1. By 2026-07-28 it had regrown to
**200** (Moe 100, Matt 81, Randy 18; 45 funded). One more row appeared *during* this
investigation — the re-stamping was live.

### 3. The candidate chain coalesced before cleaning

```ts
cleanSource(CF ?? contact.source ?? opp.source ?? embedded.source)
```

`??` picks the first **non-null** candidate, and only the winner gets cleaned. Arive stamps
its own name into GHL's contact-level `source` on sync-back, so "Arive" won the coalesce and
was then nulled — while the real vendor sat unused one position down the chain. That is
exactly Garry: contact `"Arive"` beat opportunity `"FRU"`, and the sync wrote nothing.

This shape means the bug is *self-concealing*: with `maybeSet` skipping nulls, a deal whose
only real source is on the opportunity keeps its stale value forever and never errors.

## Fix

- **One canonical `cleanSource`** in `lib/utils.ts` — now also absorbs the junk-value filter
  the sync copy owned, so there is no reason for a route to declare its own again. Comment
  says so explicitly.
- **New `resolveLeadSource(...candidates)`** — cleans each candidate *individually* and
  returns the first real one, so a rejected-but-present value falls through instead of
  shadowing a good one. Used by the sync and by the webhook's insert path, which had the
  same `||`-then-clean shape.
- **`scripts/lead-source-check.ts`** — 21 fixtures locking both properties, including the
  exact Garry case (`resolveLeadSource(null, 'Arive', 'FRU') === 'FRU'`).
- **`scripts/arive-source-backfill.ts`** — one-time repair, dry-run by default, backs up the
  before-state. Recovery order: opportunity source → `lead_source_agg` → null.

## What the backfill could and could not recover

130 of 200 recovered; **70 nulled** as genuinely unknown. Only 13 deals had a real source on
the opportunity — for the other 187 the LOS name had already overwritten the contact-level
value in GHL itself, so `lead_source_agg` (from the Arive CSV) was the only surviving witness.

Vendor misattribution was small — just **LMB ×3 and FRU ×1** were purchased leads. The bulk
were organic categories (Return Client ×45, Referral - Business Contact ×20, …) that had been
sitting in a phantom "Arive" bucket.

## Follow-ups not done here

- **70 deals now have no source.** Recoverable only from GHL contact history or Arive.
- **`lead_source_agg` vs `source` remain two columns behind one "Source" label.** The import
  updates one and the deal page shows the other; nothing reconciles them or flags a conflict.
  This is what made the bug read as "the overwrite didn't work".
- The sync reads contacts via the LIST endpoint, which omits custom fields, so on **create**
  it still cannot see the "Lead Source" CF and falls back to `Self Source`.
