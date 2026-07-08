// Forward-only stage-change event logger.
//
// Called by app/api/webhooks/ghl/route.ts on every real GHL opportunity stage
// move. Persists one row to the `stage_events` table (see supabase-stage-events.sql)
// so the Lead Cohort report can answer "when did this lead FIRST become responded".
//
// CONTRACT: this NEVER throws. The webhook's primary job is updating deals; a
// logging failure (or the table not existing yet, before the migration is run)
// must degrade to a console warning, not a 400. Callers do NOT await-guard it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isRespondedStatus } from './leadReport'

export type StageEventInput = {
  opportunityId: string | null
  contactId: string | null
  dealId?: string | null
  fromStageId?: string | null
  toStageId?: string | null
  fromStatus?: string | null
  toStatus: string
  toPipelineGroup?: string | null
  pipelineId?: string | null
  loanOfficer?: string | null
  assignedTo?: string | null
  /** Event timestamp from the payload (ISO or epoch). Falls back to now(). */
  eventAt?: string | number | null
}

/** GHL sends timestamps as ISO strings OR epoch (s/ms). Normalize to ISO, or null. */
export function normalizeEventTs(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    const d = new Date(v < 1e12 ? v * 1000 : v) // seconds vs ms
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  const s = String(v).trim()
  if (/^\d{10}$/.test(s)) { const d = new Date(Number(s) * 1000); return isNaN(d.getTime()) ? null : d.toISOString() }
  if (/^\d{13}$/.test(s)) { const d = new Date(Number(s));        return isNaN(d.getTime()) ? null : d.toISOString() }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export async function logStageEvent(supabase: SupabaseClient, e: StageEventInput): Promise<void> {
  try {
    const eventAt = normalizeEventTs(e.eventAt) ?? new Date().toISOString()
    const toResponded = isRespondedStatus(e.toStatus)
    const { error } = await supabase.from('stage_events').insert({
      opportunity_id:    e.opportunityId,
      contact_id:        e.contactId,
      deal_id:           e.dealId ?? null,
      from_stage_id:     e.fromStageId ?? null,
      to_stage_id:       e.toStageId ?? null,
      from_status:       e.fromStatus ?? null,
      to_status:         e.toStatus,
      to_pipeline_group: e.toPipelineGroup ?? null,
      to_responded:      toResponded,
      pipeline_id:       e.pipelineId ?? null,
      loan_officer:      e.loanOfficer ?? null,
      assigned_to:       e.assignedTo ?? null,
      event_at:          eventAt,
    })
    if (error) {
      // Most common cause before go-live: table doesn't exist yet. Non-fatal.
      console.error('[stage_events] insert failed (non-fatal):', error.message)
    } else {
      console.log(`[stage_events] ${e.fromStatus ?? '?'} → ${e.toStatus} (responded=${toResponded}) opp=${e.opportunityId ?? 'n/a'}`)
    }
  } catch (err) {
    console.error('[stage_events] logging threw (non-fatal):', err)
  }
}
