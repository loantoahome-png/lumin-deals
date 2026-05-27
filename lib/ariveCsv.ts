// ── Arive CSV importer — shared helpers ─────────────────────────────────────
// Parses an Arive export and translates it into dashboard deal fields.
// Designed to be tolerant: missing columns are skipped silently, unknown values
// pass through, and matching falls back from arive_file_no → email → phone → name.

import { normEmail, normPhone } from './dealMatcher'

// ── CSV parsing (RFC 4180-aware, no external dep) ───────────────────────────
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const cells: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0

  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue } // escaped quote
        inQuotes = false; i++; continue
      }
      cell += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(cell); cell = ''; i++; continue }
    if (c === '\r') { i++; continue } // strip
    if (c === '\n') { row.push(cell); cells.push(row); row = []; cell = ''; i++; continue }
    cell += c; i++
  }
  // Flush last cell/row
  if (cell !== '' || row.length > 0) { row.push(cell); cells.push(row) }

  // Drop any trailing all-empty rows
  while (cells.length > 0 && cells[cells.length - 1].every(c => c === '')) cells.pop()

  if (cells.length === 0) return { header: [], rows: [] }
  const [header, ...rows] = cells
  return { header, rows }
}

// ── Value normalizers ───────────────────────────────────────────────────────
const STATES: Record<string, string> = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',
  connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',
  hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',
  louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',
  mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',
  ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',
  washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY',
}
function normState(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (!t) return null
  if (t.length === 2) return t.toUpperCase()         // already an abbreviation
  const abbr = STATES[t.toLowerCase()]
  return abbr ?? t
}

function normOccupancy(v: string | null): string | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  if (t.includes('primary')) return 'Primary'
  if (t.includes('second'))  return 'Second Home'
  if (t.includes('invest'))  return 'Investment'
  return v.trim() || null
}

function normPropertyType(v: string | null): string | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  if (t.includes('single family') || t.includes('sfr')) return 'Single Family'
  if (t.includes('condo'))      return 'Condo'
  if (t.includes('townhouse') || t.includes('town home')) return 'Townhouse'
  if (t.includes('multi') || t.includes('2-4') || t.includes('1-4')) return 'Multi-Family'
  if (t.includes('manufactured') || t.includes('mobile')) return 'Manufactured'
  return v.trim() || null
}

function normLoanPurpose(v: string | null): string | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  if (t.includes('purchase')) return 'Purchase'
  // Cash-Out Refinance / Refinance / Rate-Term Refi etc. all collapse to "Refinance"
  // (the dashboard dropdown is restricted to Purchase/Refinance — see prior migration).
  if (t.includes('refi'))     return 'Refinance'
  return null
}

/**
 * Map Arive's Mortgage Type → dashboard loan_type (family only).
 * Returns null for any value that doesn't map to a known family.
 */
function normLoanType(mortgageType: string | null): string | null {
  if (!mortgageType) return null
  const fam = mortgageType.trim().toLowerCase()
  if (fam.includes('heloc') || fam.includes('home equity line'))  return 'HELOC'
  if (fam.includes('heloan') || fam.includes('home equity loan')) return 'HELOAN'
  if (fam.includes('hard'))     return 'Hard Money'
  if (fam.includes('non-qm') || fam.includes('non qm')) return 'Non-QM'
  if (fam.includes('dscr'))     return 'DSCR'
  if (fam.includes('va'))       return 'VA'
  if (fam.includes('fha'))      return 'FHA'
  if (fam.includes('conv'))     return 'Conv'
  return null
}

/**
 * Derive refinance_type from Arive's Refinance CashOut Type + Mortgage Type
 * + Loan Purpose. Returns null when the deal isn't a refinance or we can't tell.
 */
function normRefinanceType(
  cashOutType: string | null,
  loanPurpose: string | null,
  mortgageType: string | null,
): string | null {
  const purpose = (loanPurpose ?? '').toLowerCase()
  if (!purpose.includes('refi')) return null
  const cot = (cashOutType ?? '').toLowerCase()
  const mt  = (mortgageType ?? '').toLowerCase()
  if (cot.includes('cash')) return 'Cash Out'
  if (cot.includes('rate') || cot.includes('term')) return 'Rate and Term'
  // VA IRRRL and FHA Streamline are inherently rate-and-term
  if (mt.includes('irrrl') || mt.includes('streamline')) return 'Rate and Term'
  // Can't tell — leave null rather than guess
  return null
}

const DASHBOARD_STAGES = new Set<string>([
  'New Lead','Attempted Contact','Ghosted','Responded','Pitching','Appointment Booked',
  'Arive Lead','App Intake','Qualification','Pre-Approved',
  'Loan Setup','Disclosed','Submitted to UW','Approved w/ Conditions','Re-Submittal',
  'Clear to Close','Docs Out','Docs Signed','Loan Funded','Broker Check Received',
  'Loan Finalized',
  'Not Qualified - Credit','Not Qualified - Income','Not Ready - Timeframe',
  'DND - SMS','Not Ready - Rate','Lost to Competitor','Non-Responsive',
  'Remove from All Automations','STOP',
])

function normStage(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (!t) return null
  if (DASHBOARD_STAGES.has(t)) return t                       // exact match
  // Case-insensitive match
  const lower = t.toLowerCase()
  for (const s of DASHBOARD_STAGES) if (s.toLowerCase() === lower) return s
  // Common Arive → dashboard fuzzy matches
  if (lower.includes('approved') && lower.includes('cond')) return 'Approved w/ Conditions'
  if (lower.includes('clear to close'))   return 'Clear to Close'
  if (lower.includes('submitted to uw'))  return 'Submitted to UW'
  if (lower.includes('docs out'))         return 'Docs Out'
  if (lower.includes('docs signed'))      return 'Docs Signed'
  if (lower.includes('funded'))           return 'Loan Funded'
  if (lower.includes('disclosed'))        return 'Disclosed'
  if (lower.includes('loan setup'))       return 'Loan Setup'
  return null
}

function num(v: string | null): number | null {
  if (!v) return null
  const cleaned = String(v).replace(/[$,\s]/g, '')
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isNaN(n) ? null : n
}

function dateOnly(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (!t) return null
  // Arive lock-expiration looks like "2026-06-17 11:59:13 PM" — keep the YYYY-MM-DD prefix
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  // Try Date.parse fallback
  const d = new Date(t)
  if (!isNaN(d.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  }
  return null
}

function trimStr(v: string | null): string | null {
  if (v == null) return null
  const t = v.trim()
  return t || null
}

/** Normalize Arive's lien-position strings ("First Lien", "Second Lien", etc.)
 *  to dashboard values ("1st Lien", "2nd Lien", "3rd Lien"). */
function normLienPosition(v: string | null): string | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  if (t.includes('first') || t.startsWith('1'))  return '1st Lien'
  if (t.includes('second') || t.startsWith('2')) return '2nd Lien'
  if (t.includes('third') || t.startsWith('3'))  return '3rd Lien'
  return null
}

/**
 * Combine the three address fragments Arive exports into one string suitable
 * for the dashboard's single `property_address` column.
 *   Subject Address Line 1  →  "21 Woodcrest Road"
 *   Subject Address Line 2  →  "Suite 200"          (often empty)
 *   Apt/Unit #              →  "4B"                  (often empty)
 *
 * Dedup'd so we never duplicate the unit info if it appears in two fields.
 */
function combinePropertyAddress(line1: string | null, line2: string | null, aptUnit: string | null): string | null {
  const l1 = (line1 ?? '').trim()
  if (!l1) return null
  const parts: string[] = [l1]
  const l2 = (line2 ?? '').trim()
  if (l2 && !l1.toLowerCase().includes(l2.toLowerCase())) parts.push(l2)
  const apt = (aptUnit ?? '').trim()
  if (apt && !parts.some(p => p.toLowerCase().includes(apt.toLowerCase()))) {
    parts.push(`#${apt}`)
  }
  return parts.join(' ')
}

// ── Column → dashboard field mapping ────────────────────────────────────────
// Source-of-truth list of every Arive column we know about. Each entry knows
// (a) the dashboard field name, (b) how to normalize the value. Columns not
// in this list are ignored.
type Mapping = {
  ariveCols: string[]                                        // accept any of these (different exports vary)
  field: string | null                                       // dashboard field name (null = used elsewhere)
  normalize: (raw: string | null, row: Row) => unknown
}

type Row = Record<string, string | null>

const MAPPINGS: Mapping[] = [
  { ariveCols: ['ARIVE Loan Id'],            field: 'arive_file_no',     normalize: r => trimStr(r) },
  { ariveCols: ['Stage Name'],               field: 'status',            normalize: r => normStage(r) },
  { ariveCols: ['Total Loan Amount'],        field: 'loan_amount',       normalize: r => num(r) },
  { ariveCols: ['Loan Purpose'],             field: 'loan_purpose',      normalize: r => normLoanPurpose(r) },
  { ariveCols: ['Primary Loan Officer Name'], field: 'loan_officer',     normalize: r => trimStr(r) },
  { ariveCols: ['Lender'],                   field: 'investor',          normalize: r => trimStr(r) },
  { ariveCols: ['Lien Position'],            field: 'lien_position',     normalize: r => normLienPosition(r) },
  { ariveCols: ['Lead Source'],              field: 'lead_source_agg',   normalize: r => trimStr(r) },
  { ariveCols: ['Loan FICO'],                field: 'credit_score',      normalize: r => num(r) },
  // loan_type: this export labels the product column "Loan Product"; older
  // exports used "Mortgage Type". Accept either.
  { ariveCols: ['Mortgage Type', 'Loan Product'], field: 'loan_type',     normalize: r => normLoanType(r) },
  { ariveCols: ['Refinance CashOut Type', 'Refinance Purpose Type'], field: 'refinance_type',
    normalize: (r, row) => normRefinanceType(r, row['Loan Purpose'] ?? null, row['Mortgage Type'] ?? row['Loan Product'] ?? null) },
  { ariveCols: ['LTV'],                      field: 'ltv',               normalize: r => num(r) },
  { ariveCols: ['Purchase Price'],           field: 'purchase_price',    normalize: r => num(r) },
  { ariveCols: ['Total Housing Payment'],    field: 'housing_payment',   normalize: r => num(r) },
  { ariveCols: ['Subject County'],           field: 'county',            normalize: r => trimStr(r) },
  { ariveCols: ['Adverse'],                  field: 'adverse',           normalize: r => trimStr(r) },
  { ariveCols: ['Appraised Value','Property Value'], field: 'estimated_value', normalize: r => num(r) },
  { ariveCols: ['Primary Borrower Email'],   field: 'email',             normalize: r => trimStr(r)?.toLowerCase() ?? null },
  { ariveCols: ['Primary Borrower Cell Phone','Primary Borrower Home Phone'], field: 'phone', normalize: r => trimStr(r) },
  { ariveCols: ['Occupancy'],                field: 'occupancy',         normalize: r => normOccupancy(r) },
  // property_address combines Subject Address Line 1 + Line 2 + Apt/Unit #
  // so units/suites aren't lost. Line 2 and Apt/Unit # are usually blank.
  { ariveCols: ['Subject Address Line 1'],   field: 'property_address',
    normalize: (r, row) => combinePropertyAddress(r, row['Subject Address Line 2'] ?? null, row['Apt/Unit #'] ?? null) },
  { ariveCols: ['Subject City'],             field: 'city',              normalize: r => trimStr(r) },
  { ariveCols: ['Subject State'],            field: 'state',             normalize: r => normState(r) },
  { ariveCols: ['Subject ZIP'],              field: 'zip',               normalize: r => trimStr(r) },
  { ariveCols: ['Property Type (Housing Type)','Property Type'], field: 'property_type', normalize: r => normPropertyType(r) },
  { ariveCols: ['Lender Loan #'],            field: 'investor_file_no',  normalize: r => trimStr(r) },
  { ariveCols: ['Processor Type'],           field: 'processor',         normalize: r => trimStr(r) },
  { ariveCols: ['Interest Rate'],            field: 'rate',              normalize: r => num(r) },
  { ariveCols: ['Lock Expiration'],          field: 'lock_expiration',   normalize: r => dateOnly(r) },
  { ariveCols: ['Estimated Closing Date'],   field: 'close_of_escrow_date', normalize: r => dateOnly(r) },
  { ariveCols: ['Refinance CashOut Amount'], field: 'cash_out',          normalize: r => num(r) },
  { ariveCols: ['Compensation Amount', 'Comp Amount', 'Total Compensation'], field: 'compensation_amount', normalize: r => num(r) },
  // Existing first/second mortgage balance — Arive labels vary across exports
  { ariveCols: ['Existing Liens Amount', 'Total Existing Liens', 'First Mortgage Balance', 'Existing Lien Amount'],
                                             field: 'current_balance',   normalize: r => num(r) },
  // Prefer the ACTUAL funded date. Arive's funded report names this column
  // "Loan Funded"; older exports used "Funded Date"/"Est. Funding Date".
  { ariveCols: ['Loan Funded', 'Loan Funded Date', 'Funded Date', 'Funding Date', 'Actual Funding Date', 'Est. Funding Date'],
                                             field: 'funded_date',       normalize: r => dateOnly(r) },
]

// ── Build a row → patch (only fields the CSV actually has data for) ─────────
export type AriveImportPatch = Record<string, unknown> & {
  arive_file_no?: string | null
  // Carrier fields used for matching — NOT written unless field is also a real
  // dashboard column. Email/phone ARE real columns so they get written too.
  __borrower_name?: string
}

export function rowToPatch(row: Row): AriveImportPatch {
  const patch: AriveImportPatch = {}
  for (const m of MAPPINGS) {
    if (!m.field) continue
    let raw: string | null = null
    for (const col of m.ariveCols) {
      if (col in row && row[col] != null && row[col] !== '') { raw = row[col]; break }
    }
    const value = m.normalize(raw, row)
    if (value !== null && value !== undefined && value !== '') {
      patch[m.field] = value
    }
  }
  // Stash the borrower name for matching fallback
  patch.__borrower_name = (row['Primary Borrower'] ?? '').trim()
  return patch
}

// ── Match a CSV row to an existing dashboard deal ───────────────────────────
type ExistingDealLight = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  arive_file_no: string | null
}

export type MatchResult =
  | { matched: true;  dealId: string; via: 'arive_file_no' | 'email' | 'phone' | 'name' | 'name_firstlast' }
  | { matched: false; reason: string }

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '')
}

// Generational suffixes that aren't part of the last name.
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

/** Reduce a name to first-token + last-token, ignoring middle names/initials,
 *  comma formatting, AND generational suffixes (Jr/Sr/III). So:
 *    "Carlton J. Louie"        → carlton|louie
 *    "Fipe,Sammy Ra,Leilua"    → fipe|leilua
 *    "Rene Robert Gonzalez jr" → rene|gonzalez   (was rene|jr before this fix)
 */
function normFirstLast(s: string): string {
  let tokens = s.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/)
    .map(t => t.replace(/[^a-z]/g, '')).filter(Boolean)
  // Drop trailing suffix tokens (keep at least 2 tokens so we don't over-strip)
  while (tokens.length > 2 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1)
  }
  if (tokens.length === 0) return ''
  if (tokens.length === 1) return tokens[0]
  return `${tokens[0]}|${tokens[tokens.length - 1]}`
}

/** Build O(1) lookup indices over the existing-deals list. */
export function buildMatchIndex(deals: ExistingDealLight[]) {
  const byArive = new Map<string, string>()         // arive_file_no → id
  const byEmail = new Map<string, string>()         // normalized email → id
  const byPhone = new Map<string, string>()         // last-10-digit phone → id
  const byName  = new Map<string, string[]>()       // full normalized name → ids[]
  const byFirstLast = new Map<string, string[]>()   // first|last → ids[] (looser fallback)

  for (const d of deals) {
    if (d.arive_file_no) byArive.set(String(d.arive_file_no), d.id)
    const e = normEmail(d.email); if (e && !byEmail.has(e)) byEmail.set(e, d.id)
    const p = normPhone(d.phone); if (p && !byPhone.has(p)) byPhone.set(p, d.id)
    if (d.name) {
      const k = normName(d.name)
      if (k) {
        const ex = byName.get(k); if (ex) ex.push(d.id); else byName.set(k, [d.id])
      }
      const fl = normFirstLast(d.name)
      if (fl) {
        const ex = byFirstLast.get(fl); if (ex) ex.push(d.id); else byFirstLast.set(fl, [d.id])
      }
    }
  }
  return { byArive, byEmail, byPhone, byName, byFirstLast }
}

export function matchRow(
  patch: AriveImportPatch,
  ix: ReturnType<typeof buildMatchIndex>,
): MatchResult {
  const fno = patch.arive_file_no
  if (fno && ix.byArive.has(String(fno))) {
    return { matched: true, dealId: ix.byArive.get(String(fno))!, via: 'arive_file_no' }
  }
  const e = normEmail((patch.email as string | undefined) ?? null)
  if (e && ix.byEmail.has(e)) {
    return { matched: true, dealId: ix.byEmail.get(e)!, via: 'email' }
  }
  const p = normPhone((patch.phone as string | undefined) ?? null)
  if (p && ix.byPhone.has(p)) {
    return { matched: true, dealId: ix.byPhone.get(p)!, via: 'phone' }
  }
  const name = patch.__borrower_name
  if (name) {
    // 1) Exact full-name match (most precise)
    const ids = ix.byName.get(normName(name))
    if (ids && ids.length === 1) return { matched: true, dealId: ids[0], via: 'name' }
    if (ids && ids.length > 1)   return { matched: false, reason: `name_ambiguous_${ids.length}_matches` }
    // 2) First+last fallback — ignores middle names/initials ("Carlton J. Louie" → "Carlton Louie")
    const flIds = ix.byFirstLast.get(normFirstLast(name))
    if (flIds && flIds.length === 1) return { matched: true, dealId: flIds[0], via: 'name_firstlast' }
    if (flIds && flIds.length > 1)   return { matched: false, reason: `name_ambiguous_${flIds.length}_matches` }
  }
  return { matched: false, reason: 'no_match' }
}

// Map a dashboard status to its pipeline_group (mirrors lib/types.ts groupings).
function pipelineGroupForStatus(status: string): string {
  const FUNDED = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
  const IN_PROCESS = new Set(['Loan Setup','Disclosed','Submitted to UW','Approved w/ Conditions','Re-Submittal','Clear to Close','Docs Out','Docs Signed'])
  const NOT_READY = new Set(['Not Qualified - Credit','Not Qualified - Income','Not Ready - Timeframe','DND - SMS','Not Ready - Rate','Lost to Competitor','Non-Responsive','Remove from All Automations','STOP'])
  if (FUNDED.has(status)) return 'Funded'
  if (IN_PROCESS.has(status)) return 'Loans in Process'
  if (NOT_READY.has(status)) return 'Not Ready'
  return 'Leads'
}

// ── Build the per-row commit plan ───────────────────────────────────────────
export type FieldChange = {
  field: string
  current: unknown
  next: unknown
  action: 'fill' | 'overwrite' | 'unchanged'
}

export type RowPlan = {
  rowIndex: number
  borrower: string
  arive_file_no: string | null
  matched: boolean
  matchedVia?: 'arive_file_no' | 'email' | 'phone' | 'name' | 'name_firstlast'
  dealId?: string
  reason?: string
  changes: FieldChange[]
  // ── Multi-loan support (Option A) ─────────────────────────────────────────
  // When a borrower already has a deal but THIS Arive file # is different,
  // we create a NEW loan card linked to the same person via borrower_id.
  //   'update'      → matched existing deal, write changed fields
  //   'create_loan' → matched a PERSON but a different loan → new card, same borrower
  //   'create_new'  → no match at all → brand-new deal (opt-in via createUnmatched)
  action: 'update' | 'create_loan' | 'create_new'
  borrowerId?: string | null   // for create_loan: the person to link the new loan to
  newLoanData?: Record<string, unknown>  // full insert payload for create_loan / create_new
}

// Build a full insert payload for a brand-new deal from an Arive row.
function buildNewDealFromPatch(patch: AriveImportPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(patch)) {
    if (field.startsWith('__')) continue
    if (value === undefined || value === null || value === '') continue
    data[field] = value
  }
  data.name = patch.__borrower_name ?? 'Unknown'
  // Status: prefer the Arive stage; else infer from whether it's funded.
  const status = (typeof data.status === 'string' && data.status)
    ? data.status as string
    : (data.funded_date ? 'Loan Funded' : 'Loan Setup')
  data.status = status
  data.pipeline_group = pipelineGroupForStatus(status)
  // Lead source → the dashboard's `source` column (so it attributes correctly).
  if (!data.source && data.lead_source_agg) data.source = data.lead_source_agg
  return data
}

export function buildPlan(args: {
  rows: AriveImportPatch[]
  deals: Map<string, Record<string, unknown>>      // dealId → current deal record
  ix: ReturnType<typeof buildMatchIndex>
  mode: 'fill_blanks' | 'overwrite'
  createUnmatched?: boolean   // when true, no_match rows become brand-new deals
}): RowPlan[] {
  const { rows, deals, ix, mode, createUnmatched } = args
  const plans: RowPlan[] = []
  for (let i = 0; i < rows.length; i++) {
    const patch = rows[i]
    const match = matchRow(patch, ix)
    const plan: RowPlan = {
      rowIndex: i,
      borrower: patch.__borrower_name ?? '(unknown)',
      arive_file_no: (patch.arive_file_no as string | null) ?? null,
      matched: match.matched,
      changes: [],
      action: 'update',
    }
    if (!match.matched) {
      plan.reason = match.reason
      // Only create brand-new deals for TRUE no-matches — never for ambiguous
      // rows (those already exist and would create duplicates).
      if (createUnmatched && match.reason === 'no_match') {
        const newDeal = buildNewDealFromPatch(patch)
        plan.action = 'create_new'
        plan.newLoanData = newDeal
        for (const [field, value] of Object.entries(newDeal)) {
          if (value == null) continue
          plan.changes.push({ field, current: null, next: value, action: 'fill' })
        }
      }
      plans.push(plan); continue
    }
    plan.dealId    = match.dealId
    plan.matchedVia = match.via

    const deal = deals.get(match.dealId) ?? {}

    // ── New-loan detection ────────────────────────────────────────────────
    // If we matched a person by name/email/phone (NOT by this Arive file #),
    // and that person's deal is already linked to a DIFFERENT Arive file #,
    // then this CSV row is a separate loan → create a new card for it.
    const matchedFileNo = (deal.arive_file_no as string | null) ?? null
    const incomingFileNo = (patch.arive_file_no as string | null) ?? null
    if (
      match.via !== 'arive_file_no' &&
      incomingFileNo &&
      matchedFileNo &&
      String(matchedFileNo) !== String(incomingFileNo)
    ) {
      // Build a full insert for the new loan, inheriting the person's identity.
      const borrowerId = (deal.borrower_id as string | null) ?? null
      const newLoan: Record<string, unknown> = {
        // identity carried from the existing person record
        borrower_id:     borrowerId,                 // may be null → backend will assign
        name:            (deal.name as string) ?? patch.__borrower_name ?? 'Unknown',
        first_name:      deal.first_name ?? null,
        last_name:       deal.last_name ?? null,
        email:           deal.email ?? patch.email ?? null,
        phone:           deal.phone ?? patch.phone ?? null,
        ghl_contact_id:  deal.ghl_contact_id ?? null,
        ghl_location_id: deal.ghl_location_id ?? null,
        loan_officer:    deal.loan_officer ?? null,
        // loan-specific fields from the Arive row
        status:          (patch.status as string) ?? 'Loan Funded',
        pipeline_group:  'Funded',   // refined below from status
      }
      // Layer the mapped Arive fields on top (loan_type, amount, comp, etc.)
      for (const [field, value] of Object.entries(patch)) {
        if (field.startsWith('__')) continue
        if (value === undefined || value === null || value === '') continue
        newLoan[field] = value
      }
      // Derive pipeline_group from status if we have one
      if (typeof newLoan.status === 'string') {
        newLoan.pipeline_group = pipelineGroupForStatus(newLoan.status as string)
      }
      plan.action = 'create_loan'
      plan.borrowerId = borrowerId
      plan.newLoanData = newLoan
      // Show the user what the new loan will contain
      for (const [field, value] of Object.entries(newLoan)) {
        if (value == null) continue
        plan.changes.push({ field, current: null, next: value, action: 'fill' })
      }
      plans.push(plan)
      continue
    }
    for (const [field, value] of Object.entries(patch)) {
      if (field.startsWith('__')) continue                 // skip carrier fields
      if (value === undefined || value === null) continue
      const current = deal[field]
      const isBlank = current == null || current === ''
      const isSame  = String(current) === String(value)
      if (isSame) {
        plan.changes.push({ field, current, next: value, action: 'unchanged' })
      } else if (isBlank) {
        plan.changes.push({ field, current, next: value, action: 'fill' })
      } else {
        // Non-blank existing value — only overwrite in overwrite mode
        plan.changes.push({
          field, current, next: value,
          action: mode === 'overwrite' ? 'overwrite' : 'unchanged',
        })
      }
    }
    // If matched by something other than arive_file_no, also push the file # so future imports are direct
    if (match.via !== 'arive_file_no' && patch.arive_file_no) {
      const current = deal.arive_file_no
      if (!current) {
        plan.changes.push({ field: 'arive_file_no', current: null, next: patch.arive_file_no, action: 'fill' })
      }
    }
    plans.push(plan)
  }
  return plans
}

// Summarize a plan for the response payload
export function summarizePlan(plans: RowPlan[]) {
  let matched = 0, unmatched = 0, fill = 0, overwrite = 0, unchanged = 0, willCreate = 0
  for (const p of plans) {
    if (p.matched) matched++; else unmatched++
    if (p.action === 'create_new') willCreate++
    for (const c of p.changes) {
      if (c.action === 'fill') fill++
      else if (c.action === 'overwrite') overwrite++
      else unchanged++
    }
  }
  return {
    total_rows: plans.length,
    matched,
    unmatched,
    will_create: willCreate,
    fields_to_fill: fill,
    fields_to_overwrite: overwrite,
    fields_unchanged: unchanged,
  }
}

// ── Glue: full transform from raw CSV text → row plans ──────────────────────
export function parseRowsFromCsv(text: string): Row[] {
  const { header, rows } = parseCsv(text)
  return rows.map(cells => {
    const row: Row = {}
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = (cells[i] ?? '').trim() || null
    }
    return row
  })
}
