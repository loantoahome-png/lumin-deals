import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { OPTOUT_STATUSES } from '@/lib/leadReport'

// Returns { opportunity_id: firstOptoutISO } — the EARLIEST logged crossing into
// an opt-out status (STOP / DND - SMS / Remove from All Automations) per
// opportunity. Feeds /lead-roi's "opted out within 7 days of creation" stat.
//
// Mirror of ./first-responded. Forward-only: opt-outs that happened before the
// stage_events webhook went live have no event here, so the page reports timing
// coverage alongside the stat instead of pretending it's complete.

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServiceClient()
  const firstOptout: Record<string, string> = {}

  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('stage_events')
      .select('opportunity_id, event_at')
      .in('to_status', [...OPTOUT_STATUSES])
      .order('event_at', { ascending: true }) // earliest first → first write per opp wins
      .range(offset, offset + PAGE - 1)

    if (error) {
      // Most likely the table doesn't exist yet (pre-migration). Degrade gracefully.
      console.warn('[first-optout] read failed (returning empty map):', error.message)
      return NextResponse.json({ ok: true, firstOptout: {}, note: error.message })
    }

    const rows = (data ?? []) as { opportunity_id: string | null; event_at: string }[]
    for (const r of rows) {
      const opp = r.opportunity_id
      if (opp && !(opp in firstOptout)) firstOptout[opp] = r.event_at
    }
    if (rows.length < PAGE) break
    offset += PAGE
  }

  return NextResponse.json({ ok: true, firstOptout })
}
