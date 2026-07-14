import { supabase } from './supabase'
import type { Deal } from './types'

// Every deal column EXCEPT `raw_ghl_data` — the full GHL webhook JSON blob
// (~3 KB/row, ~52% of a `select=*` payload) that no list/board page renders.
// A bare `select('*')` on a ~2,500-row page (pipeline, deals) drags ~7 MB of
// this blob the browser throws away; skipping it roughly halves the transfer
// and the time spent waiting on it during a post-sync DB slow window.
//
// This is an EXCLUDE-ONE list (all columns but the blob), NOT a hand-picked
// allow-list, so it can't silently drop a rendered field. When a new deal
// column is added to the schema, add it here too (the same convention
// Dashboard.tsx already follows). Pages that genuinely need the raw blob
// (the single-deal edit route, push-stage) fetch it explicitly themselves.
export const DEAL_COLUMNS = [
  'id', 'name', 'first_name', 'last_name', 'email', 'phone', 'status',
  'pipeline_group', 'stage_changed_at', 'loan_officer', 'ghl_assigned_user',
  'processor', 'processor_status', 'processor_handoff', 'subbed', 'waiting_on',
  'escrow_priority', 'escrow_start_date', 'close_of_escrow_date', 'signing_date',
  'loan_amount', 'loan_type', 'loan_purpose', 'loan_timeframe', 'refinance_type',
  'lien_position', 'cash_out', 'current_balance', 'current_va_loan',
  'estimated_value', 'purchase_price', 'down_payment', 'ltv', 'rate',
  'rate_at_close_10yr', 'housing_payment', 'pi_payment', 'compensation_amount',
  'revenue', 'lead_price', 'credit_score', 'credit_rating', 'occupancy',
  'property_address', 'property_type', 'property_found', 'city', 'county',
  'state', 'zip', 'is_military', 'has_accepted_offer', 'adverse',
  'investor', 'investor_file_no', 'arive_file_no', 'broker_corr',
  'locked', 'lock_expiration', 'lock_alerts_sent', 'appraisal_status',
  'appraisal_contingency_date', 'inspection_contingency_date',
  'loan_contingency_date', 'contingency_alerts_sent', 'document_upload_link',
  'next_action', 'next_action_assignee', 'next_action_due', 'next_action_log',
  'second_callback_at', 'client_notes', 'lo_notes', 'source', 'lead_source_agg',
  'ghl_contact_id', 'ghl_location_id', 'ghl_opportunity_id', 'ghl_status',
  'ghl_tags', 'borrower_id', 'reo_properties', 'communications',
  'comm_unread_count', 'last_communication_at', 'last_communication_type',
  'last_contacted', 'last_inbound_at', 'last_outbound_at', 'dnd', 'dnd_settings',
  'rate_watch_active', 'rate_watch_target', 'rate_watch_notes',
  'rate_watch_alerted_at', 'date_added_ghl', 'funded_date', 'paid_date',
  'created_at', 'updated_at',
].join(',')

// PostgREST caps a single .select() at 1000 rows. Any page that loads the full
// deal set for analysis/display must paginate or it silently truncates.
// This helper walks pages until exhausted. Use it instead of a bare
// supabase.from('deals').select('*').
//
// `refine` lets callers add filters/ordering (.eq, .not, .order, etc.) — but
// NOT .range, since this helper owns pagination.

// Loose type for the query builder — Supabase's generics are painful to thread
// through here, and this is an internal helper.
/* eslint-disable @typescript-eslint/no-explicit-any */
type DealQuery = any

export async function fetchAllDeals(
  refine?: (q: DealQuery) => DealQuery,
  columns: string = '*',
): Promise<Deal[]> {
  const all: Deal[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    let q: DealQuery = supabase.from('deals').select(columns)
    if (refine) q = refine(q)
    const { data, error } = await q.range(offset, offset + PAGE - 1)
    if (error) {
      console.error('[fetchAllDeals] page failed:', error.message)
      break
    }
    const rows = (data as Deal[]) ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return all
}
