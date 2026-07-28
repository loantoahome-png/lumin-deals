// Park historical Arive-only loans as "Old Deals" (out of every report).
//
//   npx tsx scripts/park-old-deals.ts        → dry run
//   npx tsx scripts/park-old-deals.ts apply  → writes (backs up first)
//   npx tsx scripts/park-old-deals.ts undo <backup.json>   → restore
//
// Efrain, 2026-07-28: "get rid of the 77 dashboard deals with no GHL opportunity,
// create a tab all the way at the bottom titled old deals and move them all there
// and get rid of them from all reporting."
//
// WHO QUALIFIES — deliberately narrow. A deal is parked only when:
//   • no ghl_opportunity_id  (it does not exist in GHL at all), AND
//   • no lead_price          (no purchased-lead spend is attached to it), AND
//   • pipeline_group is Funded or Not Ready — i.e. the loan is DONE or DEAD
//
// The no-price condition guarantees parking cannot remove spend from Lead ROI.
//
// The pipeline_group condition is the one that matters most. An "Arive-only" deal
// is not automatically historical: the first pass over this rule would have parked
// James Garcia and Derek Coffill, both sitting in Leads/App Intake and both touched
// the same day — live loans originated in Arive that simply have no GHL
// opportunity yet. Anything still in Leads or Loans in Process stays visible, no
// matter how it got here.
//
// This does NOT delete. `pipeline_group` becomes 'Old Deals', every other field is
// untouched, and the before-state is written to a backup so `undo` restores it.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { OLD_DEALS_GROUP } from '../lib/fetchAllDeals'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

type Deal = Record<string, unknown>

async function allDeals(): Promise<Deal[]> {
  const out: Deal[] = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('id, name, loan_officer, status, pipeline_group, ghl_opportunity_id, lead_price, loan_amount, compensation_amount, funded_date, arive_file_no, source')
      .order('id', { ascending: true })
      .range(off, off + 999)
    if (error) throw new Error(error.message)
    const b = (data ?? []) as Deal[]
    out.push(...b)
    if (b.length < 1000) break
  }
  return out
}

;(async () => {
  const cmd = process.argv[2]

  if (cmd === 'undo') {
    const path = process.argv[3]
    if (!path) { console.error('usage: undo <backup.json>'); process.exit(1) }
    const backup = JSON.parse(readFileSync(path, 'utf8')) as Array<{ id: string; before: string }>
    let ok = 0
    for (const b of backup) {
      const { error } = await sb.from('deals').update({ pipeline_group: b.before }).eq('id', b.id)
      if (!error) ok++
    }
    console.log(`restored ${ok}/${backup.length} deals to their previous pipeline_group`)
    return
  }

  const apply = cmd === 'apply'
  const deals = await allDeals()
  const PARKABLE_GROUPS = new Set(['Funded', 'Not Ready'])   // done or dead — never in-flight
  const plan = deals.filter(d =>
    !d.ghl_opportunity_id &&
    !d.lead_price &&
    PARKABLE_GROUPS.has(String(d.pipeline_group ?? '')) &&
    d.pipeline_group !== OLD_DEALS_GROUP)

  const skippedActive = deals.filter(d =>
    !d.ghl_opportunity_id && !d.lead_price &&
    !PARKABLE_GROUPS.has(String(d.pipeline_group ?? '')) &&
    d.pipeline_group !== OLD_DEALS_GROUP)
  if (skippedActive.length) {
    console.log(`SKIPPED as still in-flight (Arive-only but NOT historical): ${skippedActive.length}`)
    for (const d of skippedActive) console.log(`   ${d.name} — ${d.pipeline_group}/${d.status}`)
    console.log()
  }

  console.log(`MODE: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`)
  console.log(`scanned ${deals.length} deals · to park: ${plan.length}\n`)

  const by = (f: string) => {
    const m: Record<string, number> = {}
    for (const d of plan) { const k = String(d[f] ?? '(none)'); m[k] = (m[k] ?? 0) + 1 }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }
  for (const [label, field] of [['current pipeline_group', 'pipeline_group'], ['loan officer', 'loan_officer'], ['source', 'source']] as const) {
    console.log(`${label}:`)
    for (const [k, v] of by(field)) console.log(`  ${String(v).padStart(4)}  ${k}`)
  }
  const vol = plan.reduce((n, d) => n + (Number(d.loan_amount) || 0), 0)
  const comp = plan.reduce((n, d) => n + (Number(d.compensation_amount) || 0), 0)
  console.log(`\nleaving reporting: ${plan.filter(d => d.funded_date).length} funded · volume $${vol.toLocaleString()} · comp $${comp.toLocaleString()}`)

  // Safety: parking must never touch a lead anyone paid for.
  const priced = plan.filter(d => d.lead_price)
  if (priced.length) throw new Error(`refusing: ${priced.length} priced deals in the plan`)

  if (!apply) { console.log('\nDry run — nothing written. Re-run with `apply`.'); return }
  if (!plan.length) { console.log('\nNothing to park.'); return }

  const dir = process.env.BACKFILL_BACKUP_DIR ?? '/tmp'
  const backup = `${dir}/park-old-deals-${process.env.BACKFILL_STAMP ?? 'run'}.json`
  writeFileSync(backup, JSON.stringify(
    plan.map(d => ({ id: d.id, name: d.name, before: d.pipeline_group })), null, 2))
  console.log(`\nbefore-state backed up → ${backup}`)

  let ok = 0
  const failures: Array<{ id: string; error: string }> = []
  for (const d of plan) {
    const { error } = await sb.from('deals').update({ pipeline_group: OLD_DEALS_GROUP }).eq('id', d.id as string)
    if (error) failures.push({ id: d.id as string, error: error.message })
    else ok++
  }
  console.log(`\nparked ${ok}/${plan.length}`)
  if (failures.length) {
    console.error(`${failures.length} failed:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.id}: ${f.error}`)
    process.exit(1)
  }
})()
