// Incremental-sync cursor decision: should this opportunity be processed?
//
// Lives here rather than inline in the sync route so it can be fixture-tested.
// The route-local-helper trap bit twice on 2026-07-28 (cleanSource, then
// normalizeGhlLoanPurpose) — both were unexported, untestable, and silently
// wrong for months.

/** The decision for one opportunity, plus whether it only survived as a rescue
 *  (so the caller can log how many were recovered). */
export type OppCursorDecision = { process: boolean; rescued: boolean }

/**
 * @param updatedAt      the opportunity's updatedAt / dateUpdated / lastStatusChangeAt
 * @param cursorMs       last successful sync time, already reduced by the overlap buffer
 * @param opportunityId  the GHL opportunity id
 * @param knownOppIds    every opportunity id the dashboard already stores, or null
 *                       when the caller can't know (plain incremental ping — no
 *                       rescue is attempted and behaviour is the old cursor-only rule)
 *
 * Rescue rule: an opportunity older than the cursor is normally skipped, but if we
 * hold the complete opportunity list AND have no deal for it, it was never ingested
 * — process it. Without this a miss is PERMANENT: GHL's opportunity search index
 * lags the live record, so an opportunity can slip past the overlap window once, and
 * its `updatedAt` never moves again, so every later run filters it out. Maintenance
 * runs fetch everything but only for the prune, so they don't rescue it either.
 * Eleven of Randy's leads sat unseen for four days that way.
 */
export function shouldProcessOpportunity(
  updatedAt: string | null | undefined,
  cursorMs: number,
  opportunityId: string | null | undefined,
  knownOppIds: Set<string> | null,
): OppCursorDecision {
  const ms = updatedAt ? Date.parse(updatedAt) : 0
  // No usable timestamp → process, to be safe. Covers unparseable values too:
  // Date.parse returns NaN, and NaN >= cursor is false, so it must be caught here.
  if (!Number.isFinite(ms) || ms === 0) return { process: true, rescued: false }
  if (ms >= cursorMs) return { process: true, rescued: false }

  const id = (opportunityId ?? '').trim()
  if (knownOppIds && id && !knownOppIds.has(id)) return { process: true, rescued: true }
  return { process: false, rescued: false }
}
