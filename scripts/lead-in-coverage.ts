// How usable is date_added_ghl as a COHORT ANCHOR? (read-only)
// A "leads that came in during month M" report can only see rows that have it.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const PURCHASED = ['FRU', 'LMB', 'Lendgo', 'LeadPoint', 'OwnUp', 'Sales Rush', 'Others']

async function main() {
  // ⚠️ A bare select caps at 1000 rows — paginate or the whole report is a lie.
  const rows: any[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('deals')
      .select('id,source,lead_price,funded_date,date_added_ghl,created_at,pipeline_group,loan_officer')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) { console.error(error); process.exit(1) }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  console.log(`rows: ${rows.length}\n`)

  const bucket = (r: any) => {
    const s = (r.source ?? '').trim()
    if (!s) return '(no source)'
    return PURCHASED.includes(s) ? 'PURCHASED' : 'warm/organic'
  }

  const groups = new Map<string, { n: number; withDate: number; spend: number; spendWithDate: number; funded: number; fundedWithDate: number }>()
  for (const r of rows) {
    const k = bucket(r)
    const g = groups.get(k) ?? { n: 0, withDate: 0, spend: 0, spendWithDate: 0, funded: 0, fundedWithDate: 0 }
    g.n++
    const has = !!r.date_added_ghl
    if (has) g.withDate++
    const p = Number(r.lead_price ?? 0)
    g.spend += p
    if (has) g.spendWithDate += p
    if (r.funded_date) { g.funded++; if (has) g.fundedWithDate++ }
    groups.set(k, g)
  }

  console.log('date_added_ghl coverage — can a cohort report see this row?\n')
  for (const [k, g] of [...groups].sort()) {
    const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : '—'
    console.log(`${k}`)
    console.log(`   leads      ${g.withDate}/${g.n} have a lead-in date  (${pct(g.withDate, g.n)})`)
    console.log(`   spend      $${g.spendWithDate.toFixed(0)}/$${g.spend.toFixed(0)}  (${pct(g.spendWithDate, g.spend)})`)
    console.log(`   funded     ${g.fundedWithDate}/${g.funded}  (${pct(g.fundedWithDate, g.funded)})`)
  }

  // Purchased leads by lead-in month — is the history deep enough for a month picker?
  const byMonth = new Map<string, { leads: number; spend: number; funded: number }>()
  for (const r of rows) {
    if (bucket(r) !== 'PURCHASED' || !r.date_added_ghl) continue
    const m = String(r.date_added_ghl).slice(0, 7)
    const g = byMonth.get(m) ?? { leads: 0, spend: 0, funded: 0 }
    g.leads++; g.spend += Number(r.lead_price ?? 0); if (r.funded_date) g.funded++
    byMonth.set(m, g)
  }
  console.log('\nPurchased leads BY LEAD-IN MONTH (the proposed anchor):')
  for (const [m, g] of [...byMonth].sort()) {
    console.log(`   ${m}   ${String(g.leads).padStart(4)} leads · $${String(g.spend.toFixed(0)).padStart(6)} spend · ${g.funded} funded (${g.leads ? (g.funded / g.leads * 100).toFixed(1) : '0'}%)`)
  }
}
main()
