import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Shared, editable Lender List. Stored in sync_state (key/value jsonb) — same
// pattern as /api/tools — so the whole team sees and edits ONE list, no schema
// change. The static lib/lenders.ts is the SEED; once the team publishes an edit
// here, this DB copy is authoritative (the page reads it in preference to the seed).

const KEY = 'lenders_list'

type LenderRow = {
  id: string
  category: string
  categoryLabel: string
  lender: string
  inArive: string
  contact: string
  phone: string
  email: string
  products: string[]
  minFico: string
  comp: string
  notes: string
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Keep only well-formed lenders; coerce/trim fields; cap the list. */
function sanitize(input: unknown): LenderRow[] | null {
  if (!Array.isArray(input)) return null
  const out: LenderRow[] = []
  for (const raw of input.slice(0, 1000)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const lender = s(r.lender)
    if (!lender) continue // a lender name is the one required field
    out.push({
      id: s(r.id) || `l_${Date.now()}_${out.length}`,
      category: s(r.category) || 'Agency/Jumbo',
      categoryLabel: s(r.categoryLabel) || s(r.category) || 'Agency / Jumbo',
      lender,
      inArive: s(r.inArive),
      contact: s(r.contact),
      phone: s(r.phone),
      email: s(r.email),
      products: Array.isArray(r.products)
        ? r.products.filter(p => typeof p === 'string').map(p => (p as string).trim()).filter(Boolean).slice(0, 12)
        : [],
      minFico: s(r.minFico),
      comp: s(r.comp),
      notes: s(r.notes),
    })
  }
  return out
}

export async function GET() {
  const sb = createServiceClient()
  const { data } = await sb.from('sync_state').select('value').eq('key', KEY).maybeSingle()
  // null = not yet published; the client falls back to the static seed (lib/lenders.ts).
  const lenders = Array.isArray(data?.value) ? (data!.value as LenderRow[]) : null
  return NextResponse.json({ ok: true, lenders })
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { lenders?: unknown }
    const lenders = sanitize(body.lenders)
    if (!lenders) return NextResponse.json({ ok: false, error: 'lenders must be an array' }, { status: 400 })
    const sb = createServiceClient()
    const { error } = await sb.from('sync_state').upsert(
      { key: KEY, value: lenders, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, lenders })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
