// Manage manual lead-source pins (see lib/sourcePins.ts).
//
//   npx tsx scripts/source-pins.ts list
//   npx tsx scripts/source-pins.ts add <opportunityId> <source> "<reason>"
//   npx tsx scripts/source-pins.ts remove <opportunityId>
//
// `add` writes the pin to sync_state AND applies it to the matching deal now, so
// the dashboard is correct immediately rather than at the next sync. Every later
// sync re-applies it, which is the point: without a pin the sync rewrites
// `source` on every pass and a manual correction silently reverts.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { SOURCE_PINS_KEY, parseSourcePins, type SourcePin } from '../lib/sourcePins'

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

async function readPins(): Promise<SourcePin[]> {
  const { data } = await sb.from('sync_state').select('value').eq('key', SOURCE_PINS_KEY).maybeSingle()
  return Array.isArray(data?.value) ? (data!.value as SourcePin[]) : []
}

async function writePins(pins: SourcePin[]) {
  const { error } = await sb.from('sync_state').upsert(
    { key: SOURCE_PINS_KEY, value: pins, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  if (error) throw new Error(error.message)
}

;(async () => {
  const [cmd, oppId, source, reason] = process.argv.slice(2)
  const pins = await readPins()

  if (!cmd || cmd === 'list') {
    console.log(`${pins.length} pin(s) in sync_state.${SOURCE_PINS_KEY}:`)
    for (const p of pins) console.log(`  ${p.opportunity_id}  →  ${p.source}${p.reason ? `   (${p.reason})` : ''}`)
    return
  }

  if (cmd === 'add') {
    if (!oppId || !source) { console.error('usage: add <opportunityId> <source> "<reason>"'); process.exit(1) }
    const next = pins.filter(p => p.opportunity_id !== oppId)
    next.push({ opportunity_id: oppId, source, reason: reason || undefined, pinned_at: new Date().toISOString() })
    await writePins(next)
    console.log(`pinned ${oppId} → ${source}`)
    // Apply now so the dashboard doesn't wait for the next sync.
    const { data, error } = await sb.from('deals').update({ source })
      .eq('ghl_opportunity_id', oppId).select('id, name, source')
    if (error) throw new Error(error.message)
    if (!data?.length) console.warn('  ⚠️  pin saved, but no deal currently has that opportunity id')
    for (const d of data ?? []) console.log(`  applied → ${d.name}: source=${d.source}`)
    return
  }

  if (cmd === 'remove') {
    if (!oppId) { console.error('usage: remove <opportunityId>'); process.exit(1) }
    const next = pins.filter(p => p.opportunity_id !== oppId)
    if (next.length === pins.length) { console.log('no such pin'); return }
    await writePins(next)
    console.log(`removed pin for ${oppId} — the next sync will re-derive its source from GHL`)
    return
  }

  console.error(`unknown command: ${cmd}`)
  process.exit(1)
})()
