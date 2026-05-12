import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// ── Cleanup tool: find/delete Monday-only imports ───────────────────────────
//
// Fingerprint of a Monday-only deal:
//   - raw_ghl_data IS NULL    (never synced from GHL)
//   - ghl_contact_id IS NULL  (no GHL link)
//   - created_at >= now() - 30 days  (within the Monday sync window)
//
// GET  → returns preview { count, deals: [...] }
// POST → deletes them. Body: { confirm: true, ids?: string[] }
//        - If `ids` is provided, only those (matching the fingerprint) are deleted
//        - Otherwise all matching deals are deleted

const CUTOFF_DAYS = 30

function getCutoffISO() {
  return new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

async function findCandidates() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('deals')
    .select('id, name, status, pipeline_group, loan_officer, loan_amount, source, created_at')
    .is('raw_ghl_data', null)
    .is('ghl_contact_id', null)
    .gte('created_at', getCutoffISO())
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function GET() {
  try {
    const deals = await findCandidates()
    return NextResponse.json({
      cutoff_days: CUTOFF_DAYS,
      count: deals.length,
      deals,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { confirm?: boolean; ids?: string[] }
    if (body.confirm !== true) {
      return NextResponse.json({ error: 'Confirmation required: send { confirm: true }' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const candidates = await findCandidates()
    if (candidates.length === 0) {
      return NextResponse.json({ success: true, deleted: 0, message: 'Nothing to delete' })
    }

    // If specific ids passed, only delete those (and only if they match the fingerprint — safety)
    let idsToDelete = candidates.map(d => d.id)
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const wanted = new Set(body.ids)
      idsToDelete = idsToDelete.filter(id => wanted.has(id))
    }

    if (idsToDelete.length === 0) {
      return NextResponse.json({ success: true, deleted: 0, message: 'No matching ids' })
    }

    const { error } = await supabase.from('deals').delete().in('id', idsToDelete)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, deleted: idsToDelete.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
