import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// The pinned notes block at the top of /worklist — the "Training Notes for
// Ordering Title" from the Google Doc this page replaced. Stored in sync_state
// (key/value jsonb), same pattern as /api/tools and /api/lenders, so all three
// of them see and edit ONE block with no schema change.
//
// ⚠️ Stored as HTML because the original notes use colour for emphasis (the
//    Alamo rule is red in the doc, and that emphasis is load-bearing — it's the
//    thing that gets forgotten). The client sanitizes on READ with DOMPurify,
//    the same path the deal notes editor already uses. This route is a dumb
//    store: it caps length and rejects non-strings, nothing more.

const KEY = 'worklist_notes'
const MAX_LEN = 200_000

export async function GET() {
  const sb = createServiceClient()
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  const v = data?.value as { html?: unknown; updated_at?: unknown; updated_by?: unknown } | null
  return NextResponse.json({
    ok: true,
    html: typeof v?.html === 'string' ? v.html : null,
    updated_at: typeof v?.updated_at === 'string' ? v.updated_at : null,
    updated_by: typeof v?.updated_by === 'string' ? v.updated_by : null,
  })
}

export async function PUT(req: Request) {
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad JSON' }, { status: 400 }) }

  const b = body as Record<string, unknown>
  if (typeof b?.html !== 'string') {
    return NextResponse.json({ ok: false, error: 'html must be a string' }, { status: 400 })
  }
  if (b.html.length > MAX_LEN) {
    return NextResponse.json({ ok: false, error: 'Too long' }, { status: 400 })
  }

  const value = {
    html: b.html,
    updated_at: new Date().toISOString(),
    updated_by: typeof b.updated_by === 'string' ? b.updated_by.slice(0, 120) : null,
  }

  const sb = createServiceClient()
  const { error } = await sb.from('sync_state').upsert(
    { key: KEY, value },
    { onConflict: 'key' },
  )
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ...value })
}
