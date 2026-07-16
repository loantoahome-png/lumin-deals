import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { createHmac } from 'crypto'
import { findExistingDeal } from '@/lib/dealMatcher'
import { titleCase, cleanSource } from '@/lib/utils'
import { resolveLO } from '@/lib/loanOfficer'
import { logStageEvent } from '@/lib/stageEvents'
import {
  pick, isOpportunityPayload, getCustomData, cleanGhlId,
  resolveWebhookEventType, channelLabel, messageSnippet, sanitizeRawBody,
} from '@/lib/webhookPayload'

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

// pick / channelLabel / isOpportunityPayload / customData + snippet + sanitize
// helpers moved to lib/webhookPayload.ts (pure, fixture-tested by
// scripts/webhook-fields-check.ts — route files can't export helpers).

function buildNameFromObj(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null
  if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim()
  if (typeof obj.fullName === 'string' && obj.fullName.trim()) return obj.fullName.trim()
  const first = typeof obj.firstName === 'string' ? obj.firstName.trim() : ''
  const last  = typeof obj.lastName  === 'string' ? obj.lastName.trim()  : ''
  return `${first} ${last}`.trim() || null
}

// resolveLO + LO_MAP moved to lib/loanOfficer.ts (shared with the GHL sync + Arive importer).

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

  // Resolve the CONTACT id — never the opportunity id.
  //
  // `contact` above falls back to `body` itself when there's no nested contact
  // object, so reading `id` off it on an opportunity payload yields the
  // OPPORTUNITY id. That value used to win over the correct `contact_id` sitting
  // right beside it, get written to deals.ghl_contact_id, and 404 the "open in
  // GHL" link until the sync's reconciliation repaired it (see
  // docs/diagnoses/2026-07-16-ghl-link-opp-id-diagnosis.md).
  //
  // Order: nested contact object → explicit contact_id/contactId →
  // customData.contactId (the stage workflows map it explicitly; 99% fill —
  // cleanGhlId guards against unresolved "{{…}}" merge tags) → bare `id`,
  // and the bare `id` ONLY when this isn't an opportunity payload. Returning
  // null is safe: the caller's `|| undefined` leaves the stored value alone,
  // which beats overwriting it with a known-wrong id.
  const nestedContact = body.contact as Record<string, unknown> | undefined
  const customData = getCustomData(body)
  const ghlContactId =
    (nestedContact ? pick(nestedContact, 'id', 'contact_id', 'contactId') : null) ||
    pick(body, 'contact_id', 'contactId') ||
    cleanGhlId(customData ? pick(customData, 'contactId', 'contact_id') : null) ||
    (isOpportunityPayload(body) ? null : pick(body, 'id'))

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

  // The VENDOR's own lead id (GHL "Lead ID" contact CF, 92% fill) — the join
  // key for Lendgo/FRU refund & dispute reconciliation. Exact top-level key
  // ONLY: getCustomField's substring match would also catch "Lumin Lead ID".
  // sanitizeStr rejects GHL's "{…}"/"[…]" object-serialization junk.
  const vendorLeadId = sanitizeStr(pick(body, 'Lead ID'))

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
    contactSource, campaign, leadSourceAgg, dateAddedGHL, vendorLeadId,
    // Guard the LOS name out of `source`: Arive writes its own name into GHL's
    // native `source` attribute once a loan syncs back, which would clobber the
    // real vendor (LMB/OwnUp/…). cleanSource() nulls "Arive"/"unknown" — same
    // guard the 15-min sync (route.ts) and Arive CSV import already enforce. Never
    // default to the literal 'GHL'; fall back to 'Self Source' like the sync does.
    source: cleanSource(contactSource || pick(contact, 'source')) || 'Self Source',
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
    // Workflow webhooks carry no top-level type/event — the reply workflows
    // ("LD - replies" / "Customer Replied") send event=inbound_message inside
    // customData, which resolveWebhookEventType reads. Before 2026-07-16 that
    // nesting made the message branch unreachable and every reply fell through
    // to the contact path (proof: 17 reply bodies stored in raw_ghl_data).
    const customData = getCustomData(body)
    const eventType = resolveWebhookEventType(body)

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
          pick((body.contact as Record<string, unknown>) || {}, 'id') ||
          cleanGhlId(customData ? pick(customData, 'contactId', 'contact_id') : null)
        if (!msgContactId) return NextResponse.json({ success: false, reason: 'no contactId on message event' })
        // Channel arrives as text on native events, as GHL's numeric enum on
        // workflow webhooks (customData.channel / message.type: 1=Call 2=SMS 3=Email).
        const channel = channelLabel(
          pick(body, 'messageType', 'message_type', 'channel') ||
          (customData ? pick(customData, 'channel', 'messageType') : null) ||
          pick((body.message as Record<string, unknown>) || {}, 'type'))
        const { error } = await supabase.from('deals').update({
          last_communication_at: new Date().toISOString(),
          last_communication_type: channel,
          comm_unread_count: isInbound ? 1 : 0,
        }).eq('ghl_contact_id', msgContactId)
        if (error) console.error('[GHL Webhook] message update error:', error.message)
        // What they actually said — surfaced on /hot-leads ("client waiting").
        // Separate best-effort write so a missing column (migration not yet
        // run: supabase-webhook-fields.sql) can never fail the core update.
        // Calls carry no body; noisy email bodies are collapsed + truncated.
        if (isInbound) {
          const snippet = messageSnippet(body)
          if (snippet) {
            const { error: msgErr } = await supabase.from('deals')
              .update({ last_inbound_message: snippet })
              .eq('ghl_contact_id', msgContactId)
            if (msgErr) console.warn('[GHL Webhook] last_inbound_message skipped (run supabase-webhook-fields.sql?):', msgErr.message)
          }
        }
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
    // OPPORTUNITY STATUS → LOST / ABANDONED — demote to Not Ready in real time
    //   GHL separates an opportunity's STATUS (open|won|lost|abandoned) from its
    //   pipeline STAGE. The team marks a fallen-through loan "lost" while LEAVING
    //   it on its last stage (e.g. "Clear to Close"), so a pure status flip is not
    //   a stage change and carries no resolvable stage NAME — the native GHL payload
    //   has only a pipelineStageId UUID, which we can't map to a status without the
    //   pipeline table the sync holds. This block keys off `status` directly, mirroring
    //   the sync's isDead rule (app/api/sync/ghl/route.ts): route to "Not Ready", stamp
    //   ghl_status, and LEAVE the stage label intact (the sync reconciles the exact
    //   stage name later). Funded is never demoted — Arive owns funded, and the .neq
    //   guard enforces it at the DB. Runs BEFORE the stage-change branch so a native
    //   lost payload can't fall into resolveGHLStage("lost")'s fragile partial match
    //   (which would wrongly relabel the stage to "Lost to Competitor"). Match is
    //   opportunity-id-first so a lost flip can't demote a sibling loan of a
    //   multi-loan borrower (see the funded-marks-sibling bug this mirrors).
    // ══════════════════════════════════════════════════════════════════════════
    {
      const oppStatus = (pick(body, 'status', 'opportunityStatus') || '').toLowerCase()
      const isDead = oppStatus === 'lost' || oppStatus.startsWith('abandon')
      if (isDead) {
        const contactObj = (body.contact as Record<string, unknown>) || {}
        const oppId = pick(body, 'id', 'opportunity_id', 'opportunityId')
        const statusContactId = pick(body, 'contactId', 'contact_id') || pick(contactObj, 'id')
        const existing = await findExistingDeal(supabase, { opportunityId: oppId, ghlContactId: statusContactId })
        if (!existing) {
          console.log('[GHL Webhook] lost/abandoned for unknown deal — sync will demote:', statusContactId)
          return NextResponse.json({ success: false, reason: 'no matching deal; sync will demote' })
        }
        const { error: deadErr } = await supabase.from('deals')
          .update({ pipeline_group: 'Not Ready', ghl_status: oppStatus })
          .eq('id', existing.id)
          .neq('pipeline_group', 'Funded')   // never demote a funded loan
        if (deadErr) {
          console.error('[GHL Webhook] lost demotion error:', deadErr.message)
          return NextResponse.json({ error: deadErr.message }, { status: 500 })
        }
        console.log(`[GHL Webhook] status=${oppStatus} → Not Ready on deal ${existing.id} (matched by ${existing.matchedBy})`)
        return NextResponse.json({ success: true, action: 'status_demoted_not_ready', dealId: existing.id, status: oppStatus })
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NOTE — there is deliberately NO dedicated "opportunity stage change" branch.
    // GHL's Workflow webhook (the only thing that posts here) sends the stage under
    // the MISSPELLED key `pipleline_stage` and carries no `pipelineStageId`,
    // `pipelineStageName`, or `type`/`event` — so eventType always resolves to
    // 'ContactCreate' and stage moves are applied by the CONTACT CREATE/UPDATE path
    // below (see the `whStageName` block). A branch keyed on pipelineStageId /
    // pipelineStageName existed here until 2026-07-16 and had never once fired:
    // 0 of 1,162 stage_events carried a from_stage_id/to_stage_id, and its
    // `.update(stage)` lacked the Funded guard the surviving path has.
    // Verified payload shape + reasoning: docs/diagnoses/2026-07-16-webhook-dead-code.md
    // ══════════════════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════════════════
    // CONTACT CREATE / UPDATE — full field sync
    // ══════════════════════════════════════════════════════════════════════════
    const fields = extractFields(body)
    const { ghlContactId, fullName, email, phone } = fields

    // ── Duplicate check ───────────────────────────────────────────────────────
    // Try contact_id → email → phone so that if GHL assigns this person a NEW
    // contact ID (delete+re-add, merges, etc.), we still find the existing
    // dashboard record and update it instead of creating a duplicate.
    // Opportunity webhooks carry the opportunity id in `id`; pass it so the update
    // lands on the EXACT loan, not an arbitrary sibling on the same contact. (This
    // is what caused a funded loan's webhook to mark a borrower's withdrawn loan as
    // funded — contact/email/phone can't tell two loans of one person apart.)
    const opportunityId = isOpportunityPayload(body) ? pick(body, 'id', 'opportunity_id', 'opportunityId') : null
    const match = await findExistingDeal(supabase, { opportunityId, ghlContactId, email, phone })
    if (match) {
      const patch: Record<string, unknown> = {
        last_contacted: new Date().toISOString().split('T')[0],
        // Never persist SSN-class keys — 2 real bodies arrived carrying a
        // top-level "Social Security Number" CF. GHL retains the source data.
        raw_ghl_data: sanitizeRawBody(body),
        // CRITICAL: when we matched by email/phone, force-update the contact_id
        // so the next webhook event finds this record by contact_id directly
        // (without falling back through email/phone again).
        ghl_contact_id: ghlContactId || undefined,
      }
      const maybeSet = (key: string, val: unknown) => { if (val !== null && val !== undefined) patch[key] = val }

      // loan_amount is deliberately NOT written here. The GHL "Loan Amount" CUSTOM
      // FIELD is an unreliable lead-intake number (it once put $610k on a $150k loan),
      // and the payload carries no opportunity monetaryValue to use instead (verified
      // 2026-07-16: 0 of 142 stored webhook bodies have one). loan_amount is SYNC-ONLY —
      // the 15-min sync mirrors the opp value onto every non-funded deal
      // (sync/ghl/route.ts:1223) and Arive stays authoritative for funded loans.
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
      // cleanSource() → null for "Arive"/"unknown", and maybeSet skips nulls, so a
      // drifted webhook can never re-stamp the LOS name over a real vendor source.
      maybeSet('source',            cleanSource(fields.contactSource))
      maybeSet('dnd',               fields.dnd)
      maybeSet('dnd_settings',      fields.dndSettings)

      await supabase.from('deals').update(patch).eq('id', match.id)

      // Vendor lead id (refund/dispute reconciliation) — separate best-effort
      // write so a missing column (migration not yet run:
      // supabase-webhook-fields.sql) can never fail the core update above.
      if (fields.vendorLeadId) {
        const { error: vErr } = await supabase.from('deals')
          .update({ vendor_lead_id: fields.vendorLeadId }).eq('id', match.id)
        if (vErr) console.warn('[GHL Webhook] vendor_lead_id skipped (run supabase-webhook-fields.sql?):', vErr.message)
      }

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
        // Read current status BEFORE the update — the "from" side we log, and the
        // signal for whether this is a real move worth logging.
        const { data: cur } = await supabase.from('deals')
          .select('status, pipeline_group, ghl_opportunity_id, ghl_contact_id, loan_officer')
          .eq('id', match.id).maybeSingle()
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
        else {
          console.log(`[GHL Webhook] Stage applied from workflow payload → ${whStage.status} (${newGroup})`)
          // Log only when the guard above actually applied a move — not Funded, and
          // status genuinely changed. Mirrors the .neq() conditions on the update so
          // the log matches what really happened. Non-fatal.
          if (cur && cur.pipeline_group !== 'Funded' && cur.status !== whStage.status) {
            await logStageEvent(supabase, {
              opportunityId:   cur.ghl_opportunity_id ?? opportunityId ?? null,
              contactId:       ghlContactId ?? cur.ghl_contact_id ?? null,
              dealId:          match.id,
              toStageId:       pick(body, 'pipelineStageId', 'stageId', 'pipeline_stage_id'),
              fromStatus:      cur.status,
              toStatus:        whStage.status,
              toPipelineGroup: newGroup,
              pipelineId:      pick(body, 'pipelineId', 'pipeline_id'),
              loanOfficer:     cur.loan_officer ?? fields.loanOfficer ?? null,
              assignedTo:      fields.ghlAssignedUser,
              eventAt:         pick(body, 'dateUpdated', 'date_updated', 'updatedAt', 'timestamp'),
            })
          }
        }
      }

      // ── NOTE: no real-time loan_amount write here ──────────────────────────
      // A block here used to mirror the sync's opp-value rule by reading a
      // `monetaryValue` key off the payload. It never fired: 0 of 142 stored
      // webhook bodies carry a top-level monetaryValue, and there is no
      // `body.opportunity` either. The Workflow UI's "monetaryValue" custom field
      // lands in the NESTED `body.customData` (which we don't read) — and its key
      // literally has a trailing space ("monetaryValue "), so a hasOwnProperty
      // lookup could never have matched it anyway.
      // loan_amount is therefore SYNC-ONLY, and that is fine: the 15-min sync
      // mirrors the opp value on every non-funded deal (sync/ghl/route.ts:1223).
      // Removed 2026-07-16 — see docs/diagnoses/2026-07-16-webhook-dead-code.md

      console.log(`[GHL Webhook] Updated deal ${match.id} (matched by ${match.matchedBy})`)
      return NextResponse.json({ success: true, action: 'updated', dealId: match.id, matchedBy: match.matchedBy })
    }

    // ── No matching deal — do NOT create here ───────────────────────────────
    // The webhook is UPDATE-ONLY. Creating a deal here is what caused the
    // duplicate flood: the webhook can't set ghl_opportunity_id / ghl_location_id,
    // so the 15-min sync (which keys by opportunity ID) couldn't recognize the
    // row and inserted a second one. Plus the webhook sometimes double-fires.
    //
    // The sync is the single source of truth for CREATING deals — it fetches
    // opportunities, keys each by its opportunity ID, and dedupes properly.
    // A brand-new lead therefore appears within ~15 minutes (next sync) with the
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
