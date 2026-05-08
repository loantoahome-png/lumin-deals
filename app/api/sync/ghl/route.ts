import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

const GHL_BASE = 'https://services.leadconnectorhq.com'

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
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

async function fetchPipelineStageMap(locationId: string): Promise<Map<string, { name: string; pipelineName: string }>> {
  const map = new Map<string, { name: string; pipelineName: string }>()
  try {
    const res = await fetch(
      `${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`,
      { headers: ghlHeaders() }
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

async function fetchUserMap(locationId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    // Fetch location-level users
    const res = await fetch(
      `${GHL_BASE}/users/?locationId=${locationId}`,
      { headers: ghlHeaders() }
    )
    const data = await res.json() as { users?: Array<{ id: string; name?: string; firstName?: string; lastName?: string; email?: string }> }
    for (const user of data.users || []) {
      const name = user.name || `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
      if (user.id && name) map.set(user.id, name)
    }
    console.log(`[GHL Sync] User map: ${map.size} users →`, Array.from(map.entries()).map(([id, n]) => `${id.slice(-6)}:${n}`).join(', '))
  } catch (e) {
    console.error('[GHL Sync] Failed to fetch users:', e)
  }
  return map
}

/** Look up a single GHL user by ID (fallback for agency-level users not in location map) */
async function fetchUserById(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/users/${userId}`, { headers: ghlHeaders() })
    if (!res.ok) return null
    const u = await res.json() as { name?: string; firstName?: string; lastName?: string }
    return u.name || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null
  } catch {
    return null
  }
}

async function fetchAllOpportunities(locationId: string): Promise<GHLOpportunity[]> {
  const all: GHLOpportunity[] = []
  let startAfter: string | undefined
  let startAfterId: string | undefined

  for (let page = 0; page < 50; page++) { // cap at 5 000 opportunities
    const params: Record<string, string> = { location_id: locationId, limit: '100' }
    if (startAfter)   params.startAfter   = startAfter
    if (startAfterId) params.startAfterId = startAfterId

    const res = await fetch(
      `${GHL_BASE}/opportunities/search?${new URLSearchParams(params)}`,
      { headers: ghlHeaders() }
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

async function fetchAllContacts(locationId: string): Promise<Map<string, GHLContact>> {
  const map = new Map<string, GHLContact>()
  let page = 1

  for (let i = 0; i < 50; i++) { // cap at 5 000 contacts
    const params = new URLSearchParams({ locationId, limit: '100', page: String(page) })
    const res = await fetch(
      `${GHL_BASE}/contacts/?${params}`,
      { headers: ghlHeaders() }
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

export async function POST() {
  const apiKey     = process.env.GHL_API_KEY
  const locationId = process.env.GHL_LOCATION_ID

  if (!apiKey || !locationId) {
    return NextResponse.json({ error: 'GHL_API_KEY or GHL_LOCATION_ID not configured' }, { status: 500 })
  }

  const supabase = createServiceClient()
  let created = 0, updated = 0
  const errors: string[] = []

  try {
    // ── 1. Fetch lookup maps ───────────────────────────────────────────────────
    const [pipelineMap, userMap, contactMap, opportunities] = await Promise.all([
      fetchPipelineStageMap(locationId),
      fetchUserMap(locationId),
      fetchAllContacts(locationId),
      fetchAllOpportunities(locationId),
    ])

    console.log(`[GHL Sync] Processing ${opportunities.length} opportunities`)

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
          assignedName = await fetchUserById(assignedToId)
          if (assignedName) {
            userMap.set(assignedToId, assignedName) // cache it for subsequent iterations
            console.log(`[GHL Sync] Fetched unknown user ${assignedToId} → ${assignedName}`)
          }
        }

        const loanOfficer = resolveLO(assignedName)
        if (!loanOfficer && assignedToId) {
          console.log(`[GHL Sync] No LO resolved for assignedTo="${assignedToId}" name="${assignedName}" contact="${contactId}"`)
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
        const { data: existing } = await supabase
          .from('deals')
          .select('id, status, pipeline_group')
          .eq('ghl_contact_id', contactId)
          .maybeSingle()

        if (existing) {
          // Update: always sync status/pipeline; only overwrite loan fields if GHL has a value
          const patch: Record<string, unknown> = {
            status:         dealData.status,
            pipeline_group: dealData.pipeline_group,
            loan_officer:   dealData.loan_officer,
            ghl_tags:       dealData.ghl_tags,
            raw_ghl_data:   dealData.raw_ghl_data,
          }
          const maybeSet = (k: string) => { if (dealData[k] != null) patch[k] = dealData[k] }
          ;['loan_amount','estimated_value','credit_score','loan_type','loan_purpose',
            'occupancy','property_type','property_address','current_balance','ltv',
            'cash_out','down_payment','rate','investor','credit_rating','is_military',
            'current_va_loan','city','state','zip','first_name','last_name','email','phone',
          ].forEach(maybeSet)

          await supabase.from('deals').update(patch).eq('id', existing.id)
          updated++
        } else {
          // Create new deal
          await supabase.from('deals').insert(dealData)
          created++
        }
      } catch (err) {
        const msg = String(err)
        errors.push(msg)
        console.error('[GHL Sync] Error processing opportunity:', opp.id, msg)
      }
    }

    const synced = created + updated
    console.log(`[GHL Sync] Done — ${synced} total (${created} created, ${updated} updated, ${errors.length} errors)`)

    return NextResponse.json({
      success: true,
      synced,
      created,
      updated,
      errors: errors.slice(0, 20),
    })
  } catch (err) {
    console.error('[GHL Sync] Fatal error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'POST to this endpoint to trigger a full GHL → Supabase sync',
    configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
  })
}
