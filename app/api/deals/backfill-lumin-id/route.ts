import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'

// One-time historical backfill for deals.lumin_lead_id (+ vendor_lead_id where
// still null — same contact fetch, free). The webhook only forward-fills these
// on live events, so deals that never fire another event would stay null and
// website → GHL → funded attribution couldn't reach historical loans. This
// route pulls each deal's CONTACT custom fields from the GHL API and fills the
// nulls. Never overwrites: every write carries an .is(column, null) guard, so
// webhook-written values always win and re-runs are safe.
//
// TRIGGER (must be logged in — middleware-gated):
//   GET /api/deals/backfill-lumin-id?limit=25          ← DRY RUN (no writes)
//   GET /api/deals/backfill-lumin-id?limit=1000&run=1  ← write; re-run until remaining=0
//
// Custom-field VALUES come keyed by field ID on the /contacts endpoint, so each
// location's field ids are resolved first from its custom-field schema (exact
// normalized NAME match — never substring, so vendor "Lead ID" can't grab
// "Lumin Lead ID"). A location with neither field skips all its deals without
// per-contact calls (expected for Randy's sub-account).

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONCURRENCY = 5
const DEFAULT_LIMIT = 250

const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-/.]+/g, '')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function getJson(url: string, apiKey: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: ghlHeaders(apiKey) })
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (attempt + 1)); continue }
    if (!res.ok) return null
    return res.json()
  }
  return null
}

/** Contact CF values arrive as {id, value} on /contacts (other key variants seen
 *  elsewhere in GHL — read them all, first non-empty wins). */
type ContactCF = { id?: string; value?: unknown; fieldValueString?: unknown; fieldValue?: unknown; field_value?: unknown }
function cfValue(f: ContactCF): unknown {
  for (const v of [f.value, f.fieldValueString, f.fieldValue, f.field_value]) {
    if (v != null && v !== '') return v
  }
  return undefined
}

/** Trimmed string value, or null for GHL's serialized-object junk / absurd lengths. */
function cleanIdValue(v: unknown): string | null {
  if (v == null) return null
  const s = String(Array.isArray(v) ? v[0] ?? '' : v).trim()
  if (!s || s.startsWith('{') || s.startsWith('[')) return null
  return s.length >= 3 && s.length <= 64 ? s : null
}

type FieldIds = { lumin: string | null; vendor: string | null }

/** Resolve the location's field ids for "Lumin Lead ID" / "Lead ID" from its
 *  CONTACT custom-field schema (the endpoint's default model). */
async function resolveFieldIds(locationId: string, apiKey: string): Promise<FieldIds> {
  const data = await getJson(`${GHL_BASE}/locations/${locationId}/customFields`, apiKey) as
    { customFields?: Array<{ id?: string; name?: string; fieldKey?: string }> } | null
  const out: FieldIds = { lumin: null, vendor: null }
  for (const f of data?.customFields ?? []) {
    if (!f.id) continue
    const name = norm(f.name ?? '')
    const key = norm(f.fieldKey ?? '')
    if (name === 'luminleadid' || key === 'contactluminleadid') out.lumin ??= f.id
    else if (name === 'leadid' || key === 'contactleadid') out.vendor ??= f.id
  }
  return out
}

type DealRow = {
  id: string
  ghl_contact_id: string | null
  ghl_location_id: string | null
  vendor_lead_id: string | null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const run = url.searchParams.get('run') === '1'
  const limit = Math.min(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1000)

  const supabase = createServiceClient()

  // Candidates: linked to GHL, lumin still null. vendor_lead_id selected so the
  // opportunistic fill knows whether that column also needs its null filled.
  const { data, error } = await supabase
    .from('deals')
    .select('id, ghl_contact_id, ghl_location_id, vendor_lead_id')
    .not('ghl_contact_id', 'is', null)
    .not('ghl_location_id', 'is', null)
    .is('lumin_lead_id', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 })
  const deals = (data ?? []) as DealRow[]

  const summary = {
    ok: true, run, limit, scanned: deals.length,
    locations: {} as Record<string, { hasLuminField: boolean; hasVendorField: boolean; deals: number }>,
    contactsFetched: 0, noApiKey: 0, skippedNoFieldDef: 0, noContact: 0, errors: 0,
    luminFound: 0, luminWritten: 0, vendorFound: 0, vendorWritten: 0,
    samples: [] as Array<{ deal: string; lumin: string }>,
    remaining: 0,
  }

  // Per-location field-id resolution, once each.
  const fieldIdsByLoc = new Map<string, FieldIds>()
  for (const d of deals) {
    const loc = d.ghl_location_id!
    if (fieldIdsByLoc.has(loc)) { summary.locations[loc].deals++; continue }
    const apiKey = resolveApiKey(loc)
    const ids = apiKey ? await resolveFieldIds(loc, apiKey) : { lumin: null, vendor: null }
    fieldIdsByLoc.set(loc, ids)
    summary.locations[loc] = { hasLuminField: !!ids.lumin, hasVendorField: !!ids.vendor, deals: 1 }
  }

  // Simple concurrency pool (mirrors stage-events/backfill).
  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= deals.length) return
      const d = deals[i]
      const apiKey = resolveApiKey(d.ghl_location_id)
      if (!apiKey) { summary.noApiKey++; continue }
      const ids = fieldIdsByLoc.get(d.ghl_location_id!) ?? { lumin: null, vendor: null }
      if (!ids.lumin && !ids.vendor) { summary.skippedNoFieldDef++; continue }
      try {
        const j = await getJson(`${GHL_BASE}/contacts/${d.ghl_contact_id}`, apiKey) as
          { contact?: { customFields?: ContactCF[] } } | null
        const cfs = j?.contact?.customFields
        if (!cfs) { summary.noContact++; continue }
        summary.contactsFetched++

        let lumin: string | null = null
        let vendor: string | null = null
        for (const f of cfs) {
          if (ids.lumin && f.id === ids.lumin) lumin = cleanIdValue(cfValue(f))
          else if (ids.vendor && f.id === ids.vendor) vendor = cleanIdValue(cfValue(f))
        }

        if (lumin) {
          summary.luminFound++
          if (summary.samples.length < 8) summary.samples.push({ deal: d.id, lumin })
          if (run) {
            const { error: e1 } = await supabase.from('deals')
              .update({ lumin_lead_id: lumin }).eq('id', d.id).is('lumin_lead_id', null)
            if (e1) summary.errors++
            else summary.luminWritten++
          }
        }
        if (vendor && d.vendor_lead_id == null) {
          summary.vendorFound++
          if (run) {
            const { error: e2 } = await supabase.from('deals')
              .update({ vendor_lead_id: vendor }).eq('id', d.id).is('vendor_lead_id', null)
            if (e2) summary.errors++
            else summary.vendorWritten++
          }
        }
      } catch (err) {
        summary.errors++
        console.error('[backfill-lumin-id] deal', d.id, 'failed:', err)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // How many candidates are still unfilled (drives "re-run until 0").
  const { count } = await supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .not('ghl_contact_id', 'is', null)
    .not('ghl_location_id', 'is', null)
    .is('lumin_lead_id', null)
  summary.remaining = count ?? 0

  return NextResponse.json(summary)
}
