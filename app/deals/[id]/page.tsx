'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Deal, STATUS_COLORS, PIPELINE_GROUPS, PIPELINE_STATUSES,
  LOAN_OFFICERS, LOAN_TYPES, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import Link from 'next/link'
import { use } from 'react'
import { ArrowLeft, Check, Trash2, X, ExternalLink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import LoanHistory from '@/components/LoanHistory'

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

// ── Timestamped Notes ────────────────────────────────────────────────────────

type DealNote = { id: string; content: string; created_at: string }

function parseNotes(raw: string | null): DealNote[] {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as DealNote[]
  } catch { /* not JSON */ }
  // Legacy plain text → migrate to single note entry
  return [{ id: 'legacy', content: raw.trim(), created_at: new Date().toISOString() }]
}

function DealNotes({ dealId, initialNotes }: { dealId: string; initialNotes: string | null }) {
  const [notes, setNotes] = useState<DealNote[]>(() => parseNotes(initialNotes))
  const [newNote, setNewNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  async function persistNotes(updated: DealNote[]) {
    await supabase.from('deals')
      .update({ lo_notes: JSON.stringify(updated) })
      .eq('id', dealId)
  }

  async function handleSaveNote() {
    const trimmed = newNote.trim()
    if (!trimmed) return
    setSaving(true)
    const note: DealNote = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      content: trimmed,
      created_at: new Date().toISOString(),
    }
    const updated = [note, ...notes]
    setNotes(updated)
    setNewNote('')
    await persistNotes(updated)
    setSaving(false)
    textareaRef.current?.focus()
  }

  async function handleDeleteNote(noteId: string) {
    setDeletingId(noteId)
    const updated = notes.filter(n => n.id !== noteId)
    setNotes(updated)
    await persistNotes(updated)
    setDeletingId(null)
  }

  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      })
    } catch { return iso }
  }

  return (
    <div className="space-y-4">
      {/* New note composer */}
      <div>
        <textarea
          ref={textareaRef}
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveNote() }}
          rows={3}
          placeholder="Write a note…"
          className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors resize-none placeholder:text-slate-400"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px] text-slate-400">⌘+Enter to save</span>
          <button
            onClick={handleSaveNote}
            disabled={!newNote.trim() || saving}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {saving
              ? <><div className="animate-spin rounded-full h-3 w-3 border border-white border-b-transparent mr-1" />Saving…</>
              : 'Save Note →'
            }
          </button>
        </div>
      </div>

      {/* Notes timeline */}
      {notes.length > 0 ? (
        <div className="space-y-4 pt-3 border-t border-slate-100">
          {notes.map(note => (
            <div key={note.id} className="group">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">
                  {formatDate(note.created_at)}
                </span>
                <div className="flex-1 h-px bg-slate-100" />
                <button
                  onClick={() => handleDeleteNote(note.id)}
                  disabled={deletingId === note.id}
                  title="Delete note"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-300 hover:text-red-400 p-0.5 rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed pl-0.5">
                {note.content}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center py-4 text-slate-400 text-xs">No notes yet — add the first one above.</p>
      )}
    </div>
  )
}

// ── Deal Detail Page ──────────────────────────────────────────────────────────

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

  function set<K extends keyof Deal>(key: K, value: Deal[K] | string | number | null) {
    setSaved(false)
    setForm(f => f ? { ...f, [key]: value === '' ? null : value } : f)
  }

  async function handleSave() {
    if (!form) return
    setSaving(true)
    setError('')
    // Exclude lo_notes and client_notes — those are managed independently by DealNotes
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lo_notes: _ln, client_notes: _cn, ...formData } = form
    const { error: err } = await supabase.from('deals').update(formData).eq('id', form.id as string)
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

          <input
            value={form.name || ''}
            onChange={e => set('name', e.target.value)}
            className="text-2xl font-bold text-slate-900 focus:outline-none bg-transparent border-b-2 border-transparent focus:border-blue-400 w-full pb-0.5 transition-colors hover:border-slate-300"
            placeholder="Borrower Name"
          />

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {/* Status — filtered to only valid stages for the current pipeline */}
            <select
              value={form.status || ''}
              onChange={e => set('status', e.target.value)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${statusClass}`}
            >
              {/* Show legacy value at top if it doesn't belong to the current pipeline */}
              {form.status && !(PIPELINE_STATUSES[form.pipeline_group || ''] || []).includes(form.status) && (
                <option value={form.status}>{form.status} ⚠ (legacy)</option>
              )}
              {(PIPELINE_STATUSES[form.pipeline_group || ''] || []).map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {/* Pipeline — changing it resets status to the first valid stage */}
            <select
              value={form.pipeline_group || ''}
              onChange={e => {
                const pg = e.target.value
                const firstStatus = PIPELINE_STATUSES[pg]?.[0] || ''
                setForm(f => f ? { ...f, pipeline_group: pg, status: firstStatus } : f)
                setSaved(false)
              }}
              className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-100 text-slate-600 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Show legacy pipeline_group if not in valid list */}
              {form.pipeline_group && !(PIPELINE_GROUPS as readonly string[]).includes(form.pipeline_group) && (
                <option value={form.pipeline_group}>{form.pipeline_group} ⚠ (legacy)</option>
              )}
              {PIPELINE_GROUPS.map(g => <option key={g}>{g}</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* View in GHL — only shown when contact is synced from GHL */}
          {form.ghl_contact_id && (
            <a
              href={`${process.env.NEXT_PUBLIC_GHL_BASE_URL}/v2/location/${process.env.NEXT_PUBLIC_GHL_LOCATION_ID}/contacts/detail/${form.ghl_contact_id}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in GoHighLevel"
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 hover:border-blue-300 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View in GHL
            </a>
          )}
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
              saved ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'
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
              <Field label="Loan Purpose">
                <select value={form.loan_purpose || ''} onChange={e => set('loan_purpose', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="Purchase">Purchase</option>
                  <option value="Refinance">Refinance</option>
                  <option value="Cash-Out Refinance">Cash-Out Refinance</option>
                  <option value="HELOC">HELOC</option>
                </select>
              </Field>
              <Field label="Loan Type">
                <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  {LOAN_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Loan Amount ($)">
                <input type="number" value={form.loan_amount ?? ''} onChange={e => set('loan_amount', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Estimated / Property Value ($)">
                <input type="number" value={form.estimated_value ?? ''} onChange={e => set('estimated_value', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Current Balance ($)">
                <input type="number" value={form.current_balance ?? ''} onChange={e => set('current_balance', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="LTV (%)">
                <input type="number" step="0.01" value={form.ltv ?? ''} onChange={e => set('ltv', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="e.g. 54.23" />
              </Field>
              <Field label="Cash Out ($)">
                <input type="number" value={form.cash_out ?? ''} onChange={e => set('cash_out', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Down Payment ($)">
                <input type="number" value={form.down_payment ?? ''} onChange={e => set('down_payment', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="0" />
              </Field>
              <Field label="Rate (%)">
                <input type="number" step="0.001" value={form.rate ?? ''} onChange={e => set('rate', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="6.500" />
              </Field>
              <Field label="Investor">
                <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inp} placeholder="e.g. Rocket, Figure" />
              </Field>
              <Field label="Broker / Correspondent">
                <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="Broker">Broker</option>
                  <option value="Correspondent">Correspondent</option>
                </select>
              </Field>
              <Field label="Source">
                <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="GHL">GHL</option>
                  <option value="Self Source">Self Source</option>
                  <option value="Referral">Referral</option>
                  <option value="Past Client">Past Client</option>
                  <option value="Open House">Open House</option>
                  <option value="Agent Partner">Agent Partner</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* Property Details */}
          <Card title="Property Details">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Property Address">
                <input value={form.property_address || ''} onChange={e => set('property_address', e.target.value)} className={inp} placeholder="123 Main St" />
              </Field>
              <Field label="City">
                <input value={form.city || ''} onChange={e => set('city', e.target.value)} className={inp} placeholder="City" />
              </Field>
              <Field label="State">
                <input value={form.state || ''} onChange={e => set('state', e.target.value)} className={inp} placeholder="CA" />
              </Field>
              <Field label="Zip">
                <input value={form.zip || ''} onChange={e => set('zip', e.target.value)} className={inp} placeholder="90210" />
              </Field>
              <Field label="Property Use / Occupancy">
                <select value={form.occupancy || ''} onChange={e => set('occupancy', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  {OCCUPANCY_TYPES.map(o => <option key={o}>{o}</option>)}
                  <option value="Primary Residence">Primary Residence</option>
                </select>
              </Field>
              <Field label="Property Type">
                <select value={form.property_type || ''} onChange={e => set('property_type', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
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
            <DealNotes dealId={id} initialNotes={form.lo_notes ?? null} />
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
              <Field label="Credit Score (FICO)">
                <input type="number" value={form.credit_score ?? ''} onChange={e => set('credit_score', e.target.value ? Number(e.target.value) : null)} className={inp} placeholder="720" />
              </Field>
              <Field label="Credit Rating">
                <select value={form.credit_rating || ''} onChange={e => set('credit_rating', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="Excellent">Excellent (750+)</option>
                  <option value="Good">Good (700–749)</option>
                  <option value="Fair">Fair (650–699)</option>
                  <option value="Poor">Poor (Below 650)</option>
                </select>
              </Field>
              <Field label="Is Military / Veteran">
                <select value={form.is_military || ''} onChange={e => set('is_military', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Current VA Loan">
                <select value={form.current_va_loan || ''} onChange={e => set('current_va_loan', e.target.value)} className={sel}>
                  <option value="">— Select —</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* Rate Watch */}
          <Card title="🔔 Rate Watch">
            <div className="space-y-3">
              {/* Toggle row */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">Active</p>
                  <p className="text-xs text-slate-400 mt-0.5">Alert when 10yr nears the rate at close</p>
                </div>
                <button
                  type="button"
                  onClick={() => set('rate_watch_active', !form.rate_watch_active)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                    form.rate_watch_active ? 'bg-blue-600' : 'bg-slate-200'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    form.rate_watch_active ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              {/* Always-visible close yield input */}
              <Field label="10-Year Treasury Yield at Close (%)">
                <input
                  type="number"
                  step="0.01"
                  value={form.rate_at_close_10yr ?? ''}
                  onChange={e => set('rate_at_close_10yr', e.target.value ? Number(e.target.value) : null)}
                  className={inp}
                  placeholder="e.g. 4.25"
                />
              </Field>

              {/* Alert threshold preview */}
              {form.rate_at_close_10yr != null && (
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
                  <p className="text-xs font-semibold text-blue-700 mb-0.5">Alert threshold</p>
                  <p className="text-xs text-blue-600 font-mono">
                    10yr drops to <strong>{(Number(form.rate_at_close_10yr) - 0.10).toFixed(2)}%</strong> or below
                  </p>
                  <p className="text-xs text-blue-500 mt-1">
                    That&apos;s 10 bps below the {Number(form.rate_at_close_10yr).toFixed(2)}% close rate — no alert if rates rise
                  </p>
                </div>
              )}

              {/* Notes */}
              {form.rate_watch_active && (
                <Field label="Rate Watch Notes">
                  <textarea
                    value={form.rate_watch_notes || ''}
                    onChange={e => set('rate_watch_notes', e.target.value)}
                    rows={2}
                    className={inp + ' resize-none'}
                    placeholder="e.g. Client wants to refi when rates drop to close range"
                  />
                </Field>
              )}

              {/* Last alert status */}
              {form.rate_watch_alerted_at ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800">⚡ Alert fired!</p>
                  <p className="text-xs text-amber-600 mt-0.5">
                    10yr entered window on {new Date(form.rate_watch_alerted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                  <button
                    type="button"
                    onClick={() => set('rate_watch_alerted_at', null)}
                    className="text-xs text-amber-700 underline mt-1"
                  >
                    Reset (watch for next crossing)
                  </button>
                </div>
              ) : form.rate_watch_active && form.rate_at_close_10yr != null ? (
                <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  Watching — no alert yet
                </div>
              ) : null}
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

      {/* Loan History — other loans for the same contact (matched by email/phone/name) */}
      <div className="mt-6">
        <LoanHistory
          currentDealId={form.id as string}
          email={form.email as string | null}
          phone={form.phone as string | null}
          firstName={form.first_name as string | null}
          lastName={form.last_name as string | null}
          name={form.name as string | null}
        />
      </div>

      {/* Bottom save bar */}
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
