import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { DEFAULT_PAR, ParRates } from '@/lib/refiRadar'

// Per-product par rates for the Refi Radar. There is no live rate in the DB, so the
// user sets these and the radar scores against them. Stored in sync_state (key/value
// jsonb) — same pattern as /api/duplicates/dismiss — so it's shared across the team
// with no schema change.

const KEY = 'refi_par_rates'
type SB = ReturnType<typeof createServiceClient>

async function readPar(sb: SB): Promise<ParRates> {
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  const v = (data?.value as Partial<ParRates> | null) ?? null
  return { ...DEFAULT_PAR, ...(v ?? {}) }
}

export async function GET() {
  const sb = createServiceClient()
  return NextResponse.json({ ok: true, par: await readPar(sb) })
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as Partial<ParRates>
    const sb = createServiceClient()
    const current = await readPar(sb)
    // Only accept sane positive numbers; ignore anything else.
    const next: ParRates = { ...current }
    for (const k of ['conv', 'fha', 'va', 'nonqm'] as const) {
      const n = body[k]
      if (typeof n === 'number' && n > 0 && n < 25) next[k] = n
    }
    const { error } = await sb.from('sync_state').upsert(
      { key: KEY, value: next, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, par: next })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
