// Which bucket a loan belongs in on the deal page's Loan History card:
// still alive (active or funded) vs. closed out (adverse action, lost, parked).
//
// Pure — no Supabase import — so scripts/loan-outcome-check.ts can run offline.
//
// Why this exists: `pipeline_group` alone doesn't answer it. A declined loan
// keeps whatever stage it died at — of the 113 deals carrying an Arive adverse
// date, 19 still read `Disclosed` and 11 still read `Submitted to UW`. And a
// loan can be dead in GHL (`ghl_status = 'lost'`) with no adverse date at all,
// which is the common case: Robert Petrilak's three closed loans are all lost,
// none adverse. So the rule has to be the union of three signals.

import { OLD_DEALS_GROUP } from './types'
import { isOpenLead } from './triage'

export const FUNDED_GROUP = 'Funded'
export const NOT_READY_GROUP = 'Not Ready'

// Minimal structural view — works for a full Deal and for narrow selected rows.
export type OutcomeDealLike = {
  status: string
  pipeline_group?: string | null
  ghl_status?: string | null
  adverse?: string | null
}

/**
 * Arive stamped an Adverse Action date on this loan — a formal decline.
 * `adverse` is stored as text (ISO YYYY-MM-DD), so blank-vs-null both count as no.
 */
export function isAdverse(d: OutcomeDealLike): boolean {
  return !!(d.adverse ?? '').trim()
}

/**
 * Closed = this loan is not going to fund.
 *
 * Funded ALWAYS wins — a funded loan is never closed-out no matter what GHL's
 * opportunity status says, because the Arive row and the GHL row can disagree
 * (funded loans imported from Arive carry a duplicate GHL row). Guarding here
 * means a stale `lost` can never hide real volume.
 */
export function isClosedLoan(d: OutcomeDealLike): boolean {
  const group = d.pipeline_group ?? ''
  if (group === FUNDED_GROUP) return false
  if (isAdverse(d)) return true
  if (!isOpenLead(d)) return true                                  // GHL lost / abandoned
  return group === NOT_READY_GROUP || group === OLD_DEALS_GROUP
}

/** Why it's closed, for the row label. null when the loan is still alive. */
export function closedReason(d: OutcomeDealLike): string | null {
  if (!isClosedLoan(d)) return null
  if (isAdverse(d)) return 'Adverse Action'
  const st = (d.ghl_status ?? '').toLowerCase()
  if (st === 'lost') return 'Lost'
  if (st.startsWith('abandon')) return 'Abandoned'
  if ((d.pipeline_group ?? '') === OLD_DEALS_GROUP) return 'Parked'
  return 'Not Proceeding'
}

/** Split a list into the two Loan History sections, order preserved. */
export function splitByOutcome<T extends OutcomeDealLike>(deals: T[]): { open: T[]; closed: T[] } {
  const open: T[] = [], closed: T[] = []
  for (const d of deals) (isClosedLoan(d) ? closed : open).push(d)
  return { open, closed }
}
