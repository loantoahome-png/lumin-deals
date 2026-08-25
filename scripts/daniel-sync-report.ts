// Live report — did Daniel McGrail-Granger's GHL sub-account actually sync?
//
// Reads the live DB with the service role. Deliberately NOT named *-check.ts:
// the fixture runner globs that pattern and every check there must run offline.
//
//   npx tsx scripts/daniel-sync-report.ts

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { totalComp } from '../lib/comp'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const DANIEL_LOCATION = 'Nt66emmbEuBZVmti60nJ'
const money = (n: number) => '$' + Math.round(n).toLocaleString()

async function main() {
  // ⚠️ The sync stamps its cursor PER ACCOUNT under `ghl_sync_last:<label>`, not
  // as one global key. That distinction is the whole diagnostic: if a `daniel`
  // row is absent the sync never saw the account (env/deploy problem), whereas a
  // `daniel` row WITH zero deals means it authenticated and found nothing (token
  // scope problem). Without this you cannot tell those two apart.
  const { data: st } = await sb.from('sync_state').select('key,value,updated_at').order('updated_at', { ascending: false })
  console.log('sync cursors:')
  const cursors = (st ?? []).filter(r => String(r.key).startsWith('ghl_sync_last'))
  if (cursors.length === 0) console.log('  (none — the GHL sync has never recorded a cursor)')
  for (const r of cursors) console.log(`  ${String(r.key).padEnd(30)} ${String(r.updated_at).slice(0, 19)}  ${JSON.stringify(r.value).slice(0, 70)}`)
  const lock = (st ?? []).find(r => r.key === 'ghl_sync_lock')
  if (lock) console.log(`  ${'ghl_sync_lock'.padEnd(30)} ${String(lock.updated_at).slice(0, 19)}  ${JSON.stringify(lock.value)}`)

  // Paginate: a bare select caps at 1000 rows.
  const all: Record<string, any>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('loan_officer,ghl_location_id,pipeline_group,loan_amount,source,lead_price,compensation_amount,broker_corr,net_discount_points,funded_date,arive_file_no')
      .range(from, from + 999)
    if (error) { console.error("QUERY ERROR:", error.message); process.exit(1) }
    all.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  console.log(`\ntotal deals in DB: ${all.length}`)

  // Whole-board snapshot. The Arive CSV carried 471 rows for the OTHER three LOs,
  // so this is the check that the import didn't move their money while adding his.
  // ⚠️ Revenue MUST come from lib/comp.ts totalComp(), never compensation_amount
  // and never a hand-rolled sum: net_discount_points is a PERCENT of loan_amount,
  // gated on broker_corr === 'Non-Del'. Adding it as dollars understates every
  // Non-Del loan by thousands. (I got this wrong on the first pass.)
  const LOS = ['Matt Park', 'Moe Sefati', 'Randy Mathis', 'Daniel McGrail-Granger']
  console.log('\nper-LO board state:')
  console.log('  ' + 'LO'.padEnd(26) + 'deals'.padStart(7) + 'funded'.padStart(8) + 'volume'.padStart(15) + 'comp'.padStart(12) + 'arive'.padStart(8))
  for (const lo of LOS) {
    const rows = all.filter(d => d.loan_officer === lo)
    const fd = rows.filter(d => d.pipeline_group === 'Funded')
    console.log('  ' + lo.padEnd(26) + String(rows.length).padStart(7) + String(fd.length).padStart(8) +
      money(fd.reduce((s2, d) => s2 + (d.loan_amount ?? 0), 0)).padStart(15) +
      money(fd.reduce((s2, d) => s2 + totalComp(d), 0)).padStart(12) +
      String(rows.filter(d => d.arive_file_no).length).padStart(8))
  }

  const byLocation = all.filter(d => d.ghl_location_id === DANIEL_LOCATION)
  const byName = all.filter(d => /daniel|mcgrail|granger|danny/i.test(d.loan_officer ?? ''))
  console.log(`\nDaniel by GHL location (${DANIEL_LOCATION}): ${byLocation.length}`)
  console.log(`Daniel by loan_officer name:                 ${byName.length}`)

  if (byName.length === 0 && byLocation.length === 0) {
    console.log('\n⚠️  NOTHING for Daniel yet — sync has not run since the env vars landed, or the token is wrong.')
    return
  }

  // ⚠️ Report the RAW spellings actually stored. He is "Danny Granger" in GHL and
  // "Daniel McGrail-Granger" in Arive; resolveLO should have folded both, so any
  // raw variant showing up here means a write path skipped the resolver.
  const spellings = new Map<string, number>()
  for (const d of byName) spellings.set(d.loan_officer ?? '(null)', (spellings.get(d.loan_officer ?? '(null)') ?? 0) + 1)
  console.log('\nstored loan_officer spellings:')
  for (const [k, v] of [...spellings].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${JSON.stringify(k)}`)

  const groups = new Map<string, number>()
  for (const d of byName) groups.set(d.pipeline_group ?? '(none)', (groups.get(d.pipeline_group ?? '(none)') ?? 0) + 1)
  console.log('\npipeline_group:')
  for (const [k, v] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

  const funded = byName.filter(d => d.pipeline_group === 'Funded')
  console.log(`\nfunded: ${funded.length}, volume ${money(funded.reduce((s, d) => s + (d.loan_amount ?? 0), 0))}`)
  const priced = byName.filter(d => (d.lead_price ?? 0) > 0)
  console.log(`with lead_price: ${priced.length}, spend ${money(priced.reduce((s, d) => s + (d.lead_price ?? 0), 0))}`)

  const src = new Map<string, number>()
  for (const d of byName) src.set(d.source ?? '(none)', (src.get(d.source ?? '(none)') ?? 0) + 1)
  console.log('\ntop sources:')
  for (const [k, v] of [...src].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(4)}  ${k}`)
}

main()
