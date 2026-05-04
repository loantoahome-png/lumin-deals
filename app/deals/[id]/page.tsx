'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Deal, STATUS_COLORS, LOAN_STATUSES, PIPELINE_GROUPS,
  LOAN_OFFICERS, LOAN_TYPES, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import { formatCurrency, formatDate, formatPercent } from '@/lib/utils'
import Link from 'next/link'
import { use } from 'react'
import { ArrowLeft, Pencil, Check, X, Phone, Mail, MapPin, ExternalLink, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

// ── Input styles ──────────────────────────────────────────────────────────────
const inp = 'w-full px-2.5 py-1.5 border border-blue-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white'
const sel = inp

// ── Sub-components ────────────────────────────────────────────────────────────
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function V({ label, value, highlight }: { label: string; value: string | null | undefined; highlight?: 'green' }) {
  return (
    <div className="flex flex-col gap-0.5 mb-3 last:mb-0">
      <span className="text-xs text-slate-400 font-medium">{label}</span>
      <span className={`text-sm font-medium ${highlight === 'green' ? 'text-emerald-700' : 'text-slate-800'}`}>
        {value || '—'}
      </span>
    </div>
  )
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [form, setForm] = useState<Partial<Deal>>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    async function fetchDeal() {
      const { data } = await supabase.from('deals').select('*').eq('id', id).single()
      setDeal(data)
      setForm(data || {})
      setLoading(false)
    }
    fetchDeal()
  }, [id])

  function set<K extends keyof Deal>(key: K, value: Deal[K] | string) {
    setForm(f => ({ ...f, [key]: value === '' ? null : value }))
  }

  function enterEdit() {
    setForm({ ...deal })
    setEditMode(true)
    setSaveError('')
  }

  function cancelEdit() {
    setForm({ ...deal })
    setEditMode(false)
    setSaveError('')
  }

  async function saveChanges() {
    if (!deal) return
    setSaving(true)
    setSaveError('')
    const { error } = await supabase.from('deals').update(form).eq('id', deal.id)
    if (error) { setSaveError(error.message); setSaving(false); return }
    const updated = { ...deal, ...form } as Deal
    setDeal(updated)
    setForm(updated)
    setEditMode(false)
    setSaving(false)
  }

  async function handleDelete() {
    if (!deal) return
    if (!confirm(`Delete deal for ${deal.name}? This cannot be undone.`)) return
    setDeleting(true)
    await supabase.from('deals').delete().eq('id', deal.id)
    router.push('/deals')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!deal) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-slate-500 text-lg">Deal not found</p>
          <Link href="/deals" className="text-blue-600 hover:underline text-sm mt-2 block">← Back to deals</Link>
        </div>
      </div>
    )
  }

  const displayStatus = (editMode ? form.status : deal.status) || deal.status
  const statusClass = STATUS_COLORS[displayStatus] || 'bg-gray-100 text-gray-600'

  return (
    <div className="p-6 max-w-5xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1 mr-4">
          <Link href="/deals" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-2 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> All Deals
          </Link>

          {editMode ? (
            <input
              value={form.name || ''}
              onChange={e => set('name', e.target.value)}
              className="text-2xl font-bold text-slate-900 border-b-2 border-blue-400 focus:outline-none bg-transparent w-full pb-1"
            />
          ) : (
            <h1 className="text-2xl font-bold text-slate-900">{deal.name}</h1>
          )}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {editMode ? (
              <>
                <select
                  value={form.status || ''}
                  onChange={e => set('status', e.target.value)}
                  className="text-sm px-2.5 py-1 rounded-lg border border-blue-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  {LOAN_STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
                <select
                  value={form.pipeline_group || ''}
                  onChange={e => set('pipeline_group', e.target.value)}
                  className="text-sm px-2.5 py-1 rounded-lg border border-blue-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  {PIPELINE_GROUPS.map(g => <option key={g}>{g}</option>)}
                </select>
              </>
            ) : (
              <>
                <span className={`text-sm px-2.5 py-1 rounded-lg font-medium ${statusClass}`}>{deal.status}</span>
                <span className="text-sm text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg">{deal.pipeline_group}</span>
              </>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {editMode ? (
            <>
              <button
                onClick={cancelEdit}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <X className="w-4 h-4" /> Cancel
              </button>
              <button
                onClick={saveChanges}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleDelete}
                disabled={deleting}
                title="Delete deal"
                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={enterEdit}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Pencil className="w-4 h-4" /> Edit
              </button>
            </>
          )}
        </div>
      </div>

      {saveError && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{saveError}</div>
      )}

      {editMode && (
        <div className="mb-4 bg-blue-50 border border-blue-200 text-blue-700 text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <Pencil className="w-4 h-4 shrink-0" />
          Edit mode — all fields are now editable. Click <strong>Save Changes</strong> when done.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* ── Left column ────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Loan Details */}
          <InfoCard title="Loan Details">
            <div className="grid grid-cols-2 gap-4">
              {editMode ? (
                <>
                  <F label="Loan Type">
                    <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={sel}>
                      <option value="">— Select —</option>
                      {LOAN_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                  </F>
                  <F label="Loan Amount ($)">
                    <input type="number" value={form.loan_amount ?? ''} onChange={e => set('loan_amount', e.target.value ? Number(e.target.value) : null as unknown as string)} className={inp} placeholder="0" />
                  </F>
                  <F label="Estimated Value ($)">
                    <input type="number" value={form.estimated_value ?? ''} onChange={e => set('estimated_value', e.target.value ? Number(e.target.value) : null as unknown as string)} className={inp} placeholder="0" />
                  </F>
                  <F label="Revenue ($)">
                    <input type="number" value={form.revenue ?? ''} onChange={e => set('revenue', e.target.value ? Number(e.target.value) : null as unknown as string)} className={inp} placeholder="0" />
                  </F>
                  <F label="Rate (%)">
                    <input type="number" step="0.001" value={form.rate ?? ''} onChange={e => set('rate', e.target.value ? Number(e.target.value) : null as unknown as string)} className={inp} placeholder="6.500" />
                  </F>
                  <F label="Investor">
                    <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inp} placeholder="e.g. Rocket, Figure" />
                  </F>
                  <F label="Occupancy">
                    <select value={form.occupancy || ''} onChange={e => set('occupancy', e.target.value)} className={sel}>
                      <option value="">— Select —</option>
                      {OCCUPANCY_TYPES.map(o => <option key={o}>{o}</option>)}
                    </select>
                  </F>
                  <F label="Broker / Correspondent">
                    <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={sel}>
                      <option value="">— Select —</option>
                      <option value="Broker">Broker</option>
                      <option value="Correspondent">Correspondent</option>
                    </select>
                  </F>
                </>
              ) : (
                <>
                  <V label="Loan Type" value={deal.loan_type} />
                  <V label="Loan Amount" value={formatCurrency(deal.loan_amount)} />
                  <V label="Estimated Value" value={formatCurrency(deal.estimated_value)} />
                  <V label="Revenue" value={formatCurrency(deal.revenue)} highlight="green" />
                  <V label="Rate" value={formatPercent(deal.rate)} />
                  <V label="Investor" value={deal.investor} />
                  <V label="Occupancy" value={deal.occupancy} />
                  <V label="Broker / Corr" value={deal.broker_corr} />
                </>
              )}
            </div>
          </InfoCard>

          {/* Lock & Appraisal */}
          <InfoCard title="Lock & Appraisal">
            <div className="grid grid-cols-2 gap-4">
              {editMode ? (
                <>
                  <F label="Locked?">
                    <select value={form.locked || 'No'} onChange={e => set('locked', e.target.value)} className={sel}>
                      <option value="No">No</option>
                      <option value="Yes">Yes</option>
                      <option value="NA">N/A</option>
                    </select>
                  </F>
                  <F label="Lock Expiration">
                    <input type="date" value={form.lock_expiration || ''} onChange={e => set('lock_expiration', e.target.value)} className={inp} />
                  </F>
                  <F label="Appraisal Status">
                    <select value={form.appraisal_status || ''} onChange={e => set('appraisal_status', e.target.value)} className={sel}>
                      {APPRAISAL_STATUSES.map(a => <option key={a}>{a}</option>)}
                    </select>
                  </F>
                </>
              ) : (
                <>
                  <V label="Locked" value={deal.locked} />
                  <V label="Lock Expiration" value={formatDate(deal.lock_expiration)} />
                  <V label="Appraisal Status" value={deal.appraisal_status} />
                </>
              )}
            </div>
          </InfoCard>

          {/* File Numbers */}
          <InfoCard title="File Numbers">
            <div className="grid grid-cols-2 gap-4">
              {editMode ? (
                <>
                  <F label="Arive File #">
                    <input value={form.arive_file_no || ''} onChange={e => set('arive_file_no', e.target.value)} className={inp} />
                  </F>
                  <F label="Investor File #">
                    <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inp} />
                  </F>
                </>
              ) : (
                <>
                  <V label="Arive File #" value={deal.arive_file_no} />
                  <V label="Investor File #" value={deal.investor_file_no} />
                </>
              )}
            </div>
          </InfoCard>

          {/* Notes */}
          <InfoCard title="Notes">
            {editMode ? (
              <div className="space-y-3">
                <F label="LO Notes">
                  <textarea value={form.lo_notes || ''} onChange={e => set('lo_notes', e.target.value)} rows={3} className={inp + ' resize-none'} placeholder="Internal loan officer notes…" />
                </F>
                <F label="Client Notes">
                  <textarea value={form.client_notes || ''} onChange={e => set('client_notes', e.target.value)} rows={3} className={inp + ' resize-none'} placeholder="Client-facing notes…" />
                </F>
              </div>
            ) : (
              <>
                {deal.lo_notes ? (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-slate-400 mb-1">LO Notes</p>
                    <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap">{deal.lo_notes}</p>
                  </div>
                ) : null}
                {deal.client_notes ? (
                  <div>
                    <p className="text-xs font-medium text-slate-400 mb-1">Client Notes</p>
                    <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap">{deal.client_notes}</p>
                  </div>
                ) : null}
                {!deal.lo_notes && !deal.client_notes && (
                  <p className="text-slate-400 text-sm">No notes yet. Click <strong>Edit</strong> to add.</p>
                )}
              </>
            )}
          </InfoCard>
        </div>

        {/* ── Right column ─────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Borrower Contact */}
          <InfoCard title="Borrower">
            {editMode ? (
              <div className="space-y-2">
                <F label="Email">
                  <input type="email" value={form.email || ''} onChange={e => set('email', e.target.value)} className={inp} placeholder="borrower@email.com" />
                </F>
                <F label="Phone">
                  <input value={form.phone || ''} onChange={e => set('phone', e.target.value)} className={inp} placeholder="(555) 555-5555" />
                </F>
                <F label="Property Address">
                  <input value={form.property_address || ''} onChange={e => set('property_address', e.target.value)} className={inp} placeholder="123 Main St" />
                </F>
                <F label="Credit Score">
                  <input type="number" value={form.credit_score ?? ''} onChange={e => set('credit_score', e.target.value ? Number(e.target.value) : null as unknown as string)} className={inp} placeholder="720" />
                </F>
              </div>
            ) : (
              <>
                {deal.email && (
                  <a href={`mailto:${deal.email}`} className="flex items-center gap-2 text-sm text-blue-600 hover:underline mb-2">
                    <Mail className="w-3.5 h-3.5" /> {deal.email}
                  </a>
                )}
                {deal.phone && (
                  <a href={`tel:${deal.phone}`} className="flex items-center gap-2 text-sm text-blue-600 hover:underline mb-2">
                    <Phone className="w-3.5 h-3.5" /> {deal.phone}
                  </a>
                )}
                {deal.property_address && (
                  <div className="flex items-start gap-2 text-sm text-slate-600 mb-2">
                    <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                    <span>{deal.property_address}</span>
                  </div>
                )}
                {deal.credit_score && (
                  <div className="text-sm text-slate-600">
                    <span className="text-xs text-slate-400 block mb-0.5">Credit Score</span>
                    <span className="font-medium">{deal.credit_score}</span>
                  </div>
                )}
                {!deal.email && !deal.phone && !deal.property_address && (
                  <p className="text-slate-400 text-sm">No contact info. Click <strong>Edit</strong> to add.</p>
                )}
              </>
            )}
          </InfoCard>

          {/* Team */}
          <InfoCard title="Team">
            {editMode ? (
              <div className="space-y-2">
                <F label="Loan Officer">
                  <select value={form.loan_officer || ''} onChange={e => set('loan_officer', e.target.value)} className={sel}>
                    <option value="">— Select —</option>
                    {LOAN_OFFICERS.map(lo => <option key={lo}>{lo}</option>)}
                  </select>
                </F>
                <F label="Processor">
                  <select value={form.processor_status || ''} onChange={e => set('processor_status', e.target.value)} className={sel}>
                    <option value="">— Select —</option>
                    <option value="Lexi - 3rd party">Lexi - 3rd party</option>
                    <option value="Hanh - 3rd party">Hanh - 3rd party</option>
                    <option value="Susan - In house">Susan - In house</option>
                    <option value="Self Processing">Self Processing</option>
                  </select>
                </F>
                <F label="Source">
                  <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={sel}>
                    <option value="">— Select —</option>
                    <option value="GHL">GHL</option>
                    <option value="Self Source">Self Source</option>
                    <option value="Referral">Referral</option>
                  </select>
                </F>
              </div>
            ) : (
              <>
                <V label="Loan Officer" value={deal.loan_officer} />
                <V label="Processor" value={deal.processor_status} />
                <V label="Source" value={deal.source} />
              </>
            )}
          </InfoCard>

          {/* Key Dates */}
          <InfoCard title="Key Dates">
            {editMode ? (
              <div className="space-y-2">
                <F label="Signing Date">
                  <input type="date" value={form.signing_date || ''} onChange={e => set('signing_date', e.target.value)} className={inp} />
                </F>
                <F label="Funded Date">
                  <input type="date" value={form.funded_date || ''} onChange={e => set('funded_date', e.target.value)} className={inp} />
                </F>
                <F label="Paid Date">
                  <input type="date" value={form.paid_date || ''} onChange={e => set('paid_date', e.target.value)} className={inp} />
                </F>
                <F label="Last Contacted">
                  <input type="date" value={form.last_contacted || ''} onChange={e => set('last_contacted', e.target.value)} className={inp} />
                </F>
              </div>
            ) : (
              <>
                <V label="Signing Date" value={formatDate(deal.signing_date)} />
                <V label="Funded Date" value={formatDate(deal.funded_date)} />
                <V label="Paid Date" value={formatDate(deal.paid_date)} />
                <V label="Last Contacted" value={formatDate(deal.last_contacted)} />
                <V label="Added" value={formatDate(deal.created_at)} />
              </>
            )}
          </InfoCard>

          {/* Document Link */}
          <InfoCard title="Documents">
            {editMode ? (
              <F label="Document Upload Link">
                <input value={form.document_upload_link || ''} onChange={e => set('document_upload_link', e.target.value)} className={inp} placeholder="https://…" />
              </F>
            ) : deal.document_upload_link ? (
              <a
                href={deal.document_upload_link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Upload Documents
              </a>
            ) : (
              <p className="text-slate-400 text-sm">No link set.</p>
            )}
          </InfoCard>
        </div>
      </div>
    </div>
  )
}
