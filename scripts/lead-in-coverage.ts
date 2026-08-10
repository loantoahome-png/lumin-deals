// How usable is date_added_ghl as a COHORT ANCHOR? (read-only)
// A "leads that came in during month M" report can only see rows that have it.
//
// ⚠️ Buckets with the APP's own isPurchased (lib/leadReport PURCHASED_SOURCES), not a
// hand-typed list — an ad-hoc list got this wrong once by omitting Lending Tree.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { isPurchased, isFunded, type LeadRow } from '../lib/leadReport'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

type Row = LeadRow & { date_added_ghl: string | null; funded_date: string | null }

async function main() {
  // ⚠️ A bare select caps at 1000 rows — paginate or the whole report is a lie.
  const rows: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('deals')
      .select('id,source,lead_price,funded_date,date_added_ghl,pipeline_group,status,loan_officer,loan_purpose,loan_type,state,compensation_amount')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) { console.error(error); process.exit(1) }
    rows.push(...((data ?? []) as unknown as Row[]))
    if (!data || data.length < PAGE) break
  }
  console.log(`rows: ${rows.length}\n`)

  const bucket = (r: Row) => (isPurchased(r) ? 'PURCHASED (agg leads)' : 'warm / organic / unset')
  const groups = new Map<string, { n: number; withDate: number; spend: number; spendWithDate: number; funded: number; fundedWithDate: number }>()
  for (const r of rows) {
    const k = bucket(r)
    const g = groups.get(k) ?? { n: 0, withDate: 0, spend: 0, spendWithDate: 0, funded: 0, fundedWithDate: 0 }
    g.n++
    const has = !!r.date_added_ghl
    if (has) g.withDate++
    const p = Number(r.lead_price ?? 0)
    g.spend += p; if (has) g.spendWithDate += p
    if (isFunded(r)) { g.funded++; if (has) g.fundedWithDate++ }
    groups.set(k, g)
  }

  console.log('date_added_ghl coverage — can a cohort report see this row?\n')
  const pct = (a: number, b: number) => (b ? `${(a / b * 100).toFixed(1)}%` : '—')
  for (const [k, g] of [...groups].sort()) {
    console.log(k)
    console.log(`   leads   ${g.withDate}/${g.n} have a lead-in date  (${pct(g.withDate, g.n)})`)
    console.log(`   spend   $${g.spendWithDate.toFixed(0)}/$${g.spend.toFixed(0)}  (${pct(g.spendWithDate, g.spend)})`)
    console.log(`   funded  ${g.fundedWithDate}/${g.funded}  (${pct(g.fundedWithDate, g.funded)})`)
  }

  const byMonth = new Map<string, { leads: number; spend: number; funded: number }>()
  for (const r of rows) {
    if (!isPurchased(r) || !r.date_added_ghl) continue
    const m = String(r.date_added_ghl).slice(0, 7)
    const g = byMonth.get(m) ?? { leads: 0, spend: 0, funded: 0 }
    g.leads++; g.spend += Number(r.lead_price ?? 0); if (isFunded(r)) g.funded++
    byMonth.set(m, g)
  }
  console.log('\nAgg leads BY LEAD-IN MONTH (the /monthly-reports anchor):')
  for (const [m, g] of [...byMonth].sort()) {
    console.log(`   ${m}   ${String(g.leads).padStart(4)} leads · $${String(g.spend.toFixed(0)).padStart(6)} spend · ${g.funded} funded (${g.leads ? (g.funded / g.leads * 100).toFixed(1) : '0'}%)`)
  }
}
main()
