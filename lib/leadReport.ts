// Purchased-lead performance report — pure aggregation logic.
//
// This powers the /lead-performance dashboard page and is the live version of the
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
export const OPTOUT_STATUSES = new Set(['DND - SMS', 'Remove from All Automations', 'STOP'])
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])

// Only the fields the report needs — keeps the page's select() slim.
export type LeadRow = Pick<Deal, 'loan_officer' | 'pipeline_group' | 'status' | 'source' | 'state' | 'lead_price' | 'compensation_amount' | 'loan_purpose'>

export const rawSource = (d: LeadRow): string => (d.source ?? '').trim()
export const isPurchased = (d: LeadRow): boolean => PURCHASED_SET.has(rawSource(d).toLowerCase())
export const isCold = (d: LeadRow): boolean => COLD_STATUSES.has(d.status ?? '')
export const isOptout = (d: LeadRow): boolean => OPTOUT_STATUSES.has(d.status ?? '')
// Ghosted is intentionally NOT cold — it means the lead responded, then went dark.
export const isResponded = (d: LeadRow): boolean => !isCold(d) && !isOptout(d)
export const isFunded = (d: LeadRow): boolean =>
  d.pipeline_group === 'Funded' || FUNDED_STATUSES.has(d.status ?? '')

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
  cold: number; crate: number; optout: number; orate: number
  funded: number; fr: number; spend: number; revenue: number; roi: number | null
}

export function segment(rows: LeadRow[]): Segment {
  const n = rows.length
  const responded = rows.filter(isResponded).length
  const cold = rows.filter(isCold).length
  const optout = rows.filter(isOptout).length
  const funded = rows.filter(isFunded).length
  // Money analysis is restricted to leads with a recorded price so revenue and
  // spend cover the SAME cohort. Otherwise a funded loan whose lead price was
  // never captured adds comp with no matching cost and inflates ROI.
  const priced = rows.filter(r => (r.lead_price ?? 0) > 0)
  const spend = priced.reduce((s, r) => s + (r.lead_price ?? 0), 0)
  const revenue = priced.reduce((s, r) => s + (r.compensation_amount ?? 0), 0)
  const safe = n || 1   // avoid div-by-zero on empty selections
  return {
    n, responded, rr: (100 * responded) / safe,
    cold, crate: (100 * cold) / safe, optout, orate: (100 * optout) / safe,
    funded, fr: (100 * funded) / safe, spend, revenue,
    // ROI as a return multiple (revenue ÷ spend); null when no priced spend.
    roi: spend > 0 ? revenue / spend : null,
  }
}

export type GroupRow = { key: string } & Segment
export function groupBy(rows: LeadRow[], keyFn: (d: LeadRow) => string): GroupRow[] {
  const groups = new Map<string, LeadRow[]>()
  for (const r of rows) {
    const k = keyFn(r)
    const arr = groups.get(k)
    if (arr) arr.push(r)
    else groups.set(k, [r])
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, ...segment(rs) }))
    .sort((a, b) => b.n - a.n)
}

/** Response-rate band → semantic color key (≥28 good · 20–28 mid · <20 bad). */
export const rrBand = (rr: number): 'good' | 'mid' | 'bad' => (rr >= 28 ? 'good' : rr >= 20 ? 'mid' : 'bad')

/** Filter a raw deal list down to the purchased-lead cohort for a given LO + loan purpose. */
export const purchasedBook = (deals: LeadRow[], lo: LO, purpose: Purpose = 'All'): LeadRow[] =>
  deals.filter(d => isPurchased(d) && matchesLO(d, lo) && matchesPurpose(d, purpose))
