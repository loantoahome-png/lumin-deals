// Re-credit existing deals to the vendor on their OPPORTUNITY.
//
//   npx tsx scripts/opp-source-backfill.ts        → dry run
//   npx tsx scripts/opp-source-backfill.ts apply  → writes
//
// Policy (Efrain, 2026-07-28): an opportunity is one purchased lead and one spend
// event, so its own `source` is the vendor that actually sold it. The contact is a
// person, and a person resold by two aggregators keeps only whichever "Lead
// Source" was written to them last — which credited 7 of Moe's Lending Tree leads
// to Lending Tree when the opportunities came from FRU, LeadPoint and LMB.
//
// The sync now ranks the opportunity first, but it only rewrites a deal when it
// next re-reads that opportunity (the ~3h full maintenance pass), so this applies
// the same rule to the existing book immediately. `raw_ghl_data` IS the stored
// opportunity object the sync last fetched, so it is the same input the sync
// itself would use — this converges the book to exactly where the sync lands.
//
// Only ever CHANGES a deal when the opportunity carries a usable vendor: a blank
// or LOS-stamped opp source leaves the existing value alone.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { cleanSource } from '../lib/utils'

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

const PURCHASED = new Set(['fru', 'lendgo', 'lmb', 'lending tree', 'leadpoint', 'ownup'])
const isPurchased = (s: string | null) => PURCHASED.has((s ?? '').trim().toLowerCase())

;(async () => {
  const apply = process.argv[2] === 'apply'

  type Deal = Record<string, unknown>
  const deals: Deal[] = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('id, name, source, loan_officer, lead_price, funded_date, raw_ghl_data')
      .order('id', { ascending: true })
      .range(off, off + 999)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as Deal[]
    deals.push(...batch)
    if (batch.length < 1000) break
  }

  const plan = deals
    .map(d => {
      const raw = (d.raw_ghl_data ?? {}) as Record<string, unknown>
      const next = cleanSource(typeof raw.source === 'string' ? raw.source : null)
      const cur = ((d.source as string | null) ?? '').trim()
      return { d, cur, next }
    })
    .filter(p => p.next && p.next.toLowerCase() !== p.cur.toLowerCase())

  console.log(`MODE: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`)
  console.log(`deals scanned: ${deals.length} · to re-credit: ${plan.length}`)
  console.log(`funded among them: ${plan.filter(p => p.d.funded_date).length}\n`)

  const pairs: Record<string, number> = {}
  for (const p of plan) {
    const k = `${p.cur || '(none)'} → ${p.next}`
    pairs[k] = (pairs[k] ?? 0) + 1
  }
  console.log('re-credits:')
  for (const [k, v] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`)
  }

  // Crossing the paid/organic boundary changes whether a deal counts as a
  // purchased lead at all — call those out rather than burying them in the totals.
  const leaves = plan.filter(p => isPurchased(p.cur) && !isPurchased(p.next))
  const enters = plan.filter(p => !isPurchased(p.cur) && isPurchased(p.next))
  if (leaves.length || enters.length) console.log('\n⚠️  crosses the paid/organic boundary:')
  for (const p of leaves) console.log(`  LEAVES paid reporting: ${p.d.name} ${p.cur} → ${p.next} (lead_price ${p.d.lead_price})`)
  for (const p of enters) console.log(`  ENTERS paid reporting: ${p.d.name} ${p.cur} → ${p.next} (lead_price ${p.d.lead_price})`)

  if (!apply) { console.log('\nDry run — nothing written. Re-run with `apply` to commit.'); return }
  if (!plan.length) { console.log('\nNothing to re-credit.'); return }

  const dir = process.env.BACKFILL_BACKUP_DIR ?? '/tmp'
  const backup = `${dir}/opp-source-backfill-${process.env.BACKFILL_STAMP ?? 'run'}.json`
  writeFileSync(backup, JSON.stringify(
    plan.map(p => ({ id: p.d.id, name: p.d.name, before: p.cur, after: p.next })), null, 2))
  console.log(`\nbefore-state backed up → ${backup}`)

  let ok = 0
  const failures: Array<{ id: string; error: string }> = []
  for (const p of plan) {
    const { error } = await sb.from('deals').update({ source: p.next }).eq('id', p.d.id as string)
    if (error) failures.push({ id: p.d.id as string, error: error.message })
    else ok++
  }
  console.log(`\nre-credited ${ok}/${plan.length}`)
  if (failures.length) {
    console.error(`${failures.length} failed:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.id}: ${f.error}`)
    process.exit(1)
  }
})()
