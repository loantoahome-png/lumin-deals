import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Shared team Tools list. Stored in sync_state (key/value jsonb) — same pattern as
// /api/radar/par-rates — so the whole team sees and edits ONE list, no schema change.
// Tools were previously per-browser (localStorage); this makes them team-wide.

const KEY = 'tools_list'

type Tool = { id: string; name: string; url: string; category: string; description?: string }

/** Keep only well-formed tools; coerce/trim fields; cap the list. */
function sanitize(input: unknown): Tool[] | null {
  if (!Array.isArray(input)) return null
  const out: Tool[] = []
  for (const raw of input.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!name || !url) continue
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `t_${Date.now()}_${out.length}`,
      name,
      url,
      category: typeof r.category === 'string' && r.category ? r.category : 'Other',
      description: typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined,
    })
  }
  return out
}

export async function GET() {
  const sb = createServiceClient()
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  // null tools = not yet published to the team (client falls back to its local list).
  const tools = Array.isArray(data?.value) ? (data!.value as Tool[]) : null
  return NextResponse.json({ ok: true, tools })
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { tools?: unknown }
    const tools = sanitize(body.tools)
    if (!tools) return NextResponse.json({ ok: false, error: 'tools must be an array' }, { status: 400 })
    const sb = createServiceClient()
    const { error } = await sb.from('sync_state').upsert(
      { key: KEY, value: tools, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, tools })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
