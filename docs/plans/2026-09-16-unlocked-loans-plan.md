# Plan — "Loans without a rate lock" on the Dashboard

Spec: `docs/specs/2026-09-16-unlocked-loans-spec.md` · **Status: COMPLETE 2026-09-16**

| # | Task | Files | Verification | Done |
|---|------|-------|--------------|------|
| 1 | Extract the lock rule into one chokepoint | `lib/lockStatus.ts` (new) | `npx tsc --noEmit` = 7-error baseline | ✅ |
| 2 | Fixture-lock the rule | `scripts/lock-status-check.ts` (new) | 17/17 pass, offline | ✅ |
| 3 | Add `locked,lock_expiration` to the dashboard's column list | `components/Dashboard.tsx` | card renders live data | ✅ |
| 4 | Render the card | `components/Dashboard.tsx` | bypass-server screenshot | ✅ |
| 5 | Prove the data path past RLS | `scripts/unlocked-loans-report.ts` (new) | 10 rows, matches the rendered card 1:1 | ✅ |
| 6 | Log + document | `VERIFICATION-LOG.md`, `GOTCHAS.md`, `CLAUDE.md` | — | ✅ |

## Design notes (non-obvious)

- **`lib/lockStatus.ts` is the chokepoint by design.** The lock rule previously existed
  twice — correctly in `components/EscrowTracker.tsx` (`lockInfo`, reads the date) and
  incorrectly in `app/reports/escrows/page.tsx` (reads the dead flag). A third private
  copy in the dashboard would have made the drift worse.
- **Ordering encodes urgency, not recency:** expired first (longest-expired leading),
  then never-locked with the deepest stage leading. A Docs Out loan with no lock is a
  bigger problem than a Loan Setup one.
- **`no-expiry` is deliberately NOT counted as unlocked.** `locked = 'Yes'` with no date
  is a data gap. It counts toward "locked" and is surfaced separately in the header, so
  it can never be confused with a loan that has no rate protection. Currently 0 rows.
- **The LO filter gets a visible escape hatch** (`hiddenUnlocked`) rather than being
  bypassed — consistent with the rest of the page, but with no blind spot.

## Deliberately NOT done

`/reports/escrows` (`lockInfo`) and `app/api/cron/lock-alerts` still gate on the dead
`locked` flag. With `locked = 'Yes'` on **0 of 32** active escrows, that means the
Escrow Report's "Locked N/M" KPI reads **0/32** and the lock-expiry alert email fires
for nobody. Both should be moved onto `lib/lockStatus.ts`; that is a separate change
and is out of this spec's scope.
