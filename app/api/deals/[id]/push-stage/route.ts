import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { pushOpportunityStage } from '@/lib/ghl'

/**
 * Push a dashboard-side status change back to GHL.
 *
 * POST /api/deals/{id}/push-stage
 *   body: { status: "Appointment Booked" }
 *
 * Always returns a JSON result describing what happened. A 502 status is
 * used for actual GHL failures so the UI can surface them; a 200 is used
 * for intentional no-ops (deal not linked to GHL, etc.).
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
    .select('id, ghl_contact_id, ghl_location_id, raw_ghl_data')
    .eq('id', id)
    .single()

  if (error || !deal) {
    return NextResponse.json(
      { ok: false, error: 'deal_not_found' },
      { status: 404 },
    )
  }

  // The opportunity ID lives inside the cached GHL payload.
  const raw = (deal.raw_ghl_data as Record<string, unknown> | null) ?? {}
  const opportunityId = (raw.id as string | undefined) ?? null

  const result = await pushOpportunityStage({
    locationId:    deal.ghl_location_id as string | null,
    opportunityId,
    status:        body.status,
    oppStatus:     body.oppStatus,
  })

  // 200 for success or intentional skip, 502 for actual GHL/lookup failures.
  const httpStatus = result.ok ? 200 : 502
  return NextResponse.json(result, { status: httpStatus })
}
