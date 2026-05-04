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
  revenue: number | null
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
  lo_notes: string | null
  client_notes: string | null
  subbed: boolean
  signing_date: string | null
  paid_date: string | null
  funded_date: string | null
  last_contacted: string | null
  ghl_contact_id: string | null
  document_upload_link: string | null
  created_at: string
  updated_at: string
}

export const LOAN_STATUSES = [
  'Client',
  'Working on application/docs',
  'Need to register',
  'Figure - income verification or less',
  'REGISTER',
  'Loan Registered',
  'F - In Process',
  'Submitted to UW',
  'Underwriting',
  'Conditional approval',
  'Conditions',
  'Waiting on Docs from Client for final approval',
  'Submitted docs for CTC',
  'Waiting on VOE',
  'F - Notary Preparation',
  'F - Note Signing',
  'F - Rescission',
  'Signing Scheduled',
  'Signing Done - Waiting for Funding',
  'Request Comp',
  'Comp Requested',
  'Clear to Close',
  'PAID',
] as const

export const PIPELINE_GROUPS = [
  'LEADS',
  'Active Escrows',
  'Signing Scheduled',
  'Closed',
  'Nurture',
  'Lost',
] as const

export const LOAN_OFFICERS = ['Efrain Ramirez', 'Matt', 'Moe Sefati'] as const

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
  'Client': 'bg-gray-100 text-gray-700',
  'Working on application/docs': 'bg-purple-100 text-purple-700',
  'Need to register': 'bg-slate-100 text-slate-700',
  'Figure - income verification or less': 'bg-blue-100 text-blue-700',
  'REGISTER': 'bg-rose-100 text-rose-700',
  'Loan Registered': 'bg-yellow-100 text-yellow-700',
  'F - In Process': 'bg-yellow-100 text-yellow-700',
  'Submitted to UW': 'bg-orange-100 text-orange-700',
  'Underwriting': 'bg-blue-100 text-blue-700',
  'Conditional approval': 'bg-amber-100 text-amber-700',
  'Conditions': 'bg-red-100 text-red-700',
  'Waiting on Docs from Client for final approval': 'bg-indigo-100 text-indigo-700',
  'Submitted docs for CTC': 'bg-cyan-100 text-cyan-700',
  'Waiting on VOE': 'bg-stone-100 text-stone-700',
  'F - Notary Preparation': 'bg-teal-100 text-teal-700',
  'F - Note Signing': 'bg-sky-100 text-sky-700',
  'F - Rescission': 'bg-lime-100 text-lime-700',
  'Signing Scheduled': 'bg-teal-100 text-teal-700',
  'Signing Done - Waiting for Funding': 'bg-orange-100 text-orange-700',
  'Request Comp': 'bg-sky-100 text-sky-700',
  'Comp Requested': 'bg-blue-100 text-blue-700',
  'Clear to Close': 'bg-green-100 text-green-700',
  'PAID': 'bg-emerald-100 text-emerald-700',
}

export const PIPELINE_STAGE_MAP: Record<string, string[]> = {
  'Leads': ['Client', 'Working on application/docs', 'Need to register', 'Figure - income verification or less'],
  'Registered': ['REGISTER', 'Loan Registered', 'F - In Process', 'Submitted to UW'],
  'Underwriting': ['Underwriting', 'Conditional approval', 'Conditions', 'Waiting on Docs from Client for final approval', 'Waiting on VOE'],
  'Closing': ['Submitted docs for CTC', 'Clear to Close', 'F - Notary Preparation', 'F - Note Signing', 'F - Rescission', 'Signing Scheduled', 'Signing Done - Waiting for Funding'],
  'Funded': ['Request Comp', 'Comp Requested', 'PAID'],
}
