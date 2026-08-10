// Live report for /monthly-reports — runs the page's EXACT math (lib/monthlyCohort.ts)
// against the real `deals` table and prints what the page will render.
//
// Run: npx tsx scripts/monthly-cohort-report.ts ["Moe Sefati"]
//
// ⚠️ Deliberately NOT named *-check.ts — every check in this repo must run offline.
// This one needs the DB, and it exists because /monthly-reports renders EMPTY under
// the local auth-bypass dev server (`deals` RLS rejects anon reads), so the browser
// cannot verify the data path. This can.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  monthlyRows, monthsInData, cohortOf, totals, bySource, scopeLeads, undated,
  maturity, medianDaysToFundAll, daysToFund, monthPeriod,
  type CohortLead,
} from '../lib/monthlyCohort'
import { isFunded } from '../lib/leadReport'
import { LO_SPLIT, type CostRow } from '../lib/leadRoi'
import { LOAN_OFFICERS } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const pct = (n: number) => `${n.toFixed(1)}%`
const mult = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}×`)
const BREAKEVEN = 1 / LO_SPLIT

async function allDeals(): Promise<CohortLead[]> {
  // ⚠️ A bare select caps at 1000 rows — paginate or every total here is wrong.
  const out: CohortLead[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('deals')
      .select('id,name,source,loan_officer,pipeline_group,status,loan_amount,state,loan_purpose,loan_type,lead_price,compensation_amount,broker_corr,net_discount_points,date_added_ghl,funded_date,last_inbound_at')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) { console.error(error); process.exit(1) }
    out.push(...((data ?? []) as unknown as CohortLead[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function main() {
  const deals = await allDeals()
  const { data: costRows } = await sb.from('lead_source_costs').select('*')
  const costs = new Map<string, CostRow>(((costRows ?? []) as CostRow[]).map(c => [c.source, c]))
  const retainerPerMonth = [...costs.values()].reduce((a, c) => a + (Number(c.cost_per_month) || 0), 0)

  console.log(`deals loaded: ${deals.length} · retainers configured: ${costs.size} ($${retainerPerMonth}/mo)\n`)

  const target = process.argv[2]
  for (const lo of (target ? [target] : [...LOAN_OFFICERS])) {
    const book = scopeLeads(deals, lo)
    const medianAll = medianDaysToFundAll(book)
    const missing = undated(book)
    console.log('═'.repeat(96))
    console.log(`${lo} — ${book.length} purchased leads · median lead→fund ${medianAll ?? '—'} days · ${missing.length} without a lead-in date`)
    console.log('═'.repeat(96))
    if (!book.length) { console.log('  (none)\n'); continue }

    const rows = monthlyRows(book, costs, new Date())
    console.log(`\n${'Month'.padEnd(16)}${'Leads'.padStart(7)}${'Spend'.padStart(10)}${'Funded'.padStart(8)}${'Fund%'.padStart(8)}${'$/funded'.padStart(10)}${'Net rev'.padStart(10)}${'Net profit'.padStart(12)}${'ROI'.padStart(8)}${'Med d'.padStart(7)}  Maturity`)
    for (const r of rows) {
      const m = maturity(r.ageDays, medianAll)
      console.log(
        r.period.label.padEnd(16) +
        String(r.leads).padStart(7) +
        money(r.spend).padStart(10) +
        String(r.funded).padStart(8) +
        pct(r.fundedPct).padStart(8) +
        (r.costPerFunded != null ? money(r.costPerFunded) : '—').padStart(10) +
        money(r.netRevenue).padStart(10) +
        money(r.netProfit).padStart(12) +
        mult(r.roi).padStart(8) +
        (r.medianDaysToFund != null ? `${r.medianDaysToFund}d` : '—').padStart(7) +
        `  ${m}`,
      )
    }

    // Detail on the most recent MATURE month — the one worth judging.
    const judged = rows.find(r => maturity(r.ageDays, medianAll) === 'mature') ?? rows[rows.length - 1]
    if (judged) {
      const period = monthPeriod(judged.period.key)
      const cohort = cohortOf(book, period)
      console.log(`\n  ── ${period.label} detail (${cohort.length} leads) ──`)
      for (const s of bySource(cohort, costs, 1)) {
        console.log(`     ${s.source.padEnd(14)} ${String(s.leads).padStart(4)} leads · ${money(s.spend).padStart(8)} · ${s.funded} funded · net ${money(s.netRevenue).padStart(9)} · profit ${money(s.netProfit).padStart(9)} · ROI ${mult(s.roi)}${s.roi != null && s.roi < BREAKEVEN && s.roi >= 1 ? '  ⚠️ clears gross, loses net' : ''}`)
      }
      const funded = cohort.filter(isFunded)
      if (funded.length) {
        console.log(`\n     what it produced:`)
        for (const d of funded) {
          console.log(`       ${String(d.name).padEnd(22)} ${String(d.source).padEnd(12)} in ${String(d.date_added_ghl).slice(0, 10)} → funded ${d.funded_date} (${daysToFund(d)}d)`)
        }
      }
    }
    console.log()
  }

  // Cross-check: the cohort view must not invent or lose funded loans.
  const allPurchased = deals.filter(d => scopeLeads([d], 'Matt Park').length || scopeLeads([d], 'Moe Sefati').length || scopeLeads([d], 'Randy Mathis').length)
  const fundedTotal = allPurchased.filter(isFunded).length
  const placed = monthsInData(allPurchased).reduce((a, p) => a + cohortOf(allPurchased, p).filter(isFunded).length, 0)
  console.log('═'.repeat(96))
  console.log(`RECONCILIATION · purchased funded loans: ${fundedTotal} · placed into a month cohort: ${placed} · unplaceable (no lead-in date): ${fundedTotal - placed}`)
  const t = totals(allPurchased, 0, 1)
  console.log(`all-LO purchased totals (sanity only, never shown combined on the page): ${t.leads} leads · ${money(t.leadSpend)} lead spend · ${t.funded} funded · ${money(t.netRevenue)} net`)
}
main()
