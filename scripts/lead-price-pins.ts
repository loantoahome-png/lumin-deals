// Manage manual lead-PRICE pins (see lib/leadPricePins.ts).
//
//   npx tsx scripts/lead-price-pins.ts list
//   npx tsx scripts/lead-price-pins.ts add <opportunityId> <price> "<reason>"
//   npx tsx scripts/lead-price-pins.ts remove <opportunityId>
//
// `add` writes the pin to sync_state AND applies it to the matching deal now, so
// the dashboard is correct immediately rather than at the next sync. Every later
// sync re-applies it, which is the point: without a pin the sync rewrites
// `lead_price` from the CONTACT on every pass and a manual correction silently
// reverts within 15 minutes.
//
// A price of 0 is legal and is the common case — it means "free and we know it".
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { LEAD_PRICE_PINS_KEY, parseLeadPricePins, type LeadPricePin } from '../lib/leadPricePins'

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

async function readPins(): Promise<LeadPricePin[]> {
  const { data } = await sb.from('sync_state').select('value').eq('key', LEAD_PRICE_PINS_KEY).maybeSingle()
  return Array.isArray(data?.value) ? (data!.value as LeadPricePin[]) : []
}

async function writePins(pins: LeadPricePin[]) {
  const { error } = await sb.from('sync_state').upsert(
    { key: LEAD_PRICE_PINS_KEY, value: pins, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  if (error) throw error
}

async function main() {
  const [cmd, oppId, priceArg, ...reasonParts] = process.argv.slice(2)

  if (!cmd || cmd === 'list') {
    const pins = await readPins()
    if (!pins.length) return console.log('No lead-price pins set.')
    console.log(`${pins.length} lead-price pin(s):\n`)
    for (const p of pins) {
      const { data } = await sb.from('deals')
        .select('name,source,lead_price,loan_officer')
        .eq('ghl_opportunity_id', p.opportunity_id).maybeSingle()
      const live = data ? `${data.name} · ${data.source} · ${data.loan_officer} · db=$${data.lead_price ?? '—'}` : 'no matching deal'
      console.log(`  ${p.opportunity_id} → $${p.lead_price}`)
      console.log(`    ${live}`)
      console.log(`    reason: ${p.reason ?? '(none)'}  pinned: ${p.pinned_at ?? '?'}\n`)
    }
    // Parse-through check: what the SYNC will actually honour, junk rows dropped.
    const honoured = parseLeadPricePins(pins)
    if (honoured.size !== pins.length) {
      console.log(`⚠️  sync will honour only ${honoured.size} of ${pins.length} — the rest failed validation.`)
    }
    return
  }

  if (cmd === 'add') {
    const price = Number(priceArg)
    if (!oppId || !Number.isFinite(price) || price < 0) {
      throw new Error('usage: add <opportunityId> <price ≥ 0> "<reason>"')
    }
    const reason = reasonParts.join(' ').trim()
    if (!reason) throw new Error('a reason is required — an unexplained pin is indistinguishable from a mistake')

    const { data: deal, error: dErr } = await sb.from('deals')
      .select('id,name,source,lead_price,loan_officer,vendor_lead_id')
      .eq('ghl_opportunity_id', oppId).maybeSingle()
    if (dErr) throw dErr
    if (!deal) console.log(`⚠️  no deal currently matches opportunity ${oppId} — pinning anyway (it will apply when one appears).`)
    else console.log(`Target: ${deal.name} · ${deal.source} · ${deal.loan_officer} · current lead_price=$${deal.lead_price ?? '—'}`)

    const pins = (await readPins()).filter(p => p.opportunity_id !== oppId)
    pins.push({ opportunity_id: oppId, lead_price: price, reason, pinned_at: new Date().toISOString() })
    await writePins(pins)
    console.log(`Pinned ${oppId} → $${price}`)

    if (deal) {
      const { error } = await sb.from('deals').update({ lead_price: price }).eq('id', deal.id).select()
      if (error) throw error
      console.log(`Applied to deal ${deal.id} now (was $${deal.lead_price ?? '—'}, now $${price}).`)
    }
    return
  }

  if (cmd === 'remove') {
    if (!oppId) throw new Error('usage: remove <opportunityId>')
    const pins = await readPins()
    const next = pins.filter(p => p.opportunity_id !== oppId)
    if (next.length === pins.length) return console.log(`No pin for ${oppId}.`)
    await writePins(next)
    console.log(`Removed pin for ${oppId}. The next sync will re-stamp GHL's own value.`)
    return
  }

  throw new Error(`unknown command "${cmd}" — use list | add | remove`)
}

main().catch(e => { console.error(e.message ?? e); process.exit(1) })
