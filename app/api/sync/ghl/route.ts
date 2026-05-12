import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normPhone, normEmail } from '@/lib/dealMatcher'

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

const LO_MAP: Record<string, string> = {
  // Moe variants
  'moe sefati': 'Moe Sefati', 'sefati': 'Moe Sefati', 'moe': 'Moe Sefati',
  // Matt variants
  'matthew park': 'Matt Park', 'matthew': 'Matt Park', 'matt park': 'Matt Park',
  'matt': 'Matt Park', 'park': 'Matt Park',
}

function resolveLO(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const [key, value] of Object.entries(LO_MAP)) {
    if (lower.includes(key)) return value
  }
  // No match — return the raw name so we don't lose the assignment
  return trimmed
}

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

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
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
  //    look at deals where that ID appears in raw_ghl_data.assignedTo AND loan_officer is already set,
  //    take the most common LO name. This effectively learns the mapping from Monday's data.
  try {
    const { data: deals } = await supabase
      .from('deals')
      .select('loan_officer, raw_ghl_data')
      .not('loan_officer', 'is', null)
      .not('raw_ghl_data', 'is', null)
      .limit(2000)

    const tally: Record<string, Record<string, number>> = {}
    for (const d of (deals as Array<{ loan_officer: string | null; raw_ghl_data: Record<string, unknown> | null }>) || []) {
      const r = d.raw_ghl_data ?? {}
      const aid = (r.assignedTo ?? r.assigned_to ?? r.assignedToId ?? r.userId) as string | undefined
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

  return map
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

async function fetchAllOpportunities(locationId: string, apiKey: string): Promise<GHLOpportunity[]> {
  const all: GHLOpportunity[] = []
  let startAfter: string | undefined
  let startAfterId: string | undefined

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
      break
    }
    const data = await res.json() as { opportunities?: GHLOpportunity[]; meta?: { startAfter?: string; startAfterId?: string } }
    const batch = data.opportunities || []
    all.push(...batch)
    console.log(`[GHL Sync] Fetched ${all.length} opportunities so far...`)

    if (batch.length < 100 || !data.meta?.startAfter) break
    startAfter   = data.meta.startAfter
    startAfterId = data.meta.startAfterId
  }
  return all
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

// ── Main Sync Handler ─────────────────────────────────────────────────────────

async function syncAccount(
  account: GHLAccount,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<{ created: number; updated: number; errors: string[] }> {
  const { apiKey, locationId, label } = account
  let created = 0, updated = 0
  const errors: string[] = []

  console.log(`[GHL Sync:${label}] Starting sync for location ${locationId}`)

  // ── 1. Fetch lookup maps ───────────────────────────────────────────────────
  const [pipelineMap, userMap, contactMap, opportunities] = await Promise.all([
    fetchPipelineStageMap(locationId, apiKey),
    fetchUserMap(locationId, apiKey, supabase),
    fetchAllContacts(locationId, apiKey),
    fetchAllOpportunities(locationId, apiKey),
  ])

  // ── 1b. Build in-memory dedup index of existing dashboard deals ───────────
  //   Allows matching by contact_id → email → phone in O(1).
  //   This handles GHL contact-ID churn: if the same person was assigned a new
  //   contact ID, we still find their dashboard record by email/phone.
  const { data: existingDeals } = await supabase
    .from('deals')
    .select('id, ghl_contact_id, email, phone')
  type DealKey = { id: string }
  const byContactId = new Map<string, DealKey>()
  const byEmail = new Map<string, DealKey>()
  const byPhone = new Map<string, DealKey>()
  for (const d of (existingDeals as Array<{ id: string; ghl_contact_id: string | null; email: string | null; phone: string | null }>) || []) {
    if (d.ghl_contact_id) byContactId.set(d.ghl_contact_id, { id: d.id })
    const e = normEmail(d.email)
    if (e && !byEmail.has(e)) byEmail.set(e, { id: d.id })
    const p = normPhone(d.phone)
    if (p && !byPhone.has(p)) byPhone.set(p, { id: d.id })
  }
  console.log(`[GHL Sync:${label}] Indexed ${byContactId.size} deals by contact_id, ${byEmail.size} by email, ${byPhone.size} by phone`)

  console.log(`[GHL Sync:${label}] Processing ${opportunities.length} opportunities`)

    // ── 2. Process each opportunity ───────────────────────────────────────────
    for (const opp of opportunities) {
      try {
        // Resolve contact
        const embeddedContact = opp.contact as GHLContact | undefined
        const contactId = str(embeddedContact?.id || opp.contactId)
        if (!contactId) continue

        // Full contact data (has custom fields)
        const fullContact: GHLContact = contactMap.get(contactId) ?? embeddedContact ?? {}

        // Resolve pipeline stage
        const stageId    = str(opp.pipelineStageId)
        const stageInfo  = stageId ? pipelineMap.get(stageId) : undefined
        const stageName  = stageInfo?.name ?? str(opp.pipelineStageName)
        const pipelineName = stageInfo?.pipelineName ?? str(opp.pipelineName)
        const stage = resolveGHLStage(stageName, pipelineName)

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

        const loanOfficer = resolveLO(assignedName)
        if (!loanOfficer && assignedToId) {
          console.log(`[GHL Sync:${label}] No LO resolved for assignedTo="${assignedToId}" name="${assignedName}" contact="${contactId}"`)
        }

        // Custom fields
        const customFields = (
          (fullContact.customFields as GHLCustomField[]) ||
          (fullContact.custom_fields as GHLCustomField[]) ||
          (opp.customFields as GHLCustomField[]) || []
        )

        // Names
        const firstName = str(fullContact.firstName) ?? ''
        const lastName  = str(fullContact.lastName)  ?? ''
        const name = (str(fullContact.name ?? fullContact.fullName) ||
                     `${firstName} ${lastName}`.trim()) || 'Unknown'

        // Tags
        const tagsRaw = fullContact.tags || opp.tags
        const ghlTags = Array.isArray(tagsRaw)
          ? (tagsRaw as string[]).join(', ')
          : (typeof tagsRaw === 'string' ? tagsRaw : null)

        // Build deal record
        const dealData: Record<string, unknown> = {
          name,
          first_name:       firstName || null,
          last_name:        lastName  || null,
          email:            str(fullContact.email),
          phone:            str(fullContact.phone ?? fullContact.phoneNumber),
          status:           stage?.status        ?? 'New Lead',
          pipeline_group:   stage?.pipeline_group ?? 'Leads',
          loan_officer:     loanOfficer,
          ghl_contact_id:   contactId,
          ghl_location_id:  locationId,        // so the dashboard can link to the right GHL sub-account
          ghl_tags:         ghlTags,
          ghl_assigned_user:assignedToId,
          source:           str(fullContact.source) ?? 'GHL',
          date_added_ghl:   str(fullContact.dateAdded ?? fullContact.createdAt ?? opp.createdAt),
          raw_ghl_data:     opp,
          city:             str(fullContact.city),
          state:            str(fullContact.state),
          zip:              str(fullContact.postalCode ?? fullContact.postal_code),
          // Loan fields from custom fields
          loan_amount:      parseAmount(opp.monetaryValue as number | null) ??
                            parseAmount(getCustomField(customFields, 'loan_amount', 'loan amount', 'Loan Amount')),
          estimated_value:  parseAmount(getCustomField(customFields, 'estimated_value', 'property_value', 'home_value', 'Property Value')),
          credit_score:     parseAmount(getCustomField(customFields, 'credit_score', 'credit score', 'fico')),
          loan_type:        sanitizeStr(getCustomField(customFields, 'loan_type', 'loan type', 'Loan Type')),
          loan_purpose:     sanitizeStr(getCustomField(customFields, 'loan_purpose', 'loan purpose', 'Loan Purpose')),
          occupancy:        str(getCustomField(customFields, 'occupancy', 'property use', 'Property Use')),
          property_type:    str(getCustomField(customFields, 'property_type', 'Property Type')),
          property_address: str(getCustomField(customFields, 'property_address', 'physical_address') ?? fullContact.address1),
          current_balance:  parseAmount(getCustomField(customFields, 'current_balance', 'First Mortgage Balance')),
          ltv:              parseAmount(getCustomField(customFields, 'ltv', 'LTV')),
          cash_out:         parseAmount(getCustomField(customFields, 'cash_out', 'cashout', 'Cashout')),
          down_payment:     parseAmount(getCustomField(customFields, 'down_payment', 'Down Payment')),
          rate:             parseAmount(getCustomField(customFields, 'rate', 'interest_rate', 'note_rate')),
          investor:         str(getCustomField(customFields, 'investor', 'lender', 'wholesale_lender')),
          credit_rating:    str(getCustomField(customFields, 'credit_rating', 'credit rating', 'Credit Rating')),
          is_military:      str(getCustomField(customFields, 'is_military', 'veteran', 'Veteran')),
          current_va_loan:  str(getCustomField(customFields, 'current_va_loan', 'va_loan', 'VA Loan')),
        }

        // ── Upsert ────────────────────────────────────────────────────────────
        // ── Find existing deal via contact ID → email → phone ───────────────
        const incomingEmail = normEmail(dealData.email as string | null)
        const incomingPhone = normPhone(dealData.phone as string | null)
        let existing: DealKey | null = byContactId.get(contactId) ?? null
        let matchedBy: 'contact_id' | 'email' | 'phone' | null = existing ? 'contact_id' : null
        if (!existing && incomingEmail && byEmail.has(incomingEmail)) {
          existing = byEmail.get(incomingEmail)!
          matchedBy = 'email'
        }
        if (!existing && incomingPhone && byPhone.has(incomingPhone)) {
          existing = byPhone.get(incomingPhone)!
          matchedBy = 'phone'
        }

        if (existing) {
          // Update: always sync status/pipeline; only overwrite other fields if GHL has a value
          // (so we never erase data filled in from Monday or by hand).
          // Also force-set ghl_contact_id to the incoming value so future syncs can
          // match this person without falling back through email/phone.
          const patch: Record<string, unknown> = {
            status:           dealData.status,
            pipeline_group:   dealData.pipeline_group,
            ghl_tags:         dealData.ghl_tags,
            raw_ghl_data:     dealData.raw_ghl_data,
            ghl_location_id:  dealData.ghl_location_id,
            ghl_contact_id:   contactId,   // ← overwrite stale ID (the real fix)
          }
          const maybeSet = (k: string) => { if (dealData[k] != null) patch[k] = dealData[k] }
          ;['loan_officer','loan_amount','estimated_value','credit_score','loan_type','loan_purpose',
            'occupancy','property_type','property_address','current_balance','ltv',
            'cash_out','down_payment','rate','investor','credit_rating','is_military',
            'current_va_loan','city','state','zip','first_name','last_name','email','phone',
          ].forEach(maybeSet)

          await supabase.from('deals').update(patch).eq('id', existing.id)
          updated++
          if (matchedBy !== 'contact_id') {
            console.log(`[GHL Sync:${label}] Reconciled "${dealData.name}" by ${matchedBy} → updated ghl_contact_id to ${contactId}`)
          }
          // Keep the map fresh so we don't double-update / re-insert on later opps
          byContactId.set(contactId, existing)
        } else {
          // Create new deal
          const { data: inserted } = await supabase.from('deals').insert(dealData).select('id').single()
          if (inserted) {
            const key: DealKey = { id: inserted.id as string }
            byContactId.set(contactId, key)
            if (incomingEmail) byEmail.set(incomingEmail, key)
            if (incomingPhone) byPhone.set(incomingPhone, key)
          }
          created++
        }
      } catch (err) {
        const msg = String(err)
        errors.push(msg)
        console.error(`[GHL Sync:${label}] Error processing opportunity:`, opp.id, msg)
      }
    }

  console.log(`[GHL Sync:${label}] Done — ${created + updated} total (${created} created, ${updated} updated, ${errors.length} errors)`)
  return { created, updated, errors }
}

export async function POST() {
  const accounts = getAccounts()
  if (accounts.length === 0) {
    return NextResponse.json({ error: 'No GHL accounts configured. Set GHL_API_KEY + GHL_LOCATION_ID.' }, { status: 500 })
  }

  const supabase = createServiceClient()

  try {
    const perAccount: Array<{ label: string; locationId: string; created: number; updated: number; errors: number }> = []
    let totalCreated = 0, totalUpdated = 0
    const allErrors: string[] = []

    // Run accounts sequentially so logs stay readable and we don't double-bootstrap user maps
    for (const account of accounts) {
      const result = await syncAccount(account, supabase)
      perAccount.push({
        label: account.label,
        locationId: account.locationId,
        created: result.created,
        updated: result.updated,
        errors: result.errors.length,
      })
      totalCreated += result.created
      totalUpdated += result.updated
      allErrors.push(...result.errors)
    }

    return NextResponse.json({
      success: true,
      accounts_synced: accounts.length,
      synced: totalCreated + totalUpdated,
      created: totalCreated,
      updated: totalUpdated,
      per_account: perAccount,
      errors: allErrors.slice(0, 20),
    })
  } catch (err) {
    console.error('[GHL Sync] Fatal error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
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
