// ── Rate-lock status: the one place that decides whether a loan is locked ────
//
// `lock_expiration` is the AUTHORITY. It is imported from the Arive CSV
// (`{ ariveCols: ['Lock Expiration'] }` in lib/ariveCsv.ts) and stays current on
// its own.
//
// The `locked` Yes/No column is NOT. It has no importer anywhere — its only
// writers are the hand-edited select on the deal page and DealForm's 'No' seed —
// so nobody maintains it. Measured 2026-09-16: of the 32 active escrows, 25 carry
// a real Arive lock expiry and **zero** carry `locked = 'Yes'`. Gating on the flag
// (what /reports/escrows and app/api/cron/lock-alerts still do) reports every
// escrow as unlocked. The flag is read here only as a weak secondary signal for
// the "someone hand-flagged it but set no date" case.
//
// ⚠️ `lock_expiration` is a DATE-ONLY column. `new Date('2026-09-16')` is UTC
// midnight, which renders a day early in Pacific — parse the parts as LOCAL
// midnight, the same way lib/utils formatDate and EscrowTracker do.

import type { Deal } from './types'

const MS_PER_DAY = 86_400_000

/** The pipeline this rule applies to. A lead has nothing to lock; a funded loan
 *  has its `lock_expiration` nulled by the `clear_lock_expiration_on_funded` DB
 *  trigger, so all 136 funded rows read "no lock" and must never be listed. */
export const ESCROW_PIPELINE = 'Loans in Process'

export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s)
}

/** Whole days from today (local midnight) to the expiry (local midnight).
 *  Negative = already expired. null = no date, or unparseable. */
export function lockDaysLeft(iso: string | null | undefined, today = new Date()): number | null {
  if (!iso) return null
  const exp = parseLocalDate(iso)
  if (isNaN(exp.getTime())) return null
  const a = new Date(exp); a.setHours(0, 0, 0, 0)
  const b = new Date(today); b.setHours(0, 0, 0, 0)
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY)
}

export type LockState =
  | 'locked'        // live lock, more than 7 days out
  | 'expiring'      // live lock, expires within 7 days (today included)
  | 'expired'       // had a lock, the date has passed — NO live protection
  | 'no-expiry'     // hand-flagged locked but no date — a data gap, not unlocked
  | 'unlocked'      // no lock expiration at all

export type LockStatus = {
  state: LockState
  /** True when the loan has NO live rate protection right now. */
  needsLock: boolean
  /** Days to expiry; negative when expired, null when there is no date. */
  days: number | null
  expiration: string | null
  label: string
}

/** The minimum a deal must carry for this rule — keeps the report scripts and
 *  fixtures from having to build a whole Deal. */
export type LockCarrier = Pick<Deal, 'locked' | 'lock_expiration'>

export function lockStatus(deal: LockCarrier, today = new Date()): LockStatus {
  const flagged = (deal.locked || '').trim().toLowerCase() === 'yes'
  const exp = deal.lock_expiration || null

  if (!exp) {
    return flagged
      ? { state: 'no-expiry', needsLock: false, days: null, expiration: null, label: 'Locked · no expiry set' }
      : { state: 'unlocked', needsLock: true, days: null, expiration: null, label: 'Not locked' }
  }

  const d = lockDaysLeft(exp, today)
  // An unparseable date still means somebody recorded a lock — don't call it unlocked.
  if (d == null) return { state: 'locked', needsLock: false, days: null, expiration: exp, label: 'Locked' }
  if (d < 0)  return { state: 'expired',  needsLock: true,  days: d, expiration: exp, label: `Lock expired ${-d}d ago` }
  if (d === 0) return { state: 'expiring', needsLock: false, days: d, expiration: exp, label: 'Lock expires today' }
  if (d <= 7) return { state: 'expiring', needsLock: false, days: d, expiration: exp, label: `${d}d left on lock` }
  return { state: 'locked', needsLock: false, days: d, expiration: exp, label: `${d}d left on lock` }
}

/** Escrows with no live rate protection, most urgent first: expired (longest
 *  expired first), then never-locked, and within each group the loan closest to
 *  funding leads — that's the one where a missing lock costs the most. */
export function unlockedEscrows<T extends LockCarrier & Pick<Deal, 'status' | 'pipeline_group' | 'name'>>(
  deals: T[],
  stageDepth: (status: string | null) => number,
  today = new Date(),
): Array<T & { lock: LockStatus }> {
  return deals
    .filter(d => d.pipeline_group === ESCROW_PIPELINE)
    .map(d => ({ ...d, lock: lockStatus(d, today) }))
    .filter(d => d.lock.needsLock)
    .sort((a, b) => {
      // Expired outranks never-locked.
      const rank = (s: LockState) => (s === 'expired' ? 0 : 1)
      if (rank(a.lock.state) !== rank(b.lock.state)) return rank(a.lock.state) - rank(b.lock.state)
      // Within expired: longest expired first (most negative days).
      if (a.lock.state === 'expired' && b.lock.state === 'expired') {
        return (a.lock.days ?? 0) - (b.lock.days ?? 0)
      }
      // Within never-locked: deepest stage (closest to funding) first.
      const sd = stageDepth(b.status) - stageDepth(a.status)
      if (sd !== 0) return sd
      return (a.name || '').localeCompare(b.name || '')
    })
}

/** The flip side of `unlockedEscrows`: active escrows that DO have rate protection,
 *  soonest expiry first so the next lock to fall off the end leads. A lock with no
 *  expiry date (hand-flagged `locked = 'Yes'`) sorts last — there is no date to act on. */
export function lockedEscrows<T extends LockCarrier & Pick<Deal, 'status' | 'pipeline_group' | 'name'>>(
  deals: T[],
  today = new Date(),
): Array<T & { lock: LockStatus }> {
  return deals
    .filter(d => d.pipeline_group === ESCROW_PIPELINE)
    .map(d => ({ ...d, lock: lockStatus(d, today) }))
    .filter(d => !d.lock.needsLock && d.lock.state !== 'unlocked')
    .sort((a, b) => {
      const ad = a.lock.expiration ? a.lock.days ?? 0 : Infinity
      const bd = b.lock.expiration ? b.lock.days ?? 0 : Infinity
      if (ad !== bd) return ad - bd
      return (a.name || '').localeCompare(b.name || '')
    })
}

/** Header counters for the card. `total` / `locked` are over active escrows only. */
export function lockCounts(deals: Array<LockCarrier & Pick<Deal, 'pipeline_group'>>, today = new Date()) {
  const esc = deals.filter(d => d.pipeline_group === ESCROW_PIPELINE)
  let locked = 0, expired = 0, unlocked = 0, expiring = 0, noExpiry = 0
  for (const d of esc) {
    const s = lockStatus(d, today).state
    if (s === 'expired') expired++
    else if (s === 'unlocked') unlocked++
    else if (s === 'expiring') { locked++; expiring++ }
    else if (s === 'no-expiry') { locked++; noExpiry++ }
    else locked++
  }
  return { total: esc.length, locked, expired, unlocked, expiring, noExpiry, needsLock: expired + unlocked }
}
