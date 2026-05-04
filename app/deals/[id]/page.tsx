'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Deal, STATUS_COLORS, LOAN_STATUSES, PIPELINE_GROUPS,
  LOAN_OFFICERS, LOAN_TYPES, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import Link from 'next/link'
import { use } from 'react'
import { ArrowLeft, Check, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

const inp = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors'
const sel = inp

function Card({ title, children }: { title: string; children: React.ReactNode }) {
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

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [form, setForm] = useState<Partial<Deal> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('deals').select('*').eq('id', id).single().then(({ data }) => {
      setForm(data)
      setLoading(false)
    })
  }, [id])

  function set<K extends keyof Deal>(key: K, value: string | number | boolean | null) {
    setSaved(false)
    setForm(f => f ? { ...f, [key]: value === '' ? null : value } : f)
  }

  async function handleSave() {
    if (!form) return
    setSaving(true)
    setError('')
    const { error: err } = await supabase.from('deals').update(form).eq('id', form.id as string)
    if (err) { setError(err.message); setSaving(false); return }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function handleDelete() {
    if (!form) return
    if (!confirm(`Delete deal for ${form.name}? This cannot be undone.`)) return
    setDeleting(true)
    await supabase.from('deals').delete().eq('id', form.id as string)
    router.push('/deals')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!form) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-slate-500 text-lg">Deal not found</p>
          <Link href="/deals" className="text-blue-600 hover:underline text-sm mt-2 block">← Back to deals</Link>
        </div>
      </div>
    )
  }

  const statusClass = STATUS_COLORS[form.status || ''] || 'bg-gray-100 text-gray-600'

  return (
    <div className="p-6 max-w-5xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1 mr-4">
          <Link href="/deals" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 transition-colors w-fit">
            <ArrowLeft className="w-3.5 h-3.5" /> All Deals
          </Link>

          {/* Editable name */}
          <input
            value={form.name || ''}
            onChange={e => set('name', e.target.value)}
            className="text-2xl font-bold text-slate-900 focus:outline-none bg-transparent border-b-2 border-transparent focus:border-blue-400 w-full pb-0.5 transition-colors hover:border-slate-300"
            placeholder="Borrower Name"
          />

          {/* Status + Group selects inline */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <select
              value={form.status || ''}
              onChange={e => set('status', e.target.value)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${statusClass}`}
            >
              {LOAN_STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
            <select
              value={form.pipeline_group || ''}
              onChange={e => set('pipeline_group', e.target.value)}
              className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-100 text-slate-600 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PIPELINE_GROUPS.map(g => <option key={g}>{g}</option>)}
            </select>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDelete}
            disabled={deleting}
            title="Delete deal"
            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg transition-all ${
              saved
                ? 'bg-emerald-500 text-white'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            } disabled:opacity-60`}
          >
            <Check className="w-4 h-4" />
            {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* ── Left column ─────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Loan Details */}
          <Card title="Loan Details">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Loan Type">
                <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  {LOAN_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Loan Amount ($)">
                <input type="number" value={form.loan_amount ?? ''} onChange={e => set('loan_amount', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Estimated Value ($)">
                <input type="number" value={form.estimated_value ?? ''} onChange={e => set('estimated_value', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Revenue ($)">
                <input type="number" value={form.revenue ?? ''} onChange={e => set('revenue', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Rate (%)">
                <input type="number" step="0.001" value={form.rate ?? ''} onChange={e => set('rate', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="6.500" />
              </Field>
              <Field label="Investor">
                <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inp} placeholder="e.g. Rocket, Figure" />
              </Field>
              <Field label="Occupancy">
                <select value={form.occupancy || ''} onChange={e => set('occupancy', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  {OCCUPANCY_TYPES.map(o => <option key={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="Broker / Correspondent">
                <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="Broker">Broker</option>
                  <option value="Correspondent">Correspondent</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* Lock & Appraisal */}
          <Card title="Lock & Appraisal">
            <div className="grid grid-cols-2 gap-4">
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
                  <option value="">— Select —</option>
                  {APPRAISAL_STATUSES.map(a => <option key={a}>{a}</option>)}
                </select>
              </Field>
            </div>
          </Card>

          {/* File Numbers */}
          <Card title="File Numbers">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Arive File #">
                <input value={form.arive_file_no || ''} onChange={e => set('arive_file_no', e.target.value)} className={inp} />
              </Field>
              <Field label="Investor File #">
                <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inp} />
              </Field>
            </div>
          </Card>

          {/* Notes */}
          <Card title="Notes">
            <div className="space-y-4">
              <Field label="LO Notes">
                <textarea
                  value={form.lo_notes || ''}
                  onChange={e => set('lo_notes', e.target.value)}
                  rows={3}
                  className={inp + ' resize-none'}
                  placeholder="Internal loan officer notes…"
                />
              </Field>
              <Field label="Client Notes">
                <textarea
                  value={form.client_notes || ''}
                  onChange={e => set('client_notes', e.target.value)}
                  rows={3}
                  className={inp + ' resize-none'}
                  placeholder="Client-facing notes…"
                />
              </Field>
            </div>
          </Card>
        </div>

        {/* ── Right column ─────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Borrower */}
          <Card title="Borrower">
            <div className="space-y-3">
              <Field label="Email">
                <input type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} className={inp} placeholder="borrower@email.com" />
              </Field>
              <Field label="Phone">
                <input value={form.phone || ''} onChange={e => set('phone', e.target.value)} className={inp} placeholder="(555) 555-5555" />
              </Field>
              <Field label="Property Address">
                <input value={form.property_address || ''} onChange={e => set('property_address', e.target.value)} className={inp} placeholder="123 Main St, City, CA" />
              </Field>
              <Field label="Credit Score">
                <input type="number" value={form.credit_score ?? ''} onChange={e => set('credit_score', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="720" />
              </Field>
            </div>
          </Card>

          {/* Team */}
          <Card title="Team">
            <div className="space-y-3">
              <Field label="Loan Officer">
                <select value={form.loan_officer || ''} onChange={e => set('loan_officer', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  {LOAN_OFFICERS.map(lo => <option key={lo}>{lo}</option>)}
                </select>
              </Field>
              <Field label="Processor">
                <select value={form.processor_status || ''} onChange={e => set('processor_status', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="Lexi - 3rd party">Lexi - 3rd party</option>
                  <option value="Hanh - 3rd party">Hanh - 3rd party</option>
                  <option value="Susan - In house">Susan - In house</option>
                  <option value="Self Processing">Self Processing</option>
                </select>
              </Field>
              <Field label="Source">
                <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="GHL">GHL</option>
                  <option value="Self Source">Self Source</option>
                  <option value="Referral">Referral</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* Key Dates */}
          <Card title="Key Dates">
            <div className="space-y-3">
              <Field label="Signing Date">
                <input type="date" value={form.signing_date || ''} onChange={e => set('signing_date', e.target.value)} className={inp} />
              </Field>
              <Field label="Funded Date">
                <input type="date" value={form.funded_date || ''} onChange={e => set('funded_date', e.target.value)} className={inp} />
              </Field>
              <Field label="Paid Date">
                <input type="date" value={form.paid_date || ''} onChange={e => set('paid_date', e.target.value)} className={inp} />
              </Field>
              <Field label="Last Contacted">
                <input type="date" value={form.last_contacted || ''} onChange={e => set('last_contacted', e.target.value)} className={inp} />
              </Field>
              <div className="pt-1 border-t border-slate-100">
                <p className="text-xs text-slate-400 mt-2">
                  Added: {form.created_at ? new Date(form.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                </p>
              </div>
            </div>
          </Card>

          {/* Documents */}
          <Card title="Documents">
            <Field label="Document Upload Link">
              <input value={form.document_upload_link || ''} onChange={e => set('document_upload_link', e.target.value)} className={inp} placeholder="https://…" />
            </Field>
          </Card>
        </div>
      </div>

      {/* Sticky save bar at bottom for convenience */}
      <div className="mt-8 pb-8 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-2 px-6 py-2.5 text-sm font-semibold rounded-lg transition-all shadow-sm ${
            saved ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'
          } disabled:opacity-60`}
        >
          <Check className="w-4 h-4" />
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
