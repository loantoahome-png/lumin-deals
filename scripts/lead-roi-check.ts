// Fixture check for lib/leadRoi.ts — pure logic, no DB.
// Run: npx tsx scripts/lead-roi-check.ts   (or the tsc+node combo used by lead-report-check)
import {
  rangeBounds, monthsBetween, parseLocalMs, anchorDate, filterDeals, buildSourceStats,
  rollupKpis, funnel, stateRows, monthlySeries, projection, sourceLabel,
  optout7dStats, insights, netOf, LO_SPLIT,
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
approx('FRU revenue (comp on funded) stays GROSS', fru.revenue, 3000)
eq('responded excludes cold new-lead rows', fru.responded, 3)   // a (Pitching) + f + g funded

// ── LO split: 85% of gross is what actually pays off a lead (2026-08-10) ───────
// Revenue keeps reporting the gross commission; netRevenue is the LO's share, and
// netProfit + roi are computed from NET, never gross. These four are the whole
// change — if one of them regresses to gross, every vendor looks ~18% better than
// it is and a losing source can read as profitable.
eq('LO_SPLIT is 85%', LO_SPLIT, 0.85)
approx('netOf applies the split', netOf(1000), 850)
approx('FRU netRevenue = revenue × 85%', fru.netRevenue, 2550)          // 3000 × 0.85
approx('FRU ROI = NET rev ÷ spend (was 12× on gross)', fru.roi, 10.2)   // 2550 ÷ 250
approx('FRU net profit = NET rev − spend', fru.netProfit, 2300)         // 2550 − 250
approx('FRU cost/funded = spend÷funded (unchanged by the split)', fru.costPerFunded, 125)

// The 0.85–1.00 band is the reason this change matters: a source that clears its
// cost on gross can still lose money once the house takes its cut.
const marginal = buildSourceStats(
  [deal({ id: 'm', source: 'Marginal', pipeline_group: 'Funded', status: 'Loan Funded',
          funded_date: '2026-06-01', lead_price: 1000, compensation_amount: 1100 })],
  new Map(), 1)[0]
approx('gross would have read 1.10× …', marginal.revenue / marginal.spend, 1.1)
approx('… but net ROI is under 1× — underwater', marginal.roi, 0.935)   // 935 ÷ 1000
eq('and net profit is negative', marginal.netProfit < 0, true)

// ── KPI rollup + funnel ────────────────────────────────────────────────────────
const k = rollupKpis(stats)
eq('kpis leads', k.totalLeads, 4)
approx('kpis revenue is GROSS', k.revenue, 3000)
approx('kpis netRevenue = 85%', k.netRevenue, 2550)
approx('kpis roi runs on net', k.roi, 10.2)
approx('kpis netProfit runs on net', k.netProfit, 2300)
approx('kpis avgComp = GROSS ÷ funded', k.avgComp, 1500)      // 3000 across 2 funded
approx('kpis avgNetComp = NET ÷ funded', k.avgNetComp, 1275)  // what cost/funded must beat
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
approx('Jun revenue stays gross on the point', ms[3].revenue, 3000)
approx('Jun netRevenue = 85% (what the bar plots)', ms[3].netRevenue, 2550)
eq('Jun ROI is null — revenue but no spend that month', ms[3].roi, null)
eq('empty months are zero', [ms[1].spend, ms[1].revenue, ms[1].netRevenue], [0, 0, 0])
const msr = monthlySeries(moes, 10)   // retainer spread: every month +10
approx('retainer spread into each month', msr[1].spend, 10)
// Jun now has $10 of retainer spend against $3000 gross / $2550 net comp.
approx('monthly ROI chip runs on NET, not gross', msr[3].roi, 255)   // 2550 ÷ 10, not 300

// ── Non-Del revenue: comp + Final Price credit (lib/comp.ts) ───────────────────
// Revenue must be totalComp, not the Arive comp column — on a Non-Del loan the
// price credit is real earned money and was invisible until 2026-08-03.
const nonDelBook: Deal[] = [
  deal({ id: 'nd', source: 'Lendgo', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-05-13',
         lead_price: 100, compensation_amount: 8212.35, loan_amount: 1094980,
         broker_corr: 'Non-Del', net_discount_points: 1.21 }),                                  // Fadel
  deal({ id: 'br', source: 'LMB', pipeline_group: 'Funded', status: 'Loan Funded', funded_date: '2026-05-06',
         lead_price: 100, compensation_amount: 8946, loan_amount: 447300,
         broker_corr: 'Broker', net_discount_points: 1.21 }),                                   // broker: no credit
]
const ndStats = buildSourceStats(nonDelBook, new Map(), 1)
const ndRev = ndStats.find(s => s.source === 'Lendgo')!
const brRev = ndStats.find(s => s.source === 'LMB')!
approx('Non-Del revenue = comp + price credit', ndRev.revenue, 21461.61)
approx('Broker revenue = comp alone', brRev.revenue, 8946)
// The 85% split takes BOTH halves (Efrain 2026-08-10) — the price credit is not
// exempt, so netRevenue is 85% of the combined figure, not comp×0.85 + credit.
approx('split applies to comp AND the Non-Del credit', ndRev.netRevenue, 18242.37)   // 21461.61 × 0.85
const ndSeries = monthlySeries(nonDelBook, 0)
approx('monthly revenue carries the credit', ndSeries.find(p => p.key === '2026-05')!.revenue, 30407.61)
approx('monthly netRevenue splits the credit too', ndSeries.find(p => p.key === '2026-05')!.netRevenue, 25846.47)

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
approx('projection addComp is GROSS', proj.addComp, 4500)
approx('projection addNetComp = 85%', proj.addNetComp, 3825)
approx('projection revenue is GROSS', proj.projRevenue, 7500)
// A projected loan is split like a funded one — 7500 × 0.85.
approx('projection netRevenue = 85% of projected gross', proj.projNetRevenue, 6375)
approx('projected net profit runs on net', proj.projNetProfit, 6375 - k2.spend)
approx('projected ROI runs on net', proj.projRoi, 6375 / k2.spend)
eq('projection funded', proj.projFunded, 4)

// ── Opt-out rate + early opt-out (≤7d) ─────────────────────────────────────────
// SPLIT 2026-07-16: "opt-out" here means the CUSTOMER told us to stop (STOP /
// DND - SMS). "Remove from All Automations" is a team disposition — the /hot-leads
// triage button — and is tracked as teamRemoved instead. Folding it in made lead
// quality look like it was collapsing when the team was just clearing a backlog.
const optBook: Deal[] = [
  deal({ id: 'o1', status: 'STOP', ghl_opportunity_id: 'opp1', date_added_ghl: '2026-06-01' }),
  deal({ id: 'o2', status: 'DND - SMS', ghl_opportunity_id: 'opp2', date_added_ghl: '2026-06-01' }),
  deal({ id: 'o3', status: 'Remove from All Automations', ghl_opportunity_id: 'opp3', date_added_ghl: '2026-06-01', last_inbound_at: null }),  // TEAM, no reply → no-response
  deal({ id: 'o4', status: 'STOP', ghl_opportunity_id: null }),            // opt-out, no opp id → untimed
  deal({ id: 'o5', status: 'Pitching', ghl_opportunity_id: 'opp5' }),      // responded — neither
]
const optStats = buildSourceStats(optBook, new Map(), 1)
approx('per-source orate = CUSTOMER optout ÷ leads', optStats[0].orate, 60)   // o1,o2,o4 of 5
approx('per-source trate = team-removed ÷ leads', optStats[0].trate, 20)      // o3 of 5 (overlay)
eq('team-removed is NOT in optout', optStats[0].optout, 3)
eq('team-removed counted separately (overlay)', optStats[0].teamRemoved, 1)
eq('team-removed w/o inbound folds into cold (no-response)', optStats[0].cold, 1)   // o3
// {responded, cold, optout} partition the total; teamRemoved is now an OVERLAY (o3 is
// ALSO in cold), so don't add it here: responded(o5) + cold(o3) + optout(o1,o2,o4) = 5.
eq('per-source buckets partition total',
   optStats[0].responded + optStats[0].cold + optStats[0].optout,
   optStats[0].total)

const firstOptout = {
  opp1: '2026-06-05T12:00:00Z',   // day 4 → within 7
  opp2: '2026-06-20T12:00:00Z',   // day 19 → outside
  opp3: '2026-06-08T00:00:00Z',   // team-removed → must be IGNORED now (was counted pre-split)
  opp5: '2026-06-02T00:00:00Z',   // event exists but lead is NOT an opt-out → ignored
}
const o7 = optout7dStats(optBook, firstOptout)
eq('optouts = CUSTOMER opt-outs only (o1,o2,o4)', o7.optouts, 3)
eq('timed = customer opt-outs with event + creation date (o1,o2)', o7.timed, 2)
eq('within-7d counts day-4 only (o3 no longer inflates it)', o7.within, 1)
approx('withinPct = within ÷ timed', o7.withinPct, 50)
approx('coverage = timed ÷ optouts', o7.coverage, 66.67, 0.1)
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
// The split is uniform, so RANKINGS are unchanged — but the reported multiples are
// net. Beta was 8× on gross ($800 comp ÷ $100 spend); it is 6.8× on what Beta's
// leads actually put in the LO's pocket.
eq('bestRoi = Beta (ranking survives the split)', ins.bestRoi?.source, 'Beta')
approx('…and its ROI is reported NET', ins.bestRoi?.roi ?? null, 6.8)
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
