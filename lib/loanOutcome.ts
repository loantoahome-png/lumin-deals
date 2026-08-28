// Which bucket a loan belongs in on the deal page's Loan History card:
// still alive (active or funded) vs. closed out (adverse action or lost).
//
// Pure — no Supabase import — so scripts/loan-outcome-check.ts can run offline.
//
// Why this exists: `pipeline_group` and `status` don't answer it. A declined loan
// keeps whatever stage it died at — of the 113 deals carrying an Arive adverse
// date, 19 still read `Disclosed`, 11 `Submitted to UW`, one `Clear to Close`.
// And a loan can be dead in GHL (`ghl_status = 'lost'`) with no adverse date at
// all, which is the common case: Robert Petrilak's closed loans are all lost,
// none adverse. So the rule is the union of those two independent signals.
//
// ⚠️ `Not Ready` is deliberately NOT a death signal (Efrain, 2026-08-28). That
// group is mostly `Not Ready - Timeframe` leads that lib/triage.ts resurfaces on
// a check-in date — they are alive, just parked. Only a formal decline or a
// closed-out GHL opportunity counts here.

import { isOpenLead } from './triage'

export const FUNDED_GROUP = 'Funded'

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
 * Closed = this loan is not going to fund. Adverse action, or lost/abandoned in GHL.
 *
 * Funded ALWAYS wins — a funded loan is never closed-out no matter what GHL's
 * opportunity status says, because the Arive row and the GHL row can disagree
 * (funded loans imported from Arive carry a duplicate GHL row). Guarding here
 * means a stale `lost` can never hide real volume.
 */
export function isClosedLoan(d: OutcomeDealLike): boolean {
  if ((d.pipeline_group ?? '') === FUNDED_GROUP) return false
  if (isAdverse(d)) return true
  return !isOpenLead(d)                                            // GHL lost / abandoned
}

/** Why it's closed, for the row label. null when the loan is still alive. */
export function closedReason(d: OutcomeDealLike): string | null {
  if (!isClosedLoan(d)) return null
  if (isAdverse(d)) return 'Adverse Action'
  return (d.ghl_status ?? '').toLowerCase() === 'lost' ? 'Lost' : 'Abandoned'
}

/** Split a list into the two Loan History sections, order preserved. */
export function splitByOutcome<T extends OutcomeDealLike>(deals: T[]): { open: T[]; closed: T[] } {
  const open: T[] = [], closed: T[] = []
  for (const d of deals) (isClosedLoan(d) ? closed : open).push(d)
  return { open, closed }
}
