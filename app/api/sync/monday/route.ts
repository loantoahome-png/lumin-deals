import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { titleCase } from '@/lib/utils'

// ── Monday.com config ─────────────────────────────────────────────────────────
const MONDAY_API = 'https://api.monday.com/v2'
const DEALS_BOARD_ID = 9921654433

// ── Status mapping: Monday "Loan Status" → dashboard status + pipeline_group ─
const MONDAY_STATUS_MAP: Record<string, { status: string; pipeline_group: string }> = {
  'PAID':                                                   { status: 'Loan Funded',           pipeline_group: 'Funded' },
  'Comp Requested':                                         { status: 'Loan Finalized',        pipeline_group: 'Funded' },
  'Request Comp':                                           { status: 'Broker Check Received', pipeline_group: 'Funded' },
  'Signing Done - Waiting for Funding':                     { status: 'Docs Signed',           pipeline_group: 'Loans in Process' },
  'F -  Note Signing':                                      { status: 'Docs Signed',           pipeline_group: 'Loans in Process' },
  'F - Rescission':                                         { status: 'Docs Signed',           pipeline_group: 'Loans in Process' },
  'F -  Notary Preparation':                                { status: 'Docs Out',              pipeline_group: 'Loans in Process' },
  'Signing Scheduled':                                      { status: 'Docs Out',              pipeline_group: 'Loans in Process' },
  'Clear to Close':                                         { status: 'Clear to Close',        pipeline_group: 'Loans in Process' },
  'Submitted docs for CTC':                                 { status: 'Re-Submittal',          pipeline_group: 'Loans in Process' },
  'Conditions':                                             { status: 'Approved w/ Conditions',pipeline_group: 'Loans in Process' },
  'Conditional approval':                                   { status: 'Approved w/ Conditions',pipeline_group: 'Loans in Process' },
  'Waiting on Docs from Client for final approval':         { status: 'Approved w/ Conditions',pipeline_group: 'Loans in Process' },
  'Underwriting':                                           { status: 'Submitted to UW',       pipeline_group: 'Loans in Process' },
  'Submitted to UW':                                        { status: 'Submitted to UW',       pipeline_group: 'Loans in Process' },
  'Waiting on VOE':                                         { status: 'Submitted to UW',       pipeline_group: 'Loans in Process' },
  'Figure - income verification or less':                   { status: 'Submitted to UW',       pipeline_group: 'Loans in Process' },
  'F -  In Process':                                        { status: 'Loan Setup',            pipeline_group: 'Loans in Process' },
  'Loan Registered':                                        { status: 'Loan Setup',            pipeline_group: 'Loans in Process' },
  'Need to register':                                       { status: 'Loan Setup',            pipeline_group: 'Loans in Process' },
  'REGISTER':                                               { status: 'Loan Setup',            pipeline_group: 'Loans in Process' },
  'Working on application/docs':                            { status: 'App Intake',            pipeline_group: 'Leads' },
  'Client':                                                 { status: 'Pitching',              pipeline_group: 'Leads' },
}

// Loan type passes through (Monday options match dashboard LOAN_TYPES verbatim except spacing)
function normalizeLoanType(s: string | null): string | null {
  if (!s) return null
  const trimmed = s.trim()
  // Monday uses "Conv - R/T refi" but dashboard uses "Conv - R/T refi" — exact match
  // Just trust Monday's labels since they match
  return trimmed
}

// Monday occupancy → dashboard occupancy
const OCCUPANCY_MAP: Record<string, string> = {
  'Primary': 'Primary', 'Second Home': 'Second Home', 'Investment': 'Investment',
}

// ── GraphQL query helpers ────────────────────────────────────────────────────
async function mondayQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const apiKey = process.env.MONDAY_API_KEY
  if (!apiKey) throw new Error('MONDAY_API_KEY not configured')

  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Monday API ${res.status}: ${await res.text()}`)
  const data = await res.json() as { data?: T; errors?: Array<{ message: string }> }
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '))
  return data.data as T
}

// ── Item type from Monday ────────────────────────────────────────────────────
type MondayItem = {
  id: string
  name: string
  group: { title: string } | null
  column_values: Array<{
    id: string
    text: string | null
    value: string | null
  }>
}

type MondayResponse = {
  boards: Array<{
    items_page: {
      cursor: string | null
      items: MondayItem[]
    }
  }>
}

type MondayCursorResponse = {
  next_items_page: {
    cursor: string | null
    items: MondayItem[]
  }
}

// ── Column-value extraction helpers ──────────────────────────────────────────
function colText(item: MondayItem, columnId: string): string | null {
  const v = item.column_values.find(c => c.id === columnId)
  if (!v) return null
  const t = (v.text ?? '').trim()
  return t || null
}

function colNumber(item: MondayItem, columnId: string): number | null {
  const t = colText(item, columnId)
  if (!t) return null
  const n = parseFloat(t.replace(/[$,\s%]/g, ''))
  return isNaN(n) ? null : n
}

function colDate(item: MondayItem, columnId: string): string | null {
  const t = colText(item, columnId)
  if (!t) return null
  // Monday returns dates as "2025-05-01" — perfect ISO date string
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null
}

function colBool(item: MondayItem, columnId: string): boolean {
  const v = item.column_values.find(c => c.id === columnId)
  if (!v?.value) return false
  try {
    const parsed = JSON.parse(v.value) as { checked?: boolean }
    return parsed.checked === true
  } catch { return false }
}

// People columns: text is comma-separated names
function colPeople(item: MondayItem, columnId: string): string | null {
  return colText(item, columnId)
}

// ── LO normalization (matches webhook + GHL sync) ────────────────────────────
const LO_MAP: Record<string, string> = {
  'moe sefati': 'Moe Sefati', 'sefati': 'Moe Sefati', 'moe': 'Moe Sefati',
  'matthew park': 'Matt Park', 'matthew': 'Matt Park', 'matt park': 'Matt Park',
  'matt': 'Matt Park', 'park': 'Matt Park',
}
function resolveLO(raw: string | null): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase().trim()
  for (const [key, value] of Object.entries(LO_MAP)) {
    if (lower.includes(key)) return value
  }
  return raw.trim() || null
}

// ── Funded override (mirrors GHL sync) ───────────────────────────────────────
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
function applyFundedRule(s: { status: string; pipeline_group: string }) {
  return FUNDED_STATUSES.has(s.status) ? { ...s, pipeline_group: 'Funded' } : s
}

// ── Group → pipeline_group fallback (when status doesn't map) ────────────────
function groupToPipeline(groupTitle: string | undefined): { status: string; pipeline_group: string } | null {
  if (!groupTitle) return null
  const lower = groupTitle.toLowerCase()
  // Closed/funded groups (Apr 2026 Fundings, Oct 2025, etc.)
  if (lower.includes('funding') || lower.includes('closing') || lower === 'closed' || lower.includes('closings')) {
    return { status: 'Loan Finalized', pipeline_group: 'Funded' }
  }
  if (lower.includes('lost') || lower.includes('inactive') || lower.includes('does not qualify')) {
    return { status: 'Lost to Competitor', pipeline_group: 'Not Ready' }
  }
  if (lower.includes('nurture')) return { status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready' }
  if (lower === 'leads') return { status: 'New Lead', pipeline_group: 'Leads' }
  if (lower.includes('escrow') || lower === 'signing scheduled') {
    return { status: 'Loan Setup', pipeline_group: 'Loans in Process' }
  }
  return null
}

// ── Resolve final status + pipeline_group for a deal ─────────────────────────
function resolveStage(item: MondayItem): { status: string; pipeline_group: string } | null {
  const mondayStatus = colText(item, 'status')
  if (mondayStatus && MONDAY_STATUS_MAP[mondayStatus]) {
    return applyFundedRule(MONDAY_STATUS_MAP[mondayStatus])
  }
  return groupToPipeline(item.group?.title)
}

// ── Build patch object — only set fields that have a value ───────────────────
function buildPatch(item: MondayItem) {
  const stage = resolveStage(item)
  const firstNameRaw = colText(item, 'text_mm1km5r4')
  const lastNameRaw  = colText(item, 'text_mm1kacfe')
  const fullNameRaw  = item.name?.trim() || `${firstNameRaw ?? ''} ${lastNameRaw ?? ''}`.trim() || 'Unknown'

  // Title-case names so display is consistent
  const firstName = titleCase(firstNameRaw)
  const lastName  = titleCase(lastNameRaw)
  const fullName  = titleCase(fullNameRaw) || fullNameRaw

  const loRaw = colPeople(item, 'multiple_person_mkv9gpqz')
  const processorRaw = colPeople(item, 'multiple_person_mkv9vagy')

  return {
    name:              fullName,
    first_name:        firstName,
    last_name:         lastName,
    email:             colText(item, 'email_mm15p921'),
    phone:             colText(item, 'text_mm1dcz94'),
    status:            stage?.status,
    pipeline_group:    stage?.pipeline_group,
    loan_officer:      resolveLO(loRaw),
    processor:         processorRaw,
    processor_status:  colText(item, 'color_mm1cqgez'),
    loan_type:         normalizeLoanType(colText(item, 'dropdown_mkv9a9g4')),
    loan_amount:       colNumber(item, 'numeric_mm1kmsbx'),
    estimated_value:   colNumber(item, 'numeric_mm16rfwm'),
    rate:              colNumber(item, 'numeric_mkvm7mdd'),
    investor:          colText(item, 'text_mkv8mpmm'),
    property_address:  colText(item, 'text_mkv8qgnx'),
    occupancy:         OCCUPANCY_MAP[colText(item, 'color_mkv9ex8d') ?? ''] ?? colText(item, 'color_mkv9ex8d'),
    locked:            colText(item, 'color_mm274njy'),
    lock_expiration:   colDate(item, 'date_mkxbdm9v'),
    appraisal_status:  colText(item, 'color_mm1ypeft'),
    source:            colText(item, 'color_mm1cgrf2'),
    broker_corr:       colText(item, 'color_mm2y1mk8'),
    lead_source_agg:   colText(item, 'color_mm2vynx6'),
    arive_file_no:     colText(item, 'text_mkx48pzj'),
    investor_file_no:  colText(item, 'text_mkx435xw'),
    lo_notes:          colText(item, 'text_mm0rc1ks'),
    client_notes:      colText(item, 'text_mm15z2eg'),
    subbed:            colBool(item, 'boolean_mm0nads8'),
    signing_date:      colDate(item, 'date_mm21xwkt'),
    paid_date:         colDate(item, 'date_mm217ap0'),
    funded_date:       colDate(item, 'date_mm29bcv3'),
    last_contacted:    colDate(item, 'date_mm2xcm9r'),
    ghl_contact_id:    colText(item, 'text_mm2xnmp9'),
    document_upload_link: colText(item, 'link_mm15vyds'),
  } as Record<string, unknown>
}

// ── Match strategies: find existing deal in dashboard ────────────────────────
type DealRow = {
  id: string
  name: string
  email: string | null
  phone: string | null
  ghl_contact_id: string | null
}

function matchDeal(item: MondayItem, patch: Record<string, unknown>, allDeals: DealRow[]): DealRow | null {
  // 1. Match by ghl_contact_id (strongest)
  const ghlId = patch.ghl_contact_id as string | null
  if (ghlId) {
    const m = allDeals.find(d => d.ghl_contact_id === ghlId)
    if (m) return m
  }
  // 2. Match by email (case-insensitive)
  const email = (patch.email as string | null)?.toLowerCase().trim()
  if (email) {
    const m = allDeals.find(d => d.email?.toLowerCase().trim() === email)
    if (m) return m
  }
  // 3. Match by name (case-insensitive)
  const itemName = item.name.toLowerCase().trim()
  const m = allDeals.find(d => d.name.toLowerCase().trim() === itemName)
  if (m) return m
  return null
}

// ── Main fetch loop with pagination ──────────────────────────────────────────
async function fetchAllMondayItems(): Promise<MondayItem[]> {
  const all: MondayItem[] = []
  const firstPageQuery = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          cursor
          items {
            id
            name
            group { title }
            column_values { id text value }
          }
        }
      }
    }
  `
  const first = await mondayQuery<MondayResponse>(firstPageQuery, { boardId: DEALS_BOARD_ID.toString() })
  all.push(...first.boards[0].items_page.items)
  let cursor = first.boards[0].items_page.cursor

  const cursorQuery = `
    query ($cursor: String!) {
      next_items_page(cursor: $cursor, limit: 100) {
        cursor
        items {
          id
          name
          group { title }
          column_values { id text value }
        }
      }
    }
  `
  for (let i = 0; cursor && i < 50; i++) {
    const next = await mondayQuery<MondayCursorResponse>(cursorQuery, { cursor })
    all.push(...next.next_items_page.items)
    cursor = next.next_items_page.cursor
  }
  return all
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { mode?: 'fill_blanks' | 'overwrite' }
    const mode = body.mode === 'overwrite' ? 'overwrite' : 'fill_blanks'

    const items = await fetchAllMondayItems()
    console.log(`[Monday Sync] Fetched ${items.length} items`)

    const supabase = createServiceClient()
    const { data: existing } = await supabase
      .from('deals')
      .select('id, name, email, phone, ghl_contact_id')
    const allDeals: DealRow[] = (existing as DealRow[]) || []

    let updated = 0, created = 0, fieldsFilled = 0
    const unmatched: string[] = []

    for (const item of items) {
      try {
        const patch = buildPatch(item)
        const match = matchDeal(item, patch, allDeals)

        // Strip null/undefined values — never overwrite with blanks
        const cleaned = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== null && v !== undefined && v !== '')
        )

        if (match) {
          if (mode === 'fill_blanks') {
            // Only update fields that are currently blank in the dashboard
            const { data: current } = await supabase
              .from('deals').select('*').eq('id', match.id).single()
            if (!current) continue
            const fillPatch: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(cleaned)) {
              if (current[k as keyof typeof current] == null || current[k as keyof typeof current] === '') {
                fillPatch[k] = v
                fieldsFilled++
              }
            }
            if (Object.keys(fillPatch).length > 0) {
              await supabase.from('deals').update(fillPatch).eq('id', match.id)
              updated++
            }
          } else {
            // Overwrite mode: replace any field Monday has a value for
            await supabase.from('deals').update(cleaned).eq('id', match.id)
            fieldsFilled += Object.keys(cleaned).length
            updated++
          }
        } else {
          // No match — create a new deal so nothing is lost
          await supabase.from('deals').insert({
            name: item.name,
            status: cleaned.status ?? 'New Lead',
            pipeline_group: cleaned.pipeline_group ?? 'Leads',
            ...cleaned,
          })
          created++
          unmatched.push(item.name)
        }
      } catch (err) {
        console.error('[Monday Sync] Item error:', item.id, err)
      }
    }

    console.log(`[Monday Sync] Done — updated=${updated} created=${created} fields_filled=${fieldsFilled}`)
    return NextResponse.json({
      success: true,
      mode,
      total_monday_items: items.length,
      updated,
      created,
      fields_filled: fieldsFilled,
      unmatched_created_count: unmatched.length,
      unmatched_sample: unmatched.slice(0, 10),
    })
  } catch (err) {
    console.error('[Monday Sync] Fatal:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'POST to trigger Monday → Dashboard sync. Body: { mode: "fill_blanks" | "overwrite" } (default: fill_blanks)',
    configured: !!process.env.MONDAY_API_KEY,
  })
}
