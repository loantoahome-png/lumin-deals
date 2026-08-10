// Monthly Cohort — pure aggregation for /monthly-reports. No I/O.
//
// THE QUESTION THIS ANSWERS, and how it differs from /lead-roi:
//
//   /lead-roi anchors a FUNDED loan on its funded_date and everything else on
//   date_added_ghl. So a lead bought in May that funds in August puts its cost in
//   May and its revenue in August — two different months. That's the right shape
//   for "how did August do", and the wrong shape for "was May's buy any good".
//
//   Here EVERY number belongs to the month the lead CAME IN. Pick May and you get:
//   the leads that arrived in May, what they cost, and how many of those exact
//   leads have funded since — whenever they funded. Cost and outcome finally sit in
//   the same row, which is what makes a cohort comparable to another cohort.
//
// ⚠️ MATURITY. A cohort keeps earning after its month closes. Larisa Fuchs came in
// 2026-05-01 and funded 2026-06-02 — 32 days. Judging May on May 31 would have
// scored her as a miss. `daysToFund` percentiles are exported so the page can say
// out loud how much of a cohort is still in flight; never present a young cohort's
// funded rate as final.
//
// ⚠️ ANCHOR COVERAGE. Cohorts are built from date_added_ghl. For purchased leads
// that's 99.9% covered (2,586/2,588 as of 2026-08-10) and safe. Warm/organic is
// not — only 46 of its 139 funded loans carry the date — which is why this page
// is purchased-only by Efrain's call. `undated` is returned so the page can
// disclose what fell out rather than quietly shrinking the denominator.

import { isFunded, isResponded, isPurchased, type LeadRow } from './leadReport'
import { resolveLO } from './loanOfficer'
import { totalComp, type CompFields } from './comp'
import { netOf, parseLocalMs, type CostRow } from './leadRoi'

export type CohortLead = LeadRow & CompFields & {
  id: string
  name: string | null
  date_added_ghl: string | null
  funded_date: string | null
  loan_amount: number | null
}

// ── Period ───────────────────────────────────────────────────────────────────
export type Period = { key: string; label: string; start: Date; end: Date }

/** Month buckets present in the data, newest first. `key` is "YYYY-MM". */
export function monthsInData(leads: CohortLead[]): Period[] {
  const keys = new Set<string>()
  for (const l of leads) {
    if (l.date_added_ghl) keys.add(String(l.date_added_ghl).slice(0, 7))
  }
  return [...keys].sort().reverse().map(monthPeriod)
}

export function monthPeriod(key: string): Period {
  const [y, m] = key.split('-').map(Number)
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0)
  const end = new Date(y, m, 0, 23, 59, 59, 999)          // day 0 of next month = last day of this
  return {
    key, start, end,
    label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  }
}

export function customPeriod(from: string, to: string): Period | null {
  if (!from || !to) return null
  const s = parseLocalMs(from), e = parseLocalMs(to)
  if (isNaN(s) || isNaN(e)) return null
  const start = new Date(s), end = new Date(e)
  end.setHours(23, 59, 59, 999)
  return { key: `${from}..${to}`, label: `${from} – ${to}`, start, end }
}

/** Whole months a period spans, for retainer cost. Partial month counts as one. */
export function monthSpan(p: Period): number {
  return (p.end.getFullYear() - p.start.getFullYear()) * 12 + (p.end.getMonth() - p.start.getMonth()) + 1
}

// ── Cohort membership ────────────────────────────────────────────────────────
/** Leads that CAME IN during the period. Undated leads can never be placed. */
export function cohortOf(leads: CohortLead[], p: Period): CohortLead[] {
  const s = p.start.getTime(), e = p.end.getTime()
  return leads.filter(l => {
    if (!l.date_added_ghl) return false
    const t = parseLocalMs(l.date_added_ghl)
    return !isNaN(t) && t >= s && t <= e
  })
}

/**
 * Days from lead-in to funding, counted in CALENDAR days.
 *
 * ⚠️ The two ends have different precision: date_added_ghl is a full timestamp
 * ("2026-05-01T19:26:04Z") and funded_date is a bare DATE ("2026-06-02"). A raw
 * subtraction mixes an afternoon against a midnight and rounds the wrong way —
 * Larisa Fuchs, May 1 → June 2, came out as 31. Flatten both to local midnight
 * first so the answer is the number of days on a calendar: 32.
 */
export function daysToFund(l: CohortLead): number | null {
  if (!l.date_added_ghl || !l.funded_date) return null
  const a = parseLocalMs(l.date_added_ghl), b = parseLocalMs(l.funded_date)
  if (isNaN(a) || isNaN(b)) return null
  const midnight = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
  return Math.max(0, Math.round((midnight(b) - midnight(a)) / 86_400_000))
}

// ── Totals ───────────────────────────────────────────────────────────────────
export type CohortTotals = {
  leads: number
  leadSpend: number          // Σ lead_price of the cohort — one price per OPPORTUNITY
  retainer: number           // monthly retainers × months the period spans
  spend: number              // leadSpend + retainer
  responded: number
  respondedPct: number
  funded: number
  fundedPct: number          // of the cohort's leads
  volume: number             // funded loan amount
  grossRevenue: number       // Σ totalComp on funded
  netRevenue: number         // × LO split
  netProfit: number          // netRevenue − spend
  roi: number | null         // grossRevenue ÷ spend, as a multiple (matches /lead-roi)
  netRoi: number | null      // netRevenue ÷ spend — the one that pays the bills
  costPerLead: number | null
  costPerFunded: number | null
  avgDaysToFund: number | null
  medianDaysToFund: number | null
  inFlight: number           // cohort leads still alive and unfunded
}

export function totals(cohort: CohortLead[], retainerPerMonth: number, months: number): CohortTotals {
  const leads = cohort.length
  const leadSpend = cohort.reduce((a, l) => a + (Number(l.lead_price) || 0), 0)
  const retainer = retainerPerMonth * months
  const spend = leadSpend + retainer

  const fundedRows = cohort.filter(isFunded)
  const grossRevenue = fundedRows.reduce((a, l) => a + totalComp(l), 0)
  const netRevenue = netOf(grossRevenue)
  const respondedN = cohort.filter(isResponded).length

  const dtf = fundedRows.map(daysToFund).filter((n): n is number => n != null).sort((a, b) => a - b)

  return {
    leads,
    leadSpend, retainer, spend,
    responded: respondedN,
    respondedPct: leads ? (respondedN / leads) * 100 : 0,
    funded: fundedRows.length,
    fundedPct: leads ? (fundedRows.length / leads) * 100 : 0,
    volume: fundedRows.reduce((a, l) => a + (Number(l.loan_amount) || 0), 0),
    grossRevenue,
    netRevenue,
    netProfit: netRevenue - spend,
    roi: spend > 0 ? grossRevenue / spend : null,
    netRoi: spend > 0 ? netRevenue / spend : null,
    costPerLead: leads ? spend / leads : null,
    costPerFunded: fundedRows.length ? spend / fundedRows.length : null,
    avgDaysToFund: dtf.length ? dtf.reduce((a, b) => a + b, 0) / dtf.length : null,
    medianDaysToFund: dtf.length ? dtf[Math.floor(dtf.length / 2)] : null,
    inFlight: cohort.filter(l => !isFunded(l) && isResponded(l)).length,
  }
}

// ── Per-source split inside one cohort ───────────────────────────────────────
export type SourceCohortRow = { source: string } & CohortTotals

export function bySource(cohort: CohortLead[], costs: Map<string, CostRow>, months: number): SourceCohortRow[] {
  const groups = new Map<string, CohortLead[]>()
  for (const l of cohort) {
    const k = (l.source ?? '').trim() || '(no source)'
    const g = groups.get(k); if (g) g.push(l); else groups.set(k, [l])
  }
  return [...groups].map(([source, rows]) => ({
    source,
    ...totals(rows, costs.get(source)?.cost_per_month ?? 0, months),
  })).sort((a, b) => b.spend - a.spend)
}

// ── Every month, one row each — the trend the page leads with ────────────────
export type MonthRow = { period: Period; ageDays: number } & CohortTotals

export function monthlyRows(
  leads: CohortLead[],
  costs: Map<string, CostRow>,
  now: Date,
): MonthRow[] {
  const retainerPerMonth = [...costs.values()].reduce((a, c) => a + (Number(c.cost_per_month) || 0), 0)
  return monthsInData(leads).map(period => {
    const cohort = cohortOf(leads, period)
    return {
      period,
      // How long the cohort has had to mature, measured from the month's END.
      ageDays: ageOf(period, now),
      ...totals(cohort, retainerPerMonth, 1),
    }
  })
}

// ── Scope ────────────────────────────────────────────────────────────────────
/**
 * Purchased leads for ONE LO. Two deliberate constraints:
 *  • Purchased only — Efrain's call, and the anchor coverage backs it (99.9% vs
 *    the 33% of warm/organic funded loans that carry a lead-in date at all).
 *  • One LO at a time, matched through `resolveLO` against the canonical
 *    LOAN_OFFICERS name — same rule as /lead-roi, and it means a 4th LO appears
 *    on this page for free instead of silently inheriting someone else's leads.
 */
export function scopeLeads(leads: CohortLead[], lo: string): CohortLead[] {
  return leads.filter(l => isPurchased(l) && resolveLO(l.loan_officer) === lo)
}

/** Leads the anchor can't place — disclosed rather than silently dropped. */
export function undated(leads: CohortLead[]): CohortLead[] {
  return leads.filter(l => !l.date_added_ghl)
}

/**
 * Is this cohort old enough to judge? Compares its age against how long funded
 * leads actually take, so the page can mark a month "still in flight" instead of
 * reporting a low funded rate as if it were the final answer.
 */
export function maturity(ageDays: number, medianDaysAllTime: number | null): 'mature' | 'partial' | 'young' {
  if (medianDaysAllTime == null) return 'partial'
  if (ageDays >= medianDaysAllTime * 2) return 'mature'
  if (ageDays >= medianDaysAllTime) return 'partial'
  return 'young'
}

/** Days a period has had to mature, measured from its END. */
export function ageOf(p: Period, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - p.end.getTime()) / 86_400_000))
}

/** Median days-to-fund across every funded lead we can time. The maturity yardstick. */
export function medianDaysToFundAll(leads: CohortLead[]): number | null {
  const d = leads.filter(isFunded).map(daysToFund).filter((n): n is number => n != null).sort((a, b) => a - b)
  return d.length ? d[Math.floor(d.length / 2)] : null
}
