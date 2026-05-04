import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Normalises everything to lowercase with no spaces/underscores/hyphens.
 */
function getCustomField(fields: GHLCustomField[], ...searchKeys: string[]): string | null {
  if (!fields || !Array.isArray(fields)) return null
  for (const field of fields) {
    const identifier = [field.key, field.fieldKey, field.name, field.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/[\s_\-]+/g, '')

    for (const key of searchKeys) {
      if (identifier.includes(key.toLowerCase().replace(/[\s_\-]+/g, ''))) {
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

// ── Main Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>
    console.log('[GHL Webhook] Received payload:', JSON.stringify(body, null, 2))

    // ── Contact identity ──────────────────────────────────────────────────────
    const contact = (body.contact as Record<string, unknown>) || body
    const ghlContactId =
      pick(contact, 'id', 'contact_id', 'contactId') ||
      pick(body, 'id', 'contact_id', 'contactId')

    const firstName =
      pick(contact, 'firstName', 'first_name', 'FirstName') ||
      pick(body, 'firstName', 'first_name') || ''
    const lastName =
      pick(contact, 'lastName', 'last_name', 'LastName') ||
      pick(body, 'lastName', 'last_name') || ''
    const fullName =
      pick(contact, 'fullName', 'full_name', 'name', 'contactName') ||
      pick(body, 'fullName', 'full_name', 'name', 'contact_name') ||
      `${firstName} ${lastName}`.trim() || 'New Lead'

    const email = pick(contact, 'email') || pick(body, 'email')
    const phone =
      pick(contact, 'phone', 'phoneNumber', 'phone_number') ||
      pick(body, 'phone', 'phoneNumber', 'phone_number')

    // ── Custom fields array ───────────────────────────────────────────────────
    const rawCustomFields = (
      (contact.customFields as GHLCustomField[]) ||
      (body.customFields as GHLCustomField[]) ||
      (body.custom_fields as GHLCustomField[]) ||
      []
    )

    // ── Loan & financial fields ───────────────────────────────────────────────

    const loanAmount = parseAmount(
      pick(body, 'loan_amount', 'loanAmount', 'loan_amt') ||
      pick(contact, 'loan_amount', 'loanAmount') ||
      getCustomField(rawCustomFields,
        'loan_amount', 'loan amount', 'loanamount', 'loan_size',
        'mortgage_amount', 'requested_amount', 'Loan Amount')
    )

    const estimatedValue = parseAmount(
      pick(body, 'estimated_value', 'propertyValue', 'property_value', 'home_value', 'estimatedValue') ||
      pick(contact, 'estimated_value', 'propertyValue') ||
      getCustomField(rawCustomFields,
        'estimated_value', 'property_value', 'home_value', 'estimated value',
        'property value', 'home value', 'purchase_price', 'purchase price',
        'appraised_value', 'Property Value', 'propertyvalue')
    )

    const loanType =
      pick(body, 'loan_type', 'loanType', 'loan_program') ||
      pick(contact, 'loan_type', 'loanType') ||
      getCustomField(rawCustomFields,
        'loan_type', 'loan type', 'loan_program', 'loantype',
        'mortgage_type', 'program_type', 'product_type', 'Loan Type')

    // NEW: Loan Purpose (Refinance / Purchase / etc.)
    const loanPurpose =
      pick(body, 'loan_purpose', 'loanPurpose') ||
      getCustomField(rawCustomFields,
        'loan_purpose', 'loan purpose', 'loanpurpose', 'Loan Purpose',
        'purpose', 'loan_goal')

    // Property Address — GHL uses "PhysicalAddress" as a custom field key
    const propertyAddress =
      getCustomField(rawCustomFields,
        'property_address', 'property address', 'subject_property',
        'property_street', 'home_address', 'prop_address',
        'PhysicalAddress', 'physicaladdress', 'physical_address',
        'physical address') ||
      pick(body, 'property_address', 'propertyAddress') ||
      pick(contact, 'address1', 'address') ||
      pick(body, 'address1', 'address')

    const creditScore = parseAmount(
      pick(body, 'credit_score', 'creditScore', 'fico', 'fico_score') ||
      getCustomField(rawCustomFields,
        'credit_score', 'credit score', 'fico', 'fico_score',
        'middle_score', 'beacon_score')
    )

    // NEW: Credit Rating (text like "Good", "Excellent")
    const creditRating =
      pick(body, 'credit_rating', 'creditRating') ||
      getCustomField(rawCustomFields,
        'credit_rating', 'credit rating', 'creditrating', 'Credit Rating',
        'credit_grade', 'creditgrade')

    const revenue = parseAmount(
      pick(body, 'revenue', 'compensation', 'commission', 'total_comp') ||
      getCustomField(rawCustomFields,
        'revenue', 'compensation', 'commission', 'total_comp',
        'estimated_revenue', 'broker_comp')
    )

    const rate = parseAmount(
      pick(body, 'rate', 'interest_rate', 'interestRate') ||
      getCustomField(rawCustomFields,
        'rate', 'interest_rate', 'note_rate', 'quoted_rate')
    )

    const investor =
      pick(body, 'investor', 'lender', 'bank') ||
      getCustomField(rawCustomFields,
        'investor', 'lender', 'wholesale_lender', 'bank', 'lender_name')

    // Occupancy / Property Use
    const occupancy =
      pick(body, 'occupancy', 'property_type', 'propertyType') ||
      getCustomField(rawCustomFields,
        'occupancy', 'occupancy_type', 'property_type', 'property use',
        'propertyuse', 'Property Use', 'property_use',
        'primary', 'investment', 'second home')

    // NEW: Property Type (Manufactured, Single Family, Condo, etc.)
    const propertyType =
      pick(body, 'property_type_detail', 'propertyTypeDetail') ||
      getCustomField(rawCustomFields,
        'property_type', 'Property Type', 'propertytype', 'structure_type',
        'home_type', 'hometype', 'dwelling_type', 'dwellingtype')

    // NEW: Current Balance (existing mortgage balance)
    const currentBalance = parseAmount(
      pick(body, 'current_balance', 'currentBalance', 'existing_balance') ||
      getCustomField(rawCustomFields,
        'current_balance', 'currentbalance', 'Current Balance',
        'existing_balance', 'existingbalance', 'mortgage_balance',
        'outstanding_balance')
    )

    // NEW: LTV
    const ltv = parseAmount(
      pick(body, 'ltv', 'LTV', 'loan_to_value') ||
      getCustomField(rawCustomFields,
        'ltv', 'LTV', 'Property LTV', 'propertyltv', 'loan_to_value',
        'loantovalue')
    )

    // NEW: Cash Out
    const cashOut = parseAmount(
      pick(body, 'cash_out', 'cashOut', 'cash_out_amount') ||
      getCustomField(rawCustomFields,
        'cash_out', 'cashout', 'Cash out', 'Cashout',
        'cash_out_amount', 'cashoutamount')
    )

    // NEW: Down Payment
    const downPayment = parseAmount(
      pick(body, 'down_payment', 'downPayment', 'dp') ||
      getCustomField(rawCustomFields,
        'down_payment', 'downpayment', 'Down Payment',
        'down_pmt', 'downpmt', 'dp')
    )

    // NEW: Is Military
    const isMilitary =
      pick(body, 'is_military', 'isMilitary', 'military') ||
      getCustomField(rawCustomFields,
        'is_military', 'ismilitary', 'IsMilitary',
        'military', 'veteran', 'is_veteran')

    // NEW: Current VA Loan (note: GHL uses typo "curentVALoan")
    const currentVaLoan =
      pick(body, 'current_va_loan', 'currentVaLoan', 'curentVALoan') ||
      getCustomField(rawCustomFields,
        'current_va_loan', 'currentvaloan', 'curentVALoan',
        'currentvaloan', 'va_loan', 'valoan', 'existing_va_loan')

    // NEW: Property Found
    const propertyFound =
      pick(body, 'property_found', 'propertyFound') ||
      getCustomField(rawCustomFields,
        'property_found', 'propertyfound', 'Property Found',
        'found_property', 'foundproperty', 'home_found')

    // NEW: Loan Timeframe
    const loanTimeframe =
      pick(body, 'loan_timeframe', 'loanTimeframe', 'timeframe') ||
      getCustomField(rawCustomFields,
        'loan_timeframe', 'loantimeframe', 'Loan Timeframe',
        'timeframe', 'purchase_timeframe', 'closing_timeframe',
        'when_to_close', 'timeline')

    // NEW: Has Accepted Offer
    const hasAcceptedOffer =
      pick(body, 'has_accepted_offer', 'hasAcceptedOffer', 'accepted_offer') ||
      getCustomField(rawCustomFields,
        'has_accepted_offer', 'hasacceptedoffer', 'Has Accepted Offer',
        'accepted_offer', 'acceptedoffer', 'offer_accepted')

    // Address components (contact mailing / physical)
    const city =
      pick(contact, 'city') ||
      pick(body, 'city') ||
      getCustomField(rawCustomFields,
        'phys_city', 'physcity', 'Phys City', 'physical_city',
        'property_city', 'propertycity')

    const state =
      pick(contact, 'state') ||
      pick(body, 'state') ||
      getCustomField(rawCustomFields,
        'phys_state', 'physstate', 'Phys State', 'physical_state',
        'property_state', 'propertystate')

    const zip =
      pick(contact, 'postalCode', 'postal_code', 'zip') ||
      pick(body, 'postalCode', 'postal_code', 'zip') ||
      getCustomField(rawCustomFields,
        'phys_zip', 'physzip', 'Phys Zip', 'physical_zip',
        'property_zip', 'propertyzip')

    const source = pick(contact, 'source') || pick(body, 'source') || 'GHL'

    const tagsRaw = (contact.tags || body.tags) as string[] | string | undefined
    const ghlTags = Array.isArray(tagsRaw)
      ? tagsRaw.join(', ')
      : (typeof tagsRaw === 'string' ? tagsRaw : null)

    const ghlAssignedUser =
      pick(contact, 'assignedTo', 'assigned_to', 'assignedUser') ||
      pick(body, 'assignedTo', 'assigned_to')

    // ── Owner → Loan Officer ──────────────────────────────────────────────────
    // GHL opportunity webhooks send owner as { id, name, email } object.
    // Also try flat fields like assignedTo, owner_name, etc.
    const ownerObj = (body.owner ?? body.assignedUser ?? body.ownedBy) as Record<string, unknown> | null | undefined
    const ownerName: string | null =
      (typeof ownerObj?.name === 'string' && ownerObj.name.trim() ? ownerObj.name.trim() : null) ||
      (typeof ownerObj?.fullName === 'string' && ownerObj.fullName.trim() ? ownerObj.fullName.trim() : null) ||
      pick(body, 'owner_name', 'ownerName', 'assigned_user_name') ||
      ghlAssignedUser // last resort — could be a user ID, will still store it

    // Fuzzy-match to your known loan officers so it maps cleanly
    const LO_MAP: Record<string, string> = {
      'moe sefati':     'Moe Sefati',
      'moe':            'Moe Sefati',
      'efrain ramirez': 'Efrain Ramirez',
      'efrain':         'Efrain Ramirez',
      'matt':           'Matt',
    }

    let loanOfficer: string | null = null
    if (ownerName) {
      const lower = ownerName.toLowerCase().trim()
      for (const [key, value] of Object.entries(LO_MAP)) {
        if (lower.includes(key)) { loanOfficer = value; break }
      }
      // If no fuzzy match, store raw name so it still shows up
      if (!loanOfficer) loanOfficer = ownerName
    }

    const dateAddedGHL =
      pick(contact, 'dateAdded', 'date_added', 'createdAt') ||
      pick(body, 'dateAdded', 'date_added')

    // ── Duplicate check ───────────────────────────────────────────────────────
    const supabase = createServiceClient()

    if (ghlContactId) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id, name')
        .eq('ghl_contact_id', ghlContactId)
        .single()

      if (existing) {
        await supabase.from('deals').update({
          last_contacted: new Date().toISOString().split('T')[0],
          ...(loanAmount       && { loan_amount: loanAmount }),
          ...(estimatedValue   && { estimated_value: estimatedValue }),
          ...(loanType         && { loan_type: loanType }),
          ...(loanPurpose      && { loan_purpose: loanPurpose }),
          ...(propertyAddress  && { property_address: propertyAddress }),
          ...(creditScore      && { credit_score: creditScore }),
          ...(creditRating     && { credit_rating: creditRating }),
          ...(revenue          && { revenue }),
          ...(rate             && { rate }),
          ...(investor         && { investor }),
          ...(occupancy        && { occupancy }),
          ...(propertyType     && { property_type: propertyType }),
          ...(currentBalance   && { current_balance: currentBalance }),
          ...(ltv              && { ltv }),
          ...(cashOut          && { cash_out: cashOut }),
          ...(downPayment      && { down_payment: downPayment }),
          ...(isMilitary       && { is_military: isMilitary }),
          ...(currentVaLoan    && { current_va_loan: currentVaLoan }),
          ...(propertyFound    && { property_found: propertyFound }),
          ...(loanTimeframe    && { loan_timeframe: loanTimeframe }),
          ...(hasAcceptedOffer && { has_accepted_offer: hasAcceptedOffer }),
          ...(loanOfficer      && { loan_officer: loanOfficer }),
          ...(ghlTags          && { ghl_tags: ghlTags }),
          ...(city             && { city }),
          ...(state            && { state }),
          ...(zip              && { zip }),
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
      // Team
      loan_officer:     loanOfficer,
      // Loan fields
      loan_amount:      loanAmount,
      estimated_value:  estimatedValue,
      loan_type:        loanType,
      loan_purpose:     loanPurpose,
      property_address: propertyAddress,
      credit_score:     creditScore,
      credit_rating:    creditRating,
      revenue,
      rate,
      investor,
      occupancy,
      property_type:    propertyType,
      current_balance:  currentBalance,
      ltv,
      cash_out:         cashOut,
      down_payment:     downPayment,
      is_military:      isMilitary,
      current_va_loan:  currentVaLoan,
      property_found:   propertyFound,
      loan_timeframe:   loanTimeframe,
      has_accepted_offer: hasAcceptedOffer,
      // Address
      city,
      state,
      zip,
      // GHL metadata
      ghl_contact_id:    ghlContactId || null,
      ghl_tags:          ghlTags,
      ghl_assigned_user: ghlAssignedUser,
      date_added_ghl:    dateAddedGHL || null,
      last_contacted:    new Date().toISOString().split('T')[0],
      raw_ghl_data:      body,
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

    console.log('[GHL Webhook] Created deal:', data.id)

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
        loan_purpose: !!loanPurpose,
        property_address: !!propertyAddress,
        credit_score: !!creditScore,
        credit_rating: !!creditRating,
        property_type: !!propertyType,
        current_balance: !!currentBalance,
        ltv: !!ltv,
        cash_out: !!cashOut,
        down_payment: !!downPayment,
        is_military: !!isMilitary,
        current_va_loan: !!currentVaLoan,
        property_found: !!propertyFound,
        loan_timeframe: !!loanTimeframe,
        has_accepted_offer: !!hasAcceptedOffer,
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
    message: 'GHL webhook — capturing all custom fields',
    timestamp: new Date().toISOString(),
    fields_captured: [
      'name', 'email', 'phone', 'source',
      'loan_amount', 'estimated_value', 'loan_type', 'loan_purpose',
      'property_address', 'credit_score', 'credit_rating',
      'revenue', 'rate', 'investor', 'occupancy',
      'property_type', 'current_balance', 'ltv', 'cash_out', 'down_payment',
      'is_military', 'current_va_loan', 'property_found',
      'loan_timeframe', 'has_accepted_offer',
      'city', 'state', 'zip',
      'ghl_tags', 'ghl_assigned_user', 'raw_ghl_data',
    ]
  })
}
