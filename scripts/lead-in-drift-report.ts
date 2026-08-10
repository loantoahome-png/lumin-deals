// DRY RUN — how stale is `date_added_ghl` vs the live GHL contact dateAdded?
//
// date_added_ghl is written ONLY on insert (app/api/sync/ghl/route.ts:985) and is
// absent from the update patch, so it freezes whatever contact was attached the
// moment the row was first created. Larisa Fuchs proves it drifts: we hold
// 2026-06-02, GHL's contact says 2026-05-01 (Efrain's screenshot agrees).
//
// Run: npx tsx scripts/lead-in-drift-report.ts [--funded-only]
// Writes nothing. Prints the drift distribution + the rows that would change.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const ACCOUNTS = [
  { label: 'primary', key: get('GHL_API_KEY') },
  { label: 'matt', key: get('GHL_API_KEY_MATT') },
  { label: 'extra', key: get('GHL_API_KEY_2') },
].filter(a => a.key)

const H = (key: string) => ({ Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' })

async function ghl(path: string) {
  for (const a of ACCOUNTS) {
    const r = await fetch(`https://services.leadconnectorhq.com${path}`, { headers: H(a.key) })
    if (r.ok) return await r.json() as Record<string, any>
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500)); }
  }
  return null
}

const fundedOnly = process.argv.includes('--funded-only')

async function main() {
  let q = sb.from('deals')
    .select('id,name,source,ghl_opportunity_id,ghl_contact_id,date_added_ghl,funded_date,pipeline_group')
    .not('ghl_opportunity_id', 'is', null)
  if (fundedOnly) q = q.not('funded_date', 'is', null)
  const { data, error } = await q.limit(5000)
  if (error) { console.error(error); process.exit(1) }
  const rows = data ?? []
  console.log(`Checking ${rows.length} rows against live GHL contacts…\n`)

  const changed: { name: string; source: string | null; had: string | null; live: string; days: number; funded: string | null }[] = []
  let same = 0, noContact = 0, failed = 0

  for (let i = 0; i < rows.length; i++) {
    const d = rows[i]
    if (i % 100 === 0 && i) console.log(`  …${i}/${rows.length}`)
    const oppBody = await ghl(`/opportunities/${d.ghl_opportunity_id}`)
    const opp = (oppBody?.opportunity ?? oppBody) as Record<string, any> | null
    const cid = opp?.contactId ?? d.ghl_contact_id
    if (!cid) { noContact++; continue }
    const cBody = await ghl(`/contacts/${cid}`)
    const live = cBody?.contact?.dateAdded as string | undefined
    if (!live) { failed++; continue }
    const had = d.date_added_ghl as string | null
    if (had && Math.abs(new Date(had).getTime() - new Date(live).getTime()) < 60_000) { same++; continue }
    const days = had ? Math.round((new Date(had).getTime() - new Date(live).getTime()) / 86_400_000) : -1
    changed.push({ name: d.name, source: d.source, had, live, days, funded: d.funded_date })
  }

  console.log(`\n${'═'.repeat(78)}`)
  console.log(`already correct: ${same} · would change: ${changed.length} · no contact: ${noContact} · fetch failed: ${failed}`)

  const wasNull = changed.filter(c => !c.had)
  const drifted = changed.filter(c => c.had)
  console.log(`  of those: ${wasNull.length} currently BLANK (would gain a date), ${drifted.length} currently WRONG`)
  if (drifted.length) {
    const ds = drifted.map(c => c.days).sort((a, b) => a - b)
    console.log(`  drift in days (stored minus real): min ${ds[0]} · median ${ds[Math.floor(ds.length / 2)]} · max ${ds[ds.length - 1]}`)
  }
  console.log(`\nWrong ones, worst first:`)
  for (const c of drifted.sort((a, b) => b.days - a.days).slice(0, 40)) {
    console.log(`  ${String(c.name).padEnd(24)} ${String(c.source ?? '—').padEnd(14)} stored ${String(c.had).slice(0, 10)} → real ${c.live.slice(0, 10)}  (+${c.days}d)${c.funded ? `  funded ${c.funded}` : ''}`)
  }
}
main()
