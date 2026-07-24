// ── Shared GHL opportunity → dashboard field mapper ─────────────────────────
// Arive writes the AUTHORITATIVE loan data back into the GHL OPPORTUNITY's custom
// fields (Base Loan Amount, Purchase Price, Note Rate, Compensation, CLTV, PITI…).
// The dashboard historically read loan fields from the CONTACT's custom fields
// (stale lead-intake estimates, e.g. Property Value 475k vs the opp's real 539k)
// plus the opp's native monetaryValue — so almost none of Arive's numbers reached
// a deal. Both the 15-min sync and the real-time webhook must read the same place;
// this module is that single source of truth.
//
// GOTCHA (verified 2026-07-23 on the live 'primary' account): opportunity custom
// field values arrive under the `fieldValue` key — NOT `fieldValueString`/`value`
// (which the /contacts endpoint uses). Reading the wrong key returned null for
// EVERY opportunity field, including the "Arive Loan ID" (which is why deals never
// linked to Arive). We read all known variants below.

export type OppCustomFieldEntry = {
  id?: string; key?: string; fieldKey?: string; name?: string
  fieldValue?: unknown; fieldValueString?: string; fieldValueArray?: unknown[]
  value?: unknown; field_value?: unknown
}
export type CustomFieldDef = { id: string; name: string; fieldKey: string }
type OppLike = { customFields?: unknown } | null | undefined

const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-/.]+/g, '')

// GHL scatters the value across keys depending on account/endpoint.
function rawValue(f: OppCustomFieldEntry): unknown {
  return (
    f.fieldValueString ?? f.fieldValue ?? f.value ?? f.field_value ??
    (Array.isArray(f.fieldValueArray) ? f.fieldValueArray[0] : undefined)
  )
}

// Coerce a GHL custom-field value ("$190,454" | 190454 | "8.85" | "35.335%") → number | null.
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** First opportunity custom-field value whose name/fieldKey exactly matches (normalized)
 *  any candidate. Exact match — never substring — so "Loan Amount" can't grab
 *  "Base Loan Amount", and "LTV" can't grab "CLTV". */
export function oppCustomField(
  fields: unknown,
  defs: Map<string, CustomFieldDef> | undefined,
  ...names: string[]
): unknown {
  if (!Array.isArray(fields)) return null
  const wanted = new Set(names.map(norm))
  for (const f of fields as OppCustomFieldEntry[]) {
    const def = f.id ? defs?.get(f.id) : undefined
    const labels = [def?.name, def?.fieldKey, f.name, f.fieldKey, f.key]
      .filter(Boolean).map(x => norm(String(x)))
    // fieldKeys carry an "opportunity."/"contact." prefix — match the tail too.
    const tails = labels.map(l => l.replace(/^(opportunity|contact)/, ''))
    if ([...labels, ...tails].some(l => wanted.has(l))) {
      const v = rawValue(f)
      if (v != null && v !== '') return v
    }
  }
  return null
}

/** The Arive loan number GHL holds (opportunity custom field "Arive Loan ID"),
 *  written back into GHL by Arive — the deterministic GHL↔Arive join key. */
export function ariveLoanIdFromOpp(opp: OppLike, defs: Map<string, CustomFieldDef> | undefined): string | null {
  const v = oppCustomField(opp?.customFields, defs, 'Arive Loan ID', 'arive_loan_id')
  const s = v == null ? '' : String(v).trim()
  return s || null
}

/** Map an opportunity's Arive-written custom fields → dashboard deal columns.
 *  Returns ONLY fields the opportunity actually carries, so a caller can overlay
 *  it on contact-sourced defaults without wiping fallbacks (leads not yet in Arive
 *  have no opp custom fields → this returns {} and the contact estimate stands).
 *  loan_amount is intentionally EXCLUDED — it stays sourced from the opp's native
 *  monetaryValue with the funded provenance guard, untouched by this overlay. */
export function mapOpportunityFields(
  opp: OppLike,
  defs: Map<string, CustomFieldDef> | undefined,
): Record<string, number | string> {
  const cf = opp?.customFields
  const out: Record<string, number | string> = {}
  const num = (col: string, ...names: string[]) => {
    const n = toNum(oppCustomField(cf, defs, ...names))
    if (n != null) out[col] = n
  }
  const str = (col: string, ...names: string[]) => {
    const v = oppCustomField(cf, defs, ...names)
    if (v != null && String(v).trim()) out[col] = String(v).trim()
  }
  num('estimated_value',     'Property Value', 'Appraised Value')
  num('purchase_price',      'Purchase Price')
  num('rate',                'Note Rate', 'Interest Rate')
  num('current_balance',     'First Mortgage Balance', 'Existing Liens Amount', 'Total Existing Liens')
  num('ltv',                 'LTV')
  num('cash_out',            'Cash Out', 'Cashout Amount', 'Refinance CashOut Amount', 'Total Cash Out')
  num('down_payment',        'Down Payment')
  num('credit_score',        'Credit Score', 'Loan FICO')
  num('compensation_amount', 'Compensation', 'Compensation Amount', 'Total Compensation')
  num('housing_payment',     'Total PITI')
  num('pi_payment',          'Principal And Interest', 'First Mortgage Principal And Interest Monthly Amount')
  str('investor',            'Lender Name')
  return out
}
