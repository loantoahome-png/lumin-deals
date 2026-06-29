import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normPhone, normEmail } from '@/lib/dealMatcher'
import { titleCase } from '@/lib/utils'
import { resolveLO } from '@/lib/loanOfficer'

const GHL_BASE = 'https://services.leadconnectorhq.com'

// ── Multi-location config ───────────────────────────────────────────────────
// Reads up to 3 GHL accounts from env vars:
//   - Default: GHL_API_KEY + GHL_LOCATION_ID            (primary, backwards compatible)
//   - Matt:    GHL_API_KEY_MATT + GHL_LOCATION_ID_MATT
//   - Extra:   GHL_API_KEY_2 + GHL_LOCATION_ID_2        (open slot for future LO)
type GHLAccount = { label: string; apiKey: string; locationId: string }

function getAccounts(): GHLAccount[] {
  const accounts: GHLAccount[] = []
  if (process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
    accounts.push({ label: 'primary', apiKey: process.env.GHL_API_KEY, locationId: process.env.GHL_LOCATION_ID })
  }
  if (process.env.GHL_API_KEY_MATT && process.env.GHL_LOCATION_ID_MATT) {
    accounts.push({ label: 'matt', apiKey: process.env.GHL_API_KEY_MATT, locationId: process.env.GHL_LOCATION_ID_MATT })
  }
  if (process.env.GHL_API_KEY_2 && process.env.GHL_LOCATION_ID_2) {
    accounts.push({ label: 'extra', apiKey: process.env.GHL_API_KEY_2, locationId: process.env.GHL_LOCATION_ID_2 })
  }
  return accounts
}

function ghlHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type GHLCustomField = {
  id?: string; key?: string; fieldKey?: string; name?: string
  field_value?: string; value?: string
}

type GHLOpportunity = Record<string, unknown>
type GHLContact     = Record<string, unknown>

// ── Shared helpers (mirror of webhook logic) ──────────────────────────────────

const GHL_STAGE_MAP: Record<string, { status: string; pipeline_group: string }> = {
  'new lead':                    { status: 'New Lead',                   pipeline_group: 'Leads' },
  'attempted contact':           { status: 'Attempted Contact',          pipeline_group: 'Leads' },
  'ghosted':                     { status: 'Ghosted',                    pipeline_group: 'Leads' },
  'responded':                   { status: 'Responded',                  pipeline_group: 'Leads' },
  'pitching':                    { status: 'Pitching',                   pipeline_group: 'Leads' },
  'appointment booked':          { status: 'Appointment Booked',         pipeline_group: 'Leads' },
  'arive lead':                  { status: 'Arive Lead',                 pipeline_group: 'Leads' },
  'app intake':                  { status: 'App Intake',                 pipeline_group: 'Leads' },
  'qualification':               { status: 'Qualification',              pipeline_group: 'Leads' },
  'pre-approved':                { status: 'Pre-Approved',               pipeline_group: 'Leads' },
  'loan setup':                  { status: 'Loan Setup',                 pipeline_group: 'Loans in Process' },
  'disclosed':                   { status: 'Disclosed',                  pipeline_group: 'Loans in Process' },
  'submitted to uw':             { status: 'Submitted to UW',            pipeline_group: 'Loans in Process' },
  'approved w/ conditions':      { status: 'Approved w/ Conditions',     pipeline_group: 'Loans in Process' },
  're-submittal':                { status: 'Re-Submittal',               pipeline_group: 'Loans in Process' },
  'clear to close':              { status: 'Clear to Close',             pipeline_group: 'Loans in Process' },
  'docs out':                    { status: 'Docs Out',                   pipeline_group: 'Loans in Process' },
  'docs signed':                 { status: 'Docs Signed',                pipeline_group: 'Loans in Process' },
  'loan funded':                 { status: 'Loan Funded',                pipeline_group: 'Funded' },
  'broker check received':       { status: 'Broker Check Received',      pipeline_group: 'Funded' },
  'loan finalized':              { status: 'Loan Finalized',             pipeline_group: 'Funded' },
  'not qualified - credit':      { status: 'Not Qualified - Credit',     pipeline_group: 'Not Ready' },
  'not qualified - income':      { status: 'Not Qualified - Income',     pipeline_group: 'Not Ready' },
  'not ready - timeframe':       { status: 'Not Ready - Timeframe',      pipeline_group: 'Not Ready' },
  'dnd - sms':                   { status: 'DND - SMS',                  pipeline_group: 'Not Ready' },
  'not ready - rate':            { status: 'Not Ready - Rate',           pipeline_group: 'Not Ready' },
  'lost to competitor':          { status: 'Lost to Competitor',         pipeline_group: 'Not Ready' },
  'non-responsive':              { status: 'Non-Responsive',             pipeline_group: 'Not Ready' },
  'remove from all automations': { status: 'Remove from All Automations',pipeline_group: 'Not Ready' },
  'stop':                        { status: 'STOP',                       pipeline_group: 'Not Ready' },
}

// resolveLO + LO_MAP moved to lib/loanOfficer.ts (shared with the GHL webhook + Arive importer).

// Funded override — these statuses always land in Funded regardless of GHL pipeline
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
function applyFundedRule(r: { status: string; pipeline_group: string }) {
  return FUNDED_STATUSES.has(r.status) ? { ...r, pipeline_group: 'Funded' } : r
}

function resolveGHLStage(
  stageName: string | null | undefined,
  pipelineName?: string | null
): { status: string; pipeline_group: string } | null {
  if (!stageName) return null
  const lower = stageName.toLowerCase().trim()
  if (GHL_STAGE_MAP[lower]) return applyFundedRule(GHL_STAGE_MAP[lower])
  for (const [key, val] of Object.entries(GHL_STAGE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return applyFundedRule(val)
  }
  if (pipelineName) {
    const pl = pipelineName.toLowerCase()
    if (pl.includes('loan') || pl.includes('process') || pl.includes('escrow'))
      return { status: 'Loan Setup', pipeline_group: 'Loans in Process' }
    if (pl.includes('not ready'))
      return { status: 'Non-Responsive', pipeline_group: 'Not Ready' }
    if (pl.includes('funded'))
      return { status: 'Loan Funded', pipeline_group: 'Loans in Process' }
  }
  return null
}

function parseAmount(val: string | number | null | undefined): number | null {
  if (val == null || val === '') return null
  if (typeof val === 'number') return isNaN(val) ? null : val
  const cleaned = String(val).replace(/[$,\s]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function sanitizeStr(val: string | null | undefined): string | null {
  if (!val) return null
  const t = val.trim()
  if (t.startsWith('{') || t.startsWith('[')) return null
  return t || null
}

/**
 * Normalize whatever GHL has in its "Loan Type" custom field down to the
 * dashboard's family-only enum (HELOC / HELOAN / FHA / VA / Conv / Non-QM /
 * DSCR / Hard Money). Drops junk values like "30-Yr Fixed", "Fixed",
 * "Fixed_or_adjustable" — those aren't loan types, they're terms/structures.
 */
function normalizeGhlLoanType(val: string | null): string | null {
  if (!val) return null
  const t = val.trim().toLowerCase()
  if (!t) return null
  if (t.includes('heloc'))    return 'HELOC'
  if (t.includes('heloan'))   return 'HELOAN'
  if (t.includes('hard'))     return 'Hard Money'
  if (t.includes('non-qm') || t.includes('non qm')) return 'Non-QM'
  if (t.includes('dscr'))     return 'DSCR'
  if (t.includes('va '))      return 'VA'
  if (/\bva\b/.test(t))       return 'VA'
  if (t.includes('fha'))      return 'FHA'
  if (t.includes('conv'))     return 'Conv'
  return null  // unknown → don't write, keep dashboard value
}

/** Same — but for the loan_purpose custom field. Dashboard accepts only Purchase/Refinance. */
function normalizeGhlLoanPurpose(val: string | null): string | null {
  if (!val) return null
  const t = val.trim().toLowerCase()
  if (t.includes('purchase')) return 'Purchase'
  if (t.includes('refi'))     return 'Refinance'
  return null
}

function getCustomField(fields: GHLCustomField[], ...keys: string[]): string | null {
  if (!Array.isArray(fields)) return null
  for (const field of fields) {
    const id = [field.key, field.fieldKey, field.name, field.id]
      .filter(Boolean).join(' ').toLowerCase().replace(/[\s_-]+/g, '')
    for (const k of keys) {
      if (id.includes(k.toLowerCase().replace(/[\s_-]+/g, '')))
        return field.field_value || field.value || null
    }
  }
  return null
}

// ── Custom-field schema lookup ──────────────────────────────────────────────
// GHL's /contacts/ endpoint returns custom field entries as bare {id, value}
// pairs — no name, no fieldKey. To match them by human-readable name we must
// first load the location's custom-field definitions and use them as a
// translation table from id → fieldKey/name.
type CustomFieldDef = { id: string; name: string; fieldKey: string }

async function fetchCustomFieldDefs(locationId: string, apiKey: string): Promise<Map<string, CustomFieldDef>> {
  const map = new Map<string, CustomFieldDef>()
  // Pull BOTH schemas. The default endpoint returns only CONTACT custom fields;
  // OPPORTUNITY custom fields (e.g. "Arive Loan ID" — key opportunity.arive_loan_id,
  // written back from Arive) need ?model=opportunity. Without the opportunity schema
  // the sync can't resolve the Arive loan number that GHL already holds.
  for (const url of [
    `${GHL_BASE}/locations/${locationId}/customFields`,
    `${GHL_BASE}/locations/${locationId}/customFields?model=opportunity`,
  ]) {
    try {
      const res = await fetch(url, { headers: ghlHeaders(apiKey) })
      if (!res.ok) {
        console.warn(`[GHL Sync] customFields schema ${url} returned ${res.status} — those fields won't be enriched`)
        continue
      }
      const data = await res.json() as { customFields?: Array<{ id?: string; name?: string; fieldKey?: string }> }
      for (const f of data.customFields ?? []) {
        if (f.id) map.set(f.id, { id: f.id, name: f.name ?? '', fieldKey: f.fieldKey ?? '' })
      }
    } catch (e) {
      console.error(`[GHL Sync] customFields schema fetch failed (${url}):`, e)
    }
  }
  console.log(`[GHL Sync] Custom-field schema: ${map.size} definitions (contact + opportunity)`)
  return map
}

// Read the "Arive Loan ID" OPPORTUNITY custom field (key opportunity.arive_loan_id),
// written back into GHL from Arive. Opportunity custom fields carry their value in
// `fieldValueString` (not field_value/value) and live on opp.customFields — so the
// normal getCustomField() path can't see them. Read it directly, matched by the
// field def's key/name so it's robust across the two sub-accounts' differing field ids.
function ariveLoanIdFromOpp(opp: GHLOpportunity, defs: Map<string, CustomFieldDef>): string | null {
  const cf = (opp.customFields as Array<{ id?: string; key?: string; fieldKey?: string; fieldValueString?: string; value?: string }>) || []
  if (!Array.isArray(cf)) return null
  for (const f of cf) {
    const def = f.id ? defs.get(f.id) : undefined
    const key = `${def?.fieldKey ?? f.fieldKey ?? ''} ${def?.name ?? ''} ${f.key ?? ''}`.toLowerCase()
    if (key.includes('arive_loan_id') || key.includes('arive loan id')) {
      const v = String(f.fieldValueString ?? f.value ?? '').trim()
      if (v) return v
    }
  }
  return null
}

/** Join an opportunity/contact's {id, value} custom-field entries with the
 *  location-level schema so getCustomField() can match by name/fieldKey. */
function enrichCustomFields(
  fields: GHLCustomField[] | undefined,
  defs: Map<string, CustomFieldDef>,
): GHLCustomField[] {
  if (!Array.isArray(fields)) return []
  return fields.map(f => {
    const def = f.id ? defs.get(f.id) : undefined
    if (!def) return f
    return {
      ...f,
      name:     f.name     ?? def.name,
      fieldKey: f.fieldKey ?? def.fieldKey,
      key:      f.key      ?? def.fieldKey,
    }
  })
}

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}

// Reject junk lead-source values that some external GHL process writes (e.g.
// "loan-audit-reconciliation:<uuid>"). These are not real lead sources and
// would pollute Lead Spend. Returning null here means the sync won't overwrite
// a good source with garbage, and the deal shows "(no source set)" instead.
function cleanSource(v: string | null): string | null {
  if (!v) return null
  if (/^loan-audit-reconciliation:/i.test(v.trim())) return null
  return v
}

// ── GHL API Fetchers ──────────────────────────────────────────────────────────

async function fetchPipelineStageMap(locationId: string, apiKey: string): Promise<Map<string, { name: string; pipelineName: string }>> {
  const map = new Map<string, { name: string; pipelineName: string }>()
  try {
    const res = await fetch(
      `${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`,
      { headers: ghlHeaders(apiKey) }
    )
    const data = await res.json() as { pipelines?: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }> }
    for (const pipeline of data.pipelines || []) {
      for (const stage of pipeline.stages || []) {
        map.set(stage.id, { name: stage.name, pipelineName: pipeline.name })
      }
    }
    console.log(`[GHL Sync] Pipeline map: ${map.size} stages across ${data.pipelines?.length ?? 0} pipelines`)
  } catch (e) {
    console.error('[GHL Sync] Failed to fetch pipelines:', e)
  }
  return map
}

async function fetchUserMap(
  locationId: string,
  apiKey: string,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  // 0. Fast path — reuse a recently-built map from sync_state. The ID→name
  //    mapping is effectively static (just the LOs, e.g. Moe / Matt), so
  //    rebuilding it from the API + a 2 000-row bootstrap scan on every 5-min
  //    cron tick is pure waste. Cache it for 6h; this turns the common case
  //    into a single tiny key/value read.
  const USER_MAP_CACHE_KEY = `ghl_user_map_cache:${locationId}`
  const USER_MAP_TTL_MS = 6 * 60 * 60 * 1000
  try {
    const { data } = await supabase.from('sync_state').select('value').eq('key', USER_MAP_CACHE_KEY).maybeSingle()
    const cached = data?.value as { built_at?: string; entries?: Record<string, string> } | null
    if (cached?.built_at && cached.entries && Date.now() - Date.parse(cached.built_at) < USER_MAP_TTL_MS) {
      for (const [id, name] of Object.entries(cached.entries)) map.set(id, name)
      console.log(`[GHL Sync] User map from cache: ${map.size} users (skipped API + bootstrap)`)
      return map
    }
  } catch { /* cache miss / table issue — fall through and rebuild */ }

  // 1. Try GHL API first (works only if the PIT has the users.readonly scope)
  try {
    const res = await fetch(
      `${GHL_BASE}/users/?locationId=${locationId}`,
      { headers: ghlHeaders(apiKey) }
    )
    if (res.ok) {
      const data = await res.json() as { users?: Array<{ id: string; name?: string; firstName?: string; lastName?: string; email?: string }> }
      for (const user of data.users || []) {
        const name = user.name || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
        if (user.id && name) map.set(user.id, name)
      }
      if (map.size > 0) {
        console.log(`[GHL Sync] User map from API: ${map.size} users`)
      }
    } else {
      console.warn(`[GHL Sync] /users/ returned ${res.status} — token likely lacks users.readonly scope. Falling back to bootstrap.`)
    }
  } catch (e) {
    console.error('[GHL Sync] /users/ fetch failed:', e)
  }

  // 2. Override with explicit env-var map (highest priority)
  // Format: GHL_USER_MAP='{"BPZOTW5ZpGUzpHMl6U2m":"Moe Sefati","abc123":"Matt Park"}'
  try {
    const raw = process.env.GHL_USER_MAP
    if (raw) {
      const overrides = JSON.parse(raw) as Record<string, string>
      for (const [id, name] of Object.entries(overrides)) {
        if (id && name) map.set(id, name)
      }
      console.log(`[GHL Sync] Applied ${Object.keys(overrides).length} entries from GHL_USER_MAP`)
    }
  } catch (e) {
    console.error('[GHL Sync] Bad GHL_USER_MAP JSON:', e)
  }

  // 3. Bootstrap from existing dashboard data — for any user ID we don't yet know,
  //    look at deals where that ID is the assigned GHL user AND loan_officer is
  //    already set, take the most common LO name. Learns the mapping from data.
  //    Reads the dedicated `ghl_assigned_user` column rather than the whole
  //    `raw_ghl_data` JSON blob — same value, ~50× less data pulled per run.
  try {
    const { data: deals } = await supabase
      .from('deals')
      .select('loan_officer, ghl_assigned_user')
      .not('loan_officer', 'is', null)
      .not('ghl_assigned_user', 'is', null)
      .limit(2000)

    const tally: Record<string, Record<string, number>> = {}
    for (const d of (deals as Array<{ loan_officer: string | null; ghl_assigned_user: string | null }>) || []) {
      const aid = d.ghl_assigned_user ?? undefined
      const lo = d.loan_officer
      if (!aid || !lo) continue
      tally[aid] ??= {}
      tally[aid][lo] = (tally[aid][lo] ?? 0) + 1
    }
    let bootstrapped = 0
    for (const [aid, counts] of Object.entries(tally)) {
      if (map.has(aid)) continue // don't override API/env map
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
      if (top && top[1] >= 1) {
        map.set(aid, top[0])
        bootstrapped++
      }
    }
    if (bootstrapped > 0) {
      console.log(`[GHL Sync] Bootstrapped ${bootstrapped} user IDs from existing deals`)
    }
  } catch (e) {
    console.error('[GHL Sync] Bootstrap failed:', e)
  }

  console.log(`[GHL Sync] Final user map: ${map.size} users →`,
    Array.from(map.entries()).map(([id, n]) => `${id.slice(-6)}:${n}`).join(', '))

  // Persist for the next 6h of runs so they hit the fast path above.
  try {
    await supabase.from('sync_state').upsert({
      key: USER_MAP_CACHE_KEY,
      value: { built_at: new Date().toISOString(), entries: Object.fromEntries(map) },
      updated_at: new Date().toISOString(),
    })
  } catch { /* non-fatal — next run just rebuilds */ }

  return map
}

// ── Sync state (per-location last-synced timestamp) ───────────────────────
// Backed by a tiny key/value table in Supabase. Used for incremental sync —
// we skip any opportunity whose GHL updatedAt is older than the last run.
const SYNC_STATE_KEY = (locationId: string) => `ghl_sync_last:${locationId}`

async function getLastSyncedAt(
  supabase: ReturnType<typeof createServiceClient>,
  key: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', key)
      .maybeSingle()
    if (error) {
      console.warn(`[GHL Sync] Could not read sync_state for ${key} (${error.message}). Falling back to full sync.`)
      return null
    }
    const v = data?.value as { last_synced_at?: string } | null
    return v?.last_synced_at ?? null
  } catch (e) {
    console.warn('[GHL Sync] sync_state read failed (table may not exist yet):', e)
    return null
  }
}

async function setLastSyncedAt(
  supabase: ReturnType<typeof createServiceClient>,
  key: string,
  timestampIso: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('sync_state').upsert({
      key,
      value: { last_synced_at: timestampIso },
      updated_at: new Date().toISOString(),
    })
    if (error) console.warn(`[GHL Sync] Could not write sync_state for ${key}: ${error.message}`)
  } catch (e) {
    console.warn('[GHL Sync] sync_state write failed (table may not exist yet):', e)
  }
}

/** Look up a single GHL user by ID (fallback for agency-level users not in location map) */
async function fetchUserById(userId: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/users/${userId}`, { headers: ghlHeaders(apiKey) })
    if (!res.ok) return null
    const u = await res.json() as { name?: string; firstName?: string; lastName?: string }
    return u.name || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null
  } catch {
    return null
  }
}

// Returns the full opportunity list AND whether the fetch ran to completion.
// `complete` is true only if we reached the natural end of pagination with no
// HTTP error and without hitting the page cap. Orphan-pruning relies on this:
// we must NOT treat deals as orphaned off a partial list (an API hiccup could
// otherwise wipe live deals).
async function fetchAllOpportunities(locationId: string, apiKey: string): Promise<{ list: GHLOpportunity[]; complete: boolean }> {
  const all: GHLOpportunity[] = []
  let startAfter: string | undefined
  let startAfterId: string | undefined
  let errored = false
  let reachedEnd = false

  for (let page = 0; page < 50; page++) { // cap at 5 000 opportunities
    const params: Record<string, string> = { location_id: locationId, limit: '100' }
    if (startAfter)   params.startAfter   = startAfter
    if (startAfterId) params.startAfterId = startAfterId

    const res = await fetch(
      `${GHL_BASE}/opportunities/search?${new URLSearchParams(params)}`,
      { headers: ghlHeaders(apiKey) }
    )
    if (!res.ok) {
      console.error('[GHL Sync] Opportunities fetch error:', res.status, await res.text())
      errored = true
      break
    }
    const data = await res.json() as { opportunities?: GHLOpportunity[]; meta?: { startAfter?: string; startAfterId?: string } }
    const batch = data.opportunities || []
    all.push(...batch)
    console.log(`[GHL Sync] Fetched ${all.length} opportunities so far...`)

    if (batch.length < 100 || !data.meta?.startAfter) { reachedEnd = true; break }
    startAfter   = data.meta.startAfter
    startAfterId = data.meta.startAfterId
  }
  return { list: all, complete: reachedEnd && !errored }
}

// Incremental opportunity fetch: pull newest-updated first (order=desc, verified
// supported) and STOP as soon as we pass `sinceMs`, so a typical run fetches only
// the handful of opps changed since the last sync instead of all ~1 200 (~4 MB).
// Always returns complete:false — never used for orphan-pruning (that needs the
// full list, which the periodic maintenance run still does via fetchAllOpportunities).
async function fetchOpportunitiesSince(locationId: string, apiKey: string, sinceMs: number): Promise<{ list: GHLOpportunity[]; complete: boolean }> {
  const all: GHLOpportunity[] = []
  let startAfter: string | undefined
  let startAfterId: string | undefined

  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = { location_id: locationId, limit: '100', order: 'desc' }
    if (startAfter)   params.startAfter   = startAfter
    if (startAfterId) params.startAfterId = startAfterId

    const res = await fetch(
      `${GHL_BASE}/opportunities/search?${new URLSearchParams(params)}`,
      { headers: ghlHeaders(apiKey) }
    )
    if (!res.ok) {
      console.error('[GHL Sync] Incremental opportunities fetch error:', res.status, await res.text())
      break
    }
    const data = await res.json() as { opportunities?: GHLOpportunity[]; meta?: { startAfter?: string; startAfterId?: string } }
    const batch = data.opportunities || []

    let reachedOld = false
    for (const o of batch) {
      const u = str(o.updatedAt ?? o.dateUpdated ?? o.lastStatusChangeAt)
      const ms = u ? Date.parse(u) : 0
      if (ms && ms < sinceMs) { reachedOld = true; break }  // older than cursor → done
      all.push(o)
    }
    if (reachedOld) break
    if (batch.length < 100 || !data.meta?.startAfter) break
    startAfter   = data.meta.startAfter
    startAfterId = data.meta.startAfterId
  }
  console.log(`[GHL Sync] Incremental: fetched ${all.length} changed opportunit${all.length === 1 ? 'y' : 'ies'} (skipped full ~1 200-row scan)`)
  return { list: all, complete: false }
}

async function fetchAllContacts(locationId: string, apiKey: string): Promise<Map<string, GHLContact>> {
  const map = new Map<string, GHLContact>()
  let page = 1

  for (let i = 0; i < 50; i++) { // cap at 5 000 contacts
    const params = new URLSearchParams({ locationId, limit: '100', page: String(page) })
    const res = await fetch(
      `${GHL_BASE}/contacts/?${params}`,
      { headers: ghlHeaders(apiKey) }
    )
    if (!res.ok) {
      console.error('[GHL Sync] Contacts fetch error:', res.status, await res.text())
      break
    }
    const data = await res.json() as { contacts?: GHLContact[] }
    const batch = data.contacts || []
    for (const c of batch) {
      const id = str(c.id)
      if (id) map.set(id, c)
    }
    console.log(`[GHL Sync] Fetched ${map.size} contacts so far...`)
    if (batch.length < 100) break
    page++
  }
  return map
}

// Incremental-sync companion to fetchAllContacts: fetch only the specific
// contacts whose opportunities changed since the last run. Avoids paging
// through thousands of unchanged contacts on every 5-min cron tick.
async function fetchContactsByIds(
  apiKey: string,
  ids: string[],
): Promise<Map<string, GHLContact>> {
  const map = new Map<string, GHLContact>()
  if (ids.length === 0) return map
  const CONCURRENCY = 10
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async id => {
        try {
          const res = await fetch(`${GHL_BASE}/contacts/${id}`, { headers: ghlHeaders(apiKey) })
          if (!res.ok) return null
          const data = await res.json() as { contact?: GHLContact }
          return data.contact ?? null
        } catch {
          return null
        }
      })
    )
    for (let j = 0; j < chunk.length; j++) {
      const c = results[j]
      if (c) map.set(chunk[j], c)
    }
  }
  return map
}

// ── Main Sync Handler ─────────────────────────────────────────────────────────

async function syncAccount(
  account: GHLAccount,
  supabase: ReturnType<typeof createServiceClient>,
  opts: { full: boolean; maintenance?: boolean } = { full: false },
): Promise<{ created: number; updated: number; skipped: number; pruned: number; flagged: string[]; errors: string[] }> {
  const { apiKey, locationId, label } = account
  let created = 0, updated = 0, skipped = 0, pruned = 0
  const flagged: string[] = []   // funded deals whose GHL opportunity vanished (kept, not deleted)
  const errors: string[] = []

  // Capture the run-start time BEFORE doing any work — anything updated in GHL
  // during the run still gets picked up next time (small over-fetch is safer
  // than the alternative of missing changes).
  const runStartedAt = new Date().toISOString()

  // Load the last successful run timestamp for this location (null if first
  // run, table missing, or ?full=1 was passed). Anything older than this in
  // GHL will be skipped — that's the incremental-sync trick.
  //
  // OVERLAP: we subtract a buffer so each run re-checks the last ~10 minutes of
  // changes. GHL's opportunity SEARCH index lags a few seconds behind the live
  // opportunity, so a stage change can land just as a sync reads stale data —
  // the run then advances the cursor PAST that change's timestamp and the
  // opportunity (whose updatedAt never moves again) gets skipped forever.
  // Re-checking a short window absorbs that lag. Reprocessing unchanged opps is
  // idempotent (same values written), so the only cost is a few extra writes.
  const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000
  const lastSyncedAt = opts.full ? null : await getLastSyncedAt(supabase, SYNC_STATE_KEY(locationId))
  const lastSyncedMs = lastSyncedAt ? Math.max(0, Date.parse(lastSyncedAt) - INCREMENTAL_OVERLAP_MS) : 0

  console.log(`[GHL Sync:${label}] Starting${opts.full ? ' FULL' : ''} sync for location ${locationId}` +
              (lastSyncedAt ? ` (incremental — last synced ${lastSyncedAt})` : ' (full — no prior sync state)'))

  const isFullSync = lastSyncedMs === 0   // first-ever run OR ?full=1
  const runMaintenance = opts.maintenance !== false
  // The prune needs the COMPLETE live-opp set, so do a full opp fetch on first/
  // forced runs and on maintenance runs (gated to ~15 min by the cron). On plain
  // incremental pings, early-stop after the changed opps — the big CPU saver.
  const needFullOpps = isFullSync || runMaintenance

  // ── 1. Fetch lookup maps ───────────────────────────────────────────────────
  // Contacts are intentionally NOT in this Promise.all — on incremental syncs
  // we only need contacts for the small set of opportunities that actually
  // changed, so fetching all of them every ping is pure waste.
  const [pipelineMap, userMap, oppResult, customFieldDefs] = await Promise.all([
    fetchPipelineStageMap(locationId, apiKey),
    fetchUserMap(locationId, apiKey, supabase),
    needFullOpps ? fetchAllOpportunities(locationId, apiKey) : fetchOpportunitiesSince(locationId, apiKey, lastSyncedMs),
    fetchCustomFieldDefs(locationId, apiKey),
  ])
  const opportunities = oppResult.list
  const oppFetchComplete = oppResult.complete

  // ── 1a. Pre-filter to opportunities that actually changed ────────────────
  // Was done per-iteration below; lifting it here lets us scope the contact
  // fetch + dedup-index query to just the changed set on incremental runs.
  let changedOpps: GHLOpportunity[]
  if (isFullSync) {
    changedOpps = opportunities
  } else {
    changedOpps = opportunities.filter(opp => {
      const u = str(opp.updatedAt ?? opp.dateUpdated ?? opp.lastStatusChangeAt)
      const ms = u ? Date.parse(u) : 0
      // No timestamp → process to be safe (rare). Otherwise apply the cursor.
      return ms === 0 || ms >= lastSyncedMs
    })
    skipped += opportunities.length - changedOpps.length
    console.log(`[GHL Sync:${label}] Incremental: ${changedOpps.length}/${opportunities.length} opps changed since cursor`)
  }

  // ── 1b. Fetch contacts (scoped on incremental, full on first/forced run) ──
  let contactMap: Map<string, GHLContact>
  if (isFullSync) {
    contactMap = await fetchAllContacts(locationId, apiKey)
  } else {
    const wantedContactIds = Array.from(new Set(
      changedOpps
        .map(opp => {
          const embedded = opp.contact as GHLContact | undefined
          return str(embedded?.id) ?? str(opp.contactId)
        })
        .filter((x): x is string => !!x)
    ))
    contactMap = await fetchContactsByIds(apiKey, wantedContactIds)
    console.log(`[GHL Sync:${label}] Incremental: fetched ${contactMap.size}/${wantedContactIds.length} contacts (skipped full ~5 000-row scan)`)
  }

  // ── 1c. Build in-memory dedup index of existing dashboard deals ──────────
  //   Maps:
  //     • byOppId            ghl_opportunity_id → deal (the loan) — used to
  //                          decide insert-vs-update for each incoming opp.
  //     • contactToBorrower  contact_id → borrower_id — used when a new opp
  //     • emailToBorrower    email      → borrower_id   comes in for a known
  //     • phoneToBorrower    phone      → borrower_id   person so the new
  //                          loan card is linked to their existing group.
  //
  //   FULL sync: page through every deal (cap 1 000/page from PostgREST).
  //   INCREMENTAL: scoped query — only deals matching the changed opps' ids
  //   or their contact_ids. Cuts a multi-thousand-row scan to a few dozen.
  type DealKey = { id: string; pipeline_group: string | null }
  const byOppId = new Map<string, DealKey>()
  const contactToBorrower = new Map<string, string>()
  const emailToBorrower = new Map<string, string>()
  const phoneToBorrower = new Map<string, string>()

  type DedupRow = { id: string; ghl_contact_id: string | null; ghl_opportunity_id: string | null; email: string | null; phone: string | null; borrower_id: string | null; pipeline_group: string | null }
  const ingestDedupRow = (d: DedupRow) => {
    if (d.ghl_opportunity_id && !byOppId.has(d.ghl_opportunity_id)) byOppId.set(d.ghl_opportunity_id, { id: d.id, pipeline_group: d.pipeline_group })
    if (d.borrower_id) {
      if (d.ghl_contact_id && !contactToBorrower.has(d.ghl_contact_id)) contactToBorrower.set(d.ghl_contact_id, d.borrower_id)
      const e = normEmail(d.email); if (e && !emailToBorrower.has(e)) emailToBorrower.set(e, d.borrower_id)
      const p = normPhone(d.phone); if (p && !phoneToBorrower.has(p)) phoneToBorrower.set(p, d.borrower_id)
    }
  }

  if (isFullSync) {
    const DEDUP_PAGE = 1000
    let offset = 0
    for (;;) {
      const { data: pageRows, error: pageErr } = await supabase
        .from('deals')
        .select('id, ghl_contact_id, ghl_opportunity_id, email, phone, borrower_id, pipeline_group')
        .order('id', { ascending: true })
        .range(offset, offset + DEDUP_PAGE - 1)
      if (pageErr) {
        console.error(`[GHL Sync:${label}] Dedup index page ${offset} failed:`, pageErr.message)
        break
      }
      const rows = (pageRows ?? []) as DedupRow[]
      for (const d of rows) ingestDedupRow(d)
      if (rows.length < DEDUP_PAGE) break
      offset += DEDUP_PAGE
    }
  } else {
    // Scoped dedup: only rows that could possibly match a changed opp.
    const targetOppIds = new Set<string>()
    const targetContactIds = new Set<string>()
    for (const opp of changedOpps) {
      const oid = str(opp.id); if (oid) targetOppIds.add(oid)
      const embedded = opp.contact as GHLContact | undefined
      const cid = str(embedded?.id) ?? str(opp.contactId)
      if (cid) targetContactIds.add(cid)
    }

    const seenIds = new Set<string>()
    const queryBy = async (col: 'ghl_opportunity_id' | 'ghl_contact_id', values: Set<string>) => {
      if (values.size === 0) return
      const arr = Array.from(values)
      const CHUNK = 100   // keeps the .in() URL well under PostgREST's limit
      for (let i = 0; i < arr.length; i += CHUNK) {
        const chunk = arr.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from('deals')
          .select('id, ghl_contact_id, ghl_opportunity_id, email, phone, borrower_id, pipeline_group')
          .in(col, chunk)
        if (error) {
          console.error(`[GHL Sync:${label}] Scoped dedup query (${col}) failed:`, error.message)
          continue
        }
        for (const d of ((data ?? []) as DedupRow[])) {
          if (seenIds.has(d.id)) continue
          seenIds.add(d.id)
          ingestDedupRow(d)
        }
      }
    }
    await queryBy('ghl_opportunity_id', targetOppIds)
    await queryBy('ghl_contact_id', targetContactIds)
  }

  console.log(`[GHL Sync:${label}] Indexed ${byOppId.size} deals by opportunity_id; borrower lookups: ${contactToBorrower.size} contact / ${emailToBorrower.size} email / ${phoneToBorrower.size} phone`)

  console.log(`[GHL Sync:${label}] Processing ${changedOpps.length} opportunities (of ${opportunities.length} fetched)`)

  // Accumulators — we collect everything, then write in batches at the end.
  const toInsert: Record<string, unknown>[] = []
  const toUpdate: Record<string, unknown>[] = []
  // De-dupe within this run by opportunity id (rare but possible if GHL pages overlap).
  const seenOppIds = new Set<string>()
  // Track borrower ids assigned to brand-new contacts within this run, so a
  // contact's 2nd opportunity processed in the same run lands in the same group.
  const runContactBorrower = new Map<string, string>()

    // ── 2. Process each opportunity ───────────────────────────────────────────
    // Iterate ONLY the changed set — the incremental cursor was applied at the
    // top, so we no longer per-iter skip. On full syncs changedOpps === opportunities.
    for (const opp of changedOpps) {
      try {
        // Resolve contact + opportunity id. We key the deal by OPPORTUNITY id
        // (one loan per opportunity), so two opportunities for the same contact
        // become two separate cards.
        const embeddedContact = opp.contact as GHLContact | undefined
        const contactId = str(embeddedContact?.id || opp.contactId)
        if (!contactId) continue
        const oppId = str(opp.id)
        if (!oppId) continue                       // can't key it — skip
        if (seenOppIds.has(oppId)) continue        // dedupe within this run
        seenOppIds.add(oppId)

        // Full contact data (has custom fields)
        const fullContact: GHLContact = contactMap.get(contactId) ?? embeddedContact ?? {}

        // Resolve pipeline stage
        const stageId    = str(opp.pipelineStageId)
        const stageInfo  = stageId ? pipelineMap.get(stageId) : undefined
        const stageName  = stageInfo?.name ?? str(opp.pipelineStageName)
        const pipelineName = stageInfo?.pipelineName ?? str(opp.pipelineName)
        const stage = resolveGHLStage(stageName, pipelineName)

        // GHL opportunity STATUS (open | won | lost | abandoned), separate from
        // the pipeline stage. The team now leaves a fallen-through loan in its
        // last stage (e.g. "Submitted to UW") and just flips status to lost/
        // abandoned — so "active" can no longer be judged from stage alone. A
        // dead opportunity is routed to "Not Ready" so it drops out of Active
        // Escrows everywhere (funded deals are protected — they never get
        // demoted by a status flip).
        const oppStatus = (str(opp.status) ?? '').toLowerCase()
        const isDead = oppStatus === 'lost' || oppStatus.startsWith('abandon')
        const stageGroup = stage?.pipeline_group ?? 'Leads'
        const effectiveGroup = (isDead && stageGroup !== 'Funded') ? 'Not Ready' : stageGroup

        // Resolve loan officer — check camelCase, snake_case, and embedded user objects
        const assignedToId = str(
          opp.assignedTo ?? opp.assigned_to ?? opp.assignedToId ?? opp.userId ??
          fullContact.assignedTo ?? fullContact.assigned_to
        )

        // Check for an embedded user/owner object in the opportunity
        const embeddedUserObj = (opp.user ?? opp.owner ?? opp.assignedUser) as Record<string, unknown> | null | undefined
        const embeddedUserName = embeddedUserObj
          ? str(embeddedUserObj.name ?? embeddedUserObj.fullName ??
              `${embeddedUserObj.firstName ?? ''} ${embeddedUserObj.lastName ?? ''}`.trim())
          : null

        // Look up from map first, then fall back to a direct API fetch for agency-level users
        let assignedName: string | null = embeddedUserName ?? (assignedToId ? (userMap.get(assignedToId) ?? null) : null)
        if (!assignedName && assignedToId) {
          assignedName = await fetchUserById(assignedToId, apiKey)
          if (assignedName) {
            userMap.set(assignedToId, assignedName) // cache it for subsequent iterations
            console.log(`[GHL Sync:${label}] Fetched unknown user ${assignedToId} → ${assignedName}`)
          }
        }

        // Resolve the LO from the assigned GHL user. If nobody is assigned in
        // GHL, fall back to the sub-account owner (each LO has their own
        // location): Matt's account → Matt Park, Moe's (primary) → Moe Sefati.
        const loFromAccount = label === 'matt' ? 'Matt Park' : label === 'primary' ? 'Moe Sefati' : null
        const loanOfficer = resolveLO(assignedName) || loFromAccount
        if (!loanOfficer && assignedToId) {
          console.log(`[GHL Sync:${label}] No LO resolved for assignedTo="${assignedToId}" name="${assignedName}" contact="${contactId}"`)
        }

        // Custom fields — GHL's /contacts/ endpoint returns these as bare
        // {id, value} pairs, so we enrich them with name/fieldKey from the
        // location-level schema before lookup.
        const rawCustomFields = (
          (fullContact.customFields as GHLCustomField[]) ||
          (fullContact.custom_fields as GHLCustomField[]) ||
          (opp.customFields as GHLCustomField[]) || []
        )
        const customFields = enrichCustomFields(rawCustomFields, customFieldDefs)
        // Arive loan number that Arive writes back into the GHL opportunity. This is
        // the deterministic GHL↔Arive join key — far better than fuzzy name matching.
        const ariveLoanId = ariveLoanIdFromOpp(opp, customFieldDefs)

        // Names
        const firstName = str(fullContact.firstName) ?? ''
        const lastName  = str(fullContact.lastName)  ?? ''
        const rawName = (str(fullContact.name ?? fullContact.fullName) ||
                     `${firstName} ${lastName}`.trim()) || 'Unknown'
        // Title-case so display is consistent regardless of how GHL stored it
        const name = titleCase(rawName) || rawName
        const firstNameCased = titleCase(firstName)
        const lastNameCased  = titleCase(lastName)

        // Tags
        const tagsRaw = fullContact.tags || opp.tags
        const ghlTags = Array.isArray(tagsRaw)
          ? (tagsRaw as string[]).join(', ')
          : (typeof tagsRaw === 'string' ? tagsRaw : null)

        // Build deal record
        const dealData: Record<string, unknown> = {
          name,
          first_name:       firstNameCased,
          last_name:        lastNameCased,
          email:            str(fullContact.email),
          phone:            str(fullContact.phone ?? fullContact.phoneNumber),
          status:           stage?.status        ?? 'New Lead',
          pipeline_group:   effectiveGroup,
          ghl_status:       oppStatus || null,
          loan_officer:     loanOfficer,
          ghl_contact_id:   contactId,
          ghl_opportunity_id: str(opp.id),     // the GHL opportunity (loan) ID
          arive_file_no:    ariveLoanId,       // Arive loan #, written back into GHL (deterministic join)
          ghl_location_id:  locationId,        // so the dashboard can link to the right GHL sub-account
          ghl_tags:         ghlTags,
          ghl_assigned_user:assignedToId,
          // borrower_id links a person's multiple loans. On INSERT this fresh
          // UUID is used; on UPDATE it's excluded from maybeSet so the existing
          // borrower grouping is preserved.
          borrower_id:      crypto.randomUUID(),
          // Real lead source from GHL. PREFER the "Lead Source" custom field
          // (contact.lead_source) — that's the field the team actually maintains
          // (e.g. "Lendgo"). GHL's native `source` attribute is auto-attribution
          // (e.g. "Advertisements") and often disagrees, so it's only a fallback.
          // Do NOT default to the literal 'GHL'; leave null when GHL has nothing.
          source:           cleanSource(str(getCustomField(customFields, 'lead_source', 'Lead Source', 'leadsource'))
                            ?? str(fullContact.source) ?? str(opp.source) ?? str(embeddedContact?.source) ?? null),
          date_added_ghl:   str(fullContact.dateAdded ?? fullContact.createdAt ?? opp.createdAt),
          raw_ghl_data:     opp,
          city:             str(fullContact.city),
          state:            str(fullContact.state),
          zip:              str(fullContact.postalCode ?? fullContact.postal_code),
          // Do-Not-Contact (compliance) — master flag + per-channel settings.
          dnd:              typeof fullContact.dnd === 'boolean' ? fullContact.dnd : null,
          dnd_settings:     (fullContact.dndSettings && typeof fullContact.dndSettings === 'object') ? fullContact.dndSettings : null,
          // Loan fields from custom fields
          // loan_amount: ALWAYS the GHL opportunity Value (monetaryValue) — NEVER the
          // "Loan Amount" custom field, an unreliable lead-intake number (it put $610k
          // on a $150k loan). The opp value drives the amount on every IN-PROCESS loan;
          // Arive becomes authoritative only once the loan is FUNDED (see update guard).
          loan_amount:      parseAmount(opp.monetaryValue as number | null),
          estimated_value:  parseAmount(getCustomField(customFields, 'estimated_value', 'property_value', 'home_value', 'Property Value')),
          credit_score:     parseAmount(getCustomField(customFields, 'credit_score', 'credit score', 'fico')),
          loan_type:        normalizeGhlLoanType(getCustomField(customFields, 'loan_type', 'loan type', 'Loan Type')),
          loan_purpose:     normalizeGhlLoanPurpose(getCustomField(customFields, 'loan_purpose', 'loan purpose', 'Loan Purpose')),
          occupancy:        str(getCustomField(customFields, 'occupancy', 'property use', 'Property Use')),
          property_type:    str(getCustomField(customFields, 'property_type', 'Property Type')),
          property_address: str(getCustomField(customFields, 'property_address', 'physical_address') ?? fullContact.address1),
          current_balance:  parseAmount(getCustomField(customFields, 'current_balance', 'First Mortgage Balance')),
          ltv:              parseAmount(getCustomField(customFields, 'ltv', 'LTV')),
          cash_out:         parseAmount(getCustomField(customFields, 'cash_out', 'cashout', 'Cashout')),
          down_payment:     parseAmount(getCustomField(customFields, 'down_payment', 'Down Payment')),
          lead_price:       parseAmount(getCustomField(customFields, 'lead_price', 'Lead Price')),
          rate:             parseAmount(getCustomField(customFields, 'rate', 'interest_rate', 'note_rate')),
          investor:         str(getCustomField(customFields, 'investor', 'lender', 'wholesale_lender')),
          credit_rating:    str(getCustomField(customFields, 'credit_rating', 'credit rating', 'Credit Rating')),
          is_military:      str(getCustomField(customFields, 'is_military', 'veteran', 'Veteran')),
          current_va_loan:  str(getCustomField(customFields, 'current_va_loan', 'va_loan', 'VA Loan')),
        }

        // ── Match by OPPORTUNITY id (the loan) ──────────────────────────────
        const incomingEmail = normEmail(dealData.email as string | null)
        const incomingPhone = normPhone(dealData.phone as string | null)
        const existing: DealKey | null = byOppId.get(oppId) ?? null

        if (existing) {
          // Update the loan. Sync status/pipeline always; other fields only when
          // GHL has a value (never erase manual/Monday/Arive data).
          const patch: Record<string, unknown> = {
            id:               existing.id,
            name:             dealData.name,   // NOT NULL — required even on update via upsert path
            status:           dealData.status,
            pipeline_group:   dealData.pipeline_group,
            ghl_tags:         dealData.ghl_tags,
            raw_ghl_data:     dealData.raw_ghl_data,
            ghl_location_id:  dealData.ghl_location_id,
            ghl_contact_id:   contactId,
          }
          // A funded deal carries Arive-authoritative dollars. GHL's opportunity
          // value (often a stale lead estimate, sometimes 0) must NOT overwrite the
          // closed-loan amount — mirrors the funded guard in the reconcile block
          // below. Without this, any later opp change clobbers funded volume back
          // to the GHL number.
          const existingIsFunded = existing.pipeline_group === 'Funded'
          // loan_amount provenance (Efrain, 2026-06-25): the dashboard AMOUNT shows the
          // GHL OPPORTUNITY value (monetaryValue) for every IN-PROCESS loan — Arive-backed
          // or not. Arive is authoritative ONLY for FUNDED loans (closed-loan dollars must
          // not be clobbered by a later/stale opp edit). So the guard is funded-only: an
          // arive_file_no no longer locks loan_amount while the loan is still in process.
          const fundedOwnsAmount = existingIsFunded
          const maybeSet = (k: string) => {
            if (dealData[k] == null) return
            if (k === 'loan_amount' && fundedOwnsAmount) return
            patch[k] = dealData[k]
          }
          ;['loan_officer','loan_amount','estimated_value','credit_score','loan_type','loan_purpose',
            'occupancy','property_type','property_address','current_balance','ltv',
            'cash_out','down_payment','rate','investor','credit_rating','is_military',
            'current_va_loan','city','state','zip','first_name','last_name','email','phone',
            'source','lead_price','ghl_opportunity_id','dnd','dnd_settings','ghl_status',
          ].forEach(maybeSet)
          // In-process loans (Arive-backed or not): loan_amount mirrors the GHL
          // opportunity value — write it even when the opp value is 0/empty so a stale
          // figure (e.g. an old custom-field import that put $297,500 on a $0 opp) is
          // cleared, not left to linger. Only FUNDED deals keep their Arive figure
          // (fundedOwnsAmount).
          if (!fundedOwnsAmount) {
            patch.loan_amount = (dealData.loan_amount as number | null) ?? null
          }
          // borrower_id intentionally NOT synced — preserve existing grouping.
          toUpdate.push(patch)
          updated++
        } else {
          // New opportunity → new loan card. Link it to the person's borrower
          // group: prefer a borrower_id we already know for this contact/email/
          // phone (from existing deals or from another opp earlier in this run).
          let borrowerId =
            runContactBorrower.get(contactId) ??
            contactToBorrower.get(contactId) ??
            (incomingEmail ? emailToBorrower.get(incomingEmail) : undefined) ??
            (incomingPhone ? phoneToBorrower.get(incomingPhone) : undefined) ??
            null
          if (!borrowerId) {
            borrowerId = crypto.randomUUID()   // brand-new person
          }
          // Remember it so this contact's other opps in this run share the group
          runContactBorrower.set(contactId, borrowerId)
          dealData.borrower_id = borrowerId
          // No purchased vendor source on a brand-new lead → it's self-sourced
          // (e.g. created in GHL when an Arive app is started). Label it so it
          // categorizes instead of showing as "(no source set)". Applied ONLY on
          // insert — the update path never overwrites an existing/real source,
          // so manual recategorizations and vendor sources are preserved.
          if (!dealData.source) dealData.source = 'Self Source'
          toInsert.push(dealData)
          created++
        }
      } catch (err) {
        const msg = String(err)
        errors.push(msg)
        console.error(`[GHL Sync:${label}] Error processing opportunity:`, opp.id, msg)
      }
    }

  // ── 3. Batch-write to Supabase ─────────────────────────────────────────────
  // 500 rows per chunk keeps payload size well under Postgres / PostgREST limits.
  const CHUNK = 500
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK)
    const { error } = await supabase.from('deals').insert(slice)
    if (error) {
      console.error(`[GHL Sync:${label}] Batch insert (${slice.length}) failed:`, error.message)
      errors.push(`insert batch: ${error.message}`)
      // Don't credit these as created if the write failed
      created -= slice.length
    } else {
      console.log(`[GHL Sync:${label}] Inserted batch of ${slice.length} (total inserted: ${Math.min(i + CHUNK, toInsert.length)}/${toInsert.length})`)
    }
  }
  // ── Updates: per-row .update() (NOT bulk upsert) ──────────────────────────
  // CRITICAL: a bulk upsert of rows with heterogeneous keys makes PostgREST
  // null out any column that's present in *some* rows but missing in others
  // (it unions the columns and fills the gaps with NULL). That silently wiped
  // manually-entered fields like loan_type on deals where GHL had no value.
  // Per-row .update() only touches the columns in that row's patch — safe.
  // We run them with bounded concurrency so it stays fast (~5-10s for ~1000).
  const CONCURRENCY = 20
  for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
    const chunk = toUpdate.slice(i, i + CONCURRENCY)
    const results = await Promise.all(chunk.map(async patch => {
      const { id, ...fields } = patch as { id: string } & Record<string, unknown>
      const { error } = await supabase.from('deals').update(fields).eq('id', id)
      return error
    }))
    for (const error of results) {
      if (error) {
        console.error(`[GHL Sync:${label}] Row update failed:`, error.message)
        errors.push(`update row: ${error.message}`)
        updated--
      }
    }
  }

  // ── 3a½. Fill arive_file_no from GHL's "Arive Loan ID" field (FILL-ONLY) ───
  // Arive writes each loan # back into its GHL opportunity. Read it off the FULL
  // fetched opp list (`opportunities`, NOT just `changedOpps`) so the backlog of
  // already-closed opps links on a full/maintenance run — not only when an opp next
  // changes. `.is('arive_file_no', null)` keeps it strictly additive: a value already
  // set (e.g. from the Arive CSV) is never overwritten. This is the deterministic
  // GHL↔Arive join that stops duplicate/phantom funded rows at the source.
  {
    const fills: Array<{ oppId: string; ariveLoanId: string }> = []
    for (const opp of opportunities) {
      const oppId = str(opp.id)
      if (!oppId) continue
      const ariveLoanId = ariveLoanIdFromOpp(opp, customFieldDefs)
      if (ariveLoanId) fills.push({ oppId, ariveLoanId })
    }
    let filled = 0
    const FILL_CONC = 20
    for (let i = 0; i < fills.length; i += FILL_CONC) {
      const chunk = fills.slice(i, i + FILL_CONC)
      const counts = await Promise.all(chunk.map(async ({ oppId, ariveLoanId }) => {
        const { error, count } = await supabase
          .from('deals')
          .update({ arive_file_no: ariveLoanId }, { count: 'exact' })
          .eq('ghl_opportunity_id', oppId)
          .is('arive_file_no', null)
        if (error) { errors.push(`arive fill: ${error.message}`); return 0 }
        return count ?? 0
      }))
      filled += counts.reduce((s, n) => s + n, 0)
    }
    if (filled) console.log(`[GHL Sync:${label}] Filled arive_file_no on ${filled} deals from GHL's Arive Loan ID field (${fills.length} opps carry it)`)
  }

  // ── 3b. Prune orphans — deals whose GHL opportunity no longer exists ──────
  // When a duplicate/erroneous opportunity is deleted or merged in GHL, the
  // matching dashboard row would otherwise linger forever (the sync only ever
  // inserts/updates). That's the recurring "why do I see 2 loans?" bug.
  //
  // SAFETY (this can delete rows, so it's deliberately conservative):
  //   • Only runs when the opportunity fetch ran to COMPLETION (oppFetchComplete)
  //     and returned at least one opportunity — never prune off a partial list.
  //   • Scoped to THIS account's location; other locations are untouched.
  //   • Only considers deals that HAVE a ghl_opportunity_id (Arive-only or
  //     manually-created deals are never pruned).
  //   • FUNDED deals are NEVER auto-deleted — they're closed business. If a
  //     funded deal's opportunity vanished, we just flag it for review.
  //   • Aborts if the orphan set looks implausibly large (logic-error guard).
  //
  // CPU: this whole pass (all-deals scan + reconciliation) is skipped on most
  // runs and only runs on maintenance runs (the cron gates it to ~15 min, and
  // those are the runs that fetched the COMPLETE opp list). The lightweight
  // create/update of changed opps above still runs every ping.
  if (runMaintenance && oppFetchComplete && opportunities.length > 0) {
    const liveOppIds = new Set<string>()
    // oppId → opportunity value (the loan amount). GHL is the authority for the
    // loan amount on active (non-funded) deals, so we reconcile below.
    const oppValue = new Map<string, number | null>()
    // oppId → the opportunity's real contactId. The incremental sync skips
    // unchanged opps, so a deal's ghl_contact_id can go stale/wrong (e.g. an
    // opportunity id ends up stored there, breaking the "open in GHL" link).
    // We reconcile it from the live opportunity below.
    const oppContact = new Map<string, string>()
    // oppId → the stage/status the live opportunity resolves to. The per-ping
    // loop only re-resolves opps changed since the cursor, so a stage move that
    // slipped the incremental window (or arrived via a webhook we couldn't parse)
    // strands the deal on its old stage forever. On maintenance runs we hold the
    // COMPLETE opp list, so we recompute every live deal's stage and fix drift.
    const oppStageInfo = new Map<string, { status: string; pipeline_group: string; ghl_status: string | null }>()
    for (const o of opportunities) {
      const id = str(o.id)
      if (!id) continue
      liveOppIds.add(id)
      // Store EVERY live opp's value — including 0/empty (null) — so the reconcile
      // can CLEAR a stale loan_amount on a pre-Arive lead, not just bump it up.
      oppValue.set(id, parseAmount(o.monetaryValue as number | null))
      const cid = str((o.contact as { id?: string } | undefined)?.id ?? o.contactId)
      if (cid) oppContact.set(id, cid)
      // Resolve stage/status exactly as the main create/update loop does.
      const sId = str(o.pipelineStageId)
      const sInfo = sId ? pipelineMap.get(sId) : undefined
      const sName = sInfo?.name ?? str(o.pipelineStageName)
      const plName = sInfo?.pipelineName ?? str(o.pipelineName)
      const st = resolveGHLStage(sName, plName)
      if (st) {
        const os = (str(o.status) ?? '').toLowerCase()
        const dead = os === 'lost' || os.startsWith('abandon')
        const grp = (dead && st.pipeline_group !== 'Funded') ? 'Not Ready' : st.pipeline_group
        oppStageInfo.set(id, { status: st.status, pipeline_group: grp, ghl_status: os || null })
      }
    }

    // Pull this location's deals that have an opportunity id (paginated).
    // NOTE: we deliberately do NOT select dnd/dnd_settings here. dnd_settings is
    // a JSON blob that was ~0.5 GB/mo of egress to read for the whole table every
    // run, just to diff it. DND is reconciled below by writing the contact's
    // current value directly (see the loop), so we never need the stored copy.
    type PruneRow = { id: string; name: string | null; ghl_opportunity_id: string | null; pipeline_group: string | null; status: string | null; loan_amount: number | null; ghl_contact_id: string | null; arive_file_no: string | null }
    const locDeals: PruneRow[] = []
    let pOffset = 0
    const PRUNE_PAGE = 1000
    for (;;) {
      const { data: pr, error: pErr } = await supabase
        .from('deals')
        .select('id, name, ghl_opportunity_id, pipeline_group, status, loan_amount, ghl_contact_id, arive_file_no')
        .eq('ghl_location_id', locationId)
        .not('ghl_opportunity_id', 'is', null)
        .order('id', { ascending: true })
        .range(pOffset, pOffset + PRUNE_PAGE - 1)
      if (pErr) { console.error(`[GHL Sync:${label}] Prune scan failed:`, pErr.message); break }
      const rows = (pr ?? []) as PruneRow[]
      locDeals.push(...rows)
      if (rows.length < PRUNE_PAGE) break
      pOffset += PRUNE_PAGE
    }

    const orphanIds: string[] = []
    // Loan-amount reconciliation: the incremental sync skips unchanged opps, so a
    // loan amount edited in GHL can go stale. For LIVE, non-funded deals we force
    // loan_amount to match the opportunity's value. Funded deals keep their Arive
    // amount (authoritative for closed loans).
    const amountFixes: Array<{ id: string; loan_amount: number | null }> = []
    // DND reconciliation: Do-Not-Contact lives on the CONTACT. contactMap holds
    // only the contacts whose opportunity changed this run, so this fires just
    // for those people's deals (including their other loans). We write the
    // contact's current DND straight through — no diff against a stored copy,
    // because reading dnd_settings for the whole table every run was the costly
    // bit. The write set is small and the write is idempotent, and we still only
    // act when the contact actually carries DND info, so a sparse payload can
    // never wrongly clear a real opt-out.
    const dndFixes: Array<{ id: string; dnd: boolean | null; dnd_settings: Record<string, unknown> | null }> = []
    // Contact-id reconciliation: keep ghl_contact_id pointing at the
    // opportunity's REAL contact. The incremental sync skips unchanged opps, so
    // some rows had a stale/wrong value (even an opportunity id) stored here,
    // which broke the "open in GHL" link. We fix it for every live deal.
    const contactFixes: Array<{ id: string; ghl_contact_id: string }> = []
    // Stage/status drift fixes — see oppStageInfo above. Non-funded deals only:
    // a funded deal carries Arive-authoritative data and must not be demoted off
    // a (possibly lagging) GHL stage, same guard as loan_amount below.
    const stageFixes: Array<{ id: string; status: string; pipeline_group: string; ghl_status: string | null }> = []
    for (const d of locDeals) {
      if (!d.ghl_opportunity_id) continue
      if (!liveOppIds.has(d.ghl_opportunity_id)) {
        if (d.pipeline_group === 'Funded') {
          flagged.push(`${d.name ?? d.id} (${d.ghl_opportunity_id})`)
          console.warn(`[GHL Sync:${label}] FUNDED deal's opportunity is gone from GHL — flagged, NOT deleted: ${d.name ?? d.id}`)
        } else {
          orphanIds.push(d.id)
        }
        continue
      }
      // Opportunity still exists → reconcile loan amount + stage (non-funded only).
      if (d.pipeline_group !== 'Funded') {
        // loan_amount mirrors the GHL opportunity value on EVERY in-process loan —
        // Arive-backed or not (Efrain, 2026-06-25). Arive is authoritative only for
        // FUNDED loans, already excluded by the `!== 'Funded'` guard above. Write the
        // opp value INCLUDING 0/empty (so a stale figure can't linger); `has`
        // distinguishes "opp not fetched this run" (skip) from "value is null".
        if (oppValue.has(d.ghl_opportunity_id)) {
          const target = oppValue.get(d.ghl_opportunity_id) ?? null
          if (Number(target ?? NaN) !== Number(d.loan_amount ?? NaN)) {
            amountFixes.push({ id: d.id, loan_amount: target })
          }
        }
        const resolved = oppStageInfo.get(d.ghl_opportunity_id)
        if (resolved && (resolved.status !== d.status || resolved.pipeline_group !== d.pipeline_group)) {
          stageFixes.push({ id: d.id, status: resolved.status, pipeline_group: resolved.pipeline_group, ghl_status: resolved.ghl_status })
        }
      }
      // Reconcile contact id (all stages) from the opportunity's real contact.
      const realContact = oppContact.get(d.ghl_opportunity_id)
      if (realContact && realContact !== d.ghl_contact_id) {
        contactFixes.push({ id: d.id, ghl_contact_id: realContact })
      }
      // Reconcile DND from the contact (all stages). Only deals whose contact
      // was fetched this run (changed opps) are in contactMap.
      if (d.ghl_contact_id) {
        const c = contactMap.get(d.ghl_contact_id) as Record<string, unknown> | undefined
        const hasDndInfo = c && (typeof c.dnd === 'boolean' || (c.dndSettings && typeof c.dndSettings === 'object'))
        if (c && hasDndInfo) {
          const newDnd = typeof c.dnd === 'boolean' ? c.dnd : null
          const newDs = (c.dndSettings && typeof c.dndSettings === 'object') ? c.dndSettings as Record<string, unknown> : null
          dndFixes.push({ id: d.id, dnd: newDnd, dnd_settings: newDs })
        }
      }
    }

    // Apply loan-amount corrections (bounded concurrency).
    if (amountFixes.length > 0) {
      const AMT_CONC = 20
      let af = 0
      for (let i = 0; i < amountFixes.length; i += AMT_CONC) {
        const chunk = amountFixes.slice(i, i + AMT_CONC)
        const res = await Promise.all(chunk.map(f => supabase.from('deals').update({ loan_amount: f.loan_amount }).eq('id', f.id).then(r => r.error)))
        for (const e of res) { if (e) { console.error(`[GHL Sync:${label}] loan_amount fix failed:`, e.message) } else af++ }
      }
      console.log(`[GHL Sync:${label}] Reconciled loan_amount on ${af} non-funded deal(s) from the opportunity value.`)
    }

    // Apply stage/status corrections (bounded concurrency). Writing `status`
    // trips the Postgres trigger that resets stage_changed_at — correct here,
    // since the deal genuinely moved stage in GHL.
    if (stageFixes.length > 0) {
      const ST_CONC = 20
      let sf = 0
      for (let i = 0; i < stageFixes.length; i += ST_CONC) {
        const chunk = stageFixes.slice(i, i + ST_CONC)
        const res = await Promise.all(chunk.map(f =>
          supabase.from('deals')
            .update({ status: f.status, pipeline_group: f.pipeline_group, ghl_status: f.ghl_status })
            .eq('id', f.id).then(r => r.error)))
        for (const e of res) { if (e) { console.error(`[GHL Sync:${label}] stage fix failed:`, e.message) } else sf++ }
      }
      console.log(`[GHL Sync:${label}] Reconciled stage/status on ${sf} drifted deal(s) from the live opportunity.`)
    }

    // Apply DND corrections (bounded concurrency).
    if (dndFixes.length > 0) {
      const DND_CONC = 20
      let df = 0
      for (let i = 0; i < dndFixes.length; i += DND_CONC) {
        const chunk = dndFixes.slice(i, i + DND_CONC)
        const res = await Promise.all(chunk.map(f => supabase.from('deals').update({ dnd: f.dnd, dnd_settings: f.dnd_settings }).eq('id', f.id).then(r => r.error)))
        for (const e of res) { if (e) { console.error(`[GHL Sync:${label}] dnd fix failed:`, e.message) } else df++ }
      }
      console.log(`[GHL Sync:${label}] Reconciled DND on ${df} deal(s) from the contact.`)
    }

    // Apply contact-id corrections (bounded concurrency).
    if (contactFixes.length > 0) {
      const CID_CONC = 20
      let cf = 0
      for (let i = 0; i < contactFixes.length; i += CID_CONC) {
        const chunk = contactFixes.slice(i, i + CID_CONC)
        const res = await Promise.all(chunk.map(f => supabase.from('deals').update({ ghl_contact_id: f.ghl_contact_id }).eq('id', f.id).then(r => r.error)))
        for (const e of res) { if (e) { console.error(`[GHL Sync:${label}] contact_id fix failed:`, e.message) } else cf++ }
      }
      console.log(`[GHL Sync:${label}] Reconciled ghl_contact_id on ${cf} deal(s) from the opportunity.`)
    }

    // Logic-error guard: never delete more than 30% of the location's GHL deals
    // (or 25 rows, whichever is larger) in a single run.
    const maxPrune = Math.max(25, Math.floor(locDeals.length * 0.3))
    if (orphanIds.length > maxPrune) {
      console.error(`[GHL Sync:${label}] Prune ABORTED — ${orphanIds.length} orphans exceeds safety cap ${maxPrune}. No deletions made.`)
      errors.push(`prune aborted: ${orphanIds.length} orphans > cap ${maxPrune}`)
    } else if (orphanIds.length > 0) {
      const PRUNE_CHUNK = 200
      for (let i = 0; i < orphanIds.length; i += PRUNE_CHUNK) {
        const slice = orphanIds.slice(i, i + PRUNE_CHUNK)
        const { error: delErr } = await supabase.from('deals').delete().in('id', slice)
        if (delErr) { console.error(`[GHL Sync:${label}] Prune delete failed:`, delErr.message); errors.push(`prune delete: ${delErr.message}`) }
        else pruned += slice.length
      }
      console.log(`[GHL Sync:${label}] Pruned ${pruned} orphaned deal(s) (opportunity deleted in GHL).`)
    }
  } else {
    console.log(`[GHL Sync:${label}] Skipping orphan prune (opportunity fetch ${oppFetchComplete ? 'empty' : 'incomplete'}).`)
  }

  // ── 4. Save sync timestamp (only if no errors — otherwise next run re-tries) ──
  if (errors.length === 0) {
    await setLastSyncedAt(supabase, SYNC_STATE_KEY(locationId), runStartedAt)
  } else {
    console.warn(`[GHL Sync:${label}] Skipping sync_state write — ${errors.length} errors this run`)
  }

  console.log(
    `[GHL Sync:${label}] Done — ${created + updated} written ` +
    `(${created} created, ${updated} updated, ${skipped} skipped as unchanged, ${pruned} pruned, ${flagged.length} flagged, ${errors.length} errors)`
  )
  return { created, updated, skipped, pruned, flagged, errors }
}

// The GHL sync issues hundreds of sequential Supabase writes — give it room.
// Honored on Vercel Pro (up to 300s); Hobby caps function duration lower.
export const maxDuration = 300

type SyncResult = {
  success: boolean
  full: boolean
  accounts_synced: number
  synced: number
  created: number
  updated: number
  skipped: number
  pruned: number
  flagged: string[]
  duration_ms: number
  per_account: Array<{ label: string; locationId: string; created: number; updated: number; skipped: number; pruned: number; errors: number }>
  errors: string[]
}

/**
 * Run the multi-account GHL sync. Shared by the manual POST trigger and the
 * scheduled cron route so both paths stay identical.
 *
 * @param opts.full  If true, ignores the per-location last_synced_at and
 *                   re-processes every opportunity. Use as an escape hatch.
 * @param opts.maintenance  If false, skip the prune/reconcile pass (CPU saver
 *                   for frequent cron pings). Defaults true; full always runs it.
 */
export async function runGhlSync(opts: { full?: boolean; maintenance?: boolean } = {}): Promise<SyncResult> {
  const accounts = getAccounts()
  if (accounts.length === 0) {
    throw new Error('No GHL accounts configured. Set GHL_API_KEY + GHL_LOCATION_ID.')
  }

  const supabase = createServiceClient()
  const full = !!opts.full
  const maintenance = full || opts.maintenance !== false
  const startMs = Date.now()

  // Run accounts in PARALLEL — each one is self-contained (different location,
  // contact IDs don't overlap). Halves wall time when both LOs are configured.
  const results = await Promise.all(accounts.map(account => syncAccount(account, supabase, { full, maintenance })))

  const perAccount: SyncResult['per_account'] = []
  let totalCreated = 0, totalUpdated = 0, totalSkipped = 0, totalPruned = 0
  const allErrors: string[] = []
  const allFlagged: string[] = []
  for (let i = 0; i < accounts.length; i++) {
    const r = results[i], a = accounts[i]
    perAccount.push({
      label: a.label, locationId: a.locationId,
      created: r.created, updated: r.updated, skipped: r.skipped, pruned: r.pruned, errors: r.errors.length,
    })
    totalCreated += r.created
    totalUpdated += r.updated
    totalSkipped += r.skipped
    totalPruned  += r.pruned
    allErrors.push(...r.errors)
    allFlagged.push(...r.flagged)
  }

  return {
    success: true,
    full,
    accounts_synced: accounts.length,
    synced: totalCreated + totalUpdated,
    created: totalCreated,
    updated: totalUpdated,
    skipped: totalSkipped,
    pruned: totalPruned,
    flagged: allFlagged,
    duration_ms: Date.now() - startMs,
    per_account: perAccount,
    errors: allErrors.slice(0, 20),
  }
}

export async function POST(req: Request) {
  try {
    // Force a full sync with ?full=1 — useful if the incremental state drifts
    const url = new URL(req.url)
    const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true'
    const result = await runGhlSync({ full })
    // Note: conversation/unread refresh is handled by the 3-min cron and the
    // live /unread inbox — intentionally NOT run here to keep manual sync fast.
    return NextResponse.json(result)
  } catch (err) {
    console.error('[GHL Sync] Fatal error:', err)
    const msg = String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function GET() {
  const accounts = getAccounts()
  return NextResponse.json({
    status: 'ok',
    message: 'POST to trigger sync across all configured GHL accounts',
    configured_accounts: accounts.map(a => ({ label: a.label, locationId: a.locationId })),
  })
}
