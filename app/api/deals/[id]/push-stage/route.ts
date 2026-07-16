import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { pushOpportunityStage } from '@/lib/ghl'
import { logStageEvent } from '@/lib/stageEvents'

/**
 * Push a dashboard-side status change back to GHL.
 *
 * POST /api/deals/{id}/push-stage
 *   body: { status: "Appointment Booked" }
 *
 * Always returns a JSON result describing what happened. A 502 status is
 * used for actual GHL failures so the UI can surface them; a 200 is used
 * for intentional no-ops (deal not linked to GHL, etc.).
 *
 * ALSO logs the move to stage_events (source='dashboard'). See the note further
 * down — without this, dashboard-origin stage moves are invisible to the log.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: { status?: string; oppStatus?: 'open' | 'lost' } = {}
  try { body = await req.json() } catch { /* allow empty body — will 400 below */ }

  if (!id || !body.status) {
    return NextResponse.json(
      { ok: false, error: 'missing_id_or_status' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()
  const { data: deal, error } = await supabase
    .from('deals')
    .select('id, ghl_contact_id, ghl_location_id, ghl_opportunity_id, pipeline_group, loan_officer, raw_ghl_data')
    .eq('id', id)
    .single()

  if (error || !deal) {
    return NextResponse.json(
      { ok: false, error: 'deal_not_found' },
      { status: 404 },
    )
  }

  // Prefer the dedicated column — it's what the rest of the app joins on (notably
  // /lead-roi's opt-out timing, which keys firstOptout by ghl_opportunity_id). The
  // raw_ghl_data blob stays as a fallback for rows the column never got set on.
  const raw = (deal.raw_ghl_data as Record<string, unknown> | null) ?? {}
  const opportunityId =
    (deal.ghl_opportunity_id as string | null) ??
    (raw.id as string | undefined) ??
    null

  const result = await pushOpportunityStage({
    locationId:    deal.ghl_location_id as string | null,
    opportunityId,
    status:        body.status,
    oppStatus:     body.oppStatus,
  })

  // ── Log the move to stage_events ───────────────────────────────────────────
  // Why here: the dashboard writes deals.status FIRST, then calls this route. So
  // when GHL echoes the change back via the stage webhook, that handler finds
  // cur.status === the new status and its echo-guard (.neq('status', …)) correctly
  // suppresses the log. Net effect: every dashboard-origin move — including every
  // triage disposition — was invisible to stage_events, leaving /lead-roi's opt-out
  // timing at 5.7% coverage (27 of 473) and biased toward GHL-origin moves only.
  // This is the single choke point: all 11 dashboard stage-change call sites route
  // through lib/pushStage.ts → here.
  //
  // Skipped for oppStatus='lost' — that's a won/lost flip that deliberately LEAVES
  // the stage alone (see hot-leads' handleMarkLost, which passes the CURRENT status),
  // so logging it would invent a stage move that never happened.
  //
  // from_status is null by construction: the client already overwrote deals.status
  // before calling us, so the prior value isn't recoverable here. The opt-out and
  // first-responded readers key on to_status/event_at/opportunity_id, not from_status.
  if (body.oppStatus !== 'lost') {
    const recentCutoff = new Date(Date.now() - 120_000).toISOString()
    const { data: dupe } = await supabase
      .from('stage_events')
      .select('id')
      .eq('deal_id', deal.id)
      .eq('to_status', body.status)
      .gte('created_at', recentCutoff)
      .limit(1)

    if (!dupe?.length) {
      await logStageEvent(supabase, {
        opportunityId,
        contactId:       deal.ghl_contact_id as string | null,
        dealId:          deal.id as string,
        fromStatus:      null,
        toStatus:        body.status,
        toPipelineGroup: deal.pipeline_group as string | null,
        loanOfficer:     deal.loan_officer as string | null,
        source:          'dashboard',
      })
    }
  }

  // 200 for success or intentional skip, 502 for actual GHL/lookup failures.
  const httpStatus = result.ok ? 200 : 502
  return NextResponse.json(result, { status: httpStatus })
}
