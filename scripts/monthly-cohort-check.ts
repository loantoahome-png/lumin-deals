// Fixture check for lib/monthlyCohort.ts — the lead-in cohort math. Pure, no DB.
// Run: npx tsx scripts/monthly-cohort-check.ts
//
// Locks the one rule that makes this page different from /lead-roi: every number
// belongs to the month the lead CAME IN, including revenue from a loan that funded
// months later. The anchor case is Larisa Fuchs — came in 2026-05-01, funded
// 2026-06-02 — who must count as MAY revenue here and JUNE revenue on /lead-roi.
import {
  monthPeriod, customPeriod, monthSpan, monthsInData, cohortOf, daysToFund,
  totals, bySource, monthlyRows, scopeLeads, undated, maturity, medianDaysToFundAll,
  type CohortLead,
} from '../lib/monthlyCohort'
import type { CostRow } from '../lib/leadRoi'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
function approx(label: string, got: number | null, want: number, eps = 0.01) {
  const ok = got != null && Math.abs(got - want) < eps
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ~${want}`) }
}

const lead = (p: Partial<CohortLead>): CohortLead => ({
  id: 'x', name: 'Test', status: 'New Lead', pipeline_group: 'Leads',
  loan_officer: 'Moe Sefati', source: 'FRU', state: 'CA', loan_purpose: 'Purchase',
  lead_price: 30, compensation_amount: null, loan_amount: null,
  broker_corr: null, net_discount_points: null,
  date_added_ghl: '2026-05-10T12:00:00.000Z', funded_date: null,
  ...p,
} as CohortLead)

// ── Period construction ──────────────────────────────────────────────────────
const may = monthPeriod('2026-05')
eq('May label', may.label, 'May 2026')
eq('May starts on the 1st', may.start.getDate(), 1)
eq('May ends on the 31st', may.end.getDate(), 31)
eq('May end is inclusive to the last ms', may.end.getHours(), 23)
eq('February 2026 ends on the 28th', monthPeriod('2026-02').end.getDate(), 28)
eq('a single month spans 1', monthSpan(may), 1)
eq('Mar–May spans 3', monthSpan({ ...may, start: new Date(2026, 2, 1), end: new Date(2026, 4, 31) }), 3)
eq('a custom range covers its last day', customPeriod('2026-05-01', '2026-05-31')?.end.getDate(), 31)
eq('a half-open custom range is rejected', customPeriod('2026-05-01', ''), null)

// ⚠️ Date-only strings must parse as LOCAL midnight or a 1st-of-month lead falls
// out of its own cohort in Pacific. This is the same trap as parseLocalMs.
eq('a lead dated the 1st is IN that month',
  cohortOf([lead({ date_added_ghl: '2026-05-01' })], may).length, 1)
eq('a lead dated the last day is IN that month',
  cohortOf([lead({ date_added_ghl: '2026-05-31' })], may).length, 1)
eq('a lead dated the 1st of the NEXT month is OUT',
  cohortOf([lead({ date_added_ghl: '2026-06-01' })], may).length, 0)
eq('an undated lead is in NO cohort',
  cohortOf([lead({ date_added_ghl: null })], may).length, 0)
eq('undated leads are surfaced, not dropped silently',
  undated([lead({ date_added_ghl: null }), lead({})]).length, 1)

// ── THE ANCHOR: Larisa Fuchs ─────────────────────────────────────────────────
// Real row. Lead in 2026-05-01, funded 2026-06-02, $121,741, comp $2,899.
const larisa = lead({
  name: 'Larisa Fuchs', date_added_ghl: '2026-05-01T19:26:04.978Z',
  funded_date: '2026-06-02', pipeline_group: 'Funded', status: 'Loan Funded',
  loan_amount: 121741, compensation_amount: 2899, lead_price: 29,
})
eq('Larisa belongs to MAY, the month she came in', cohortOf([larisa], may).length, 1)
eq('…and NOT to June, the month she funded', cohortOf([larisa], monthPeriod('2026-06')).length, 0)
eq('Larisa took 32 days lead-to-funding', daysToFund(larisa), 32)
eq('days-to-fund is null while a lead is unfunded', daysToFund(lead({})), null)

const t = totals([larisa], 0, 1)
eq('one funded lead', t.funded, 1)
eq('100% of a one-lead cohort funded', t.fundedPct, 100)
approx('gross revenue = the Arive comp', t.grossRevenue, 2899)
approx('net revenue = 85% of gross', t.netRevenue, 2464.15)
approx('spend = her lead price', t.spend, 29)
approx('ROI is gross ÷ spend, a multiple', t.roi, 99.97)
approx('net ROI is the one that pays the bills', t.netRoi, 84.97)
approx('net profit = net revenue − spend', t.netProfit, 2435.15)
approx('cost per funded = spend ÷ funded', t.costPerFunded, 29)

// ── Spend: retainers ride the months, lead prices ride the leads ─────────────
const three = [lead({ lead_price: 30 }), lead({ lead_price: 20 }), lead({ lead_price: 0 })]
const r3 = totals(three, 500, 1)
approx('lead spend sums every price', r3.leadSpend, 50)
approx('retainer = per-month × months', r3.retainer, 500)
approx('spend = lead prices + retainer', r3.spend, 550)
approx('a 3-month period charges 3 retainers', totals(three, 500, 3).retainer, 1500)
approx('cost per lead spreads the retainer too', r3.costPerLead, 550 / 3)
eq('ROI is null when nothing was spent', totals([lead({ lead_price: 0 })], 0, 1).roi, null)
eq('cost per funded is null with no funded loan', r3.costPerFunded, null)

// ⚠️ lead_price is per OPPORTUNITY — the same person bought twice is two charges.
const twice = [lead({ id: 'a', name: 'Same Guy', lead_price: 30 }), lead({ id: 'b', name: 'Same Guy', lead_price: 30 })]
approx('the same borrower bought twice costs twice', totals(twice, 0, 1).leadSpend, 60)

// ── Funded revenue counts whenever it landed ─────────────────────────────────
const mayCohort = [
  larisa,
  lead({ id: 'l2', date_added_ghl: '2026-05-15', funded_date: '2026-08-01', pipeline_group: 'Funded', status: 'Loan Funded', compensation_amount: 5000, loan_amount: 300000, lead_price: 30 }),
  lead({ id: 'l3', date_added_ghl: '2026-05-20', status: 'Non-Responsive', lead_price: 30 }),
  lead({ id: 'l4', date_added_ghl: '2026-05-22', status: 'Application Started', lead_price: 30 }),
]
const mt = totals(mayCohort, 0, 1)
eq('4 leads in the May cohort', mt.leads, 4)
eq('2 of them funded — one in June, one in August', mt.funded, 2)
approx('May earned both loans\' comp regardless of funding month', mt.grossRevenue, 7899)
eq('50% funded rate', mt.fundedPct, 50)
eq('non-responsive does not count as responded', mt.responded, 3)
eq('an unfunded live lead counts as in-flight', mt.inFlight, 1)
eq('median days-to-fund across 32 and 78', mt.medianDaysToFund, 78)

// ── Per-source split ─────────────────────────────────────────────────────────
const costs = new Map<string, CostRow>([
  ['LMB', { source: 'LMB', cost_per_month: 200, notes: null, updated_at: '' }],
])
const mixed = [
  lead({ id: 's1', source: 'FRU', lead_price: 30, funded_date: '2026-06-01', pipeline_group: 'Funded', compensation_amount: 3000 }),
  lead({ id: 's2', source: 'LMB', lead_price: 40 }),
  lead({ id: 's3', source: 'LMB', lead_price: 40 }),
]
const rows = bySource(mixed, costs, 1)
eq('one row per source', rows.length, 2)
eq('sorted by spend, biggest first', rows[0].source, 'LMB')
approx('LMB carries its own retainer', rows[0].spend, 280)
approx('FRU has no retainer configured', rows[1].spend, 30)
eq('FRU is the one with a funded loan', rows[1].funded, 1)

// ── Scope: purchased only, one LO ────────────────────────────────────────────
const scoped = scopeLeads([
  lead({ id: 'p1', source: 'FRU', loan_officer: 'Moe Sefati' }),
  lead({ id: 'p2', source: 'Self Source', loan_officer: 'Moe Sefati' }),   // warm → out
  lead({ id: 'p3', source: 'FRU', loan_officer: 'Matt Park' }),            // other LO → out
  lead({ id: 'p4', source: 'FRU', loan_officer: 'Moe' }),                  // resolveLO folds it in
], 'Moe Sefati')
eq('purchased + this LO only', scoped.map(l => l.id), ['p1', 'p4'])

// ── Month rows + maturity ────────────────────────────────────────────────────
const now = new Date(2026, 7, 10)   // 2026-08-10
const mr = monthlyRows(mayCohort, new Map(), now)
eq('one row per month present in the data', mr.length, 1)
eq('newest month first', mr[0].period.key, '2026-05')
// Aug 10 minus May 31 = 70 days. Measured from the month's END, not its start —
// a cohort's youngest lead is what limits how much it can be judged.
eq('age measured from the month END', mr[0].ageDays, 70)

eq('months in data are newest-first',
  monthsInData([lead({ date_added_ghl: '2026-03-02' }), lead({ date_added_ghl: '2026-07-02' })]).map(p => p.key),
  ['2026-07', '2026-03'])

eq('median days-to-fund all-time', medianDaysToFundAll(mayCohort), 78)
const row = mr[0]
eq('a cohort older than 2× the median is mature', maturity(row.ageDays, 30), 'mature')
eq('…between 1× and 2× is partial', maturity(row.ageDays, 50), 'partial')
eq('…younger than the median is still in flight', maturity(row.ageDays, 100), 'young')
eq('no yardstick → never claim mature', maturity(row.ageDays, null), 'partial')

console.log(`\n${fail === 0 ? '✓' : '✗'} monthly-cohort: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
