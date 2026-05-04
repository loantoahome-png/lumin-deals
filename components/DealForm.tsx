'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  Deal, LOAN_STATUSES, PIPELINE_GROUPS, LOAN_OFFICERS,
  LOAN_TYPES, OCCUPANCY_TYPES, APPRAISAL_STATUSES
} from '@/lib/types'

type DealFormData = Omit<Deal, 'id' | 'created_at' | 'updated_at'>

const emptyDeal: DealFormData = {
  name: '',
  first_name: null,
  last_name: null,
  email: null,
  phone: null,
  status: 'Client',
  pipeline_group: 'LEADS',
  loan_officer: null,
  processor: null,
  processor_status: null,
  loan_type: null,
  loan_amount: null,
  estimated_value: null,
  revenue: null,
  rate: null,
  investor: null,
  property_address: null,
  occupancy: null,
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
  signing_date: null,
  paid_date: null,
  funded_date: null,
  last_contacted: null,
  ghl_contact_id: null,
  document_upload_link: null,
}

export default function DealForm({ deal }: { deal?: Deal }) {
  const router = useRouter()
  const isEdit = !!deal
  const [form, setForm] = useState<DealFormData>(deal ? {
    name: deal.name,
    first_name: deal.first_name,
    last_name: deal.last_name,
    email: deal.email,
    phone: deal.phone,
    status: deal.status,
    pipeline_group: deal.pipeline_group,
    loan_officer: deal.loan_officer,
    processor: deal.processor,
    processor_status: deal.processor_status,
    loan_type: deal.loan_type,
    loan_amount: deal.loan_amount,
    estimated_value: deal.estimated_value,
    revenue: deal.revenue,
    rate: deal.rate,
    investor: deal.investor,
    property_address: deal.property_address,
    occupancy: deal.occupancy,
    locked: deal.locked,
    lock_expiration: deal.lock_expiration,
    appraisal_status: deal.appraisal_status,
    source: deal.source,
    broker_corr: deal.broker_corr,
    lead_source_agg: deal.lead_source_agg,
    arive_file_no: deal.arive_file_no,
    investor_file_no: deal.investor_file_no,
    lo_notes: deal.lo_notes,
    client_notes: deal.client_notes,
    subbed: deal.subbed,
    signing_date: deal.signing_date,
    paid_date: deal.paid_date,
    funded_date: deal.funded_date,
    last_contacted: deal.last_contacted,
    ghl_contact_id: deal.ghl_contact_id,
    document_upload_link: deal.document_upload_link,
  } : emptyDeal)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  function set(key: keyof DealFormData, value: string | number | boolean | null) {
    setForm(f => ({ ...f, [key]: value === '' ? null : value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')

    // Auto-fill name from first/last if name is empty and both are present
    const payload = { ...form }
    if (!payload.name && payload.first_name && payload.last_name) {
      payload.name = `${payload.first_name} ${payload.last_name}`
    }

    if (isEdit) {
      const { error: err } = await supabase.from('deals').update(payload).eq('id', deal.id)
      if (err) { setError(err.message); setSaving(false); return }
      router.push(`/deals/${deal.id}`)
    } else {
      const { data, error: err } = await supabase.from('deals').insert(payload).select().single()
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
    <form onSubmit={handleSubmit} className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{isEdit ? `Edit — ${deal.name}` : 'New Deal'}</h1>
          <p className="text-sm text-slate-500 mt-0.5">Fill in the borrower and loan details</p>
        </div>
        <div className="flex items-center gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete Deal'}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Deal'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      {/* Section: Pipeline */}
      <Section title="Pipeline">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Pipeline Group">
            <select value={form.pipeline_group || ''} onChange={e => set('pipeline_group', e.target.value)} className={selectClass}>
              {PIPELINE_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
          <Field label="Loan Status">
            <select value={form.status} onChange={e => set('status', e.target.value)} className={selectClass}>
              {LOAN_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {/* Section: Borrower */}
      <Section title="Borrower Info">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Full Name *">
            <input value={form.name} onChange={e => set('name', e.target.value)} className={inputClass} placeholder="e.g. John Smith" required />
          </Field>
          <Field label="First Name">
            <input value={form.first_name || ''} onChange={e => set('first_name', e.target.value)} className={inputClass} placeholder="First" />
          </Field>
          <Field label="Last Name">
            <input value={form.last_name || ''} onChange={e => set('last_name', e.target.value)} className={inputClass} placeholder="Last" />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} className={inputClass} placeholder="borrower@email.com" />
          </Field>
          <Field label="Phone">
            <input value={form.phone || ''} onChange={e => set('phone', e.target.value)} className={inputClass} placeholder="(555) 555-5555" />
          </Field>
          <Field label="Source">
            <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              <option value="GHL">GHL</option>
              <option value="Self Source">Self Source</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* Section: Loan Details */}
      <Section title="Loan Details">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Loan Type">
            <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {LOAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Loan Amount ($)">
            <input type="number" value={form.loan_amount ?? ''} onChange={e => set('loan_amount', e.target.value ? Number(e.target.value) : null)} className={inputClass} placeholder="0.00" />
          </Field>
          <Field label="Estimated Value ($)">
            <input type="number" value={form.estimated_value ?? ''} onChange={e => set('estimated_value', e.target.value ? Number(e.target.value) : null)} className={inputClass} placeholder="0.00" />
          </Field>
          <Field label="Revenue ($)">
            <input type="number" value={form.revenue ?? ''} onChange={e => set('revenue', e.target.value ? Number(e.target.value) : null)} className={inputClass} placeholder="0.00" />
          </Field>
          <Field label="Rate (%)">
            <input type="number" step="0.001" value={form.rate ?? ''} onChange={e => set('rate', e.target.value ? Number(e.target.value) : null)} className={inputClass} placeholder="6.500" />
          </Field>
          <Field label="Investor">
            <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inputClass} placeholder="e.g. Rocket, Figure" />
          </Field>
          <Field label="Property Address">
            <input value={form.property_address || ''} onChange={e => set('property_address', e.target.value)} className={inputClass} placeholder="123 Main St, City, CA 90210" />
          </Field>
          <Field label="Occupancy">
            <select value={form.occupancy || ''} onChange={e => set('occupancy', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {OCCUPANCY_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Broker / Correspondent">
            <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              <option value="Broker">Broker</option>
              <option value="Correspondent">Correspondent</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* Section: Lock & Appraisal */}
      <Section title="Lock & Appraisal">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Locked?">
            <select value={form.locked || 'No'} onChange={e => set('locked', e.target.value)} className={selectClass}>
              <option value="No">No</option>
              <option value="Yes">Yes</option>
              <option value="NA">N/A</option>
            </select>
          </Field>
          <Field label="Lock Expiration">
            <input type="date" value={form.lock_expiration || ''} onChange={e => set('lock_expiration', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Appraisal Status">
            <select value={form.appraisal_status || ''} onChange={e => set('appraisal_status', e.target.value)} className={selectClass}>
              {APPRAISAL_STATUSES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {/* Section: Team */}
      <Section title="Team">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Loan Officer">
            <select value={form.loan_officer || ''} onChange={e => set('loan_officer', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
            </select>
          </Field>
          <Field label="Processor">
            <select value={form.processor_status || ''} onChange={e => set('processor_status', e.target.value)} className={selectClass}>
              <option value="">— Select —</option>
              <option value="Lexi - 3rd party">Lexi - 3rd party</option>
              <option value="Hanh - 3rd party">Hanh - 3rd party</option>
              <option value="Susan - In house">Susan - In house</option>
              <option value="Self Processing">Self Processing</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* Section: File Numbers */}
      <Section title="File Numbers">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Arive File #">
            <input value={form.arive_file_no || ''} onChange={e => set('arive_file_no', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Investor File #">
            <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inputClass} />
          </Field>
        </div>
      </Section>

      {/* Section: Key Dates */}
      <Section title="Key Dates">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Signing Date">
            <input type="date" value={form.signing_date || ''} onChange={e => set('signing_date', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Funded Date">
            <input type="date" value={form.funded_date || ''} onChange={e => set('funded_date', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Paid Date">
            <input type="date" value={form.paid_date || ''} onChange={e => set('paid_date', e.target.value)} className={inputClass} />
          </Field>
          <Field label="Last Contacted">
            <input type="date" value={form.last_contacted || ''} onChange={e => set('last_contacted', e.target.value)} className={inputClass} />
          </Field>
        </div>
      </Section>

      {/* Section: Notes */}
      <Section title="Notes">
        <div className="grid grid-cols-1 gap-4">
          <Field label="LO Notes">
            <textarea value={form.lo_notes || ''} onChange={e => set('lo_notes', e.target.value)} rows={3} className={inputClass + ' resize-none'} placeholder="Internal loan officer notes…" />
          </Field>
          <Field label="Client Notes">
            <textarea value={form.client_notes || ''} onChange={e => set('client_notes', e.target.value)} rows={3} className={inputClass + ' resize-none'} placeholder="Client-facing notes…" />
          </Field>
          <Field label="Document Upload Link">
            <input value={form.document_upload_link || ''} onChange={e => set('document_upload_link', e.target.value)} className={inputClass} placeholder="https://…" />
          </Field>
        </div>
      </Section>

      {/* Submit */}
      <div className="flex justify-end pt-2 pb-8">
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Deal'}
        </button>
      </div>
    </form>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

const inputClass = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white'
const selectClass = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white'
