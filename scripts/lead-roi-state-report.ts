// Live read-out of the /lead-roi submission + per-state additions, straight from the DB.
// Run: npx tsx scripts/lead-roi-state-report.ts [LO name]
//
// Why it exists: /lead-roi renders EMPTY under the local auth-bypass dev server because
// `deals` RLS rejects anon reads (see the deals-rls note), so the browser cannot verify
// these numbers. This can. Pure read — writes nothing.
//
// It runs the SAME lib/leadRoi pipeline the page runs (filterDeals → buildSourceStats →
// rollupKpis → stateStats), so a disagreement between this and the
// page is a rendering bug, not a math one.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  filterDeals, buildSourceStats, rollupKpis, stateStats,
  isSubmitted, rangeBounds, monthsBetween,
} from '../lib/leadRoi'
import { LOAN_OFFICERS } from '../lib/types'
import type { Deal } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

// Must mirror LEAD_COLS in app/lead-roi/page.tsx — arive_file_no included, or the
// submission predicate goes inert and this report understates the page.
const COLS = 'id,name,source,loan_officer,pipeline_group,status,loan_amount,state,loan_purpose,loan_type,lead_price,compensation_amount,broker_corr,net_discount_points,date_added_ghl,funded_date,created_at,ghl_opportunity_id,arive_file_no'

const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const pct = (n: number) => n.toFixed(1) + '%'
const roi = (n: number | null) => (n == null ? '—' : n.toFixed(2) + '×')

async function main() {
  const rows: Deal[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('deals').select(COLS).range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as unknown as Deal[]))
    if (!data || data.length < 1000) break
  }

  // Repo-wide submission. `isSubmitted` is a status-rank test — the Arive file number
  // is created at APPLICATION and is deliberately never read (see lib/leadRoi).
  const priced = rows.filter(d => (d.lead_price ?? 0) > 0)
  const submitted = priced.filter(isSubmitted).length
  console.log(`Priced leads (all LOs): ${priced.length}`)
  console.log(`  submitted to UW: ${submitted} (${pct(100 * submitted / priced.length)})\n`)

  const { start, end } = rangeBounds('all')
  const months = monthsBetween(start, end)
  const target = process.argv[2]
  const los = target ? [target] : [...LOAN_OFFICERS]

  for (const lo of los) {
    const filtered = filterDeals(rows, { lo, scope: 'Purchased', purpose: 'All', stage: '', start, end })
    if (!filtered.length) { console.log(`── ${lo} — no purchased leads\n`); continue }
    const sources = buildSourceStats(filtered, new Map(), months)
    const k = rollupKpis(sources)
    console.log(`── ${lo} — ${k.totalLeads} agg leads · submitted ${k.submitted} (${pct(k.sr)}) · funded ${k.funded} (${pct(k.fr)})`)
    console.log('   SOURCE                LEADS   SUB %  FUNDED   FUND %        SPEND      NET REV     ROI')
    for (const s of sources.slice(0, 8)) {
      console.log(
        `   ${s.source.padEnd(20)} ${String(s.total).padStart(5)}  ${pct(s.sr).padStart(6)}  ${String(s.funded).padStart(6)}  ${pct(s.fr).padStart(6)}  ${money(s.spend).padStart(11)}  ${money(s.netRevenue).padStart(11)}  ${roi(s.roi).padStart(6)}`,
      )
    }
    // Drill into the biggest source — the per-state table the page now renders,
    // plus the reconciliation the UI footer claims.
    const top = sources[0]
    const st = stateStats(top.deals, top.retainer)
    console.log(`\n   ${top.source} by state:`)
    console.log('     ST   LEADS   RESP %   SUB %  FUNDED       SPEND      NET REV          NET     ROI')
    for (const r of st.slice(0, 8)) {
      console.log(
        `     ${r.state.padEnd(5)}${String(r.n).padStart(5)}  ${pct(r.rr).padStart(7)} ${pct(r.sr).padStart(7)}  ${String(r.funded).padStart(6)}  ${money(r.spend).padStart(10)}  ${money(r.netRevenue).padStart(11)}  ${money(r.netProfit).padStart(11)}  ${roi(r.roi).padStart(6)}`,
      )
    }
    const sum = (f: (r: typeof st[number]) => number) => st.reduce((a, r) => a + f(r), 0)
    const ok = (a: number, b: number) => (Math.abs(a - b) < 0.01 ? 'OK' : `MISMATCH (${a} vs ${b})`)
    console.log(`     reconcile → leads ${ok(sum(r => r.n), top.total)} · spend ${ok(sum(r => r.spend), top.spend)} · net ${ok(sum(r => r.netProfit), top.netProfit)} · submitted ${ok(sum(r => r.submitted), top.submitted)} · open ${ok(sum(r => r.open), top.open)} · active ${ok(sum(r => r.active), top.active)} · lost ${ok(sum(r => r.lost), top.lost)} · optout ${ok(sum(r => r.optout), top.optout)} · volume ${ok(sum(r => r.fundedVolume), top.fundedVolume)}`)

    console.log()
  }
}
main()
