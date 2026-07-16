// Purchased-lead performance report — pure aggregation logic.
//
// This powers /lead-roi (via lib/leadRoi.ts) and /report-import, and is the live version of the
// "Purchased Lead Performance Report" PDF. Kept as pure functions (no I/O) so it's
// testable via scripts/lead-report-check.ts and reusable anywhere.
//
// Definitions (load-bearing — match the approved report):
//   • PURCHASED only      — vendor-bought leads. Warm/organic (Self Source, Return
//                           Client, Referrals, Arive, Unknown/unattributed) are excluded.
//   • Responded           — the lead engaged at least once. GHOSTED COUNTS as responded
//                           (you can't ghost without first responding). Only New Lead /
//                           Attempted Contact / Non-Responsive are "no response".
//   • Opted out / DND     — STOP / DND-SMS / Remove from All Automations. Reported as its
//                           own bucket, NOT folded into responded.
import type { Deal } from './types'

// Vendor (purchased) lead sources. Everything else = warm/organic and is excluded.
export const PURCHASED_SOURCES = ['FRU', 'Lendgo', 'LMB', 'Lending Tree', 'LeadPoint', 'OwnUp'] as const

const PURCHASED_SET = new Set<string>(PURCHASED_SOURCES.map(s => s.toLowerCase()))
export const COLD_STATUSES = new Set(['New Lead', 'Attempted Contact', 'Non-Responsive'])

// ── Opt-out, split two ways (2026-07-16) ──────────────────────────────────────
// These used to be one bucket. They answer different questions and must not be
// conflated: 61% of the old bucket (295 of 486) was "Remove from All Automations",
// which is a BUTTON WE PRESS, not something the borrower did — and the /hot-leads
// triage UI now generates it in bulk (121 in its first two days). Left merged, the
// "opt-out rate" reads as worsening lead quality when it's really triage adoption.

/** Customer-initiated: the borrower told us to stop. A real lead-quality signal. */
export const CUSTOMER_OPTOUT_STATUSES = new Set(['DND - SMS', 'STOP'])

/** Team disposition: WE decided to stop working the lead (the triage button).
 *  Says nothing about the lead's quality — it's an operational choice. */
export const TEAM_REMOVED_STATUSES = new Set(['Remove from All Automations'])

/** UNION — every status that takes a lead out of play.
 *  ⚠️ DO NOT narrow this to the customer set. `isRespondedStatus` is defined as
 *  "not cold AND not opt-out", and "Remove from All Automations" is not cold — so
 *  dropping it here would silently reclassify ~295 deals as **Responded**, inflating
 *  every responded rate and flipping `to_responded` on future stage_events rows. */
export const OPTOUT_STATUSES = new Set([...CUSTOMER_OPTOUT_STATUSES, ...TEAM_REMOVED_STATUSES])
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])

// Only the fields the report needs — keeps the page's select() slim.
export type LeadRow = Pick<Deal, 'loan_officer' | 'pipeline_group' | 'status' | 'source' | 'state' | 'lead_price' | 'compensation_amount' | 'loan_purpose'>

export const rawSource = (d: LeadRow): string => (d.source ?? '').trim()
export const isPurchased = (d: LeadRow): boolean => PURCHASED_SET.has(rawSource(d).toLowerCase())

// ── Status-level predicates (single source of truth) ───────────────────────────
// The stage-change webhook (lib/stageEvents.ts) needs to decide "did this move
// cross into a responded stage?" from a bare status string, before there's a Deal
// row. Keep the responded definition here so the webhook and the report can never
// disagree. Ghosted counts as responded (you can't ghost without first responding).
export const isColdStatus    = (s: string | null | undefined): boolean => COLD_STATUSES.has(s ?? '')
/** UNION (customer opt-out OR team-removed) — "out of play". Keep it broad: see the
 *  warning on OPTOUT_STATUSES. This is what `isRespondedStatus` keys off. */
export const isOptoutStatus  = (s: string | null | undefined): boolean => OPTOUT_STATUSES.has(s ?? '')
/** The borrower told us to stop. Use this for opt-out RATE and TIMING metrics. */
export const isCustomerOptoutStatus = (s: string | null | undefined): boolean => CUSTOMER_OPTOUT_STATUSES.has(s ?? '')
/** We stopped working the lead (triage button). Operational, not lead quality. */
export const isTeamRemovedStatus    = (s: string | null | undefined): boolean => TEAM_REMOVED_STATUSES.has(s ?? '')
export const isRespondedStatus = (s: string | null | undefined): boolean => !isColdStatus(s) && !isOptoutStatus(s)

export const isCold = (d: LeadRow): boolean => isColdStatus(d.status)
// NOTE: there is deliberately no `isOptout` any more (removed 2026-07-16). It was
// ambiguous once the bucket split — callers must say which question they're asking:
//   isCustomerOptout → did the BORROWER opt out?   (lead quality)
//   isTeamRemoved    → did WE stop working it?     (operations)
//   isOptoutStatus   → is it out of play either way? (responded/funnel math)
export const isCustomerOptout = (d: LeadRow): boolean => isCustomerOptoutStatus(d.status)
export const isTeamRemoved    = (d: LeadRow): boolean => isTeamRemovedStatus(d.status)
// Ghosted is intentionally NOT cold — it means the lead responded, then went dark.
export const isResponded = (d: LeadRow): boolean => isRespondedStatus(d.status)
export const isFunded = (d: LeadRow): boolean =>
  d.pipeline_group === 'Funded' || FUNDED_STATUSES.has(d.status ?? '')

// In escrow: reached "Submitted to UW" or a later underwriting/closing stage but
// hasn't funded yet. Used for the escrow-pipeline + hypothetical-funding sections.
export const ESCROW_UW_STATUSES = new Set([
  'Submitted to UW', 'Approved w/ Conditions', 'Re-Submittal',
  'Clear to Close', 'Docs Out', 'Docs Signed',
])
export const isInEscrow = (d: LeadRow): boolean =>
  !isFunded(d) && ESCROW_UW_STATUSES.has(d.status ?? '')

export type LO = 'All' | 'Matt' | 'Moe' | 'Randy'
export function matchesLO(d: LeadRow, lo: LO): boolean {
  if (lo === 'All') return true
  const l = (d.loan_officer ?? '').toLowerCase()
  return lo === 'Matt' ? l.includes('matt') : lo === 'Moe' ? l.includes('moe') : l.includes('randy') || l.includes('mathis')
}

// loan_purpose buckets in the data: Refinance, Purchase, HELOC (+ ~8% untagged that
// only appear under 'All'). 'Refinance' GROUPS true refinances AND HELOCs together
// (a HELOC is an equity refinance).
export type Purpose = 'All' | 'Purchase' | 'Refinance'
export function matchesPurpose(d: LeadRow, p: Purpose): boolean {
  if (p === 'All') return true
  const lp = (d.loan_purpose ?? '').trim().toLowerCase()
  if (p === 'Refinance') return lp === 'refinance' || lp === 'heloc'
  return lp === p.toLowerCase()
}

export const sourceKey = (d: LeadRow): string => rawSource(d) || '(no source)'
export const stateKey = (d: LeadRow): string => {
  const t = (d.state ?? '').trim()
  return t ? t.toUpperCase().slice(0, 2) : '(no state)'
}

export type Segment = {
  n: number; responded: number; rr: number
  cold: number; crate: number
  /** CUSTOMER opt-outs only (STOP / DND - SMS) — the borrower told us to stop. */
  optout: number; orate: number
  /** Team dispositions (Remove from All Automations) — we stopped working it.
   *  Split out 2026-07-16; previously folded into `optout`, where it was 61% of
   *  the bucket and rising with triage adoption. */
  teamRemoved: number; trate: number
  funded: number; fr: number; spend: number; revenue: number; roi: number | null
}

// allFundedRevenue: count comp on ALL funded loans, not just priced ones. Used by
// the "All sources" scope, where warm/referral funded loans carry no lead_price but
// their comp is still real earned revenue. Purchased scope leaves it false so spend
// and revenue stay on the same priced cohort (Efrain's call — clean ROI).
export function segment(rows: LeadRow[], allFundedRevenue = false): Segment {
  const n = rows.length
  const responded = rows.filter(isResponded).length
  const cold = rows.filter(isCold).length
  // optout + teamRemoved were one bucket until 2026-07-16. Together with responded
  // and cold they still partition the whole set (responded = !cold && !either), so
  // the funnel keeps summing to n — the team half just stops masquerading as a
  // customer signal.
  const optout = rows.filter(isCustomerOptout).length
  const teamRemoved = rows.filter(isTeamRemoved).length
  const funded = rows.filter(isFunded).length
  // Money analysis is restricted to leads with a recorded price so revenue and
  // spend cover the SAME cohort. Otherwise a funded loan whose lead price was
  // never captured adds comp with no matching cost and inflates ROI.
  const priced = rows.filter(r => (r.lead_price ?? 0) > 0)
  const spend = priced.reduce((s, r) => s + (r.lead_price ?? 0), 0)
  // Revenue = broker comp actually EARNED, so only FUNDED loans count. Arive
  // pre-populates compensation_amount at loan setup, and it lingers on leads that
  // never fund — even dead "Non-Responsive / Not Ready" ones. Summing it across
  // all priced leads overstated revenue ~3× ($292k vs ~$96k earned) and inflated
  // ROI (~4.9× vs ~1.6×). Spend still counts every priced lead you paid for; only
  // funded leads return comp, which is exactly the ROI we want (earned ÷ spent).
  const fundedForRevenue = allFundedRevenue ? rows.filter(isFunded) : priced.filter(isFunded)
  const revenue = fundedForRevenue.reduce((s, r) => s + (r.compensation_amount ?? 0), 0)
  const safe = n || 1   // avoid div-by-zero on empty selections
  return {
    n, responded, rr: (100 * responded) / safe,
    cold, crate: (100 * cold) / safe,
    optout, orate: (100 * optout) / safe,
    teamRemoved, trate: (100 * teamRemoved) / safe,
    funded, fr: (100 * funded) / safe, spend, revenue,
    // ROI as a return multiple (revenue ÷ spend); null when no priced spend.
    roi: spend > 0 ? revenue / spend : null,
  }
}

export type GroupRow = { key: string } & Segment
export function groupBy(rows: LeadRow[], keyFn: (d: LeadRow) => string, allFundedRevenue = false): GroupRow[] {
  const groups = new Map<string, LeadRow[]>()
  for (const r of rows) {
    const k = keyFn(r)
    const arr = groups.get(k)
    if (arr) arr.push(r)
    else groups.set(k, [r])
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, ...segment(rs, allFundedRevenue) }))
    .sort((a, b) => b.n - a.n)
}

/** Response-rate band → semantic color key (≥28 good · 20–28 mid · <20 bad). */
export const rrBand = (rr: number): 'good' | 'mid' | 'bad' => (rr >= 28 ? 'good' : rr >= 20 ? 'mid' : 'bad')

// Source scope: 'Purchased' = vendor-bought leads only (the ROI funnel); 'All' =
// every source, so warm/organic (Return Client, Referrals, …) are included too.
export type SourceScope = 'Purchased' | 'All'

/** The lead cohort for a given LO + purpose, scoped to Purchased (default) or All sources. */
export const leadBook = (deals: LeadRow[], lo: LO, purpose: Purpose = 'All', scope: SourceScope = 'Purchased'): LeadRow[] =>
  deals.filter(d => (scope === 'All' || isPurchased(d)) && matchesLO(d, lo) && matchesPurpose(d, purpose))

/** Purchased-only cohort — back-compat alias for leadBook(..., 'Purchased'). */
export const purchasedBook = (deals: LeadRow[], lo: LO, purpose: Purpose = 'All'): LeadRow[] =>
  leadBook(deals, lo, purpose, 'Purchased')
