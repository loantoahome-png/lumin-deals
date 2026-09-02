import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Read side of the Arive import log (see supabase-import-log.sql).
//
//   GET /api/import/arive/history            → { ok, runs }            latest 50 runs
//   GET /api/import/arive/history?run=<id>   → { ok, run, changes }    one run, every field written
//   GET /api/import/arive/history?deal=<id>  → { ok, changes }         every import that touched one deal
//
// Service role only — the tables are RLS-on with no policies.

const PAGE = 1000

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  const runId = req.nextUrl.searchParams.get('run')
  const dealId = req.nextUrl.searchParams.get('deal')

  if (runId) {
    const { data: run, error } = await supabase.from('import_runs').select('*').eq('id', runId).single()
    if (error || !run) return NextResponse.json({ ok: false, error: error?.message ?? 'not_found' }, { status: 404 })
    const changes: unknown[] = []
    for (let off = 0; ; off += PAGE) {
      const { data, error: e } = await supabase
        .from('import_changes')
        .select('*')
        .eq('run_id', runId)
        .order('borrower', { ascending: true })
        .order('id', { ascending: true })
        .range(off, off + PAGE - 1)
      if (e) return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
      changes.push(...(data ?? []))
      if ((data ?? []).length < PAGE) break
    }
    return NextResponse.json({ ok: true, run, changes })
  }

  if (dealId) {
    const { data, error } = await supabase
      .from('import_changes')
      .select('*, import_runs(created_at, filename, mode)')
      .eq('deal_id', dealId)
      .order('id', { ascending: false })
      .limit(500)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, changes: data ?? [] })
  }

  const { data, error } = await supabase
    .from('import_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, runs: data ?? [] })
}
