import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { CallRow } from '@/lib/callsCsv'
import {
  effortRollup, dialerBreakdown, economicsRollup, coverageWindow, coveredLos, activityBuckets,
  unreachableRollup, type DealLite,
} from '@/lib/callsReport'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/calls — the /calls page's data.
 *
 * Rollups are computed HERE, not in the browser: the raw call log is a few
 * thousand rows and the page only ever renders aggregates. `calls` is RLS-ON
 * with no policies (server-only), so this route uses the service-role client —
 * the same posture as stage_events.
 */
export async function GET() {
  const supabase = createServiceClient()

  // Calls (paginate — a bare select caps at 1000)
  const calls: CallRow[] = []
  {
    const PAGE = 1000
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('calls')
        .select('call_ts, contact_phone, contact_name, direction, call_status, disposition, duration_sec, dialer_number_name, dialer_number_phone, first_time, account_label, source_file')
        .order('call_ts', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) {
        return NextResponse.json({ ok: false, error: `calls:${error.message}` }, { status: 500 })
      }
      const page = (data ?? []) as unknown as CallRow[]
      // Normalize to ISO so string comparisons against parsed rows are consistent.
      for (const c of page) calls.push({ ...c, call_ts: new Date(c.call_ts).toISOString() })
      if (page.length < PAGE) break
      offset += PAGE
    }
  }

  // Deals (paginate)
  const deals: DealLite[] = []
  {
    const PAGE = 1000
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('deals')
        .select('id, name, phone, loan_officer, source, lead_price, funded_date, date_added_ghl')
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) {
        return NextResponse.json({ ok: false, error: `deals:${error.message}` }, { status: 500 })
      }
      const page = (data ?? []) as unknown as DealLite[]
      deals.push(...page)
      if (page.length < PAGE) break
      offset += PAGE
    }
  }

  const window = coverageWindow(calls)
  // Activity is returned PRE-BUCKETED BY PT DAY rather than as raw calls, so the
  // page can sum any range — today, this week, a custom span — with no refetch,
  // while the payload stays ~100 rows instead of ~7,000.
  const buckets = activityBuckets(calls)

  return NextResponse.json({
    ok: true,
    totalCalls: calls.length,
    window,
    dataThrough: window?.end ?? null,
    covered: [...coveredLos(calls)],
    effort: effortRollup(calls, deals),
    dialers: dialerBreakdown(calls, deals),
    economics: economicsRollup(calls, deals),
    activity: buckets,
    // Numbers the carrier refuses. Full window, never date-filtered: a dead
    // number is dead regardless of which range the Activity tab is showing.
    unreachable: unreachableRollup(calls, deals),
  })
}
