// ─────────────────────────────────────────────────────────────────────────────
// Refi Radar — product-segmented refinance scoring over the funded book.
//
// Pure and dependency-free (so it can be unit-tested on fixtures and reused by the
// /radar page, the contacts pill, and the person callout without divergence).
//
// Grounded in the funded book (2026-06-16): the high-rate loans are HELOCs
// (avg 9.6%), not non-QM/bridge; first mortgages mostly closed at good rates. So
// this is NOT a blanket "rate > par" — each product gets its own play and trigger,
// gated by seasoning and a net-benefit threshold. There is no live rate in the
// data, so the borrower's rate is compared against a par rate the user sets.
// ─────────────────────────────────────────────────────────────────────────────

export type ParRates = { conv: number; fha: number; va: number; nonqm: number }
export const DEFAULT_PAR: ParRates = { conv: 6.5, fha: 5.5, va: 5.5, nonqm: 7.25 }

export type RefiPlay = 'second-lien' | 'first-lien' | 'non-qm' | 'fha-mip' | 'va-irrrl'

export const PLAY_LABEL: Record<RefiPlay, string> = {
  'second-lien': 'HELOC / 2nd',
  'first-lien':  'Rate refi',
  'non-qm':      'Non-QM season-out',
  'fha-mip':     'FHA MIP drop',
  'va-irrrl':    'VA IRRRL',
}

// Minimal structural shape — the page passes Deal rows, fixtures pass plain objects.
export type RadarDeal = {
  id: string
  borrower_id: string | null
  name: string | null
  loan_type: string | null
  rate: number | null
  loan_amount: number | null
  funded_date: string | null
  pipeline_group: string | null
  estimated_value?: number | null
  current_balance?: number | null
  ltv?: number | null
  compensation_amount?: number | null
  dnd?: boolean | null
  last_contacted?: string | null
}

export type RefiCandidate = {
  deal: RadarDeal
  play: RefiPlay
  reason: string
  score: number              // $-weighted priority (delta × balance), for ranking
  eligible: boolean          // seasoned ≥ 6mo AND trigger met → actionable now
  tooNew: boolean            // trigger met but seasoned < 6mo → maturing pipeline
  monthsSeasoned: number | null
  estMonthly: number | null  // rough monthly interest saving when loan_amount is known
  needsEquity: boolean       // play is valid but $ sizing waits on value/balance
}

// ── Tunables ─────────────────────────────────────────────────────────────────
export const SEASONING_MIN_MONTHS = 6
const SECOND_LIEN_HIGH = 8.5     // a HELOC/HELOAN at/above this is a consolidation candidate
const FIRST_LIEN_DELTA = 0.5     // a first must beat par by this much to be worth it
const NONQM_DELTA = 0.0          // any premium over conventional par = season-out candidate
const FALLBACK_BALANCE = 300_000 // used only to rank loans whose amount we don't have

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4

export function monthsSince(dateStr: string | null | undefined, asOf: Date): number | null {
  if (!dateStr) return null
  const t = new Date(dateStr).getTime()
  if (Number.isNaN(t)) return null
  return (asOf.getTime() - t) / MS_PER_MONTH
}

/** Classify one funded loan into a refi play, or null if it isn't a candidate. Pure. */
export function classify(deal: RadarDeal, par: ParRates, asOf: Date): RefiCandidate | null {
  const rate = deal.rate
  if (typeof rate !== 'number' || rate <= 0) return null // can't assess without a rate

  const type = (deal.loan_type ?? '').toLowerCase()
  const months = monthsSince(deal.funded_date, asOf)

  let play: RefiPlay | null = null
  let benchmark = par.conv       // the rate we'd refinance them toward
  let trigger = false
  let reason = ''

  if (type.includes('heloc') || type.includes('heloan')) {
    play = 'second-lien'
    trigger = rate >= SECOND_LIEN_HIGH
    reason = `${deal.loan_type} ${rate}% — high-cost 2nd, consolidate to a fixed first`
  } else if (type.includes('non-qm') || type.includes('nonqm') || type.includes('dscr')) {
    play = 'non-qm'
    trigger = rate > par.nonqm + NONQM_DELTA
    reason = `Non-QM ${rate}% — may qualify conventional after seasoning`
  } else if (type.includes('fha')) {
    play = 'fha-mip'
    benchmark = par.fha
    const equityKnown = typeof deal.ltv === 'number' && deal.ltv > 0
    const hasEquity = equityKnown && (deal.ltv as number) <= 80
    const streamline = rate >= par.fha + FIRST_LIEN_DELTA
    trigger = hasEquity || streamline
    reason = hasEquity
      ? `FHA at ${deal.ltv}% LTV — refi to conventional to drop lifetime MIP`
      : `FHA ${rate}% — streamline / MIP drop (confirm equity)`
  } else if (type.includes('va')) {
    play = 'va-irrrl'
    benchmark = par.va
    trigger = rate >= par.va + FIRST_LIEN_DELTA
    reason = `VA ${rate}% — IRRRL streamline candidate`
  } else {
    // Conv, 30-Yr Fixed, Fixed, or blank → treat as a first-lien rate refi.
    play = 'first-lien'
    trigger = rate >= par.conv + FIRST_LIEN_DELTA
    const delta = (rate - par.conv).toFixed(2)
    reason = `${deal.loan_type || 'Conventional'} ${rate}% — ${delta}% over par, rate-and-term`
  }

  if (!play || !trigger) return null

  const delta = Math.max(0, rate - benchmark)
  const balance = deal.loan_amount && deal.loan_amount > 0 ? deal.loan_amount : null
  const estMonthly = balance ? Math.round((balance * (delta / 100)) / 12) : null
  const score = delta * (balance ?? FALLBACK_BALANCE)

  const seasoned = months !== null && months >= SEASONING_MIN_MONTHS
  const tooNew = months !== null && months < SEASONING_MIN_MONTHS
  // Equity-dependent plays can't be $-sized without value/balance.
  const needsEquity = (play === 'second-lien' || play === 'fha-mip') && balance === null

  return {
    deal, play, reason, score,
    eligible: seasoned && trigger,
    tooNew: tooNew && trigger,
    monthsSeasoned: months === null ? null : Math.round(months),
    estMonthly, needsEquity,
  }
}

/** Score the whole funded book. Returns candidates (trigger met), ranked by score desc.
 *  The caller splits eligible (actionable) vs tooNew (maturing). */
export function scoreFundedBook(deals: RadarDeal[], par: ParRates, asOf: Date = new Date()): RefiCandidate[] {
  const out: RefiCandidate[] = []
  for (const d of deals) {
    if (d.pipeline_group !== 'Funded') continue
    const c = classify(d, par, asOf)
    if (c) out.push(c)
  }
  return out.sort((a, b) => b.score - a.score)
}
