import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Returns { opportunity_id: firstRespondedISO } — the EARLIEST logged crossing into
// a responded stage per opportunity. Feeds the Lead Cohort report's window timing.
//
// Uses the precomputed `to_responded` flag (set at write time with the same
// isRespondedStatus definition the report uses), so this is just "min(event_at)
// per opportunity where to_responded". Reads via the service client to bypass RLS.
//
// Forward-only: if the migration hasn't run yet the table won't exist — we return
// an empty map (not a 500) so the report still renders with as-of-today totals.

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServiceClient()
  const firstResponded: Record<string, string> = {}

  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('stage_events')
      .select('opportunity_id, event_at')
      .eq('to_responded', true)
      .order('event_at', { ascending: true }) // earliest first → first write per opp wins
      .range(offset, offset + PAGE - 1)

    if (error) {
      // Most likely the table doesn't exist yet (pre-migration). Degrade gracefully.
      console.warn('[first-responded] read failed (returning empty map):', error.message)
      return NextResponse.json({ ok: true, firstResponded: {}, coverage: 0, note: error.message })
    }

    const rows = (data ?? []) as { opportunity_id: string | null; event_at: string }[]
    for (const r of rows) {
      const opp = r.opportunity_id
      if (opp && !(opp in firstResponded)) firstResponded[opp] = r.event_at
    }
    if (rows.length < PAGE) break
    offset += PAGE
  }

  return NextResponse.json({ ok: true, firstResponded, coverage: Object.keys(firstResponded).length })
}
