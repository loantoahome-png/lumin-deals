import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { resolveApiKey } from '@/lib/ghl'
import { fetchFirstInbound } from '@/lib/ghlConversations'
import { isRespondedStatus } from '@/lib/leadReport'

// Backfill "first responded" timing from GHL conversation history, so the Lead
// Cohort report's 7/14-day windows work for cohorts created BEFORE the live
// stage-event log existed. For each in-scope deal we find the earliest INBOUND
// message/call and upsert a stage_events row (source='backfill_comm'); the
// first-responded reader then takes MIN(event_at) across live + backfilled rows.
//
// TRIGGER (must be logged in — middleware-gated):
//   GET /api/stage-events/backfill?from=2026-06-01&to=2026-07-08&run=1
//   Omit run=1 for a DRY RUN (counts only, no writes). Scope with from/to
//   (date_added_ghl) and re-run for wider ranges — it's idempotent per opp.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONCURRENCY = 5
const DEFAULT_LIMIT = 250

type DealRow = {
  id: string
  ghl_contact_id: string | null
  ghl_location_id: string | null
  ghl_opportunity_id: string | null
  loan_officer: string | null
  status: string | null
  date_added_ghl: string | null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const run = url.searchParams.get('run') === '1'
  const includeAll = url.searchParams.get('all') === '1'   // include unpriced/organic leads too
  const limit = Math.min(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1000)

  const supabase = createServiceClient()

  // Scope: deals with the GHL identifiers we need, optionally within a created-date range.
  // Aggregator (priced) leads only by default — matches what /lead-cohorts tracks; pass
  // ?all=1 to backfill organic leads too.
  let q = supabase
    .from('deals')
    .select('id, ghl_contact_id, ghl_location_id, ghl_opportunity_id, loan_officer, status, date_added_ghl')
    .not('ghl_contact_id', 'is', null)
    .not('ghl_location_id', 'is', null)
    .not('ghl_opportunity_id', 'is', null)
    .order('date_added_ghl', { ascending: false })
    .limit(limit)
  if (!includeAll) q = q.gt('lead_price', 0)
  if (from) q = q.gte('date_added_ghl', `${from}T00:00:00Z`)
  if (to) q = q.lte('date_added_ghl', `${to}T23:59:59.999Z`)

  const { data, error } = await q
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 })
  const deals = (data ?? []) as DealRow[]

  const summary = {
    ok: true, run, scope: { from, to, limit }, scanned: deals.length,
    withInbound: 0, written: 0, noConversation: 0, noApiKey: 0, errors: 0,
    respondedButNoInbound: 0,     // responded-by-stage but no inbound (the answered-outbound-call gap; kept inbound-only by decision 2026-07-08)
    samples: [] as Array<{ opp: string; at: string; channel: string }>,
  }

  // Simple concurrency pool.
  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= deals.length) return
      const d = deals[i]
      const apiKey = resolveApiKey(d.ghl_location_id)
      if (!apiKey) { summary.noApiKey++; continue }
      try {
        const first = await fetchFirstInbound(d.ghl_location_id!, d.ghl_contact_id!, apiKey)
        if (!first) {
          summary.noConversation++
          if (isRespondedStatus(d.status)) summary.respondedButNoInbound++
          continue
        }
        summary.withInbound++
        if (summary.samples.length < 8) summary.samples.push({ opp: d.ghl_opportunity_id!, at: first.at, channel: first.channel })

        if (run) {
          // Idempotent: one backfill row per opportunity.
          await supabase.from('stage_events').delete()
            .eq('opportunity_id', d.ghl_opportunity_id!).eq('source', 'backfill_comm')
          const { error: insErr } = await supabase.from('stage_events').insert({
            opportunity_id: d.ghl_opportunity_id,
            contact_id: d.ghl_contact_id,
            deal_id: d.id,
            from_status: null,
            to_status: `(inbound ${first.channel})`,
            to_pipeline_group: null,
            to_responded: true,
            loan_officer: d.loan_officer,
            event_at: first.at,
            source: 'backfill_comm',
          })
          if (insErr) { summary.errors++; console.error('[backfill] insert failed:', insErr.message) }
          else summary.written++
        }
      } catch (err) {
        summary.errors++
        console.error('[backfill] deal', d.id, 'failed:', err)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  return NextResponse.json(summary)
}
