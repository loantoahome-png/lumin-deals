'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Deal, STATUS_COLORS, PIPELINE_GROUPS, PIPELINE_STATUSES,
  LOAN_OFFICERS, LOAN_TYPES, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import Link from 'next/link'
import { use } from 'react'
import {
  ArrowLeft, Check, Trash2, X, ExternalLink,
  DollarSign, Home, Lock, Hash, User, Users,
  Calendar, Bell, MessageSquare,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import LoanHistory from '@/components/LoanHistory'

// ── Format helpers ──────────────────────────────────────────────────────────
function fmtMoneyShort(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n.toLocaleString()}`
}
function initialsFrom(name: string | null | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?'
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

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

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

function CurrencyInput({ value, onChange }: {
  value: number | null | undefined
  onChange: (n: number | null) => void
}) {
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

function PercentInput({ value, onChange, step = '0.01' }: {
  value: number | null | undefined
  onChange: (n: number | null) => void
  step?: string
}) {
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

  // Hero KPI computations
  const ageDays = form.created_at ? Math.floor((Date.now() - new Date(form.created_at).getTime()) / 86400000) : null
  const ageLabel = ageDays === null ? '—' : ageDays === 0 ? 'Today' : `${ageDays}d`

  return (
    <div className="p-6 max-w-6xl mx-auto">

      {/* ── Back link ─────────────────────────────────────────────── */}
      <Link href="/deals" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 transition-colors w-fit">
        <ArrowLeft className="w-3.5 h-3.5" /> All Deals
      </Link>

      {/* ── Hero card ─────────────────────────────────────────────── */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 rounded-2xl shadow-sm overflow-hidden text-white mb-5">
        {/* Top row: avatar + name + actions */}
        <div className="px-6 pt-5 pb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 flex-1 min-w-0">
            {/* Avatar */}
            <div className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-lg font-bold shadow-md">
              {initialsFrom(form.name as string | null)}
            </div>
            <div className="flex-1 min-w-0">
              <input
                value={form.name || ''}
                onChange={e => set('name', e.target.value)}
                className="text-2xl font-bold text-white focus:outline-none bg-transparent border-b-2 border-transparent focus:border-blue-400 w-full pb-0.5 transition-colors hover:border-slate-700 capitalize"
                placeholder="Borrower Name"
              />
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <select
                  value={form.status || ''}
                  onChange={e => set('status', e.target.value)}
                  className={`text-xs font-semibold px-2.5 py-1 rounded-md border-0 focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer ${statusClass}`}
                >
                  {form.status && !(PIPELINE_STATUSES[form.pipeline_group || ''] || []).includes(form.status) && (
                    <option value={form.status}>{form.status} ⚠ (legacy)</option>
                  )}
                  {(PIPELINE_STATUSES[form.pipeline_group || ''] || []).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={form.pipeline_group || ''}
                  onChange={e => {
                    const pg = e.target.value
                    const firstStatus = PIPELINE_STATUSES[pg]?.[0] || ''
                    setForm(f => f ? { ...f, pipeline_group: pg, status: firstStatus } : f)
                    setSaved(false)
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border-0 bg-slate-700/60 text-slate-200 font-medium focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
                >
                  {form.pipeline_group && !(PIPELINE_GROUPS as readonly string[]).includes(form.pipeline_group) && (
                    <option value={form.pipeline_group}>{form.pipeline_group} ⚠ (legacy)</option>
                  )}
                  {PIPELINE_GROUPS.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {form.ghl_contact_id && (
              <a
                href={`${process.env.NEXT_PUBLIC_GHL_BASE_URL}/v2/location/${process.env.NEXT_PUBLIC_GHL_LOCATION_ID}/contacts/detail/${form.ghl_contact_id}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in GoHighLevel"
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-200 bg-blue-500/10 border border-blue-400/30 rounded-lg hover:bg-blue-500/20 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" /> View in GHL
              </a>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="Delete deal"
              className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg transition-all shadow-sm ${
                saved ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white hover:bg-blue-500'
              } disabled:opacity-60`}
            >
              <Check className="w-4 h-4" />
              {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div className="border-t border-slate-700/70 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 divide-x divide-slate-700/70">
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Loan Amount</p>
            <p className="text-lg font-bold mt-0.5">{fmtMoneyShort(form.loan_amount as number | null)}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Property Value</p>
            <p className="text-lg font-bold mt-0.5">{fmtMoneyShort(form.estimated_value as number | null)}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">LTV</p>
            <p className="text-lg font-bold mt-0.5">{form.ltv != null ? `${Number(form.ltv).toFixed(2)}%` : '—'}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">FICO</p>
            <p className="text-lg font-bold mt-0.5">{form.credit_score ?? '—'}</p>
          </div>
          <div className="px-5 py-3 col-span-2 sm:col-span-1">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">LO · Age</p>
            <p className="text-sm font-semibold mt-0.5 truncate">
              {(form.loan_officer as string | null) ?? <span className="text-slate-500">No LO</span>} · <span className="text-slate-300 font-normal">{ageLabel}</span>
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      {/* ── One unified card containing all sections ─────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-3">

          {/* ── Left column (2/3) ────────────────────────────────── */}
          <div className="lg:col-span-2 divide-y divide-slate-200">

            {/* Loan Details */}
            <Section title="Loan Details" icon={<DollarSign className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Loan Purpose">
                  <select value={form.loan_purpose || ''} onChange={e => set('loan_purpose', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="Purchase">Purchase</option>
                    <option value="Refinance">Refinance</option>
                    <option value="Cash-Out Refinance">Cash-Out Refinance</option>
                    <option value="HELOC">HELOC</option>
                  </select>
                </Field>
                <Field label="Loan Type">
                  <select value={form.loan_type || ''} onChange={e => set('loan_type', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {LOAN_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="Loan Amount">
                  <CurrencyInput value={form.loan_amount as number | null} onChange={v => set('loan_amount', v)} />
                </Field>
                <Field label="Property Value">
                  <CurrencyInput value={form.estimated_value as number | null} onChange={v => set('estimated_value', v)} />
                </Field>
                <Field label="Current Balance">
                  <CurrencyInput value={form.current_balance as number | null} onChange={v => set('current_balance', v)} />
                </Field>
                <Field label="LTV">
                  <PercentInput value={form.ltv as number | null} onChange={v => set('ltv', v)} step="0.01" />
                </Field>
                <Field label="Cash Out">
                  <CurrencyInput value={form.cash_out as number | null} onChange={v => set('cash_out', v)} />
                </Field>
                <Field label="Down Payment">
                  <CurrencyInput value={form.down_payment as number | null} onChange={v => set('down_payment', v)} />
                </Field>
                <Field label="Rate">
                  <PercentInput value={form.rate as number | null} onChange={v => set('rate', v)} step="0.001" />
                </Field>
                <Field label="Investor">
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
                    <option value="GHL">GHL</option>
                    <option value="Self Source">Self Source</option>
                    <option value="Referral">Referral</option>
                    <option value="Past Client">Past Client</option>
                    <option value="Open House">Open House</option>
                    <option value="Agent Partner">Agent Partner</option>
                  </select>
                </Field>
              </div>
            </Section>

            {/* Property Details */}
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
                    <option value="">—</option>
                    {APPRAISAL_STATUSES.map(a => <option key={a}>{a}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            {/* File Numbers */}
            <Section title="File Numbers" icon={<Hash className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Arive File #">
                  <input value={form.arive_file_no || ''} onChange={e => set('arive_file_no', e.target.value)} className={inp} />
                </Field>
                <Field label="Investor File #">
                  <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inp} />
                </Field>
              </div>
            </Section>

            {/* Notes */}
            <Section title="Notes" icon={<MessageSquare className="w-4 h-4" />}>
              <DealNotes dealId={id} initialNotes={form.lo_notes ?? null} />
            </Section>
          </div>

          {/* ── Right column (1/3) ───────────────────────────────── */}
          <div className="lg:border-l border-slate-200 divide-y divide-slate-200">

            {/* Borrower */}
            <Section title="Borrower" icon={<User className="w-4 h-4" />}>
              <div className="space-y-3">
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
                <Field label="Current VA Loan">
                  <select value={form.current_va_loan || ''} onChange={e => set('current_va_loan', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </Field>
              </div>
            </Section>

            {/* Rate Watch */}
            <Section title="Rate Watch" icon={<Bell className="w-4 h-4" />}>
              <div className="space-y-3">
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

                <Field label="10-Year Treasury Yield at Close (%)">
                  <input
                    type="number"
                    step="0.01"
                    value={form.rate_at_close_10yr ?? ''}
                    onChange={e => set('rate_at_close_10yr', e.target.value ? Number(e.target.value) : null)}
                    className={inp}
                  />
                </Field>

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

                {form.rate_watch_active && (
                  <Field label="Rate Watch Notes">
                    <textarea
                      value={form.rate_watch_notes || ''}
                      onChange={e => set('rate_watch_notes', e.target.value)}
                      rows={2}
                      className={inp + ' resize-none'}
                    />
                  </Field>
                )}

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
            </Section>

            {/* Team */}
            <Section title="Team" icon={<Users className="w-4 h-4" />}>
              <div className="space-y-3">
                <Field label="Loan Officer">
                  <select value={form.loan_officer || ''} onChange={e => set('loan_officer', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {LOAN_OFFICERS.map(lo => <option key={lo}>{lo}</option>)}
                  </select>
                </Field>
                <Field label="Processor">
                  <select value={form.processor_status || ''} onChange={e => set('processor_status', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="Lexi - 3rd party">Lexi - 3rd party</option>
                    <option value="Hanh - 3rd party">Hanh - 3rd party</option>
                    <option value="Susan - In house">Susan - In house</option>
                    <option value="Self Processing">Self Processing</option>
                  </select>
                </Field>
              </div>
            </Section>

            {/* Key Dates */}
            <Section title="Key Dates" icon={<Calendar className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Signing">
                  <input type="date" value={form.signing_date || ''} onChange={e => set('signing_date', e.target.value)} className={inp} />
                </Field>
                <Field label="Funded">
                  <input type="date" value={form.funded_date || ''} onChange={e => set('funded_date', e.target.value)} className={inp} />
                </Field>
                <Field label="Paid">
                  <input type="date" value={form.paid_date || ''} onChange={e => set('paid_date', e.target.value)} className={inp} />
                </Field>
                <Field label="Last Contact">
                  <input type="date" value={form.last_contacted || ''} onChange={e => set('last_contacted', e.target.value)} className={inp} />
                </Field>
              </div>
              <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
                Added {form.created_at ? new Date(form.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
              </p>
            </Section>
          </div>
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
