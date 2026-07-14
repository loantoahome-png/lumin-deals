// Fixture check for lib/leadRoi.ts — pure logic, no DB.
// Run: npx tsx scripts/lead-roi-check.ts   (or the tsc+node combo used by lead-report-check)
import {
  rangeBounds, monthsBetween, parseLocalMs, anchorDate, filterDeals, buildSourceStats,
  rollupKpis, funnel, stateRows, monthlySeries, projection, sourceLabel,
  optout7dStats, insights,
  type CostRow, type RoiFilters,
} from '../lib/leadRoi'
import type { Deal } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
function approx(label: string, got: number | null, want: number, eps = 0.01) {
  const ok = got != null && Math.abs(got - want) < eps
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ~${want}`) }
}

// Minimal Deal factory — only the fields leadRoi reads.
const deal = (p: Partial<Deal>): Deal => ({
  id: 'x', name: 'Test', status: 'New Lead', pipeline_group: 'Leads',
  loan_officer: 'Moe Sefati', source: 'FRU', state: 'CA',
  lead_price: 0, compensation_amount: null, loan_amount: null,
  loan_purpose: 'Refinance', date_added_ghl: '2026-03-10', funded_date: null,
  ...p,
} as Deal)

// ── Date anchoring ─────────────────────────────────────────────────────────────
eq('lead anchors on date_added_ghl', anchorDate(deal({})), '2026-03-10')
eq('funded anchors on funded_date strictly',
  anchorDate(deal({ pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-04-02', date_added_ghl: '2026-01-05' })),
  '2026-04-02')
eq('funded without funded_date anchors nowhere',
  anchorDate(deal({ pipeline_group: 'Funded', status: 'Loan Funded', funded_date: null })), null)
eq('status-funded outside Funded group also uses funded_date rule',
  anchorDate(deal({ pipeline_group: 'Leads', status: 'Broker Check Received', funded_date: null })), null)

// Date-only strings parse as LOCAL midnight (not UTC — the 1st-of-month bug)
const firstOfMonth = parseLocalMs('2026-05-01')
eq('date-only parses as local midnight', firstOfMonth, new Date(2026, 4, 1).getTime())

// ── rangeBounds / monthsBetween ────────────────────────────────────────────────
const now = new Date(2026, 6, 13, 12)   // Jul 13 2026 local
const tm = rangeBounds('this_month', '', '', now)
eq('this_month starts Jul 1', tm.start?.getTime(), new Date(2026, 6, 1).getTime())
const lmo = rangeBounds('last_month', '', '', now)
eq('last_month is June', [lmo.start?.getMonth(), lmo.end?.getMonth()], [5, 5])
eq('ytd starts Jan 1', rangeBounds('ytd', '', '', now).start?.getTime(), new Date(2026, 0, 1).getTime())
eq('all time unbounded', rangeBounds('all', '', '', now), { start: null, end: null })
approx('monthsBetween ~6 for Jan–Jun', monthsBetween(new Date(2026, 0, 1), new Date(2026, 5, 30)), 5.9, 0.2)
eq('monthsBetween all-time = 12', monthsBetween(null, null), 12)

// ── Filtering ──────────────────────────────────────────────────────────────────
const book: Deal[] = [
  deal({ id: 'a', loan_officer: 'Moe Sefati', status: 'Pitching' }),
  deal({ id: 'b', loan_officer: 'moe' }),                                    // resolves to Moe Sefati
  deal({ id: 'c', loan_officer: 'Matt Park' }),
  deal({ id: 'd', loan_officer: 'Randy Mathis', source: 'Lendgo' }),
  deal({ id: 'e', loan_officer: 'Moe Sefati', source: 'Self Source' }),      // warm — excluded in Purchased scope
  deal({ id: 'f', loan_officer: 'Moe Sefati', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-06-15', lead_price: 50, compensation_amount: 3000, loan_amount: 400000 }),
  deal({ id: 'g', loan_officer: 'Moe Sefati', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: null }),      // undatable funded
]
const f = (over: Partial<RoiFilters>): RoiFilters => ({
  lo: 'Moe Sefati', scope: 'Purchased', purpose: 'All', stage: '', start: null, end: null, ...over,
})
eq('LO tab isolates one LO (variants resolve)',
  filterDeals(book, f({})).map(d => d.id), ['a', 'b', 'f', 'g'])
eq('Matt sees only Matt', filterDeals(book, f({ lo: 'Matt Park' })).map(d => d.id), ['c'])
eq('All-sources scope includes warm', filterDeals(book, f({ scope: 'All' })).map(d => d.id), ['a', 'b', 'e', 'f', 'g'])
eq('undatable funded hidden in bounded range',
  filterDeals(book, f({ start: new Date(2026, 5, 1), end: new Date(2026, 5, 30) })).map(d => d.id), ['f'])
eq('stage group filter', filterDeals(book, f({ stage: 'Funded' })).map(d => d.id), ['f', 'g'])
eq('stage status filter', filterDeals(book, f({ stage: 'Pitching' })).map(d => d.id), ['a'])

// ── Source stats: blended spend + ROI multiple ─────────────────────────────────
const costs = new Map<string, CostRow>([
  ['FRU', { source: 'FRU', cost_per_month: 100, notes: null, updated_at: '' }],
])
const moes = filterDeals(book, f({}))
const stats = buildSourceStats(moes, costs, 2)   // 2-month range → $200 retainer
const fru = stats.find(s => s.source === 'FRU')!
eq('FRU lead count', fru.total, 4)
eq('FRU funded (incl. undatable)', fru.funded, 2)
approx('FRU leadCost', fru.leadCost, 50)
approx('FRU retainer 100×2', fru.retainer, 200)
approx('FRU blended spend', fru.spend, 250)
approx('FRU revenue (comp on funded)', fru.revenue, 3000)
approx('FRU ROI = rev÷spend multiple', fru.roi, 12)
approx('FRU net = rev − spend', fru.netProfit, 2750)
approx('FRU cost/funded = spend÷funded', fru.costPerFunded, 125)
eq('responded excludes cold new-lead rows', fru.responded, 3)   // a (Pitching) + f + g funded

// ── KPI rollup + funnel ────────────────────────────────────────────────────────
const k = rollupKpis(stats)
eq('kpis leads', k.totalLeads, 4)
approx('kpis roi', k.roi, 12)
approx('kpis avgComp', k.avgComp, 1500)   // 3000 across 2 funded
const fn = funnel(k)
eq('funnel stages', fn.map(s => s.n), [4, 3, 2, 2])   // 0 active → became-a-loan = funded

// ── States ─────────────────────────────────────────────────────────────────────
const st = stateRows(moes)
eq('state rollup', st[0].state, 'CA')
eq('state funded', st[0].funded, 2)

// ── Monthly series ─────────────────────────────────────────────────────────────
const ms = monthlySeries(moes, 0)
// spend lands Mar (lead-in of the priced funded lead f: date_added 2026-03-10, price 50)
// revenue lands Jun (funded_date 2026-06-15, comp 3000); span fills Mar..Jun
eq('series spans Mar–Jun', ms.map(p => p.key), ['2026-03', '2026-04', '2026-05', '2026-06'])
approx('Mar spend', ms[0].spend, 50)
approx('Jun revenue', ms[3].revenue, 3000)
eq('empty months are zero', [ms[1].spend, ms[1].revenue], [0, 0])
const msr = monthlySeries(moes, 10)   // retainer spread: every month +10
approx('retainer spread into each month', msr[1].spend, 10)

// ── Projection ─────────────────────────────────────────────────────────────────
const withActive: Deal[] = [
  ...moes,
  deal({ id: 'h', pipeline_group: 'Loans in Process', status: 'Submitted to UW', lead_price: 40, compensation_amount: 2000 }),
  deal({ id: 'i', pipeline_group: 'Loans in Process', status: 'Submitted to UW', lead_price: 40, compensation_amount: null }),
]
const stats2 = buildSourceStats(withActive, new Map(), 1)
const k2 = rollupKpis(stats2)
const proj = projection(stats2, k2)
eq('projection counts actives', proj.activeCount, 2)
eq('projection estimates comp-less actives', proj.estimatedCount, 1)
// avgComp over comp-bearing deals: f(3000) + h(2000) = 2500; addComp = 2000 + 2500
approx('projection addComp', proj.addComp, 4500)
approx('projection revenue', proj.projRevenue, 7500)
eq('projection funded', proj.projFunded, 4)

// ── Opt-out rate + early opt-out (≤7d) ─────────────────────────────────────────
const optBook: Deal[] = [
  deal({ id: 'o1', status: 'STOP', ghl_opportunity_id: 'opp1', date_added_ghl: '2026-06-01' }),
  deal({ id: 'o2', status: 'DND - SMS', ghl_opportunity_id: 'opp2', date_added_ghl: '2026-06-01' }),
  deal({ id: 'o3', status: 'Remove from All Automations', ghl_opportunity_id: 'opp3', date_added_ghl: '2026-06-01' }),
  deal({ id: 'o4', status: 'STOP', ghl_opportunity_id: null }),            // opt-out, no opp id → untimed
  deal({ id: 'o5', status: 'Pitching', ghl_opportunity_id: 'opp5' }),      // responded — not an opt-out
]
const optStats = buildSourceStats(optBook, new Map(), 1)
approx('per-source orate = optout ÷ leads', optStats[0].orate, 80)   // 4 of 5
const firstOptout = {
  opp1: '2026-06-05T12:00:00Z',   // day 4 → within 7
  opp2: '2026-06-20T12:00:00Z',   // day 19 → outside
  opp3: '2026-06-08T00:00:00Z',   // day 7 boundary → within (≤ 7d)
  opp5: '2026-06-02T00:00:00Z',   // event exists but lead is NOT in the opt-out bucket → ignored
}
const o7 = optout7dStats(optBook, firstOptout)
eq('optouts counts the current bucket', o7.optouts, 4)
eq('timed = opt-outs with event + creation date', o7.timed, 3)
eq('within-7d counts day-4 and day-7-boundary', o7.within, 2)
approx('withinPct = within ÷ timed', o7.withinPct, 66.67, 0.1)
approx('coverage = timed ÷ optouts', o7.coverage, 75)
const o7empty = optout7dStats(optBook, {})
eq('no events → zero coverage, no crash', [o7empty.timed, o7empty.within, o7empty.coverage], [0, 0, 0])

// ── Insights ───────────────────────────────────────────────────────────────────
const insBook: Deal[] = [
  // Alpha: 2 funded, roi 4× (spend 1000 → rev 4000), 25 leads worth of rows collapsed to essentials
  ...Array.from({ length: 23 }, (_, i) => deal({ id: `a${i}`, source: 'Alpha', status: 'Pitching', lead_price: 20 })),
  deal({ id: 'aF1', source: 'Alpha', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-06-10', lead_price: 270, compensation_amount: 2000 }),
  deal({ id: 'aF2', source: 'Alpha', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-06-11', lead_price: 270, compensation_amount: 2000 }),
  // Beta: 1 funded, roi 8× on tiny spend (best ROI), but small net
  deal({ id: 'bF', source: 'Beta', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-06-12', lead_price: 100, compensation_amount: 800 }),
  // Gamma: 30 leads, high response, no funded, underwater spend
  ...Array.from({ length: 30 }, (_, i) => deal({ id: `g${i}`, source: 'Gamma', status: i < 24 ? 'Pitching' : 'STOP', lead_price: 10 })),
  // Delta: 1 funded but underwater (roi 0.5×)
  deal({ id: 'dF', source: 'Delta', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-06-13', lead_price: 1000, compensation_amount: 500 }),
]
const insStats = buildSourceStats(insBook, new Map(), 1)
const ins = insights(insStats, 20)
eq('bestRoi = Beta (8×)', ins.bestRoi?.source, 'Beta')
eq('topNet = Alpha (biggest $)', ins.topNet?.source, 'Alpha')
eq('bestResponse needs ≥20 leads', ['Alpha', 'Gamma'].includes(ins.bestResponse?.source ?? ''), true)
eq('worstRoi = Delta (underwater)', ins.worstRoi?.source, 'Delta')
eq('highestOptout sized pick', ins.highestOptout?.source, 'Gamma')
const insEmpty = insights([])
eq('insights on empty book → all null', [insEmpty.bestRoi, insEmpty.topNet, insEmpty.bestResponse, insEmpty.worstRoi, insEmpty.highestOptout], [null, null, null, null, null])

// ── Misc ───────────────────────────────────────────────────────────────────────
eq('sourceLabel blank → sentinel', sourceLabel({ source: '  ' }), '(no source set)')

console.log(`\nlead-roi-check: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
