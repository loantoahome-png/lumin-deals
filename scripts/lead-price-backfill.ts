import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { oppCustomField, type CustomFieldDef } from '../lib/ghlOpportunityFields'

// Re-source `deals.lead_price` from the GHL OPPORTUNITY's "Lead Price" custom
// field instead of the contact's. See
// docs/specs/2026-07-31-lead-price-opportunity-backfill-spec.md
//
//   npx tsx scripts/lead-price-backfill.ts            # DRY RUN — writes nothing
//   npx tsx scripts/lead-price-backfill.ts --apply    # writes
//
// WHY: a contact holds ONE lead price; each opportunity holds its own, and every
// priced opportunity is a real separate charge. Reading the contact put one
// value on all of a person's opportunities (Lawrence Turner: six real charges of
// 34/31/38/23/29/21 stored as 34 six times).
//
// ⚠️ ORDER: `lead_price` is in the sync's maybeSet list, so until the sync reads
// the opportunity too, anything written here is re-stamped from the contact
// within 15 minutes. Dry-run is safe to run any time; --apply is not, until the
// sync fix ships.
//
// ⚠️ The search path returns numeric custom fields under `fieldValueNumber`
// (single GET uses `fieldValue`) — oppCustomField/rawValue read every variant,
// so never index a key directly.

const APPLY = process.argv.includes('--apply')
// --missing: list the aggregator-sourced opportunities carrying NO Lead Price in
// GHL. Those are spend we either can't see or aren't being charged for, and they
// never show up in the diff (there's nothing to compare against).
const MISSING_ONLY = process.argv.includes('--missing')

const PURCHASED = ['FRU', 'Lendgo', 'LMB', 'Lending Tree', 'LeadPoint', 'OwnUp']
const PURCHASED_SET = new Set(PURCHASED.map(s => s.toLowerCase()))
const isAgg = (v: unknown) => PURCHASED_SET.has(String(v ?? '').trim().toLowerCase())

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const GHL_BASE = 'https://services.leadconnectorhq.com'
const headers = (k: string) => ({ Authorization: `Bearer ${k}`, Version: '2021-07-28', Accept: 'application/json' })

const ACCOUNTS = [
  { label: 'Moe',   apiKey: env.GHL_API_KEY,       locationId: env.GHL_LOCATION_ID },
  { label: 'Matt',  apiKey: env.GHL_API_KEY_MATT,  locationId: env.GHL_LOCATION_ID_MATT },
  { label: 'Randy', apiKey: env.GHL_API_KEY_2,     locationId: env.GHL_LOCATION_ID_2 },
].filter(a => a.apiKey && a.locationId)

type Opp = { id?: string; name?: string; customFields?: unknown }

/** Opportunity custom-field definitions for a location, so a field can be matched
 *  by NAME. The ids differ per sub-account — nothing may hardcode one. */
async function fieldDefs(locationId: string, apiKey: string): Promise<Map<string, CustomFieldDef>> {
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customFields?model=opportunity`, { headers: headers(apiKey) })
  const map = new Map<string, CustomFieldDef>()
  if (!res.ok) return map
  const data = await res.json() as { customFields?: CustomFieldDef[] }
  for (const f of data.customFields ?? []) if (f.id) map.set(f.id, f)
  return map
}

async function allOpportunities(locationId: string, apiKey: string): Promise<Opp[]> {
  const out: Opp[] = []
  let startAfter: string | undefined, startAfterId: string | undefined
  for (let page = 0; page < 80; page++) {
    const params: Record<string, string> = { location_id: locationId, limit: '100' }
    if (startAfter) params.startAfter = startAfter
    if (startAfterId) params.startAfterId = startAfterId
    const res = await fetch(`${GHL_BASE}/opportunities/search?${new URLSearchParams(params)}`, { headers: headers(apiKey) })
    if (!res.ok) { console.error(`  ! page ${page}: ${res.status} ${(await res.text()).slice(0, 120)}`); break }
    const data = await res.json() as { opportunities?: Opp[]; meta?: { startAfter?: string; startAfterId?: string } }
    const batch = data.opportunities ?? []
    out.push(...batch)
    if (batch.length < 100 || !data.meta?.startAfter) break
    startAfter = data.meta.startAfter
    startAfterId = data.meta.startAfterId
  }
  return out
}

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const money = (n: number) => `$${n.toFixed(2)}`

async function main() {
  console.log(APPLY ? '### APPLY — this writes to deals.lead_price' : '### DRY RUN — nothing will be written\n')

  // Every priced deal, plus unpriced ones with an opportunity id (the opportunity
  // may carry a price we never stored).
  const deals: Record<string, any>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('deals')
      .select('id,name,loan_officer,source,lead_price,ghl_opportunity_id,ghl_location_id,pipeline_group,status')
      .range(from, from + 999)
    if (error) throw error
    deals.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  const withOpp = deals.filter(d => d.ghl_opportunity_id)
  console.log(`deals ${deals.length} | with an opportunity id ${withOpp.length} | priced ${deals.filter(d => Number(d.lead_price ?? 0) > 0).length}\n`)

  // opportunity id → its own Lead Price and Lead Vendor
  const oppPrice = new Map<string, number | null>()
  const oppVendor = new Map<string, string | null>()
  const seen = new Set<string>()
  for (const a of ACCOUNTS) {
    process.stdout.write(`fetching ${a.label} opportunities… `)
    const defs = await fieldDefs(a.locationId!, a.apiKey!)
    const opps = await allOpportunities(a.locationId!, a.apiKey!)
    let priced = 0
    for (const o of opps) {
      if (!o.id) continue
      seen.add(o.id)
      const v = toNum(oppCustomField(o.customFields, defs, 'Lead Price', 'lead_price'))
      oppPrice.set(o.id, v)
      const vend = oppCustomField(o.customFields, defs, 'Lead Vendor', 'lead_vendor')
      oppVendor.set(o.id, vend == null ? null : String(vend).trim() || null)
      if (v != null) priced++
    }
    console.log(`${opps.length} opportunities, ${priced} carry a Lead Price`)
  }

  if (MISSING_ONLY) {
    // Aggregator leads whose OPPORTUNITY has no Lead Price. Split by whether we
    // hold a price anyway (the contact-sourced value) or have none at all.
    const rows = withOpp
      .filter(d => seen.has(d.ghl_opportunity_id))
      .filter(d => oppPrice.get(d.ghl_opportunity_id) == null)
      .filter(d => isAgg(d.source) || isAgg(oppVendor.get(d.ghl_opportunity_id)))
    const stored = rows.filter(d => Number(d.lead_price ?? 0) > 0)
    const nothing = rows.filter(d => !(Number(d.lead_price ?? 0) > 0))
    console.log(`\n${'='.repeat(96)}\nAGG LEADS WITH NO "Lead Price" ON THE GHL OPPORTUNITY\n${'='.repeat(96)}`)
    console.log(`${rows.length} opportunities — ${stored.length} we price anyway (from the contact), ${nothing.length} with no price anywhere\n`)

    const show = (label: string, list: Record<string, any>[]) => {
      if (!list.length) return
      console.log(`${label} (${list.length}, ${money(list.reduce((a, d) => a + Number(d.lead_price ?? 0), 0))})`)
      console.log(`  ${'name'.padEnd(26)}${'source'.padEnd(14)}${'opp Lead Vendor'.padEnd(17)}${'stored'.padStart(9)}  ${'LO'.padEnd(13)}status`)
      for (const d of list.sort((a, b) => Number(b.lead_price ?? 0) - Number(a.lead_price ?? 0))) {
        console.log(`  ${String(d.name).slice(0, 25).padEnd(26)}${String(d.source ?? '—').padEnd(14)}${String(oppVendor.get(d.ghl_opportunity_id) ?? '—').padEnd(17)}${(d.lead_price == null ? '—' : money(Number(d.lead_price))).padStart(9)}  ${String(d.loan_officer ?? '').slice(0, 12).padEnd(13)}${d.status ?? ''}`)
      }
      console.log('')
    }
    show('PRICED HERE, BLANK IN GHL — the backfill leaves these alone', stored)
    show('NO PRICE ANYWHERE — never counted as spend', nothing)
    return
  }
  const missingAccounts = ['Moe', 'Matt', 'Randy'].filter(l => !ACCOUNTS.some(a => a.label === l))
  if (missingAccounts.length) console.log(`\n⚠️  no API key configured for: ${missingAccounts.join(', ')} — their deals are NOT covered below`)

  // ── Diff ──────────────────────────────────────────────────────────────────
  type Row = { deal: Record<string, any>; from: number | null; to: number | null }
  const changes: Row[] = [], unreachable: Record<string, any>[] = [], oppHasNone: Row[] = []
  for (const d of withOpp) {
    if (!seen.has(d.ghl_opportunity_id)) { unreachable.push(d); continue }
    const to = oppPrice.get(d.ghl_opportunity_id) ?? null
    const from = d.lead_price == null ? null : Number(d.lead_price)
    if (to == null) { if (from != null) oppHasNone.push({ deal: d, from, to }); continue }
    if (from == null || Math.abs(from - to) > 0.001) changes.push({ deal: d, from, to })
  }

  const sumFrom = changes.reduce((a, c) => a + (c.from ?? 0), 0)
  const sumTo = changes.reduce((a, c) => a + (c.to ?? 0), 0)

  console.log(`\n${'='.repeat(78)}\nDIFF\n${'='.repeat(78)}`)
  console.log(`deals whose stored price disagrees with their opportunity: ${changes.length}`)
  console.log(`  stored total  ${money(sumFrom)}`)
  console.log(`  GHL total     ${money(sumTo)}`)
  console.log(`  net change    ${sumTo - sumFrom >= 0 ? '+' : ''}${money(sumTo - sumFrom)}`)
  console.log(`\ndeals priced here but with NO Lead Price on the opportunity: ${oppHasNone.length} (${money(oppHasNone.reduce((a, c) => a + (c.from ?? 0), 0))}) — LEFT ALONE`)
  console.log(`deals whose opportunity wasn't in any fetched location: ${unreachable.length} (${money(unreachable.reduce((a, d) => a + Number(d.lead_price ?? 0), 0))})`)

  // Break the unreachable set down — "no API key for that LO" and "the search
  // endpoint no longer returns that opportunity" are very different problems,
  // and the second one would mean the SYNC has the same blind spot.
  if (unreachable.length) {
    const grp: Record<string, { n: number; $: number }> = {}
    for (const d of unreachable) {
      const k = `${d.loan_officer ?? '(none)'} · ${d.pipeline_group ?? '(none)'}`
      grp[k] ??= { n: 0, $: 0 }
      grp[k].n++; grp[k].$ += Number(d.lead_price ?? 0)
    }
    console.log(`  breakdown:`)
    for (const k of Object.keys(grp).sort((a, b) => grp[b].n - grp[a].n)) {
      console.log(`    ${k.padEnd(38)} ${String(grp[k].n).padStart(4)} deals  ${money(grp[k].$).padStart(11)}`)
    }
  }

  // Per vendor — the number that actually matters, since totals barely move.
  const byVendor: Record<string, { n: number; from: number; to: number }> = {}
  for (const c of changes) {
    const k = c.deal.source ?? '(none)'
    byVendor[k] ??= { n: 0, from: 0, to: 0 }
    byVendor[k].n++; byVendor[k].from += c.from ?? 0; byVendor[k].to += c.to ?? 0
  }
  console.log(`\nPER VENDOR\n${'-'.repeat(78)}`)
  console.log(`${'vendor'.padEnd(16)}${'deals'.padStart(6)}${'stored'.padStart(13)}${'GHL'.padStart(13)}${'delta'.padStart(13)}`)
  for (const k of Object.keys(byVendor).sort((a, b) => Math.abs(byVendor[b].to - byVendor[b].from) - Math.abs(byVendor[a].to - byVendor[a].from))) {
    const v = byVendor[k]
    console.log(`${k.padEnd(16)}${String(v.n).padStart(6)}${money(v.from).padStart(13)}${money(v.to).padStart(13)}${((v.to - v.from >= 0 ? '+' : '') + money(v.to - v.from)).padStart(13)}`)
  }

  // Per LO
  const byLo: Record<string, { n: number; from: number; to: number }> = {}
  for (const c of changes) {
    const k = c.deal.loan_officer ?? '(none)'
    byLo[k] ??= { n: 0, from: 0, to: 0 }
    byLo[k].n++; byLo[k].from += c.from ?? 0; byLo[k].to += c.to ?? 0
  }
  console.log(`\nPER LOAN OFFICER\n${'-'.repeat(78)}`)
  for (const k of Object.keys(byLo).sort()) {
    const v = byLo[k]
    console.log(`${k.padEnd(16)}${String(v.n).padStart(6)}${money(v.from).padStart(13)}${money(v.to).padStart(13)}${((v.to - v.from >= 0 ? '+' : '') + money(v.to - v.from)).padStart(13)}`)
  }

  console.log(`\nLARGEST 25 INDIVIDUAL CHANGES\n${'-'.repeat(78)}`)
  for (const c of [...changes].sort((a, b) => Math.abs((b.to ?? 0) - (b.from ?? 0)) - Math.abs((a.to ?? 0) - (a.from ?? 0))).slice(0, 25)) {
    console.log(`  ${String(c.deal.name).slice(0, 26).padEnd(27)}${String(c.deal.source ?? '—').padEnd(14)}${(c.from == null ? 'null' : money(c.from)).padStart(10)} → ${(c.to == null ? 'null' : money(c.to)).padStart(9)}   ${c.deal.loan_officer ?? ''}`)
  }

  if (!APPLY) {
    console.log(`\n${'='.repeat(78)}\nDRY RUN — nothing written. Re-run with --apply once the sync fix has shipped.`)
    return
  }
  // Apply: record the prior value so this is reversible.
  console.log('\nwriting…')
  let done = 0
  for (const c of changes) {
    const { error } = await sb.from('deals').update({ lead_price: c.to }).eq('id', c.deal.id).select('id')
    if (error) { console.error(`  ! ${c.deal.name}: ${error.message}`); continue }
    done++
  }
  console.log(`updated ${done}/${changes.length}`)
}
main()
