# Spec — "Loans without a rate lock" on the Dashboard

**Date:** 2026-09-16 · **Mode:** Build (small) · **Requested:** "create something on the
dashboard that shows all loans that are not locked"

## The problem

Nothing on `/` surfaces a loan that is sitting in escrow with no rate protection.
The only lock displays are the escrow card (`components/EscrowTracker.tsx`) and
`/reports/escrows`, and neither answers "which files still need a lock?" at a glance.

## Measured state (live, service-role, 2026-09-16)

| | |
|---|---|
| Active escrows (`pipeline_group = 'Loans in Process'`) | 32 |
| … with an Arive `lock_expiration` | 25 |
| … with **no** lock expiry at all | **7** |
| … whose lock has **expired** | **3** (Sep 11, Sep 12, Aug 29) |
| … with `locked = 'Yes'` | **0** |
| Funded rows with a `lock_expiration` | **0 of 136** |

Two facts drive the whole design:

1. **`locked` is dead.** Zero of 32 active escrows carry the flag, while 25 carry a
   real Arive expiry. Gating on the flag (what `/reports/escrows` and
   `app/api/cron/lock-alerts` still do) would report **32 of 32 unlocked** — noise,
   not a worklist. `lock_expiration` is the authority.
2. **Funded loans must be excluded.** The DB trigger `clear_lock_expiration_on_funded`
   nulls `lock_expiration` before any write lands on a funded status, so all 136
   funded rows read "no lock". Including them would bury the 10 real ones.

## Scope

- **In:** `pipeline_group = 'Loans in Process'` only, respecting the dashboard's
  existing LO filter.
- **Out:** Leads (a lead has nothing to lock), Not Ready, Old Deals, Funded.

## What "not locked" means here

A loan has no live rate protection when **either**:

- **Never locked** — `lock_expiration` is null. (If `locked = 'Yes'` with no date it
  is shown separately as "locked, no expiry" — a data gap, not an unlocked loan.)
- **Expired** — `lock_expiration` is in the past (local midnight).

Both are listed, expired first, because an expired lock is the more urgent of the two.

## Acceptance criteria

1. `/` shows a card listing every active escrow with no live lock, expired before
   never-locked, and within each group by stage depth (closest to funding first).
2. The card header states the split (`N expired` / `N never locked`) and the count
   locked out of the total.
3. The card respects the LO checkboxes like every other dashboard metric — BUT,
   because the filter defaults to Matt + Moe and this is a risk list, it also
   counts what the filter is hiding ("+ N more under loan officers not selected
   above"). A risk card must never have a silent blind spot. Today that footer
   would read "+ 7 more" on the default view: 7 of the 10 unlocked loans belong
   to Randy and Daniel.
4. The card always renders. When every active escrow is locked it shows a green
   confirmation — an absent card would be ambiguous (broken? or nothing to show?).
5. Each row links to its deal page, shows stage, LO and loan amount.
6. The rule lives in ONE place (`lib/lockStatus.ts`) and is fixture-locked.
7. `lock_expiration` is parsed as LOCAL midnight — never `new Date(str)`.

## Out of scope (flagged, not done)

`/reports/escrows` `lockInfo` and `app/api/cron/lock-alerts` still gate on the dead
`locked` flag and therefore under-report locks / under-fire alerts. Fixing them is a
separate change — this spec does not touch them.
