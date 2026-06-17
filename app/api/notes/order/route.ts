import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Manual note order for /notes. Stored in sync_state (key/value jsonb) — same
// pattern as /api/radar/par-rates — so the arrangement is shared across the team
// with no schema change to dashboard_notes.

const KEY = 'notes_order'
type SB = ReturnType<typeof createServiceClient>

async function readOrder(sb: SB): Promise<string[]> {
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  const ids = (data?.value as { ids?: unknown } | null)?.ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

export async function GET() {
  const sb = createServiceClient()
  return NextResponse.json({ ok: true, ids: await readOrder(sb) })
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : null
    if (!ids) return NextResponse.json({ ok: false, error: 'ids array required' }, { status: 400 })
    const sb = createServiceClient()
    const { error } = await sb.from('sync_state').upsert(
      { key: KEY, value: { ids }, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
