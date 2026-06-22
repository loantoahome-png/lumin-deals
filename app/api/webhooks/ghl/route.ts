import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { createHmac } from 'crypto'
import { findExistingDeal } from '@/lib/dealMatcher'
import { titleCase } from '@/lib/utils'

// ── Signature validation ──────────────────────────────────────────────────────
async function validateGHLSignature(req: NextRequest, rawBody: string): Promise<boolean> {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) return true // Skip validation if secret not configured (dev mode)

  // Path 1 — shared secret via ?secret= or x-webhook-secret header.
  // This is what GHL *Workflow* webhook actions use (they don't HMAC-sign).
  const shared = new URL(req.url).searchParams.get('secret') || req.headers.get('x-webhook-secret')
  if (shared && shared === secret) return true

  // Path 2 — HMAC signature (native GHL app/marketplace webhooks).
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

function channelLabel(type: string | null | undefined): string {
  if (!type) return 'Text'
  const t = String(type).toUpperCase()
  if (t.includes('SMS') || t.includes('TEXT')) return 'Text'
  if (t.includes('CALL') || t.includes('PHONE') || t.includes('VOICE') || t.includes('NO_SHOW')) return 'Call'
  if (t.includes('EMAIL')) return 'Email'
  if (t.includes('FB') || t.includes('FACEBOOK')) return 'Facebook'
  if (t.includes('IG') || t.includes('INSTAGRAM')) return 'Instagram'
  if (t.includes('WHATSAPP')) return 'WhatsApp'
  return 'Text'
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
  // Moe variants
  'moe sefati': 'Moe Sefati', 'sefati': 'Moe Sefati', 'moe': 'Moe Sefati',
  // Matt variants
  'matthew park': 'Matt Park', 'matthew': 'Matt Park', 'matt park': 'Matt Park',
  'matt': 'Matt Park', 'park': 'Matt Park',
}

function resolveLO(ownerName: string | null | undefined): string | null {
  if (!ownerName) return null
  const trimmed = ownerName.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const [key, value] of Object.entries(LO_MAP)) {
    if (lower.includes(key)) return value
  }
  // No match — return the raw name so we don't lose the assignment
  return trimmed
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
  'loan funded':              { status: 'Loan Funded',              pipeline_group: 'Funded' },
  'broker check received':    { status: 'Broker Check Received',    pipeline_group: 'Funded' },
  'loan finalized':           { status: 'Loan Finalized',           pipeline_group: 'Funded' },
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

// ── Funded override — these statuses always belong in Funded regardless of GHL pipeline ──
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
function applyFundedRule(result: { status: string; pipeline_group: string }): { status: string; pipeline_group: string } {
  return FUNDED_STATUSES.has(result.status) ? { ...result, pipeline_group: 'Funded' } : result
}

function resolveGHLStage(
  stageName: string | null,
  pipelineName?: string | null
): { status: string; pipeline_group: string } | null {
  if (!stageName) return null
  const lower = stageName.toLowerCase().trim()
  // 1. Exact match
  if (GHL_STAGE_MAP[lower]) return applyFundedRule(GHL_STAGE_MAP[lower])
  // 2. Partial match
  for (const [key, val] of Object.entries(GHL_STAGE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return applyFundedRule(val)
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

  const firstNameRaw = pick(contact, 'firstName', 'first_name') || pick(body, 'firstName', 'first_name') || ''
  const lastNameRaw  = pick(contact, 'lastName',  'last_name')  || pick(body, 'lastName',  'last_name')  || ''
  const fullNameRaw  =
    pick(contact, 'fullName', 'full_name', 'name', 'contactName') ||
    pick(body, 'fullName', 'full_name', 'name', 'contact_name') ||
    `${firstNameRaw} ${lastNameRaw}`.trim() || 'New Lead'
  // Title-case so names display consistently regardless of how GHL stored them
  const firstName = titleCase(firstNameRaw) ?? ''
  const lastName  = titleCase(lastNameRaw) ?? ''
  const fullName  = titleCase(fullNameRaw) ?? fullNameRaw

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

  const ghlAssignedUser =
    pick(contact, 'assignedTo', 'assigned_to', 'assignedToId', 'userId') ||
    pick(body, 'assignedTo', 'assigned_to', 'assignedToId', 'userId') || null

  // Check embedded user/owner objects first, then fall back to the assigned ID as a display name
  const userObj = (body.user ?? body.owner ?? body.assignedUser ?? body.ownedBy ??
    contact.user ?? contact.owner ?? contact.assignedUser) as Record<string, unknown> | null | undefined
  const ownerName =
    buildNameFromObj(userObj) ||
    pick(body, 'owner_name', 'ownerName', 'assignedToName', 'assigned_to_name') ||
    pick(contact, 'owner_name', 'ownerName', 'assignedToName') ||
    null
  const loanOfficer = resolveLO(ownerName)

  const contactSource = pick(body, 'contact_source', 'Lead Source', 'source') || null
  const campaign      = pick(body, 'Campaign', 'campaign') || null
  const leadSourceAgg = [campaign, contactSource].filter(Boolean).join(' / ') || null

  const dateAddedGHL = pick(contact, 'dateAdded', 'date_added', 'createdAt') || pick(body, 'dateAdded', 'date_added', 'date_created') || null

  // Do-Not-Contact (compliance): master flag + per-channel settings.
  const dndRaw = contact.dnd ?? body.dnd
  const dnd = typeof dndRaw === 'boolean' ? dndRaw : null
  const dndSettingsRaw = (contact.dndSettings ?? body.dndSettings) as Record<string, unknown> | undefined
  const dndSettings = dndSettingsRaw && typeof dndSettingsRaw === 'object' ? dndSettingsRaw : null

  return {
    ghlContactId, firstName, lastName, fullName, email, phone, dnd, dndSettings,
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
    // MESSAGE EVENTS — instant "client waiting" toggle (real-time)
    //   inbound  → client texted/called us  → flag waiting + stamp last contact
    //   outbound → we replied               → clear waiting + stamp last contact
    // Works with native GHL InboundMessage/OutboundMessage events AND with a
    // Workflow webhook that sends event=inbound_message / outbound_message.
    // ══════════════════════════════════════════════════════════════════════════
    {
      const ev = eventType.toLowerCase()
      const isInbound  = ev.includes('inbound')
      const isOutbound = ev.includes('outbound')
      if (isInbound || isOutbound) {
        const msgContactId =
          pick(body, 'contactId', 'contact_id') ||
          pick((body.contact as Record<string, unknown>) || {}, 'id')
        if (!msgContactId) return NextResponse.json({ success: false, reason: 'no contactId on message event' })
        const channel = channelLabel(pick(body, 'messageType', 'message_type', 'channel'))
        const { error } = await supabase.from('deals').update({
          last_communication_at: new Date().toISOString(),
          last_communication_type: channel,
          comm_unread_count: isInbound ? 1 : 0,
        }).eq('ghl_contact_id', msgContactId)
        if (error) console.error('[GHL Webhook] message update error:', error.message)
        console.log(`[GHL Webhook] ${isInbound ? 'inbound' : 'outbound'} message → contact ${msgContactId} (${channel})`)
        return NextResponse.json({ success: true, action: isInbound ? 'inbound_message' : 'outbound_message', contactId: msgContactId })
      }
    }

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
      // The opportunity's "Value" (monetaryValue) is the authoritative loan amount
      // for ACTIVE deals. Read it here so a value edit in GHL reflects on the
      // dashboard immediately, instead of waiting for the ~15-min maintenance sync
      // (which is the only other place loan_amount gets reconciled from the opp).
      const oppValue = parseAmount(pick(body, 'monetaryValue', 'monetary_value', 'value'))

      if (oppContactId && (stage || (oppValue != null && oppValue > 0))) {
        const { data: existing } = await supabase
          .from('deals').select('id, name, pipeline_group').eq('ghl_contact_id', oppContactId).single()

        if (existing) {
          const update: Record<string, unknown> = {}
          if (stage) { update.status = stage.status; update.pipeline_group = stage.pipeline_group }
          // Reconcile loan_amount from the opp value — but Funded deals keep their
          // Arive amount (closed-loan authority), so never overwrite a Funded deal.
          // Mirrors the sync's rule (route.ts: reconcile only when group !== Funded).
          const groupNow = stage ? stage.pipeline_group : existing.pipeline_group
          if (oppValue != null && oppValue > 0 && groupNow !== 'Funded') {
            update.loan_amount = oppValue
          }
          if (Object.keys(update).length > 0) {
            await supabase.from('deals').update(update).eq('id', existing.id)
          }
          console.log('[GHL Webhook] Opportunity update:', existing.id, JSON.stringify(update))
          return NextResponse.json({ success: true, action: 'opportunity_updated', dealId: existing.id, update })
        }
      }

      // Deal not found — do NOT create here. The webhook is update-only; the
      // 3-min sync owns creation (it keys by opportunity ID and dedupes
      // correctly). Creating here produced rows with no ghl_opportunity_id /
      // ghl_location_id that the sync then duplicated. The sync will pick this
      // lead up and the next stage-change webhook will match it by contact_id.
      console.log('[GHL Webhook] Stage change for unknown deal — deferring to sync:', oppContactId)
      return NextResponse.json({ success: false, reason: 'no matching deal; sync will create it' })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONTACT CREATE / UPDATE — full field sync
    // ══════════════════════════════════════════════════════════════════════════
    const fields = extractFields(body)
    const { ghlContactId, fullName, email, phone } = fields

    // ── Duplicate check ───────────────────────────────────────────────────────
    // Try contact_id → email → phone so that if GHL assigns this person a NEW
    // contact ID (delete+re-add, merges, etc.), we still find the existing
    // dashboard record and update it instead of creating a duplicate.
    const match = await findExistingDeal(supabase, { ghlContactId, email, phone })
    if (match) {
      const patch: Record<string, unknown> = {
        last_contacted: new Date().toISOString().split('T')[0],
        raw_ghl_data: body,
        // CRITICAL: when we matched by email/phone, force-update the contact_id
        // so the next webhook event finds this record by contact_id directly
        // (without falling back through email/phone again).
        ghl_contact_id: ghlContactId || undefined,
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
      maybeSet('dnd',               fields.dnd)
      maybeSet('dnd_settings',      fields.dndSettings)

      await supabase.from('deals').update(patch).eq('id', match.id)

      // Apply pipeline stage/status if the payload carries it. GHL opportunity
      // workflow webhooks (e.g. the "LD stage matt" workflow) deliver the stage
      // under the MISSPELLED key `pipleline_stage` and the open/won/lost/abandoned
      // status under `status` — neither of which the dedicated stage-change branch
      // above reads, so a stage move arriving this way would otherwise update
      // contact fields but silently leave the deal on its old stage.
      const whStageName = pick(body, 'pipelineStageName', 'stageName', 'stage_name',
                               'pipelineStage', 'pipleline_stage', 'pipeline_stage')
      const whStage = resolveGHLStage(whStageName, pick(body, 'pipelineName', 'pipeline_name', 'pipeline'))
      if (whStage) {
        const oppStatus = (pick(body, 'status') || '').toLowerCase()
        const dead = oppStatus === 'lost' || oppStatus.startsWith('abandon')
        const newGroup = (dead && whStage.pipeline_group !== 'Funded') ? 'Not Ready' : whStage.pipeline_group
        // Conditional: only write when status actually changes, so stage_changed_at
        // (Postgres trigger) resets on a real move, not on every workflow echo of
        // the current stage. Never demote a Funded deal (Arive-authoritative).
        const { error: stErr } = await supabase.from('deals')
          .update({ status: whStage.status, pipeline_group: newGroup, ...(oppStatus ? { ghl_status: oppStatus } : {}) })
          .eq('id', match.id)
          .neq('pipeline_group', 'Funded')
          .neq('status', whStage.status)
        if (stErr) console.error('[GHL Webhook] stage apply error:', stErr.message)
        else console.log(`[GHL Webhook] Stage applied from workflow payload → ${whStage.status} (${newGroup})`)
      }

      console.log(`[GHL Webhook] Updated deal ${match.id} (matched by ${match.matchedBy})`)
      return NextResponse.json({ success: true, action: 'updated', dealId: match.id, matchedBy: match.matchedBy })
    }

    // ── No matching deal — do NOT create here ───────────────────────────────
    // The webhook is UPDATE-ONLY. Creating a deal here is what caused the
    // duplicate flood: the webhook can't set ghl_opportunity_id / ghl_location_id,
    // so the 3-min sync (which keys by opportunity ID) couldn't recognize the
    // row and inserted a second one. Plus the webhook sometimes double-fires.
    //
    // The sync is the single source of truth for CREATING deals — it fetches
    // opportunities, keys each by its opportunity ID, and dedupes properly.
    // A brand-new lead therefore appears within ~3 minutes (next sync) with the
    // correct IDs, and every later webhook event (messages, stage, notes,
    // fields) will then match it and update in real time.
    console.log(`[GHL Webhook] New contact "${fullName}" has no matching deal — deferring creation to sync (contact ${ghlContactId ?? 'n/a'})`)
    return NextResponse.json({ success: false, action: 'deferred_to_sync', reason: 'webhook is update-only; sync will create this lead' })

  } catch (err) {
    console.error('[GHL Webhook] Error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    supported_events: ['InboundMessage', 'OutboundMessage', 'ContactCreate', 'ContactUpdate', 'NoteCreate', 'OpportunityStageChange'],
    timestamp: new Date().toISOString(),
  })
}
