import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// The shared Work List document — a plain, everyone-can-edit page that replaced
// the "Tasklist for Bri and Efrain" Google Doc verbatim (Efrain 2026-08-10:
// "maybe we can just make a word page so I can copy and paste what she has
// already"). No structure, no derived rows: whatever they type is the truth.
//
// Stored in sync_state (key/value jsonb), same pattern as /api/tools and
// /api/lenders, so all three see ONE document with no schema change.
//
// ⚠️ Stored as HTML because the original doc leans on formatting — the Alamo
//    rule is red, and that emphasis is the thing that stops it being forgotten.
//    This route is a dumb store: it caps length and type-checks, nothing more.
//    Sanitizing happens on READ (DOMPurify), the same path the deal notes
//    editor uses; storing raw means a future sanitizer upgrade applies
//    retroactively instead of being baked into old rows.

const KEY = 'worklist_notes'
const MAX_LEN = 2_000_000   // a long pasted doc with inline images is not small

type Stored = { html: string; updated_at: string; updated_by: string | null }

function read(value: unknown): Stored {
  const v = (value ?? {}) as Record<string, unknown>
  return {
    html: typeof v.html === 'string' ? v.html : '',
    updated_at: typeof v.updated_at === 'string' ? v.updated_at : '',
    updated_by: typeof v.updated_by === 'string' ? v.updated_by : null,
  }
}

export async function GET() {
  const sb = createServiceClient()
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  const s = read(data?.value)
  return NextResponse.json({ ok: true, html: s.html, updated_at: s.updated_at || null, updated_by: s.updated_by })
}

export async function PUT(req: Request) {
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Bad JSON' }, { status: 400 }) }

  const b = body as Record<string, unknown>
  if (typeof b?.html !== 'string') {
    return NextResponse.json({ ok: false, error: 'html must be a string' }, { status: 400 })
  }
  if (b.html.length > MAX_LEN) {
    return NextResponse.json({ ok: false, error: 'Document too large' }, { status: 400 })
  }

  const sb = createServiceClient()

  // ⚠️ Conflict guard. Three people share this document, and a plain upsert is
  //    last-write-wins: whoever saves second silently erases the other's edits,
  //    with no trace that it happened. The client sends the `updated_at` it
  //    loaded; if the stored one has moved on, refuse and let it say so.
  //    `base_updated_at: null` means "I loaded an empty doc".
  if ('base_updated_at' in b) {
    const { data: cur } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
    const stored = read(cur?.value)
    const base = typeof b.base_updated_at === 'string' ? b.base_updated_at : ''
    if ((stored.updated_at || '') !== base) {
      return NextResponse.json({
        ok: false,
        conflict: true,
        error: 'Someone else saved changes while you were editing.',
        updated_at: stored.updated_at || null,
        updated_by: stored.updated_by,
        html: stored.html,
      }, { status: 409 })
    }
  }

  const value: Stored = {
    html: b.html,
    updated_at: new Date().toISOString(),
    updated_by: typeof b.updated_by === 'string' ? b.updated_by.slice(0, 120) : null,
  }

  const { error } = await sb.from('sync_state').upsert({ key: KEY, value }, { onConflict: 'key' })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ...value })
}
