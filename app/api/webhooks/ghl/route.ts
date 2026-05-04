import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// ── Helpers ──────────────────────────────────────────────────────────────────

type GHLCustomField = {
  id?: string
  key?: string
  fieldKey?: string
  name?: string
  field_value?: string
  value?: string
}

/**
 * Search GHL customFields array by any matching key/name pattern.
 * GHL uses many naming conventions (camelCase, snake_case, display name).
 */
function getCustomField(fields: GHLCustomField[], ...searchKeys: string[]): string | null {
  if (!fields || !Array.isArray(fields)) return null
  for (const field of fields) {
    const identifier = [field.key, field.fieldKey, field.name, field.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/[\s_-]+/g, '')

    for (const key of searchKeys) {
      if (identifier.includes(key.toLowerCase().replace(/[\s_-]+/g, ''))) {
        return field.field_value || field.value || null
      }
    }
  }
  return null
}

/** Strip $, commas, spaces and parse to float */
function parseAmount(val: string | number | null | undefined): number | null {
  if (val == null || val === '') return null
  const cleaned = String(val).replace(/[$,\s]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

/** Resolve a value from multiple possible keys in a GHL payload */
function pick(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = body[key]
    if (val && typeof val === 'string' && val.trim()) return val.trim()
  }
  return null
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>
    console.log('[GHL Webhook] Received payload:', JSON.stringify(body, null, 2))

    // ── Contact identity ──────────────────────────────────────────────────────
    // GHL sends different shapes depending on webhook trigger type
    const contact = (body.contact as Record<string, unknown>) || body
    const ghlContactId = pick(contact, 'id', 'contact_id', 'contactId') ||
                         pick(body, 'id', 'contact_id', 'contactId')

    const firstName  = pick(contact, 'firstName', 'first_name', 'FirstName') ||
                       pick(body, 'firstName', 'first_name') || ''
    const lastName   = pick(contact, 'lastName', 'last_name', 'LastName') ||
                       pick(body, 'lastName', 'last_name') || ''
    const fullName   = pick(contact, 'fullName', 'full_name', 'name', 'contactName') ||
                       pick(body, 'fullName', 'full_name', 'name', 'contact_name') ||
                       `${firstName} ${lastName}`.trim() || 'New Lead'

    const email = pick(contact, 'email') || pick(body, 'email')
    const phone = pick(contact, 'phone', 'phoneNumber', 'phone_number') ||
                  pick(body, 'phone', 'phoneNumber', 'phone_number')

    // ── Custom fields ─────────────────────────────────────────────────────────
    const rawCustomFields = (
      (contact.customFields as GHLCustomField[]) ||
      (body.customFields as GHLCustomField[]) ||
      (body.custom_fields as GHLCustomField[]) ||
      []
    )

    // Loan Amount — try body fields first, then custom fields
    const loanAmount = parseAmount(
      pick(body, 'loan_amount', 'loanAmount', 'loan_amt') ||
      pick(contact, 'loan_amount', 'loanAmount') ||
      getCustomField(rawCustomFields,
        'loan_amount', 'loan amount', 'loanamount',
        'loan_size', 'mortgage_amount', 'requested_amount')
    )

    // Estimated / Property Value
    const estimatedValue = parseAmount(
      pick(body, 'estimated_value', 'propertyValue', 'property_value', 'home_value', 'estimatedValue') ||
      pick(contact, 'estimated_value', 'propertyValue') ||
      getCustomField(rawCustomFields,
        'estimated_value', 'property_value', 'home_value',
        'estimated value', 'property value', 'home value',
        'purchase_price', 'purchase price', 'appraised_value')
    )

    // Loan Type
    const loanType = (
      pick(body, 'loan_type', 'loanType', 'loan_program') ||
      pick(contact, 'loan_type', 'loanType') ||
      getCustomField(rawCustomFields,
        'loan_type', 'loan type', 'loan_program', 'loantype',
        'mortgage_type', 'program_type', 'product_type')
    )

    // Property Address — custom field first (not contact.address which is mailing)
    const propertyAddress = (
      getCustomField(rawCustomFields,
        'property_address', 'property address', 'subject_property',
        'property_street', 'home_address', 'prop_address') ||
      pick(body, 'property_address', 'propertyAddress') ||
      pick(contact, 'address1', 'address') ||
      pick(body, 'address1', 'address')
    )

    // Credit Score
    const creditScore = parseAmount(
      pick(body, 'credit_score', 'creditScore', 'fico', 'fico_score') ||
      getCustomField(rawCustomFields,
        'credit_score', 'credit score', 'fico', 'fico_score',
        'middle_score', 'beacon_score')
    )

    // Revenue / Compensation
    const revenue = parseAmount(
      pick(body, 'revenue', 'compensation', 'commission', 'total_comp') ||
      getCustomField(rawCustomFields,
        'revenue', 'compensation', 'commission', 'total_comp',
        'estimated_revenue', 'broker_comp')
    )

    // Rate
    const rate = parseAmount(
      pick(body, 'rate', 'interest_rate', 'interestRate') ||
      getCustomField(rawCustomFields,
        'rate', 'interest_rate', 'note_rate', 'quoted_rate')
    )

    // Investor / Lender
    const investor = (
      pick(body, 'investor', 'lender', 'bank') ||
      getCustomField(rawCustomFields,
        'investor', 'lender', 'wholesale_lender', 'bank', 'lender_name')
    )

    // Occupancy
    const occupancy = (
      pick(body, 'occupancy', 'property_type', 'propertyType') ||
      getCustomField(rawCustomFields,
        'occupancy', 'occupancy_type', 'property_type', 'property use',
        'primary', 'investment', 'second home')
    )

    // Address components (contact mailing address)
    const city  = pick(contact, 'city')  || pick(body, 'city')
    const state = pick(contact, 'state') || pick(body, 'state')
    const zip   = pick(contact, 'postalCode', 'postal_code', 'zip') ||
                  pick(body, 'postalCode', 'postal_code', 'zip')

    // Source
    const source = pick(contact, 'source') || pick(body, 'source') || 'GHL'

    // Tags
    const tagsRaw = (contact.tags || body.tags) as string[] | string | undefined
    const ghlTags = Array.isArray(tagsRaw)
      ? tagsRaw.join(', ')
      : (typeof tagsRaw === 'string' ? tagsRaw : null)

    // Assigned user
    const ghlAssignedUser = pick(contact, 'assignedTo', 'assigned_to', 'assignedUser') ||
                            pick(body, 'assignedTo', 'assigned_to')

    // Date added to GHL
    const dateAddedGHL = (pick(contact, 'dateAdded', 'date_added', 'createdAt') ||
                          pick(body, 'dateAdded', 'date_added'))

    // ── Duplicate check ───────────────────────────────────────────────────────
    const supabase = createServiceClient()

    if (ghlContactId) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id, name')
        .eq('ghl_contact_id', ghlContactId)
        .single()

      if (existing) {
        // Update with any new info that arrived
        await supabase.from('deals').update({
          last_contacted: new Date().toISOString().split('T')[0],
          ...(loanAmount    && { loan_amount: loanAmount }),
          ...(estimatedValue && { estimated_value: estimatedValue }),
          ...(loanType      && { loan_type: loanType }),
          ...(propertyAddress && { property_address: propertyAddress }),
          ...(creditScore   && { credit_score: creditScore }),
          ...(revenue       && { revenue }),
          ...(rate          && { rate }),
          ...(investor      && { investor }),
          ...(occupancy     && { occupancy }),
          ...(ghlTags       && { ghl_tags: ghlTags }),
          raw_ghl_data: body,
        }).eq('id', existing.id)

        console.log('[GHL Webhook] Updated existing deal:', existing.id)
        return NextResponse.json({ success: true, action: 'updated', dealId: existing.id })
      }
    }

    // ── Create new deal ───────────────────────────────────────────────────────
    const newDeal = {
      name:             fullName,
      first_name:       firstName  || null,
      last_name:        lastName   || null,
      email,
      phone,
      status:           'Client',
      pipeline_group:   'LEADS',
      source,
      // Loan fields
      loan_amount:      loanAmount,
      estimated_value:  estimatedValue,
      loan_type:        loanType,
      property_address: propertyAddress,
      credit_score:     creditScore,
      revenue,
      rate,
      investor,
      occupancy,
      // Address
      city,
      state,
      zip,
      // GHL metadata
      ghl_contact_id:   ghlContactId || null,
      ghl_tags:         ghlTags,
      ghl_assigned_user: ghlAssignedUser,
      date_added_ghl:   dateAddedGHL || null,
      last_contacted:   new Date().toISOString().split('T')[0],
      raw_ghl_data:     body,
    }

    const { data, error } = await supabase
      .from('deals')
      .insert(newDeal)
      .select()
      .single()

    if (error) {
      console.error('[GHL Webhook] Insert error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log('[GHL Webhook] Created deal:', data.id, '| Fields captured:', {
      name: fullName, email, phone, loanAmount, estimatedValue,
      loanType, propertyAddress, creditScore, source,
    })

    return NextResponse.json({
      success: true,
      action: 'created',
      dealId: data.id,
      captured: {
        name: fullName,
        email: !!email,
        phone: !!phone,
        loan_amount: !!loanAmount,
        estimated_value: !!estimatedValue,
        loan_type: !!loanType,
        property_address: !!propertyAddress,
        credit_score: !!creditScore,
      }
    })

  } catch (err) {
    console.error('[GHL Webhook] Error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'GHL webhook endpoint is live — capturing all custom fields',
    timestamp: new Date().toISOString(),
    fields_captured: [
      'name', 'email', 'phone', 'source',
      'loan_amount', 'estimated_value', 'loan_type',
      'property_address', 'credit_score', 'revenue', 'rate',
      'investor', 'occupancy', 'city', 'state', 'zip',
      'ghl_tags', 'ghl_assigned_user', 'raw_ghl_data'
    ]
  })
}
