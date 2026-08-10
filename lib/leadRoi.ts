// Lead ROI — unified aggregation for /lead-roi (Lead Performance + Lead Spend merged).
// Pure functions, no I/O — fixture-tested via scripts/lead-roi-check.ts.
//
// This module owns the RECONCILED definitions (docs/specs/2026-07-13-lead-roi-unified-spec.md):
//   • Funded        — isFunded from lib/leadReport (group OR funded statuses), used for
//                     pipeline tallies too (Lead Spend previously counted group-only).
//   • Dates         — funded loans anchor on funded_date STRICTLY (no fallback: a funded
//                     loan without one has an unknown funding month and must not pollute a
//                     bounded range); everything else anchors on date_added_ghl. Date-less
//                     rows appear only under "All time".
//   • Spend         — Σ per-lead lead_price PLUS flat monthly retainers × months in range.
//                     (Retainers previously fed cost-per-funded only, so retainer-billed
//                     sources looked artificially profitable.)
//                     EVERY opportunity's lead_price is a real, separate charge. The same
//                     person IS bought more than once, and repeat buys bill at the vendor's
//                     going rate, so an identical amount on two opportunities is normal —
//                     never dedupe spend by contact or vendor_lead_id. See the note at the
//                     leadCost accumulator before touching this.
//   • Revenue       — Σ totalComp on FUNDED loans only (priced or not). totalComp is the
//                     Arive compensation_amount PLUS, on Non-Del loans, the Final Price
//                     credit (net discount points × loan amount) — that second half is
//                     real earned money Arive never puts in the comp column, and on
//                     Edward Fadel it was the LARGER half. See lib/comp.ts.
//   • Net revenue   — revenue × LO_SPLIT. The loan officer does not keep the whole
//                     commission; the house takes its cut first, so the only figure that
//                     can be honestly compared against lead spend is the LO's share.
//                     Gross revenue is still reported beside it — it's what the loan
//                     produced — but every profit and ROI number is computed on NET.
//   • ROI           — NET revenue ÷ spend as a multiple; null when spend is 0.
//   • LO            — single LO at a time via resolveLO (Efrain 2026-07-13: no combined
//                     view). Tabs render from LOAN_OFFICERS so a future LO auto-appears.
import type { Deal } from './types'
import { PIPELINE_GROUPS } from './types'
import { resolveLO } from './loanOfficer'
import { isPurchased, isResponded, isCold, isCustomerOptout, isTeamRemoved, isFunded, matchesPurpose, type Purpose, type SourceScope } from './leadReport'
import { totalComp } from './comp'

export const NO_SOURCE = '(no source set)'
export const sourceLabel = (d: Pick<Deal, 'source'>): string => (d.source ?? '').trim() || NO_SOURCE

// ── LO revenue split ───────────────────────────────────────────────────────────
// The loan officer keeps 85% of what a funded loan earns; the remaining 15% never
// reaches them. Efrain, 2026-08-10: "the loan officer does not keep 100% of that,
// they keep 85% … use net revenue in the calculations to find the TRUE ROI on the
// lead spend." Measuring a lead's return against gross commission overstates every
// vendor by ~18% (1 ÷ 0.85), which is enough to make an underwater source read as
// profitable — a 1.15× gross source is really 0.98× and losing money.
//
// FLAT for every LO by Efrain's call (2026-08-10) — not per-LO, not stored. If a
// comp plan ever splits by officer, this becomes a lookup keyed on the canonical
// LO name (and the fixtures in scripts/lead-roi-check.ts pin the arithmetic).
//
// Applied to the WHOLE totalComp, both halves: the Arive compensation line AND the
// Non-Del Final Price credit. Efrain confirmed 2026-08-10 the split takes 85% of
// both, so netRevenue() wraps totalComp rather than reaching inside lib/comp.ts.
export const LO_SPLIT = 0.85

/** The LO's share of a gross figure. Single chokepoint — never inline 0.85. */
export const netOf = (gross: number): number => gross * LO_SPLIT

// ── Date rules ─────────────────────────────────────────────────────────────────
export type RangeKey = 'this_month' | 'last_month' | '90d' | 'ytd' | 'all' | 'custom'
export const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '90d',        label: 'Last 90 days' },
  { key: 'ytd',        label: 'Year to date' },
  { key: 'all',        label: 'All time' },
  { key: 'custom',     label: 'Custom range…' },
]

export function rangeBounds(key: RangeKey, customFrom = '', customTo = '', now = new Date()): { start: Date | null; end: Date | null } {
  if (key === 'all') return { start: null, end: null }
  if (key === 'custom') {
    return {
      start: customFrom ? new Date(customFrom + 'T00:00:00') : null,
      end:   customTo   ? new Date(customTo   + 'T23:59:59') : null,
    }
  }
  if (key === 'this_month') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  if (key === 'last_month') return {
    start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    end:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
  }
  if (key === 'ytd') return { start: new Date(now.getFullYear(), 0, 1), end: now }
  return { start: new Date(now.getTime() - 90 * 86_400_000), end: now }   // '90d'
}

/** Approximate months a range spans — retainer rollup. "All time" assumes 12 (override per-source notes). */
export function monthsBetween(start: Date | null, end: Date | null): number {
  if (!start) return 12
  const e = end ?? new Date()
  return Math.max(0.1, (e.getTime() - start.getTime()) / 86_400_000 / 30.4375)
}

// Date-only values ("2026-05-01") parse as UTC midnight, which can land the evening
// BEFORE the local month starts (e.g. Pacific) and drop 1st-of-month loans from a
// bounded range. Parse them as LOCAL midnight; full ISO timestamps carry their own tz.
export function parseLocalMs(dateStr: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(dateStr + 'T00:00:00').getTime()
    : Date.parse(dateStr)
}

/** The date a deal anchors on: funded → funded_date STRICTLY, else date_added_ghl. */
export function anchorDate(d: Pick<Deal, 'pipeline_group' | 'status' | 'funded_date' | 'date_added_ghl'>): string | null {
  return isFunded(d as Deal) ? (d.funded_date ?? null) : (d.date_added_ghl ?? null)
}

// ── Filtering ──────────────────────────────────────────────────────────────────
export type RoiFilters = {
  lo: string                     // canonical LOAN_OFFICERS name — always exactly one
  scope: SourceScope             // 'Purchased' | 'All'
  purpose: Purpose               // 'All' | 'Purchase' | 'Refinance'
  stage: string                  // '' = all; else a pipeline group or a specific status
  start: Date | null
  end: Date | null
}

export const stageIsGroup = (stage: string): boolean =>
  (PIPELINE_GROUPS as readonly string[]).includes(stage)

export function filterDeals(deals: Deal[], f: RoiFilters): Deal[] {
  const startMs = f.start?.getTime() ?? 0
  const endMs   = f.end?.getTime() ?? Infinity
  const isBounded = f.start != null || f.end != null
  const grpStage = stageIsGroup(f.stage)
  return deals.filter(d => {
    if (resolveLO(d.loan_officer) !== f.lo) return false
    if (f.scope === 'Purchased' && !isPurchased(d)) return false
    if (!matchesPurpose(d, f.purpose)) return false
    if (f.stage) {
      if (grpStage) { if ((d.pipeline_group ?? '') !== f.stage) return false }
      else          { if ((d.status ?? '')         !== f.stage) return false }
    }
    const dateStr = anchorDate(d)
    if (!dateStr) return !isBounded          // undatable → All-time only
    const t = parseLocalMs(dateStr)
    return !isNaN(t) && t >= startMs && t <= endMs
  })
}

// ── Per-source stats (the table superset) ──────────────────────────────────────
export type CostRow = { source: string; cost_per_month: number; notes: string | null; updated_at: string }

export type SourceStats = {
  source: string
  total: number
  responded: number; rr: number
  cold: number
  /** CUSTOMER opt-outs only (STOP / DND - SMS). Split from team dispositions
   *  2026-07-16 — see lib/leadReport.ts. `orate` is now a lead-QUALITY signal. */
  optout: number; orate: number
  /** Team dispositions (Remove from All Automations) — the triage button. Tracked
   *  separately so triage adoption can't masquerade as leads opting out. */
  teamRemoved: number; trate: number
  open: number; active: number; lost: number
  funded: number; fr: number
  fundedVolume: number; fundedAvg: number
  leadCost: number                // Σ lead_price
  retainer: number                // cost_per_month × months in range
  spend: number                   // leadCost + retainer (blended)
  revenue: number                 // Σ totalComp on funded — GROSS, what the loan earned
  netRevenue: number              // revenue × LO_SPLIT — what the LO actually keeps
  netProfit: number               // netRevenue − spend
  roi: number | null              // netRevenue ÷ spend (multiple); null when spend 0
  costPerFunded: number | null    // spend ÷ funded; null when funded 0 or spend 0
  costPerMonth: number            // the raw retainer setting (for the editor)
  deals: Deal[]
}

export function buildSourceStats(deals: Deal[], costs: Map<string, CostRow>, months: number): SourceStats[] {
  const map = new Map<string, SourceStats>()
  const get = (src: string): SourceStats => {
    let s = map.get(src)
    if (!s) {
      const cpm = costs.get(src)?.cost_per_month ?? 0
      s = {
        source: src, total: 0, responded: 0, rr: 0, cold: 0, optout: 0, orate: 0,
        teamRemoved: 0, trate: 0,
        open: 0, active: 0, lost: 0, funded: 0, fr: 0,
        fundedVolume: 0, fundedAvg: 0,
        leadCost: 0, retainer: cpm * months, spend: 0, revenue: 0, netRevenue: 0, netProfit: 0,
        roi: null, costPerFunded: null, costPerMonth: cpm, deals: [],
      }
      map.set(src, s)
    }
    return s
  }
  for (const d of deals) {
    const s = get(sourceLabel(d))
    s.total++
    s.deals.push(d)
    if (isResponded(d)) s.responded++
    if (isCold(d)) s.cold++
    if (isCustomerOptout(d)) s.optout++
    if (isTeamRemoved(d)) s.teamRemoved++
    // EVERY opportunity's lead_price is a REAL, SEPARATE charge — never dedupe it.
    // Efrain, 2026-07-28: "there are definitely leads that are purchased twice,
    // each opportunity with a cost is a REAL cost… there are never going to be
    // duplicates of the same charge… it is normal to have the same lead cost for
    // the opportunity."
    //
    // Aggregators resell the same person, so one contact legitimately produces
    // several priced opportunities, and repeat buys from one vendor bill at that
    // vendor's going rate — so an identical amount on two opportunities is the
    // NORMAL case, not a duplicate. A shared vendor_lead_id does not merge them
    // either; it identifies the person at the vendor, not a single invoice.
    //
    // Do not "fix" this by counting spend once per contact or per vendor_lead_id.
    // That was proposed on 2026-07-28 off exactly that misreading and was wrong:
    // it would have erased ~$2k of spend Efrain actually paid and inflated every
    // vendor's ROI. Summing per deal is correct.
    s.leadCost += d.lead_price ?? 0
    if (isFunded(d)) {
      s.funded++
      s.fundedVolume += d.loan_amount ?? 0
      s.revenue += totalComp(d)
    } else if ((d.pipeline_group ?? '') === 'Loans in Process') s.active++
    else if ((d.pipeline_group ?? '') === 'Not Ready') s.lost++
    else s.open++
  }
  for (const s of map.values()) {
    s.rr = s.total ? (100 * s.responded) / s.total : 0
    s.orate = s.total ? (100 * s.optout) / s.total : 0
    s.trate = s.total ? (100 * s.teamRemoved) / s.total : 0
    s.fr = s.total ? (100 * s.funded) / s.total : 0
    s.fundedAvg = s.funded ? s.fundedVolume / s.funded : 0
    s.spend = s.leadCost + s.retainer
    // Profit and ROI run on the LO's SHARE, not the gross commission — see LO_SPLIT.
    s.netRevenue = netOf(s.revenue)
    s.netProfit = s.netRevenue - s.spend
    s.roi = s.spend > 0 ? s.netRevenue / s.spend : null
    s.costPerFunded = s.funded > 0 && s.spend > 0 ? s.spend / s.funded : null
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

// ── KPI rollup across visible sources ──────────────────────────────────────────
export type RoiKpis = {
  totalLeads: number
  responded: number; rr: number
  cold: number; crate: number
  optout: number; orate: number          // CUSTOMER opt-outs (STOP / DND-SMS)
  teamRemoved: number; trate: number     // team dispositions (Remove from All Automations)
  active: number
  funded: number; fr: number
  volume: number
  leadCost: number; retainer: number; spend: number
  revenue: number                 // GROSS comp on funded
  netRevenue: number              // revenue × LO_SPLIT — the LO's share
  netProfit: number               // netRevenue − spend
  roi: number | null              // netRevenue ÷ spend
  costPerFunded: number | null
  avgComp: number | null          // GROSS revenue ÷ funded
  avgNetComp: number | null       // netRevenue ÷ funded — the figure cost/funded must beat
}

export function rollupKpis(sources: SourceStats[]): RoiKpis {
  let totalLeads = 0, responded = 0, cold = 0, optout = 0, teamRemoved = 0, active = 0, funded = 0
  let volume = 0, leadCost = 0, retainer = 0, revenue = 0
  for (const s of sources) {
    totalLeads += s.total; responded += s.responded; cold += s.cold; optout += s.optout
    teamRemoved += s.teamRemoved
    active += s.active; funded += s.funded; volume += s.fundedVolume
    leadCost += s.leadCost; retainer += s.retainer; revenue += s.revenue
  }
  const spend = leadCost + retainer
  const safe = totalLeads || 1
  // Rolled up from GROSS then split once, rather than summing each source's already-
  // split netRevenue: identical result (the split is linear) but no drift from
  // per-source rounding, and it keeps one definition of where the 15% comes off.
  const netRevenue = netOf(revenue)
  return {
    totalLeads, responded, rr: (100 * responded) / safe,
    cold, crate: (100 * cold) / safe, optout, orate: (100 * optout) / safe,
    teamRemoved, trate: (100 * teamRemoved) / safe,
    active, funded, fr: (100 * funded) / safe, volume,
    leadCost, retainer, spend, revenue, netRevenue, netProfit: netRevenue - spend,
    roi: spend > 0 ? netRevenue / spend : null,
    costPerFunded: funded > 0 && spend > 0 ? spend / funded : null,
    avgComp: funded > 0 ? revenue / funded : null,
    avgNetComp: funded > 0 ? netRevenue / funded : null,
  }
}

// ── Lifecycle funnel ───────────────────────────────────────────────────────────
export type FunnelStage = { key: string; label: string; sub: string; n: number; pctOfLeads: number }
export function funnel(k: RoiKpis): FunnelStage[] {
  const pct = (n: number) => (k.totalLeads ? (100 * n) / k.totalLeads : 0)
  const becameLoan = k.active + k.funded
  return [
    { key: 'leads',     label: 'Leads',         sub: 'in scope',          n: k.totalLeads, pctOfLeads: 100 },
    { key: 'responded', label: 'Responded',     sub: 'engaged ≥ once',    n: k.responded,  pctOfLeads: pct(k.responded) },
    { key: 'loan',      label: 'Became a loan', sub: 'active + funded',   n: becameLoan,   pctOfLeads: pct(becameLoan) },
    { key: 'funded',    label: 'Funded',        sub: 'comp earned',       n: k.funded,     pctOfLeads: pct(k.funded) },
  ]
}

// ── Per-state rows ─────────────────────────────────────────────────────────────
export type StateRow = { state: string; n: number; responded: number; rr: number; funded: number; fr: number }
export function stateRows(deals: Deal[]): StateRow[] {
  const map = new Map<string, StateRow>()
  for (const d of deals) {
    const t = (d.state ?? '').trim()
    const key = t ? t.toUpperCase().slice(0, 2) : '(none)'
    let r = map.get(key)
    if (!r) { r = { state: key, n: 0, responded: 0, rr: 0, funded: 0, fr: 0 }; map.set(key, r) }
    r.n++
    if (isResponded(d)) r.responded++
    if (isFunded(d)) r.funded++
  }
  for (const r of map.values()) {
    r.rr = r.n ? (100 * r.responded) / r.n : 0
    r.fr = r.n ? (100 * r.funded) / r.n : 0
  }
  return [...map.values()].sort((a, b) => b.n - a.n)
}

// ── Monthly spend-vs-revenue series ────────────────────────────────────────────
// Spend lands on the month the lead came in (date_added_ghl) — retainers are spread
// evenly across the span's months. Revenue lands on the funding month (funded_date).
// Undatable rows are skipped (the KPI band still counts them).
// The monthly ROI chip is the same question as the headline ROI, one month at a
// time — so it runs on netRevenue too. `revenue` stays on the point (gross, for the
// tooltip); the plotted bar and the chip both use netRevenue.
export type MonthPoint = { key: string; label: string; spend: number; revenue: number; netRevenue: number; roi: number | null }
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ymKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthlySeries(deals: Deal[], retainerPerMonth: number, maxMonths = 24): MonthPoint[] {
  const spendBy = new Map<string, number>()
  const revBy = new Map<string, number>()
  const keys = new Set<string>()
  for (const d of deals) {
    const inStr = d.date_added_ghl
    if (inStr) {
      const t = parseLocalMs(inStr)
      if (!isNaN(t) && (d.lead_price ?? 0) > 0) {
        const k = ymKey(t)
        spendBy.set(k, (spendBy.get(k) ?? 0) + (d.lead_price ?? 0))
        keys.add(k)
      }
    }
    if (isFunded(d) && d.funded_date) {
      const t = parseLocalMs(d.funded_date)
      const earned = totalComp(d)
      if (!isNaN(t) && earned > 0) {
        const k = ymKey(t)
        revBy.set(k, (revBy.get(k) ?? 0) + earned)
        keys.add(k)
      }
    }
  }
  if (keys.size === 0) return []
  // Fill the contiguous span between first and last active month, newest-capped.
  const sorted = [...keys].sort()
  const [fy, fm] = sorted[0].split('-').map(Number)
  const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number)
  const points: MonthPoint[] = []
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? (y++, m = 1) : m++) {
    const k = `${y}-${String(m).padStart(2, '0')}`
    const spend = (spendBy.get(k) ?? 0) + retainerPerMonth
    const revenue = revBy.get(k) ?? 0
    const netRevenue = netOf(revenue)
    points.push({
      key: k,
      label: `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`,
      spend, revenue, netRevenue,
      roi: spend > 0 ? netRevenue / spend : null,
    })
  }
  return points.slice(-maxMonths)
}

// ── Early opt-out (within N days of lead creation) ─────────────────────────────
// Timing comes from the stage_events log (/api/stage-events/first-optout —
// earliest crossing into STOP / DND-SMS / Remove from All Automations per
// opportunity). Forward-only: opt-outs that predate the webhook have no event,
// so we report COVERAGE (timed ÷ current opt-out bucket) instead of pretending
// the timing is complete.
export type Optout7d = {
  optouts: number          // leads currently in the opt-out bucket (the KPI's 152)
  timed: number            // opt-out-bucket leads with a logged opt-out event AND a creation date
  within: number           // of `timed`, how many opted out ≤ N days after creation
  withinPct: number        // within ÷ timed (0 when no timing)
  coverage: number         // timed ÷ optouts (0–100)
  days: number
}

export function optout7dStats(
  deals: Deal[],
  firstOptout: Record<string, string>,
  days = 7,
): Optout7d {
  const windowMs = days * 86_400_000
  let optouts = 0, timed = 0, within = 0
  for (const d of deals) {
    if (!isCustomerOptout(d)) continue
    optouts++
    const oppId = d.ghl_opportunity_id
    const evt = oppId ? firstOptout[oppId] : undefined
    if (!evt || !d.date_added_ghl) continue
    const created = parseLocalMs(d.date_added_ghl)
    const optedAt = Date.parse(evt)
    if (isNaN(created) || isNaN(optedAt)) continue
    timed++
    if (optedAt - created <= windowMs) within++
  }
  return {
    optouts, timed, within,
    withinPct: timed ? (100 * within) / timed : 0,
    coverage: optouts ? (100 * timed) / optouts : 0,
    days,
  }
}

// ── Page-top insights — computed callouts, no editorializing beyond the math ───
// Guards keep small samples from stealing the headline: money picks need a funded
// loan + real spend; rate picks need a minimum lead count.
// Every money pick below reads SourceStats.roi / .netProfit, which are NET-based
// (LO_SPLIT applied) — so "best performer" and "underwater" are judged on money the
// LO actually keeps. A source between 0.85× and 1.00× net WILL now be flagged
// underwater despite clearing its cost on gross; that is the point of the change.
export type Insights = {
  bestRoi: SourceStats | null       // highest net ROI (funded ≥ 1, spend > 0)
  topNet: SourceStats | null        // biggest net profit in $ (may differ from bestRoi)
  bestResponse: SourceStats | null  // highest resp % (total ≥ minLeads)
  worstRoi: SourceStats | null      // underwater (< 1×) with the lowest ROI, if any
  highestOptout: SourceStats | null // highest opt-out % (total ≥ minLeads)
}

export function insights(sources: SourceStats[], minLeads = 20): Insights {
  const money = sources.filter(s => s.funded >= 1 && s.spend > 0 && s.roi != null)
  const sized = sources.filter(s => s.total >= minLeads)
  const byRoi = [...money].sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const under = byRoi.filter(s => (s.roi ?? 0) < 1)
  const topNet = [...sources].sort((a, b) => b.netProfit - a.netProfit)[0] ?? null
  return {
    bestRoi: byRoi[0] ?? null,
    topNet: topNet && (topNet.revenue > 0 || topNet.spend > 0) ? topNet : null,
    bestResponse: [...sized].sort((a, b) => b.rr - a.rr)[0] ?? null,
    worstRoi: under.length ? under[under.length - 1] : null,
    highestOptout: [...sized].sort((a, b) => b.orate - a.orate)[0] ?? null,
  }
}

// ── "If all active loans fund" projection ──────────────────────────────────────
export type ProjectionRow = {
  source: string
  activeCount: number
  addComp: number                 // GROSS comp the actives would add
  addNetComp: number              // the LO's share of it
  estimated: number               // how many actives had no comp and used the average
  projNetProfit: number
  projRoi: number | null
  netProfit: number
  roi: number | null
}
export type Projection = {
  rows: ProjectionRow[]           // only sources with active loans, by addComp desc
  activeCount: number
  estimatedCount: number
  addComp: number                 // GROSS
  addNetComp: number              // × LO_SPLIT
  addVolume: number
  avgComp: number                 // GROSS average comp of comp-bearing deals in view
  projRevenue: number             // GROSS revenue if every active funds
  projNetRevenue: number          // the LO's share of that
  projNetProfit: number           // projNetRevenue − spend
  projRoi: number | null          // projNetRevenue ÷ spend
  projFunded: number
  projVolume: number
  projConversion: number
}

export function projection(sources: SourceStats[], k: RoiKpis): Projection {
  // Average comp over comp-bearing deals in view — the estimate for actives without one.
  let compSum = 0, compN = 0
  for (const s of sources) for (const d of s.deals) {
    const c = totalComp(d)
    if (c > 0) { compSum += c; compN++ }
  }
  const avgComp = compN > 0 ? compSum / compN : 0
  const rows: ProjectionRow[] = []
  let activeCount = 0, estimatedCount = 0, addComp = 0, addVolume = 0
  for (const s of sources) {
    const actives = s.deals.filter(d => !isFunded(d) && (d.pipeline_group ?? '') === 'Loans in Process')
    if (!actives.length) continue
    let add = 0, est = 0, vol = 0
    for (const d of actives) {
      const c = totalComp(d)
      if (c > 0) add += c
      else { add += avgComp; est++ }
      vol += d.loan_amount ?? 0
    }
    activeCount += actives.length; estimatedCount += est; addComp += add; addVolume += vol
    // A projected loan is split like a funded one — the LO would keep 85% of it too.
    const projNetRev = netOf(s.revenue + add)
    rows.push({
      source: s.source, activeCount: actives.length, addComp: add, addNetComp: netOf(add), estimated: est,
      netProfit: s.netProfit, roi: s.roi,
      projNetProfit: projNetRev - s.spend,
      projRoi: s.spend > 0 ? projNetRev / s.spend : null,
    })
  }
  rows.sort((a, b) => b.addComp - a.addComp)
  const projRevenue = k.revenue + addComp
  const projNetRevenue = netOf(projRevenue)
  return {
    rows, activeCount, estimatedCount, addComp, addNetComp: netOf(addComp), addVolume, avgComp,
    projRevenue, projNetRevenue,
    projNetProfit: projNetRevenue - k.spend,
    projRoi: k.spend > 0 ? projNetRevenue / k.spend : null,
    projFunded: k.funded + activeCount,
    projVolume: k.volume + addVolume,
    projConversion: k.totalLeads > 0 ? (100 * (k.funded + activeCount)) / k.totalLeads : 0,
  }
}
