'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  Deal, PIPELINE_GROUPS, PIPELINE_STATUSES, LOAN_OFFICERS, PROCESSORS,
  LOAN_TYPES, REFINANCE_TYPES, LIEN_POSITIONS, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import {
  ArrowLeft, Check, Trash2, DollarSign, Home, User, Users,
  Lock, Hash, MessageSquare, Briefcase,
} from 'lucide-react'

type DealFormData = Omit<Deal, 'id' | 'created_at' | 'updated_at'>

const emptyDeal: DealFormData = {
  borrower_id: null,
  coborrowers: null,
  ghl_opportunity_id: null,
  name: '',
  first_name: null,
  last_name: null,
  email: null,
  phone: null,
  status: 'New Lead',
  pipeline_group: 'Leads',
  loan_officer: null,
  processor: null,
  processor_status: null,
  loan_type: null,
  refinance_type: null,
  lien_position: null,
  lead_price: null,
  compensation_amount: null,
  loan_amount: null,
  estimated_value: null,
  rate: null,
  investor: null,
  property_address: null,
  occupancy: null,
  city: null,
  state: null,
  zip: null,
  credit_score: null,
  credit_rating: null,
  loan_purpose: null,
  property_type: null,
  current_balance: null,
  ltv: null,
  cash_out: null,
  purchase_price: null,
  housing_payment: null,
  pi_payment: null,
  county: null,
  adverse: null,
  down_payment: null,
  is_military: null,
  current_va_loan: null,
  property_found: null,
  loan_timeframe: null,
  has_accepted_offer: null,
  ghl_tags: null,
  ghl_assigned_user: null,
  ghl_contact_id: null,
  ghl_location_id: null,
  date_added_ghl: null,
  raw_ghl_data: null,
  rate_watch_active: false,
  rate_watch_target: null,
  rate_at_close_10yr: null,
  rate_watch_notes: null,
  rate_watch_alerted_at: null,
  locked: 'No',
  lock_expiration: null,
  appraisal_status: 'Need to order',
  source: null,
  broker_corr: null,
  lead_source_agg: null,
  arive_file_no: null,
  investor_file_no: null,
  lo_notes: null,
  client_notes: null,
  subbed: false,
  processor_handoff: false,
  signing_date: null,
  paid_date: null,
  funded_date: null,
  last_contacted: null,
  document_upload_link: null,
  reo_properties: null,
  next_action: null,
  next_action_due: null,
  next_action_assignee: null,
  escrow_priority: null,
  stage_changed_at: null,
  waiting_on: null,
  last_communication_at: null,
  last_communication_type: null,
  comm_unread_count: null,
  communications: null,
  documents: null,
  // Purchase contingency dates (added with the contingency tracker)
  escrow_start_date: null,
  inspection_contingency_date: null,
  appraisal_contingency_date: null,
  loan_contingency_date: null,
  close_of_escrow_date: null,
}

// ── Field styles ────────────────────────────────────────────────────────────
const inp = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors'
const sel = inp
const inpCurrency = 'w-full pl-7 pr-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors tabular-nums'
const inpPercent = 'w-full pl-3 pr-7 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors tabular-nums'

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4">
        {icon && <span className="text-slate-400 shrink-0">{icon}</span>}
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

function CurrencyInput({ value, onChange }: { value: number | null; onChange: (n: number | null) => void }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">$</span>
      <input
        type="number"
        value={value ?? ''}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
        className={inpCurrency}
      />
    </div>
  )
}

function PercentInput({ value, onChange, step = '0.01' }: { value: number | null; onChange: (n: number | null) => void; step?: string }) {
  return (
    <div className="relative">
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
        className={inpPercent}
      />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">%</span>
    </div>
  )
}

/** Read-only display for computed percentage fields (LTV, CLTV). */
function ComputedPercent({ value, hint }: { value: number | null; hint?: string }) {
  return (
    <div className="relative" title={hint}>
      <div className="w-full pl-3 pr-7 py-2 border border-slate-100 rounded-lg text-sm bg-slate-50 text-slate-700 tabular-nums select-none">
        {value != null ? value.toFixed(2) : <span className="text-slate-400">—</span>}
      </div>
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">%</span>
    </div>
  )
}

// ── Compute helpers ─────────────────────────────────────────────────────────
function computeLTV(loanAmount: number | null, propertyValue: number | null): number | null {
  if (!loanAmount || !propertyValue || propertyValue <= 0) return null
  return (loanAmount / propertyValue) * 100
}
function computeCLTV(loanAmount: number | null, existingLiens: number | null, propertyValue: number | null): number | null {
  if (!propertyValue || propertyValue <= 0) return null
  const total = (loanAmount ?? 0) + (existingLiens ?? 0)
  if (total <= 0) return null
  return (total / propertyValue) * 100
}

// ── Main form ───────────────────────────────────────────────────────────────
export default function DealForm({ deal }: { deal?: Deal }) {
  const router = useRouter()
  const isEdit = !!deal
  const [form, setForm] = useState<DealFormData>(deal ? {
    ...emptyDeal,
    ...Object.fromEntries(
      Object.entries(deal).filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k))
    ),
  } as DealFormData : emptyDeal)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  function set<K extends keyof DealFormData>(key: K, value: DealFormData[K] | string | number | null) {
    setForm(f => ({ ...f, [key]: value === '' ? null : value }))
  }

  // Keep LTV in sync whenever Loan Amount or Property Value change
  useEffect(() => {
    const next = computeLTV(form.loan_amount, form.estimated_value)
    if (next !== form.ltv) {
      setForm(f => ({ ...f, ltv: next }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.loan_amount, form.estimated_value])

  // CLTV is computed live for display (not stored)
  const cltv = computeCLTV(form.loan_amount, form.current_balance, form.estimated_value)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')

    if (isEdit) {
      const { error: err } = await supabase.from('deals').update(form).eq('id', deal.id)
      if (err) { setError(err.message); setSaving(false); return }
      router.push(`/deals/${deal.id}`)
    } else {
      const { data, error: err } = await supabase.from('deals').insert(form).select().single()
      if (err) { setError(err.message); setSaving(false); return }
      router.push(`/deals/${data.id}`)
    }
  }

  async function handleDelete() {
    if (!deal) return
    if (!confirm(`Delete deal for ${deal.name}? This cannot be undone.`)) return
    setDeleting(true)
    await supabase.from('deals').delete().eq('id', deal.id)
    router.push('/deals')
  }

  return (
    <form onSubmit={handleSubmit} className="p-6 max-w-5xl mx-auto">
      {/* Back link — return to wherever the user came from, not a hardcoded page.
          Falls back to /deals on a direct load/refresh with no in-app history. */}
      <button
        type="button"
        onClick={() => {
          if (window.history.length > 1) router.back()
          else router.push('/deals')
        }}
        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{isEdit ? `Edit — ${deal.name}` : 'New Deal'}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isEdit ? 'Update borrower and loan details' : 'Enter the core info — you can fill in the rest later from the deal page'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1.5 px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 shadow-sm"
          >
            <Check className="w-4 h-4" />
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Deal'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      {/* Unified card with internal sections divided by lines */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-3">
          {/* ── Left column (2/3) ──────────────────────────────────── */}
          <div className="lg:col-span-2 divide-y divide-slate-200">

            {/* Pipeline */}
            <Section title="Pipeline" icon={<Briefcase className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Pipeline">
                  <select
                    value={form.pipeline_group || ''}
                    onChange={e => {
                      const pg = e.target.value
                      const firstStatus = PIPELINE_STATUSES[pg]?.[0] || ''
                      setForm(f => ({ ...f, pipeline_group: pg, status: firstStatus }))
                    }}
                    className={sel}
                  >
                    {PIPELINE_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </Field>
                <Field label="Stage">
                  <select value={form.status} onChange={e => set('status', e.target.value)} className={sel}>
                    {(PIPELINE_STATUSES[form.pipeline_group || ''] || []).map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>

            {/* Loan Details */}
            <Section title="Loan Details" icon={<DollarSign className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Loan Purpose">
                  <select
                    value={form.loan_purpose || ''}
                    onChange={e => {
                      const v = e.target.value
                      set('loan_purpose', v)
                      if (v !== 'Refinance' && form.refinance_type) set('refinance_type', null)
                    }}
                    className={sel}
                  >
                    <option value="">—</option>
                    <option value="Purchase">Purchase</option>
                    <option value="Refinance">Refinance</option>
                  </select>
                </Field>
                <Field label="Loan Type">
                  <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {LOAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                {form.loan_purpose === 'Refinance' && (
                  <Field label="Refinance Type">
                    <select value={form.refinance_type || ''} onChange={e => set('refinance_type', e.target.value || null)} className={sel}>
                      <option value="">—</option>
                      {REFINANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Lien Position">
                  <select value={form.lien_position || ''} onChange={e => set('lien_position', e.target.value || null)} className={sel}>
                    <option value="">—</option>
                    {LIEN_POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="Loan Amount">
                  <CurrencyInput value={form.loan_amount} onChange={v => set('loan_amount', v)} />
                </Field>
                <Field label="Property Value">
                  <CurrencyInput value={form.estimated_value} onChange={v => set('estimated_value', v)} />
                </Field>
                <Field label="Amount on Existing Liens">
                  <CurrencyInput value={form.current_balance} onChange={v => set('current_balance', v)} />
                </Field>
                <Field label="Cash Out">
                  <CurrencyInput value={form.cash_out} onChange={v => set('cash_out', v)} />
                </Field>
                <Field label="LTV (auto)">
                  <ComputedPercent value={form.ltv} hint="Loan Amount ÷ Property Value" />
                </Field>
                <Field label="CLTV (auto)">
                  <ComputedPercent value={cltv} hint="(Loan Amount + Existing Liens) ÷ Property Value" />
                </Field>
                <Field label="Down Payment">
                  <CurrencyInput value={form.down_payment} onChange={v => set('down_payment', v)} />
                </Field>
                <Field label="Purchase Price">
                  <CurrencyInput value={form.purchase_price} onChange={v => set('purchase_price', v)} />
                </Field>
                <Field label="Total Housing Payment">
                  <CurrencyInput value={form.housing_payment} onChange={v => set('housing_payment', v)} />
                </Field>
                <Field label="P&I Payment">
                  <CurrencyInput value={form.pi_payment} onChange={v => set('pi_payment', v)} />
                </Field>
                <Field label="County">
                  <input value={form.county || ''} onChange={e => set('county', e.target.value)} className={inp} />
                </Field>
                <Field label="Adverse">
                  <input value={form.adverse || ''} onChange={e => set('adverse', e.target.value)} className={inp} />
                </Field>
                <Field label="Rate">
                  <PercentInput value={form.rate} onChange={v => set('rate', v)} step="0.001" />
                </Field>
                <Field label="Lender">
                  <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inp} />
                </Field>
                <Field label="Broker / Correspondent">
                  <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="Broker">Broker</option>
                    <option value="Correspondent">Correspondent</option>
                  </select>
                </Field>
                <Field label="Source">
                  <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <optgroup label="Self Sourced">
                      <option value="Self Source">Self Source</option>
                      <option value="Referral">Referral</option>
                      <option value="Past Client">Past Client</option>
                      <option value="Open House">Open House</option>
                      <option value="Agent Partner">Agent Partner</option>
                      <option value="Financial Advisor">Financial Advisor</option>
                      <option value="Builder">Builder</option>
                      <option value="Online / Social">Online / Social</option>
                    </optgroup>
                    <optgroup label="GHL / Lead Vendors">
                      <option value="Lendgo">Lendgo</option>
                      <option value="FRU">FRU</option>
                      <option value="GHL">GHL (other)</option>
                    </optgroup>
                  </select>
                </Field>
              </div>
            </Section>

            {/* Property */}
            <Section title="Property Details" icon={<Home className="w-4 h-4" />}>
              <div className="space-y-4">
                <Field label="Property Address">
                  <input value={form.property_address || ''} onChange={e => set('property_address', e.target.value)} className={inp} />
                </Field>
                <div className="grid grid-cols-[1fr_120px_120px] gap-3">
                  <Field label="City">
                    <input value={form.city || ''} onChange={e => set('city', e.target.value)} className={inp} />
                  </Field>
                  <Field label="State">
                    <input value={form.state || ''} onChange={e => set('state', e.target.value)} className={inp} maxLength={2} />
                  </Field>
                  <Field label="Zip">
                    <input value={form.zip || ''} onChange={e => set('zip', e.target.value)} className={inp} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Property Use / Occupancy">
                    <select value={form.occupancy || ''} onChange={e => set('occupancy', e.target.value)} className={sel}>
                      <option value="">—</option>
                      {OCCUPANCY_TYPES.map(o => <option key={o}>{o}</option>)}
                      <option value="Primary Residence">Primary Residence</option>
                    </select>
                  </Field>
                  <Field label="Property Type">
                    <select value={form.property_type || ''} onChange={e => set('property_type', e.target.value)} className={sel}>
                      <option value="">—</option>
                      <option value="Single Family">Single Family</option>
                      <option value="Manufactured">Manufactured</option>
                      <option value="Condo">Condo</option>
                      <option value="Townhouse">Townhouse</option>
                      <option value="Multi-Family (2-4)">Multi-Family (2-4)</option>
                      <option value="Commercial">Commercial</option>
                      <option value="Land">Land</option>
                    </select>
                  </Field>
                </div>
              </div>
            </Section>

            {/* Lock & Appraisal */}
            <Section title="Lock & Appraisal" icon={<Lock className="w-4 h-4" />}>
              <div className="grid grid-cols-3 gap-4">
                <Field label="Locked?">
                  <select value={form.locked || 'No'} onChange={e => set('locked', e.target.value)} className={sel}>
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                    <option value="NA">N/A</option>
                  </select>
                </Field>
                <Field label="Lock Expiration">
                  <input type="date" value={form.lock_expiration || ''} onChange={e => set('lock_expiration', e.target.value)} className={inp} />
                </Field>
                <Field label="Appraisal Status">
                  <select value={form.appraisal_status || ''} onChange={e => set('appraisal_status', e.target.value)} className={sel}>
                    {APPRAISAL_STATUSES.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            {/* File Numbers */}
            <Section title="File Numbers" icon={<Hash className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Arive File #">
                  <input
                    value={form.arive_file_no || ''}
                    onChange={e => {
                      // Accept a raw file number or a pasted Arive loan URL
                      const v = e.target.value.trim()
                      const m = v.match(/myarive\.com\/app\/loans\/(\d+)/i)
                      set('arive_file_no', m ? m[1] : v)
                    }}
                    placeholder="e.g. 16776575"
                    className={inp}
                  />
                </Field>
                <Field label="Lender Loan #">
                  <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inp} />
                </Field>
              </div>
            </Section>

            {/* Notes */}
            <Section title="LO Notes" icon={<MessageSquare className="w-4 h-4" />}>
              <textarea
                value={form.lo_notes || ''}
                onChange={e => set('lo_notes', e.target.value)}
                rows={3}
                className={inp + ' resize-none'}
              />
              <p className="text-[11px] text-slate-400 mt-1.5">
                Tip: after the deal is created, you can add timestamped notes one-by-one from the deal page.
              </p>
            </Section>
          </div>

          {/* ── Right column (1/3) ─────────────────────────────────── */}
          <div className="lg:border-l border-slate-200 divide-y divide-slate-200">
            {/* Borrower */}
            <Section title="Borrower" icon={<User className="w-4 h-4" />}>
              <div className="space-y-3">
                <Field label="Full Name" required>
                  <input
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    className={inp}
                    required
                  />
                </Field>
                <Field label="Email">
                  <input type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} className={inp} />
                </Field>
                <Field label="Phone">
                  <input value={form.phone || ''} onChange={e => set('phone', e.target.value)} className={inp} />
                </Field>
                <Field label="Credit Score (FICO)">
                  <input type="number" value={form.credit_score ?? ''} onChange={e => set('credit_score', e.target.value ? Number(e.target.value) : null)} className={inp} />
                </Field>
                <Field label="Credit Rating">
                  <select value={form.credit_rating || ''} onChange={e => set('credit_rating', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="Excellent">Excellent (750+)</option>
                    <option value="Good">Good (700–749)</option>
                    <option value="Fair">Fair (650–699)</option>
                    <option value="Poor">Poor (Below 650)</option>
                  </select>
                </Field>
                <Field label="Is Military / Veteran">
                  <select value={form.is_military || ''} onChange={e => set('is_military', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </Field>
              </div>
            </Section>

            {/* Team */}
            <Section title="Team" icon={<Users className="w-4 h-4" />}>
              <div className="space-y-3">
                <Field label="Loan Officer">
                  <select value={form.loan_officer || ''} onChange={e => set('loan_officer', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
                  </select>
                </Field>
                <Field label="Processor">
                  <select value={form.processor_status || ''} onChange={e => set('processor_status', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {PROCESSORS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
              </div>
            </Section>
          </div>
        </div>
      </div>

      {/* Bottom save bar */}
      <div className="mt-6 pb-8 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 shadow-sm"
        >
          <Check className="w-4 h-4" />
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Deal'}
        </button>
      </div>
    </form>
  )
}
