import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Persist "these are NOT duplicates" decisions so a reviewed group stops showing
// on /duplicates. Keyed by the group's signature = its sorted deal-id set. If the
// same set of deals reappears it stays hidden; if a new deal joins the group the
// signature changes and it resurfaces for review (correct — the new member is
// unreviewed). Stored in sync_state (key/value jsonb) to avoid a schema change.

const KEY = 'dedupe_dismissed'
type Stored = { signatures?: string[] }
type SB = ReturnType<typeof createServiceClient>

async function readSignatures(sb: SB): Promise<string[]> {
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  const v = (data?.value as Stored | null) ?? null
  return Array.isArray(v?.signatures) ? v!.signatures! : []
}

export async function GET() {
  const sb = createServiceClient()
  return NextResponse.json({ ok: true, signatures: await readSignatures(sb) })
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { dealIds?: string[]; signature?: string; undo?: boolean }
    const sig = body.signature
      ?? (Array.isArray(body.dealIds) && body.dealIds.length >= 2 ? [...body.dealIds].sort().join('|') : null)
    if (!sig) {
      return NextResponse.json({ ok: false, error: 'dealIds (>=2) or signature required' }, { status: 400 })
    }
    const sb = createServiceClient()
    const current = await readSignatures(sb)
    const next = body.undo
      ? current.filter(s => s !== sig)
      : (current.includes(sig) ? current : [...current, sig])
    const { error } = await sb.from('sync_state').upsert(
      { key: KEY, value: { signatures: next }, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, signature: sig, dismissed: !body.undo })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
