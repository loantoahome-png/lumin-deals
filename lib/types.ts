export type Deal = {
  id: string
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
  loan_type: string | null
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
  subbed: boolean
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
  escrow_priority: string | null              // 'high' | 'normal' | 'low'
  stage_changed_at: string | null             // tracks days-in-stage (auto-updated)
  created_at: string
  updated_at: string
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

export const LOAN_OFFICERS = ['Matt', 'Moe Sefati'] as const

export const LOAN_TYPES = [
  'FHA - Purchase',
  'FHA - R/T Refinance',
  'FHA - Streamline Refi',
  'FHA - C/O Refi',
  'Conv - Purchase',
  'Conv - R/T refi',
  'Conv - C/O refi',
  'Non-QM - Purchase',
  'Non-QM - Refi',
  'HELOC',
  'HELOAN',
  'VA - Purchase',
  'VA - Refi C/O',
  'VA IRRRL',
  'DSCR - Purchase',
  'DSCR - Refinance',
  'Hard Money',
] as const

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
  'Submitted to UW':         'bg-orange-100 text-orange-700',
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
