import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Marketing spend per lead source (cost_per_month). Used by /lead-roi to
// compute cost-per-funded-loan and rough ROI per source over any date range.

type CostRow = {
  source: string
  cost_per_month: number
  notes: string | null
  updated_at: string
}

export async function GET() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('lead_source_costs')
    .select('*')
    .order('source', { ascending: true })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, costs: (data ?? []) as CostRow[] })
}

export async function PUT(req: NextRequest) {
  let body: { source?: string; cost_per_month?: number; notes?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }
  if (!body.source || typeof body.source !== 'string') {
    return NextResponse.json({ ok: false, error: 'missing_source' }, { status: 400 })
  }
  const cost = Number(body.cost_per_month ?? 0)
  if (!Number.isFinite(cost) || cost < 0) {
    return NextResponse.json({ ok: false, error: 'invalid_cost' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase.from('lead_source_costs').upsert({
    source:         body.source,
    cost_per_month: cost,
    notes:          body.notes ?? null,
    updated_at:     new Date().toISOString(),
  })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url)
  const source = url.searchParams.get('source')
  if (!source) return NextResponse.json({ ok: false, error: 'missing_source' }, { status: 400 })
  const supabase = createServiceClient()
  const { error } = await supabase.from('lead_source_costs').delete().eq('source', source)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
