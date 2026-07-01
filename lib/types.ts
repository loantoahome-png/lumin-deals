// One PERSON (Contacts Phase 2). id = the canonical borrower_id; deals.borrower_id
// is the foreign key. Derived + maintained by the identity resolver — not hand-edited.
export type Contact = {
  id: string
  display_name: string | null
  email: string | null
  phone: string | null
  ghl_contact_ids: string[]
  loan_count: number
  funded_count: number
  total_funded_volume: number
  total_comp: number
  first_loan_at: string | null
  last_loan_at: string | null
  updated_at: string
}

// ── Co-borrower linking (deal_contacts join) ────────────────────────────────
// A loan's PRIMARY borrower is `deals.borrower_id`. Additional people on the
// loan (spouse/partner) are rows in `deal_contacts` with role='co'. Two DIFFERENT
// people on one loan — distinct from the identity resolver, which groups records
// that are the SAME person.
export const BORROWER_ROLES = ['primary', 'co'] as const
export type BorrowerRole = (typeof BORROWER_ROLES)[number]
export type DealContactLink = {
  id: string
  deal_id: string
  contact_id: string
  role: BorrowerRole
  created_at: string
}
// Lightweight contact shape embedded on a loaded deal (the co-borrowers list).
export type CoborrowerLite = {
  contact_id: string
  name: string | null
  email: string | null
  phone: string | null
}

export type Deal = {
  id: string
  borrower_id: string | null              // groups multiple loans for the same person (Option A model)
  coborrowers: CoborrowerLite[] | null    // role='co' links, loaded join (null when not loaded)
  ghl_opportunity_id: string | null       // the GHL opportunity (loan) ID — distinct per loan
  name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  status: string
  pipeline_group: string
  loan_officer: string | null
  processor: string | null
  processor_status: string | null
  loan_type: string | null               // family only: HELOC / HELOAN / FHA / VA / Conv / Non-QM / DSCR / Hard Money
  refinance_type: string | null          // 'Cash Out' | 'Rate and Term' — only meaningful when loan_purpose === 'Refinance'
  lien_position: string | null           // '1st Lien' | '2nd Lien' | '3rd Lien' — where the new loan sits in title hierarchy
  lead_price: number | null              // what we paid for this individual lead (GHL "Lead Price")
  compensation_amount: number | null     // broker compensation earned on the funded loan (Arive "Compensation Amount")
  loan_amount: number | null
  estimated_value: number | null
  rate: number | null
  investor: string | null
  property_address: string | null
  occupancy: string | null
  city: string | null
  state: string | null
  zip: string | null
  credit_score: number | null
  ghl_tags: string | null
  ghl_assigned_user: string | null
  date_added_ghl: string | null
  raw_ghl_data: Record<string, unknown> | null
  ghl_location_id: string | null              // which GHL sub-account this deal lives in
  locked: string | null
  lock_expiration: string | null
  appraisal_status: string | null
  source: string | null
  broker_corr: string | null
  lead_source_agg: string | null
  arive_file_no: string | null
  investor_file_no: string | null
  loan_purpose: string | null
  property_type: string | null
  credit_rating: string | null
  current_balance: number | null
  ltv: number | null
  cash_out: number | null
  down_payment: number | null
  purchase_price: number | null          // Arive "Purchase Price"
  housing_payment: number | null         // Arive "Total Housing Payment" (monthly PITI)
  pi_payment: number | null              // Arive "First Mortgage Payment" (monthly principal & interest)
  county: string | null                  // Arive "Subject County"
  adverse: string | null                 // Arive "Adverse" = Adverse Action date (ISO YYYY-MM-DD, stored as text)
  is_military: string | null
  current_va_loan: string | null
  property_found: string | null
  loan_timeframe: string | null
  has_accepted_offer: string | null
  rate_watch_active: boolean
  rate_watch_target: number | null
  rate_at_close_10yr: number | null
  rate_watch_notes: string | null
  rate_watch_alerted_at: string | null
  lo_notes: string | null
  client_notes: string | null
  subbed: boolean                              // "Subbed on teams" checkbox on the escrow card
  processor_handoff: boolean | null            // "Processor Handoff" checkbox on the escrow card
  // ── Purchase contingency tracking (only shown in UI when loan_purpose === 'Purchase') ──
  escrow_start_date: string | null            // contract acceptance / EMD opened
  inspection_contingency_date: string | null  // last day to back out for property condition (~17d typical in CA)
  appraisal_contingency_date: string | null   // last day to back out if appraisal comes in low
  loan_contingency_date: string | null        // last day to back out due to loan denial
  close_of_escrow_date: string | null         // contractual closing date per the purchase agreement
  signing_date: string | null
  paid_date: string | null
  funded_date: string | null
  last_contacted: string | null
  ghl_contact_id: string | null
  document_upload_link: string | null
  reo_properties: REOProperty[] | null
  // ── Escrow tracking (used while pipeline_group = 'Loans in Process') ──
  next_action: string | null
  next_action_due: string | null              // ISO timestamp with date+time
  next_action_assignee: string | null
  next_action_log: NextStepEntry[] | null     // timestamped history of next steps (newest first); next_action mirrors the latest
  escrow_priority: string | null              // 'high' | 'normal' | 'low'
  stage_changed_at: string | null             // tracks days-in-stage (auto-updated)
  waiting_on: string | null                   // who/what is blocking the deal
  // Last communication, refreshed from GHL's Conversations API (hot stages).
  last_communication_at: string | null        // ISO — most recent message (any channel/direction)
  last_communication_type: string | null      // 'Text' | 'Call' | 'Email' | …
  comm_unread_count: number | null             // unanswered client messages — "waiting on us"
  last_inbound_at: string | null               // ISO — last message FROM the borrower (inbound)
  last_outbound_at: string | null              // ISO — last message FROM us (outbound)
  dnd: boolean | null                           // GHL master Do-Not-Contact (blocks ALL channels)
  dnd_settings: Record<string, unknown> | null  // GHL per-channel DND ({ SMS:{status}, Email:{status}, … })
  ghl_status: string | null                     // GHL opportunity status: 'open' | 'won' | 'lost' | 'abandoned'
  communications: Communication[] | null      // contact log per deal
  documents: DealDocument[] | null             // per-deal document checklist
  created_at: string
  updated_at: string
}

// ── Waiting-on options ──────────────────────────────────────────────────────
export const WAITING_ON_OPTIONS = [
  'Borrower', 'Co-borrower', 'Realtor', 'Title', 'Appraiser', 'UW',
  'Insurance', 'Employer (VOE)', 'Lender', 'Processor', 'No one',
] as const

// ── Tasks ──────────────────────────────────────────────────────────────────
// Stored in a separate `deal_tasks` table. deal_id is nullable so standalone
// tasks (not tied to a specific lead) can be created from the Tasks page.
export type DealTask = {
  id: string
  deal_id: string | null
  title: string
  description: string | null
  due_at: string | null             // ISO timestamp
  assignee: string | null           // who is doing the task
  assigned_by: string | null        // who delegated it
  priority: string | null           // 'high' | 'normal' | 'low'
  completed_at: string | null       // ISO timestamp when marked done
  created_at: string
}

export const TASK_ASSIGNEES = [
  'Matt Park', 'Moe Sefati', 'Efrain Ramirez', 'Brianne Han',
] as const

// ── Document checklist ──────────────────────────────────────────────────────
// Stored as a JSONB `documents` array on the deals table (same pattern as
// reo_properties / communications). Auto-populated from a per-loan-type
// template, then tracked by status as the file moves through processing.
export type DealDocument = {
  id: string
  name: string
  category: string          // see DOC_CATEGORIES
  status: string            // see DOC_STATUSES
  note: string | null
  updated_at: string        // ISO — last time status/note changed
}

export const DOC_CATEGORIES = [
  'Identity', 'Income', 'Assets', 'Property', 'Credit', 'Other',
] as const

export const DOC_STATUSES = ['needed', 'requested', 'received', 'waived', 'na'] as const

export const DOC_STATUS_LABELS: Record<string, string> = {
  needed:    'Needed',
  requested: 'Requested',
  received:  'Received',
  waived:    'Waived',
  na:        'N/A',
}

// ── Communications log ──────────────────────────────────────────────────────
export type Communication = {
  id: string
  timestamp: string                            // ISO
  channel: string                              // Call / SMS / Email / Meeting / Voicemail / Other
  with: string | null                          // Borrower / Realtor / etc.
  outcome: string | null
  by: string | null                            // who initiated
}

export const COMM_CHANNELS = ['Call', 'SMS', 'Email', 'Meeting', 'Voicemail', 'Other'] as const

// ── Next-step log ───────────────────────────────────────────────────────────
// Timestamped history of a deal's "Next Step" entries (newest first). The deal's
// `next_action` always mirrors the latest entry's text, so existing filters/sorts
// keep working off a single field.
export type NextStepEntry = {
  id: string
  at: string                                   // ISO timestamp
  text: string
}

// ── Stage SLAs (days) ──────────────────────────────────────────────────────
// Industry-standard target durations for each Loans-in-Process stage.
// If a deal exceeds the SLA for its current stage, the tracker flags it.
export const STAGE_SLA_DAYS: Record<string, number> = {
  'Loan Setup':            2,
  'Disclosed':             3,
  'Submitted to UW':       5,
  'Approved w/ Conditions':7,
  'Re-Submittal':          5,
  'Clear to Close':        3,
  'Docs Out':              2,
  'Docs Signed':           2,
  // Funded statuses don't get SLAs — they're terminal
}

// ── Real Estate Owned (borrower's other properties) ─────────────────────────
export type REOLien = {
  id: string
  holder: string | null    // e.g. "Wells Fargo", "Chase"
  type: string | null      // e.g. "1st Mortgage", "2nd Mortgage", "HELOC"
  balance: number | null
}

export type REOProperty = {
  id: string
  address: string | null
  estimated_value: number | null
  property_type: string | null
  occupancy: string | null
  liens: REOLien[]
}

export const LOAN_STATUSES = [
  // ── Leads pipeline ──────────────────────────────────────────────────────────
  'New Lead',
  'Attempted Contact',
  'Ghosted',
  'Responded',
  'Pitching',
  'Appointment Booked',
  'Arive Lead',
  'App Intake',
  'Qualification',
  'Pre-Approved',
  // ── Loans in Process pipeline ────────────────────────────────────────────────
  'Loan Setup',
  'Disclosed',
  'Submitted to UW',
  'Approved w/ Conditions',
  'Re-Submittal',
  'Clear to Close',
  'Docs Out',
  'Docs Signed',
  'Loan Funded',
  'Broker Check Received',
  'Loan Finalized',
  // ── Not Ready pipeline ───────────────────────────────────────────────────────
  'Not Qualified - Credit',
  'Not Qualified - Income',
  'Not Ready - Timeframe',
  'DND - SMS',
  'Not Ready - Rate',
  'Lost to Competitor',
  'Non-Responsive',
  'Remove from All Automations',
  'STOP',
] as const

export const PIPELINE_GROUPS = [
  'Leads',
  'Loans in Process',
  'Not Ready',
  'Funded',
] as const

// Canonical loan_officer values — MUST equal what resolveLO() produces and what the
// Arive import stores: the FULL name "Matt Park" (NOT "Matt"). The data holds "Matt
// Park" (711 deals); a short "Matt" option matches nothing, so every LO <select> across
// the app (deal detail, pipeline, deals, hot-leads, FundedTracker, DealForm) renders
// blank on Matt's deals. Keep these in lockstep with the resolveLO map.
export const LOAN_OFFICERS = ['Matt Park', 'Moe Sefati'] as const

// Processor options (stored on `processor_status`). Surfaced in the Active Escrows
// card, the deal detail panel, the new-deal form, and the pipeline table.
export const PROCESSORS = ['Self Processing', 'Susan Lim', 'Hanh Nguyen'] as const

// Loan type now stores only the FAMILY. Refinance-specific sub-type (Cash Out
// vs Rate and Term) lives in `refinance_type` — surfaced in the UI only when
// loan_purpose === 'Refinance'.
export const LOAN_TYPES = [
  'HELOC',
  'HELOAN',
  'FHA',
  'VA',
  'Conv',
  'Non-QM',
  'DSCR',
  'Hard Money',
] as const

export const REFINANCE_TYPES = ['Cash Out', 'Rate and Term'] as const

// Lien position — where the new loan sits in the title hierarchy.
// Almost always 1st (purchase, R/T refi) or 2nd (HELOC, HELOAN, subordinate financing).
export const LIEN_POSITIONS = ['1st Lien', '2nd Lien', '3rd Lien'] as const

export const OCCUPANCY_TYPES = ['Primary', 'Second Home', 'Investment'] as const

export const APPRAISAL_STATUSES = [
  'Need to order',
  'Ordered, waiting for report',
  'Appraisal IN',
  'AVM',
  'NA',
] as const

export const STATUS_COLORS: Record<string, string> = {
  // Leads pipeline
  'New Lead':            'bg-slate-100 text-slate-700',
  'Attempted Contact':   'bg-blue-100 text-blue-700',
  'Ghosted':             'bg-gray-100 text-gray-500',
  'Responded':           'bg-sky-100 text-sky-700',
  'Pitching':            'bg-violet-100 text-violet-700',
  'Appointment Booked':  'bg-purple-100 text-purple-700',
  'Arive Lead':          'bg-indigo-100 text-indigo-700',
  'App Intake':          'bg-cyan-100 text-cyan-700',
  'Qualification':       'bg-teal-100 text-teal-700',
  'Pre-Approved':        'bg-emerald-100 text-emerald-700',
  // Loans in Process pipeline
  'Loan Setup':              'bg-yellow-100 text-yellow-700',
  'Disclosed':               'bg-amber-100 text-amber-700',
  'Submitted to UW':         'bg-indigo-100 text-indigo-700',
  'Approved w/ Conditions':  'bg-lime-100 text-lime-700',
  'Re-Submittal':            'bg-red-100 text-red-700',
  'Clear to Close':          'bg-green-100 text-green-700',
  'Docs Out':                'bg-teal-100 text-teal-800',
  'Docs Signed':             'bg-emerald-100 text-emerald-700',
  'Loan Funded':             'bg-emerald-200 text-emerald-800',
  'Broker Check Received':   'bg-green-200 text-green-800',
  'Loan Finalized':          'bg-emerald-300 text-emerald-900',
  // Not Ready pipeline
  'Not Qualified - Credit':       'bg-red-100 text-red-700',
  'Not Qualified - Income':       'bg-red-100 text-red-700',
  'Not Ready - Timeframe':        'bg-orange-100 text-orange-700',
  'DND - SMS':                    'bg-slate-100 text-slate-600',
  'Not Ready - Rate':             'bg-orange-100 text-orange-600',
  'Lost to Competitor':           'bg-gray-100 text-gray-600',
  'Non-Responsive':               'bg-gray-100 text-gray-500',
  'Remove from All Automations':  'bg-slate-100 text-slate-500',
  'STOP':                         'bg-red-200 text-red-800',
}

// Statuses valid for each pipeline — used to filter stage dropdowns
export const PIPELINE_STATUSES: Record<string, string[]> = {
  'Leads': [
    'New Lead', 'Attempted Contact', 'Ghosted', 'Responded', 'Pitching',
    'Appointment Booked', 'Arive Lead', 'App Intake', 'Qualification', 'Pre-Approved',
  ],
  'Loans in Process': [
    'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
    'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
    'Loan Funded', 'Broker Check Received', 'Loan Finalized',
  ],
  'Not Ready': [
    'Not Qualified - Credit', 'Not Qualified - Income', 'Not Ready - Timeframe',
    'DND - SMS', 'Not Ready - Rate', 'Lost to Competitor', 'Non-Responsive',
    'Remove from All Automations', 'STOP',
  ],
  'Funded': ['Loan Funded', 'Broker Check Received', 'Loan Finalized'],
}

export const PIPELINE_STAGE_MAP: Record<string, string[]> = {
  'Leads': [
    'New Lead', 'Attempted Contact', 'Ghosted', 'Responded', 'Pitching',
    'Appointment Booked', 'Arive Lead', 'App Intake', 'Qualification', 'Pre-Approved',
  ],
  'Escrows': [
    'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
    'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
    'Loan Funded', 'Broker Check Received', 'Loan Finalized',
  ],
  'Funded': ['Loan Funded'],
  'Not Ready': [
    'Not Qualified - Credit', 'Not Qualified - Income', 'Not Ready - Timeframe',
    'DND - SMS', 'Not Ready - Rate', 'Lost to Competitor', 'Non-Responsive',
    'Remove from All Automations', 'STOP',
  ],
}
