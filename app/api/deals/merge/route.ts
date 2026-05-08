import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// ── Merge a set of duplicate deals into one primary ──────────────────────────
// Body: { primaryId: string, secondaryIds: string[], overrides?: Record<string, unknown> }
//
// Strategy:
//  - Start with primary's current row
//  - For each field, if primary's value is null/blank, take the first non-null
//    value from any of the secondaries (sorted by updated_at desc)
//  - For lo_notes / client_notes / ghl_tags: concatenate unique values
//  - Apply explicit `overrides` last (lets the UI pick a specific side per field)
//  - Update primary, then delete secondaries

const MERGEABLE_FIELDS = [
  'first_name','last_name','email','phone',
  'loan_officer','processor','processor_status',
  'loan_type','loan_amount','estimated_value','rate',
  'investor','property_address','occupancy','city','state','zip',
  'credit_score','credit_rating',
  'locked','lock_expiration','appraisal_status',
  'source','broker_corr','lead_source_agg',
  'arive_file_no','investor_file_no','loan_purpose','property_type',
  'current_balance','ltv','cash_out','down_payment',
  'is_military','current_va_loan','property_found','loan_timeframe','has_accepted_offer',
  'rate_watch_target','rate_at_close_10yr','rate_watch_notes',
  'signing_date','paid_date','funded_date','last_contacted',
  'ghl_contact_id','ghl_assigned_user','date_added_ghl',
  'document_upload_link',
] as const

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')
}

function mergeNotes(primary: string | null, secondaries: (string | null)[]): string | null {
  const parts: string[] = []
  if (primary && primary.trim()) parts.push(primary.trim())
  for (const s of secondaries) {
    if (!s || !s.trim()) continue
    if (parts.includes(s.trim())) continue
    parts.push(s.trim())
  }
  return parts.length > 0 ? parts.join('\n\n— merged —\n\n') : null
}

function mergeTags(values: (string | null)[]): string | null {
  const allTags = new Set<string>()
  for (const v of values) {
    if (!v) continue
    for (const tag of v.split(',').map(s => s.trim()).filter(Boolean)) {
      allTags.add(tag)
    }
  }
  return allTags.size > 0 ? Array.from(allTags).join(', ') : null
}

type DealRow = Record<string, unknown> & { id: string; updated_at?: string | null }

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      primaryId: string
      secondaryIds: string[]
      overrides?: Record<string, unknown>
    }

    if (!body.primaryId || !Array.isArray(body.secondaryIds) || body.secondaryIds.length === 0) {
      return NextResponse.json({ error: 'primaryId and at least one secondaryId required' }, { status: 400 })
    }
    if (body.secondaryIds.includes(body.primaryId)) {
      return NextResponse.json({ error: 'primaryId cannot also be in secondaryIds' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Fetch primary + all secondaries
    const allIds = [body.primaryId, ...body.secondaryIds]
    const { data: rows, error: fetchErr } = await supabase
      .from('deals').select('*').in('id', allIds)
    if (fetchErr || !rows || rows.length === 0) {
      return NextResponse.json({ error: 'Failed to fetch deals: ' + (fetchErr?.message ?? 'not found') }, { status: 500 })
    }

    const primary = (rows as DealRow[]).find(r => r.id === body.primaryId)
    if (!primary) {
      return NextResponse.json({ error: 'Primary deal not found' }, { status: 404 })
    }
    const secondaries = (rows as DealRow[])
      .filter(r => r.id !== body.primaryId)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))

    // Build merged patch
    const patch: Record<string, unknown> = {}

    for (const field of MERGEABLE_FIELDS) {
      if (!isBlank(primary[field])) continue // primary wins when populated
      for (const s of secondaries) {
        if (!isBlank(s[field])) {
          patch[field] = s[field]
          break
        }
      }
    }

    // Notes: concatenate
    const loNotes = mergeNotes(
      primary.lo_notes as string | null,
      secondaries.map(s => s.lo_notes as string | null),
    )
    if (loNotes !== primary.lo_notes) patch.lo_notes = loNotes

    const clientNotes = mergeNotes(
      primary.client_notes as string | null,
      secondaries.map(s => s.client_notes as string | null),
    )
    if (clientNotes !== primary.client_notes) patch.client_notes = clientNotes

    // Tags: union
    const tags = mergeTags([
      primary.ghl_tags as string | null,
      ...secondaries.map(s => s.ghl_tags as string | null),
    ])
    if (tags !== primary.ghl_tags) patch.ghl_tags = tags

    // Apply explicit overrides last (the UI may want to take a specific value from a secondary)
    if (body.overrides) {
      for (const [k, v] of Object.entries(body.overrides)) {
        patch[k] = v
      }
    }

    // Update primary
    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await supabase
        .from('deals').update(patch).eq('id', body.primaryId)
      if (updErr) {
        return NextResponse.json({ error: 'Update failed: ' + updErr.message }, { status: 500 })
      }
    }

    // Delete secondaries
    const { error: delErr } = await supabase
      .from('deals').delete().in('id', body.secondaryIds)
    if (delErr) {
      return NextResponse.json({ error: 'Delete failed: ' + delErr.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      primaryId: body.primaryId,
      mergedFromCount: body.secondaryIds.length,
      fieldsUpdated: Object.keys(patch),
    })
  } catch (err) {
    console.error('[merge] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
