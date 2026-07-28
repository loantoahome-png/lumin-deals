// One-time repair for deals whose `source` is the LOS name "Arive".
//
//   npx tsx scripts/arive-source-backfill.ts        → dry run, writes nothing
//   npx tsx scripts/arive-source-backfill.ts apply  → backs up, then writes
//
// Context: the 15-min sync declared a local cleanSource() that rejected junk
// values but not "Arive", so it re-stamped the LOS name over real vendors on
// every pass. The July 8 backfill took the bucket 17 → 1; unguarded, it regrew
// to 200 by July 28. Run this AFTER the guard ships, or the sync refills it.
//
// Recovery order per deal:
//   1. raw_ghl_data.source — the GHL opportunity's own source, i.e. what the
//      fixed sync will converge to on the next pass. Using it here just gets
//      there sooner and keeps the backfill consistent with the sync.
//   2. lead_source_agg — the Arive CSV's "Lead Source" column. Composites
//      (the webhook joins "campaign / source") are skipped: a value like
//      "Purchase / Arive" is not a vendor name.
//   3. null — genuinely unknown. Renders "(no source set)" rather than
//      asserting a source we cannot support. The sync's maybeSet skips nulls,
//      so a later real value still fills it in.
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

// The canonical self-sourced label. Arive exports a variant spelling that would
// otherwise open a near-duplicate bucket beside the real one.
const SELF_SOURCE_VARIANTS = new Set(['self sourced', 'selfsource', 'self-source'])

function canonical(s: string | null): string | null {
  if (!s) return null
  return SELF_SOURCE_VARIANTS.has(s.trim().toLowerCase()) ? 'Self Source' : s.trim()
}

/** lead_source_agg → a usable source, or null.
 *
 *  A slash means one of two very different things here. The webhook stores
 *  "campaign / source" composites, where an "Arive" segment makes the whole
 *  value unusable; but real category names contain slashes too
 *  ("Referral - Friend / Family"). So reject only when a SEGMENT is itself a
 *  rejected token, and otherwise keep the value whole. */
function fromAgg(agg: string | null): string | null {
  if (!agg) return null
  const segments = agg.split('/').map(s => s.trim()).filter(Boolean)
  if (segments.some(s => !cleanSource(s))) return null
  return cleanSource(agg)
}

/** The vendor to restore, or null when nothing in the row can support one. */
function recover(deal: Record<string, unknown>): { next: string | null; via: string } {
  const raw = (deal.raw_ghl_data ?? {}) as Record<string, unknown>
  const oppSource = cleanSource(typeof raw.source === 'string' ? raw.source : null)
  if (oppSource) return { next: canonical(oppSource), via: 'opportunity' }

  const agg = fromAgg(typeof deal.lead_source_agg === 'string' ? deal.lead_source_agg : null)
  if (agg) return { next: canonical(agg), via: 'lead_source_agg' }

  return { next: null, via: 'unrecoverable' }
}

;(async () => {
  const apply = process.argv[2] === 'apply'

  // Paginate — a bare select caps at 1000 rows.
  type Deal = Record<string, unknown>
  const deals: Deal[] = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('id, name, loan_officer, source, lead_source_agg, raw_ghl_data, status, funded_date')
      .eq('source', 'Arive')
      .order('id', { ascending: true })
      .range(off, off + 999)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as Deal[]
    deals.push(...batch)
    if (batch.length < 1000) break
  }

  const plan = deals.map(d => ({ deal: d, ...recover(d) }))
  const byVia: Record<string, number> = {}
  const byValue: Record<string, number> = {}
  for (const p of plan) {
    byVia[p.via] = (byVia[p.via] ?? 0) + 1
    const k = p.next ?? '(null — no source set)'
    byValue[k] = (byValue[k] ?? 0) + 1
  }

  console.log(`MODE: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`)
  console.log(`deals with source="Arive": ${deals.length}`)
  console.log(`funded among them: ${plan.filter(p => p.deal.funded_date).length}\n`)
  console.log('recovered via:')
  for (const [k, v] of Object.entries(byVia).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
  console.log('\nresulting source values:')
  for (const [k, v] of Object.entries(byValue).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

  // Nothing should keep the LOS name — that is the whole point of the run.
  const stillArive = plan.filter(p => (p.next ?? '').toLowerCase() === 'arive')
  if (stillArive.length) throw new Error(`refusing to run: ${stillArive.length} rows would keep "Arive"`)

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with `apply` to commit.')
    return
  }

  // Back up the before-state so any row can be restored by id.
  const stamp = process.env.BACKFILL_STAMP ?? 'run'
  const dir = process.env.BACKFILL_BACKUP_DIR ?? '/tmp'
  const backup = `${dir}/arive-source-backfill-${stamp}.json`
  writeFileSync(backup, JSON.stringify(
    plan.map(p => ({ id: p.deal.id, name: p.deal.name, before: p.deal.source, after: p.next, via: p.via })), null, 2))
  console.log(`\nbefore-state backed up → ${backup}`)

  let ok = 0
  const failures: Array<{ id: string; error: string }> = []
  for (const p of plan) {
    const { error } = await sb.from('deals').update({ source: p.next }).eq('id', p.deal.id as string)
    if (error) failures.push({ id: p.deal.id as string, error: error.message })
    else ok++
  }
  console.log(`\nupdated ${ok}/${plan.length}`)
  if (failures.length) {
    console.error(`${failures.length} failed:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.id}: ${f.error}`)
    process.exit(1)
  }
})()
