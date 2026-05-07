import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { createHmac } from 'crypto'

// ── Signature validation ──────────────────────────────────────────────────────
async function validateGHLSignature(req: NextRequest, rawBody: string): Promise<boolean> {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) return true // Skip validation if secret not configured (dev mode)

  const signature = req.headers.get('x-ghl-signature') ||
                    req.headers.get('x-hub-signature-256') ||
                    req.headers.get('x-signature')
  if (!signature) return false

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expectedHeader = `sha256=${expected}`

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedHeader.length) return false
  let mismatch = 0
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expectedHeader.charCodeAt(i)
  }
  return mismatch === 0
}

// ── Types ─────────────────────────────────────────────────────────────────────

type GHLCustomField = {
  id?: string; key?: string; fieldKey?: string; name?: string
  field_value?: string; value?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCustomField(fields: GHLCustomField[], ...searchKeys: string[]): string | null {
  if (!fields || !Array.isArray(fields)) return null
  for (const field of fields) {
    const identifier = [field.key, field.fieldKey, field.name, field.id]
      .filter(Boolean).join(' ').toLowerCase().replace(/[\s_\-]+/g, '')
    for (const key of searchKeys) {
      if (identifier.includes(key.toLowerCase().replace(/[\s_\-]+/g, '')))
        return field.field_value || field.value || null
    }
  }
  return null
}

/** Reject GHL object-serializations like {"ids":[]} or [123] that appear for dropdown fields */
function sanitizeStr(val: string | null): string | null {
  if (!val) return null
  const trimmed = val.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null
  return trimmed || null
}

function parseAmount(val: string | number | null | undefined): number | null {
  if (val == null || val === '') return null
  if (typeof val === 'number') return isNaN(val) ? null : val
  const cleaned = String(val).replace(/[$,\s]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

/** Pick from an object — handles strings AND numbers (GHL sends many numeric top-level fields). */
function pick(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = body[key]
    if (val !== null && val !== undefined && val !== '') {
      if (typeof val === 'string' && val.trim()) return val.trim()
      if (typeof val === 'number' && !isNaN(val)) return String(val)
    }
  }
  return null
}

function buildNameFromObj(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null
  if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim()
  if (typeof obj.fullName === 'string' && obj.fullName.trim()) return obj.fullName.trim()
  const first = typeof obj.firstName === 'string' ? obj.firstName.trim() : ''
  const last  = typeof obj.lastName  === 'string' ? obj.lastName.trim()  : ''
  return `${first} ${last}`.trim() || null
}

const LO_MAP: Record<string, string> = {
  'moe sefati': 'Moe Sefati', 'sefati': 'Moe Sefati', 'moe': 'Moe Sefati',
  'matthew': 'Matt', 'matt': 'Matt', 'park': 'Matt',
}

function resolveLO(ownerName: string | null): string | null {
  if (!ownerName) return null
  const lower = ownerName.toLowerCase().trim()
  for (const [key, value] of Object.entries(LO_MAP)) {
    if (lower.includes(key)) return value
  }
  return ownerName
}

// GHL stage name → { status, pipeline_group }  (exact match = GHL stage names)
const GHL_STAGE_MAP: Record<string, { status: string; pipeline_group: string }> = {
  // ── Leads pipeline ───────────────────────────────────────────────────────────
  'new lead':           { status: 'New Lead',           pipeline_group: 'Leads' },
  'attempted contact':  { status: 'Attempted Contact',  pipeline_group: 'Leads' },
  'ghosted':            { status: 'Ghosted',            pipeline_group: 'Leads' },
  'responded':          { status: 'Responded',          pipeline_group: 'Leads' },
  'pitching':           { status: 'Pitching',           pipeline_group: 'Leads' },
  'appointment booked': { status: 'Appointment Booked', pipeline_group: 'Leads' },
  'arive lead':         { status: 'Arive Lead',         pipeline_group: 'Leads' },
  'app intake':         { status: 'App Intake',         pipeline_group: 'Leads' },
  'qualification':      { status: 'Qualification',      pipeline_group: 'Leads' },
  'pre-approved':       { status: 'Pre-Approved',       pipeline_group: 'Leads' },
  // ── Loans in Process pipeline ─────────────────────────────────────────────────
  'loan setup':               { status: 'Loan Setup',               pipeline_group: 'Loans in Process' },
  'disclosed':                { status: 'Disclosed',                pipeline_group: 'Loans in Process' },
  'submitted to uw':          { status: 'Submitted to UW',          pipeline_group: 'Loans in Process' },
  'approved w/ conditions':   { status: 'Approved w/ Conditions',   pipeline_group: 'Loans in Process' },
  're-submittal':             { status: 'Re-Submittal',             pipeline_group: 'Loans in Process' },
  'clear to close':           { status: 'Clear to Close',           pipeline_group: 'Loans in Process' },
  'docs out':                 { status: 'Docs Out',                 pipeline_group: 'Loans in Process' },
  'docs signed':              { status: 'Docs Signed',              pipeline_group: 'Loans in Process' },
  'loan funded':              { status: 'Loan Funded',              pipeline_group: 'Loans in Process' },
  'broker check received':    { status: 'Broker Check Received',    pipeline_group: 'Loans in Process' },
  'loan finalized':           { status: 'Loan Finalized',           pipeline_group: 'Loans in Process' },
  // ── Not Ready pipeline ────────────────────────────────────────────────────────
  'not qualified - credit':        { status: 'Not Qualified - Credit',       pipeline_group: 'Not Ready' },
  'not qualified - income':        { status: 'Not Qualified - Income',       pipeline_group: 'Not Ready' },
  'not ready - timeframe':         { status: 'Not Ready - Timeframe',        pipeline_group: 'Not Ready' },
  'dnd - sms':                     { status: 'DND - SMS',                    pipeline_group: 'Not Ready' },
  'not ready - rate':              { status: 'Not Ready - Rate',             pipeline_group: 'Not Ready' },
  'lost to competitor':            { status: 'Lost to Competitor',           pipeline_group: 'Not Ready' },
  'non-responsive':                { status: 'Non-Responsive',               pipeline_group: 'Not Ready' },
  'remove from all automations':   { status: 'Remove from All Automations',  pipeline_group: 'Not Ready' },
  'stop':                          { status: 'STOP',                         pipeline_group: 'Not Ready' },
}

function resolveGHLStage(
  stageName: string | null,
  pipelineName?: string | null
): { status: string; pipeline_group: string } | null {
  if (!stageName) return null
  const lower = stageName.toLowerCase().trim()
  // 1. Exact match
  if (GHL_STAGE_MAP[lower]) return GHL_STAGE_MAP[lower]
  // 2. Partial match
  for (const [key, val] of Object.entries(GHL_STAGE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return val
  }
  // 3. Fallback by pipeline name
  if (pipelineName) {
    const pl = pipelineName.toLowerCase()
    if (pl.includes('loan') || pl.includes('process')) return { status: 'Loan Setup', pipeline_group: 'Loans in Process' }
    if (pl.includes('not ready'))                       return { status: 'Non-Responsive', pipeline_group: 'Not Ready' }
    if (pl.includes('funded'))                          return { status: 'Loan Funded', pipeline_group: 'Funded' }
  }
  return null
}

// ── Extract all contact/loan fields from a GHL payload ────────────────────────
function extractFields(body: Record<string, unknown>) {
  const contact = (body.contact as Record<string, unknown>) || body
  const rawCustomFields: GHLCustomField[] = (
    (contact.customFields as GHLCustomField[]) ||
    (body.customFields as GHLCustomField[]) ||
    (body.custom_fields as GHLCustomField[]) || []
  )

  const ghlContactId =
    pick(contact, 'id', 'contact_id', 'contactId') ||
    pick(body, 'id', 'contact_id', 'contactId')

  const firstName = pick(contact, 'firstName', 'first_name') || pick(body, 'firstName', 'first_name') || ''
  const lastName  = pick(contact, 'lastName',  'last_name')  || pick(body, 'lastName',  'last_name')  || ''
  const fullName  =
    pick(contact, 'fullName', 'full_name', 'name', 'contactName') ||
    pick(body, 'fullName', 'full_name', 'name', 'contact_name') ||
    `${firstName} ${lastName}`.trim() || 'New Lead'

  const email = pick(contact, 'email') || pick(body, 'email')
  const phone = pick(contact, 'phone', 'phoneNumber') || pick(body, 'phone', 'phoneNumber')

  const loanAmount    = parseAmount(pick(body, 'Loan Amount', 'loan_amount', 'loanAmount') || pick(contact, 'loan_amount') || getCustomField(rawCustomFields, 'loan_amount', 'loan amount', 'loanamount', 'Loan Amount'))
  const estimatedValue= parseAmount(pick(body, 'Property Value', 'estimated_value', 'propertyValue') || getCustomField(rawCustomFields, 'estimated_value', 'property_value', 'home_value', 'Property Value'))
  const loanType      = sanitizeStr(pick(body, 'Loan Type', 'loan_type', 'loanType') || getCustomField(rawCustomFields, 'loan_type', 'loan type', 'Loan Type'))
  const loanPurpose   = sanitizeStr(pick(body, 'Loan Purpose', 'loan_purpose') || getCustomField(rawCustomFields, 'loan_purpose', 'loan purpose', 'Loan Purpose'))
  const creditScore   = parseAmount(pick(body, 'Credit Score', 'credit_score', 'creditScore') || getCustomField(rawCustomFields, 'credit_score', 'credit score', 'fico'))
  const creditRating  = pick(body, 'Credit Rating', 'credit_rating') || getCustomField(rawCustomFields, 'credit_rating', 'credit rating', 'Credit Rating') || null
  const rate          = parseAmount(pick(body, 'rate', 'interest_rate') || getCustomField(rawCustomFields, 'rate', 'interest_rate', 'note_rate'))
  const investor      = pick(body, 'investor', 'lender') || getCustomField(rawCustomFields, 'investor', 'lender', 'wholesale_lender') || null
  const occupancy     = pick(body, 'Property Use', 'occupancy') || getCustomField(rawCustomFields, 'occupancy', 'property use', 'Property Use') || null
  const propertyType  = pick(body, 'Property Type', 'property_type_detail') || getCustomField(rawCustomFields, 'property_type', 'Property Type') || null
  const propertyAddress = pick(body, 'address1', 'full_address', 'property_address') || getCustomField(rawCustomFields, 'property_address', 'physical_address', 'PhysicalAddress') || pick(contact, 'address1') || null
  const currentBalance = parseAmount(pick(body, 'First Mortgage Balance', 'current_balance') || getCustomField(rawCustomFields, 'current_balance', 'First Mortgage Balance'))
  const ltv           = parseAmount(pick(body, 'LTV', 'ltv') || getCustomField(rawCustomFields, 'ltv', 'LTV'))
  const cashOut       = parseAmount(pick(body, 'Cashout', 'cash_out') || getCustomField(rawCustomFields, 'cash_out', 'cashout', 'Cashout'))
  const downPayment   = parseAmount(pick(body, 'Down Payment', 'down_payment') || getCustomField(rawCustomFields, 'down_payment', 'Down Payment'))
  const isMilitary    = pick(body, 'Veteran', 'is_military') || getCustomField(rawCustomFields, 'is_military', 'veteran') || null
  const currentVaLoan = pick(body, 'VA Loan', 'current_va_loan') || getCustomField(rawCustomFields, 'current_va_loan', 'va_loan', 'VA Loan') || null
  const propertyFound = pick(body, 'Found Home', 'Property Found', 'property_found') || getCustomField(rawCustomFields, 'property_found', 'Found Home') || null
  const loanTimeframe = pick(body, 'Loan Timeframe', 'loan_timeframe') || getCustomField(rawCustomFields, 'loan_timeframe', 'Loan Timeframe') || null
  const hasAcceptedOffer = pick(body, 'Purchase Contract', 'has_accepted_offer') || getCustomField(rawCustomFields, 'has_accepted_offer', 'Purchase Contract') || null

  const city  = pick(body, 'Mailing City', 'city')  || pick(contact, 'city')  || null
  const state = pick(body, 'Mailing State', 'state') || pick(contact, 'state') || null
  const zip   = pick(body, 'Mailing Postal Code', 'postal_code', 'postalCode') || pick(contact, 'postalCode') || null

  const tagsRaw = (contact.tags || body.tags) as string[] | string | undefined
  const ghlTags = Array.isArray(tagsRaw) ? tagsRaw.join(', ') : (typeof tagsRaw === 'string' ? tagsRaw : null)

  const ghlAssignedUser = pick(contact, 'assignedTo', 'assigned_to') || pick(body, 'assignedTo', 'assigned_to') || null

  const userObj = (body.user ?? body.owner ?? body.assignedUser ?? body.ownedBy) as Record<string, unknown> | null | undefined
  const ownerName = buildNameFromObj(userObj) || pick(body, 'owner_name', 'ownerName') || ghlAssignedUser
  const loanOfficer = resolveLO(ownerName)

  const contactSource = pick(body, 'contact_source', 'Lead Source', 'source') || null
  const campaign      = pick(body, 'Campaign', 'campaign') || null
  const leadSourceAgg = [campaign, contactSource].filter(Boolean).join(' / ') || null

  const dateAddedGHL = pick(contact, 'dateAdded', 'date_added', 'createdAt') || pick(body, 'dateAdded', 'date_added', 'date_created') || null

  return {
    ghlContactId, firstName, lastName, fullName, email, phone,
    loanAmount, estimatedValue, loanType, loanPurpose, creditScore, creditRating,
    rate, investor, occupancy, propertyType, propertyAddress,
    currentBalance, ltv, cashOut, downPayment, isMilitary, currentVaLoan,
    propertyFound, loanTimeframe, hasAcceptedOffer,
    city, state, zip, ghlTags, ghlAssignedUser, loanOfficer,
    contactSource, campaign, leadSourceAgg, dateAddedGHL,
    source: contactSource || pick(contact, 'source') || 'GHL',
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Validate GHL signature before processing ────────────────────────────
    const rawBody = await req.text()
    const isValid = await validateGHLSignature(req, rawBody)
    if (!isValid) {
      console.warn('[GHL Webhook] Invalid signature — request rejected')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const body = JSON.parse(rawBody) as Record<string, unknown>
    console.log('[GHL Webhook] Payload keys:', Object.keys(body))

    const supabase = createServiceClient()

    // ── Detect event type ─────────────────────────────────────────────────────
    const eventType = (
      pick(body, 'type', 'event', 'eventType', 'messageType') ||
      (body.note  ? 'NoteCreate' : null) ||
      (body.pipelineStageId || body.pipelineStageName ? 'OpportunityStageChange' : null) ||
      'ContactCreate'
    )

    console.log('[GHL Webhook] Event type:', eventType)

    // ══════════════════════════════════════════════════════════════════════════
    // NOTE CREATE — append to lo_notes
    // ══════════════════════════════════════════════════════════════════════════
    if (eventType === 'NoteCreate' || eventType === 'note.create') {
      const noteContent = pick(body, 'note', 'body', 'content', 'text', 'noteBody', 'message')
      const noteContactId = pick(body, 'contactId', 'contact_id', 'id')
      const noteUser = pick(body, 'createdBy', 'userId', 'user_id') || 'LO'

      if (!noteContent) {
        return NextResponse.json({ success: false, reason: 'No note content' })
      }

      const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const formattedNote = `[${timestamp} — ${noteUser}] ${noteContent}`

      if (noteContactId) {
        const { data: existing } = await supabase
          .from('deals').select('id, lo_notes').eq('ghl_contact_id', noteContactId).single()

        if (existing) {
          const updated = existing.lo_notes
            ? `${formattedNote}\n\n${existing.lo_notes}`  // prepend newest on top
            : formattedNote

          await supabase.from('deals').update({ lo_notes: updated }).eq('id', existing.id)
          console.log('[GHL Webhook] Note appended to deal:', existing.id)
          return NextResponse.json({ success: true, action: 'note_added', dealId: existing.id })
        }
      }

      return NextResponse.json({ success: false, reason: 'Contact not found for note' })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // OPPORTUNITY STAGE CHANGE — update pipeline stage
    // ══════════════════════════════════════════════════════════════════════════
    if (
      eventType === 'OpportunityStageChange' ||
      eventType === 'opportunity.stageChange' ||
      eventType === 'OpportunityStatusChanged' ||
      body.pipelineStageId || body.pipelineStageName
    ) {
      const stageName =
        pick(body, 'pipelineStageName', 'stageName', 'stage_name', 'pipelineStage') ||
        pick(body, 'status')
      const pipelineName = pick(body, 'pipelineName', 'pipeline_name', 'pipeline')
      const oppContactId = pick(body, 'contactId', 'contact_id')
      const oppName = pick(body, 'name', 'opportunityName', 'title')

      const stage = resolveGHLStage(stageName, pipelineName)

      if (oppContactId && stage) {
        const { data: existing } = await supabase
          .from('deals').select('id, name').eq('ghl_contact_id', oppContactId).single()

        if (existing) {
          await supabase.from('deals').update(stage).eq('id', existing.id)
          console.log('[GHL Webhook] Stage updated:', existing.id, '→', stage)
          return NextResponse.json({ success: true, action: 'stage_updated', dealId: existing.id, newStage: stage })
        }
      }

      // If deal not found, create it from opportunity data
      if (oppContactId && oppName) {
        const { data } = await supabase.from('deals').insert({
          name: oppName,
          ghl_contact_id: oppContactId,
          status: stage?.status || 'Client',
          pipeline_group: stage?.pipeline_group || 'LEADS',
          source: 'GHL',
          raw_ghl_data: body,
        }).select().single()
        return NextResponse.json({ success: true, action: 'created_from_opportunity', dealId: data?.id })
      }

      return NextResponse.json({ success: false, reason: 'Could not resolve stage or contact' })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONTACT CREATE / UPDATE — full field sync
    // ══════════════════════════════════════════════════════════════════════════
    const fields = extractFields(body)
    const { ghlContactId, fullName, firstName, lastName, email, phone } = fields

    // ── Duplicate check ───────────────────────────────────────────────────────
    if (ghlContactId) {
      const { data: existing } = await supabase
        .from('deals').select('id, name').eq('ghl_contact_id', ghlContactId).single()

      if (existing) {
        // ContactUpdate — refresh all non-null fields
        const patch: Record<string, unknown> = {
          last_contacted: new Date().toISOString().split('T')[0],
          raw_ghl_data: body,
        }
        const maybeSet = (key: string, val: unknown) => { if (val !== null && val !== undefined) patch[key] = val }

        maybeSet('loan_amount',       fields.loanAmount)
        maybeSet('estimated_value',   fields.estimatedValue)
        maybeSet('loan_type',         fields.loanType)
        maybeSet('loan_purpose',      fields.loanPurpose)
        maybeSet('property_address',  fields.propertyAddress)
        maybeSet('credit_score',      fields.creditScore)
        maybeSet('credit_rating',     fields.creditRating)
        maybeSet('rate',              fields.rate)
        maybeSet('investor',          fields.investor)
        maybeSet('occupancy',         fields.occupancy)
        maybeSet('property_type',     fields.propertyType)
        maybeSet('current_balance',   fields.currentBalance)
        maybeSet('ltv',               fields.ltv)
        maybeSet('cash_out',          fields.cashOut)
        maybeSet('down_payment',      fields.downPayment)
        maybeSet('is_military',       fields.isMilitary)
        maybeSet('current_va_loan',   fields.currentVaLoan)
        maybeSet('property_found',    fields.propertyFound)
        maybeSet('loan_timeframe',    fields.loanTimeframe)
        maybeSet('has_accepted_offer',fields.hasAcceptedOffer)
        maybeSet('loan_officer',      fields.loanOfficer)
        maybeSet('ghl_tags',          fields.ghlTags)
        maybeSet('city',              fields.city)
        maybeSet('state',             fields.state)
        maybeSet('zip',               fields.zip)
        maybeSet('lead_source_agg',   fields.leadSourceAgg)
        maybeSet('source',            fields.contactSource)

        await supabase.from('deals').update(patch).eq('id', existing.id)
        console.log('[GHL Webhook] Updated deal:', existing.id)
        return NextResponse.json({ success: true, action: 'updated', dealId: existing.id })
      }
    }

    // ── Create new deal ───────────────────────────────────────────────────────
    const { data, error } = await supabase.from('deals').insert({
      name:              fullName,
      first_name:        firstName || null,
      last_name:         lastName  || null,
      email,
      phone,
      status:            'New Lead',
      pipeline_group:    'Leads',
      source:            fields.source,
      loan_officer:      fields.loanOfficer,
      loan_amount:       fields.loanAmount,
      estimated_value:   fields.estimatedValue,
      loan_type:         fields.loanType,
      loan_purpose:      fields.loanPurpose,
      property_address:  fields.propertyAddress,
      credit_score:      fields.creditScore,
      credit_rating:     fields.creditRating,
      rate:              fields.rate,
      investor:          fields.investor,
      occupancy:         fields.occupancy,
      property_type:     fields.propertyType,
      current_balance:   fields.currentBalance,
      ltv:               fields.ltv,
      cash_out:          fields.cashOut,
      down_payment:      fields.downPayment,
      is_military:       fields.isMilitary,
      current_va_loan:   fields.currentVaLoan,
      property_found:    fields.propertyFound,
      loan_timeframe:    fields.loanTimeframe,
      has_accepted_offer:fields.hasAcceptedOffer,
      city:              fields.city,
      state:             fields.state,
      zip:               fields.zip,
      lead_source_agg:   fields.leadSourceAgg,
      ghl_contact_id:    ghlContactId || null,
      ghl_tags:          fields.ghlTags,
      ghl_assigned_user: fields.ghlAssignedUser,
      date_added_ghl:    fields.dateAddedGHL || null,
      last_contacted:    new Date().toISOString().split('T')[0],
      raw_ghl_data:      body,
    }).select().single()

    if (error) {
      console.error('[GHL Webhook] Insert error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, action: 'created', dealId: data.id })

  } catch (err) {
    console.error('[GHL Webhook] Error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    supported_events: ['ContactCreate', 'ContactUpdate', 'NoteCreate', 'OpportunityStageChange'],
    timestamp: new Date().toISOString(),
  })
}
