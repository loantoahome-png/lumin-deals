'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { pushStageToGHL } from '@/lib/pushStage'
import {
  Deal, STATUS_COLORS, PIPELINE_GROUPS, PIPELINE_STATUSES,
  LOAN_OFFICERS, LOAN_TYPES, REFINANCE_TYPES, LIEN_POSITIONS, OCCUPANCY_TYPES, APPRAISAL_STATUSES,
} from '@/lib/types'
import Link from 'next/link'
import { use } from 'react'
import {
  ArrowLeft, Check, Trash2, X, ExternalLink,
  DollarSign, Home, Lock, Hash, User, Users,
  Calendar, MessageSquare, Building2, AlertOctagon, ClipboardList, Flame,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import LoanHistory from '@/components/LoanHistory'
import NextStepLog from '@/components/NextStepLog'
import CoborrowerManager from '@/components/CoborrowerManager'
import RealEstateOwned from '@/components/RealEstateOwned'
import ConversationThread from '@/components/ConversationThread'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { isChannelBlocked, dndLabel } from '@/lib/utils'
import DealTasks from '@/components/DealTasks'
import { PROCESSORS } from '@/lib/types'
import type { REOProperty } from '@/lib/types'

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

// ── Arive deep-linking ──────────────────────────────────────────────────────
// Both LOs share one Arive org, so the URL is fully derivable from the file #:
//   https://luminlending.myarive.com/app/loans/{fileNo}/loan-center
const ARIVE_BASE = 'https://luminlending.myarive.com/app/loans'

/** Accepts a raw file number OR a pasted full Arive loan URL — returns just the id. */
function parseAriveFileNo(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/myarive\.com\/app\/loans\/(\d+)/i)
  return m ? m[1] : trimmed
}
function ariveUrl(fileNo: string | null | undefined): string | null {
  const id = String(fileNo ?? '').trim()
  if (!id) return null
  return `${ARIVE_BASE}/${id}/loan-center`
}

const inp = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-slate-50 focus:bg-white hover:border-slate-400 transition-colors'
const sel = inp
const inpCurrency = 'w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-slate-50 focus:bg-white hover:border-slate-400 transition-colors tabular-nums'
const inpPercent = 'w-full pl-3 pr-7 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-slate-50 focus:bg-white hover:border-slate-400 transition-colors tabular-nums'

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4 pb-2.5 border-b border-slate-200">
        {icon && <span className="text-blue-600 shrink-0">{icon}</span>}
        <h2 className="text-sm font-bold text-blue-600 uppercase tracking-wider">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1.5">{label}</label>
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

/** Date input that hides the "mm/dd/yyyy" placeholder when empty (via globals.css). */
function DateInput({ value, onChange }: {
  value: string | null | undefined
  onChange: (v: string) => void
}) {
  const v = value ?? ''
  return (
    <input
      type="date"
      value={v}
      onChange={e => onChange(e.target.value)}
      className={`${inp} ${v === '' ? 'date-empty' : ''}`}
    />
  )
}

/** Quick status pills for purchase contingencies — past due vs. days remaining. */
function ContingencyStatusBar({
  inspection, appraisal, loan, close,
}: {
  inspection: string | null
  appraisal:  string | null
  loan:       string | null
  close:      string | null
}) {
  const items: Array<{ label: string; date: string | null }> = [
    { label: 'Inspection', date: inspection },
    { label: 'Appraisal',  date: appraisal },
    { label: 'Loan',       date: loan },
    { label: 'Close',      date: close },
  ]
  // Only render the bar if at least one date is set
  if (!items.some(i => i.date)) return null

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const MS_PER_DAY = 86_400_000

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map(i => {
        if (!i.date) {
          return (
            <span key={i.label} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 border border-slate-200">
              {i.label}: —
            </span>
          )
        }
        const due = new Date(i.date + 'T00:00:00')
        const daysFromNow = Math.round((due.getTime() - today.getTime()) / MS_PER_DAY)
        let cls = 'bg-emerald-50 text-emerald-700 border-emerald-200'   // future
        let suffix = `in ${daysFromNow}d`
        if (daysFromNow < 0)      { cls = 'bg-red-50 text-red-700 border-red-200';      suffix = `${Math.abs(daysFromNow)}d past` }
        else if (daysFromNow === 0) { cls = 'bg-amber-50 text-amber-700 border-amber-200'; suffix = 'today' }
        else if (daysFromNow <= 3)  { cls = 'bg-amber-50 text-amber-700 border-amber-200' }
        return (
          <span key={i.label} className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${cls}`} title={due.toLocaleDateString()}>
            {i.label}: {suffix}
          </span>
        )
      })}
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
          className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-slate-50 focus:bg-white hover:border-slate-400 transition-colors resize-none placeholder:text-slate-400"
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

      {/* Notes timeline — each note is its own card so they're easy to tell apart */}
      {notes.length > 0 ? (
        <div className="space-y-2.5 pt-3 border-t border-slate-100">
          {notes.map(note => (
            <div
              key={note.id}
              className="group relative rounded-lg border border-slate-200 bg-slate-50/70 border-l-[3px] border-l-blue-300 px-3 py-2.5 shadow-sm"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {formatDate(note.created_at)}
                </span>
                <button
                  onClick={() => handleDeleteNote(note.id)}
                  disabled={deletingId === note.id}
                  title="Delete note"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-300 hover:text-red-500 p-0.5 rounded shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
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
  // Tracks the status at load-time so handleSave can detect a change and
  // mirror it to GHL only when the user actually moved the deal.
  const initialStatusRef = useRef<string | null>(null)

  useEffect(() => {
    supabase.from('deals').select('*').eq('id', id).single().then(({ data }) => {
      setForm(data)
      initialStatusRef.current = (data?.status as string | null) ?? null
      setLoading(false)
    })
  }, [id])

  // Every distinct lead source currently in the data — so the Source dropdown
  // lists the REAL sources from GHL/Arive (FRU, Lendgo, LMB, …), not just a
  // small hardcoded set. Paginated to clear PostgREST's 1000-row cap.
  const [knownSources, setKnownSources] = useState<string[]>([])
  useEffect(() => {
    (async () => {
      const set = new Set<string>()
      let off = 0
      for (;;) {
        const { data } = await supabase.from('deals').select('source').range(off, off + 999)
        const rows = (data ?? []) as Array<{ source: string | null }>
        for (const r of rows) { const s = (r.source ?? '').trim(); if (s) set.add(s) }
        if (rows.length < 1000) break
        off += 1000
      }
      setKnownSources(Array.from(set))
    })()
  }, [])

  // Final option list: real sources + a few manual ones + always the deal's
  // current value (so a synced source like "LMB" always shows as selected).
  const sourceOptions = useMemo(() => {
    const base = ['GHL', 'Self Source', 'Referral', 'Past Client', 'Open House', 'Agent Partner']
    const set = new Set<string>([...base, ...knownSources])
    const cur = (form?.source ?? '').trim()
    if (cur) set.add(cur)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [knownSources, form?.source])

  function set<K extends keyof Deal>(key: K, value: Deal[K] | string | number | null) {
    setSaved(false)
    setForm(f => f ? { ...f, [key]: value === '' ? null : value } : f)
  }

  // Keep LTV in sync whenever Loan Amount or Property Value change
  useEffect(() => {
    if (!form) return
    const next = computeLTV(form.loan_amount as number | null ?? null, form.estimated_value as number | null ?? null)
    if (next !== (form.ltv as number | null)) {
      setForm(f => f ? { ...f, ltv: next } : f)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.loan_amount, form?.estimated_value])

  // CLTV is computed live for display (not stored)
  const cltv = form ? computeCLTV(
    form.loan_amount as number | null ?? null,
    form.current_balance as number | null ?? null,
    form.estimated_value as number | null ?? null,
  ) : null

  async function handleSave() {
    if (!form) return
    setSaving(true)
    setError('')
    // Exclude lo_notes and client_notes — those are managed independently by DealNotes
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lo_notes: _ln, client_notes: _cn, ...formData } = form
    const { error: err } = await supabase.from('deals').update(formData).eq('id', form.id as string)
    if (err) { setError(err.message); setSaving(false); return }
    // If the user moved the deal to a new stage, push it to GHL so the next
    // sync doesn't drag it back. Only fires when status actually changed.
    const newStatus = form.status as string | null
    if (newStatus && newStatus !== initialStatusRef.current) {
      void pushStageToGHL(form.id as string, newStatus)
      initialStatusRef.current = newStatus
    }
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

  // Next-step edits persist immediately (like the escrow tracker) — independent
  // of the Save Changes button — and mirror into form so a later full save can't
  // write a stale log back over them.
  async function updateNextStep(dealId: string, patch: Record<string, unknown>) {
    setForm(f => f ? { ...f, ...patch } : f)
    const { error: err } = await supabase.from('deals').update(patch).eq('id', dealId)
    if (err) setError(err.message)
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
      {/* Return to wherever the user came from (Hot Leads, Pipeline, etc.),
          not a hardcoded page. Fall back to /deals on a direct load/refresh. */}
      <button
        onClick={() => {
          if (window.history.length > 1) router.back()
          else router.push('/deals')
        }}
        className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 transition-colors w-fit"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>

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
            {(form.borrower_id as string | null) && (
              <Link
                href={`/contacts/${form.borrower_id}`}
                title="View this person's contact — all their loans"
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-white/10 border border-white/20 rounded-lg hover:bg-white/20 transition"
              >
                <User className="w-3.5 h-3.5" /> View Contact
              </Link>
            )}
            {(() => {
              // Location resolution + the known-bad-id guard both live in
              // ghlContactUrl — this used to be a hand-rolled duplicate of it.
              const ghlUrl = ghlContactUrl(form)
              if (!ghlUrl) return null
              return (
                <a
                  href={ghlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in GoHighLevel"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-200 bg-blue-500/10 border border-blue-400/30 rounded-lg hover:bg-blue-500/20 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> View in GHL
                </a>
              )
            })()}
            {ariveUrl(form.arive_file_no as string | null) && (
              <a
                href={ariveUrl(form.arive_file_no as string | null)!}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this loan in Arive"
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-200 bg-emerald-500/10 border border-emerald-400/30 rounded-lg hover:bg-emerald-500/20 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open in Arive
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
        <div className="border-t border-slate-700/70 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x divide-slate-700/70">
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
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Lender</p>
            <p className="text-base font-bold mt-0.5 truncate" title={form.investor ? String(form.investor) : undefined}>
              {form.investor || <span className="text-slate-500">—</span>}
            </p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">LO · Age</p>
            <p className="text-sm font-semibold mt-0.5 truncate">
              {(form.loan_officer as string | null) ?? <span className="text-slate-500">No LO</span>} · <span className="text-slate-300 font-normal">{ageLabel}</span>
            </p>
          </div>
        </div>
      </div>

      {/* ── Next Step — sits between the hero and the detail body so the current
           step (with its timestamp) is visible at a glance; the full timestamped
           history is one tap away behind the "earlier steps" expander. Mirrors
           the escrow card and saves immediately, independent of Save Changes. */}
      <div className="mb-5 rounded-xl bg-orange-50 border border-orange-200 shadow-sm px-4 py-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Flame className="w-3.5 h-3.5 text-[#F37021]" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#F37021]">Next Step</span>
        </div>
        <NextStepLog deal={form as Deal} onUpdate={updateNextStep} />
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
      )}

      {/* ── One unified card containing all sections ─────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-3">

          {/* ── Left column (2/3) ────────────────────────────────── */}
          <div className="lg:col-span-2 divide-y divide-slate-200">

            {/* File Numbers — kept at the top so the Arive link is always one glance away */}
            <Section title="File Numbers" icon={<Hash className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Arive File #"
                  hint="Paste the file number or a full Arive loan URL — we'll grab the ID."
                >
                  <div className="relative">
                    <input
                      value={form.arive_file_no || ''}
                      onChange={e => set('arive_file_no', parseAriveFileNo(e.target.value))}
                      placeholder="e.g. 16776575"
                      className={inp + (ariveUrl(form.arive_file_no as string | null) ? ' pr-9' : '')}
                    />
                    {ariveUrl(form.arive_file_no as string | null) && (
                      <a
                        href={ariveUrl(form.arive_file_no as string | null)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open this loan in Arive"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 hover:text-emerald-700"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </Field>
                <Field label="Lender Loan #">
                  <input value={form.investor_file_no || ''} onChange={e => set('investor_file_no', e.target.value)} className={inp} />
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
                      // Clear refinance_type when leaving Refinance — keeps data clean
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
                    {LOAN_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </Field>
                {/* Refinance Type — only relevant when purpose is Refinance */}
                {form.loan_purpose === 'Refinance' && (
                  <Field label="Refinance Type">
                    <select value={form.refinance_type || ''} onChange={e => set('refinance_type', e.target.value || null)} className={sel}>
                      <option value="">—</option>
                      {REFINANCE_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Lien Position">
                  <select value={form.lien_position || ''} onChange={e => set('lien_position', e.target.value || null)} className={sel}>
                    <option value="">—</option>
                    {LIEN_POSITIONS.map(p => <option key={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="Loan Amount">
                  <CurrencyInput value={form.loan_amount as number | null} onChange={v => set('loan_amount', v)} />
                </Field>
                <Field label="Property Value">
                  <CurrencyInput value={form.estimated_value as number | null} onChange={v => set('estimated_value', v)} />
                </Field>
                <Field label="Amount on Existing Liens">
                  <CurrencyInput value={form.current_balance as number | null} onChange={v => set('current_balance', v)} />
                </Field>
                <Field label="Cash Out">
                  <CurrencyInput value={form.cash_out as number | null} onChange={v => set('cash_out', v)} />
                </Field>
                <Field label="LTV (auto)">
                  <ComputedPercent value={form.ltv as number | null} hint="Loan Amount ÷ Property Value" />
                </Field>
                <Field label="CLTV (auto)">
                  <ComputedPercent value={cltv} hint="(Loan Amount + Existing Liens) ÷ Property Value" />
                </Field>
                <Field label="Down Payment">
                  <CurrencyInput value={form.down_payment as number | null} onChange={v => set('down_payment', v)} />
                </Field>
                <Field label="Purchase Price">
                  <CurrencyInput value={form.purchase_price as number | null} onChange={v => set('purchase_price', v)} />
                </Field>
                <Field label="Total Housing Payment">
                  <CurrencyInput value={form.housing_payment as number | null} onChange={v => set('housing_payment', v)} />
                </Field>
                <Field label="P&I Payment">
                  <CurrencyInput value={form.pi_payment as number | null} onChange={v => set('pi_payment', v)} />
                </Field>
                <Field label="County">
                  <input value={(form.county as string | null) || ''} onChange={e => set('county', e.target.value)} className={inp} />
                </Field>
                <Field label="Rate">
                  <PercentInput value={form.rate as number | null} onChange={v => set('rate', v)} step="0.001" />
                </Field>
                <Field label="Lender">
                  <input value={form.investor || ''} onChange={e => set('investor', e.target.value)} className={inp} />
                </Field>
                <Field label="Broker / Non-Del">
                  <select value={form.broker_corr || ''} onChange={e => set('broker_corr', e.target.value)} className={sel}>
                    <option value="">—</option>
                    <option value="Broker">Broker</option>
                    <option value="Non-Del">Non-Del</option>
                  </select>
                </Field>
                <Field label="Source">
                  <select value={form.source || ''} onChange={e => set('source', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {sourceOptions.map(s => <option key={s} value={s}>{s}</option>)}
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
                  <DateInput value={form.lock_expiration as string | null} onChange={v => set('lock_expiration', v || null)} />
                </Field>
                <Field label="Appraisal Status">
                  <select value={form.appraisal_status || ''} onChange={e => set('appraisal_status', e.target.value)} className={sel}>
                    <option value="">—</option>
                    {APPRAISAL_STATUSES.map(a => <option key={a}>{a}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            {/* Real Estate Owned */}
            <Section title="Real Estate Owned (REO)" icon={<Building2 className="w-4 h-4" />}>
              <RealEstateOwned
                value={(form.reo_properties as REOProperty[] | null) || []}
                onChange={v => set('reo_properties', v)}
              />
            </Section>

            {/* GHL conversation thread — live texts/calls + reply box */}
            {form.ghl_contact_id && (
              <Section title="Text Conversation (GHL)" icon={<MessageSquare className="w-4 h-4" />}>
                <ConversationThread
                  contactId={form.ghl_contact_id as string}
                  locationId={(form.ghl_location_id as string | null) ?? null}
                  ghlUrl={ghlContactUrl(form)}
                  loanOfficer={(form.loan_officer as string | null) ?? null}
                  smsBlocked={isChannelBlocked(form, 'SMS')}
                  dndNote={dndLabel(form)}
                />
              </Section>
            )}

            {/* Tasks — tied to this deal, also visible on /tasks */}
            <Section title="Tasks" icon={<ClipboardList className="w-4 h-4" />}>
              <DealTasks dealId={id} />
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
                <div className="pt-1 border-t border-slate-100">
                  <CoborrowerManager
                    dealId={id}
                    primaryId={form.borrower_id as string | null}
                    onPrimaryChange={(newId) => setForm(f => f ? { ...f, borrower_id: newId } : f)}
                  />
                </div>
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
                    {PROCESSORS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            {/* Key Dates */}
            <Section title="Key Dates" icon={<Calendar className="w-4 h-4" />}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Signing">
                  <DateInput value={form.signing_date as string | null} onChange={v => set('signing_date', v || null)} />
                </Field>
                <Field label="Funded">
                  <DateInput value={form.funded_date as string | null} onChange={v => set('funded_date', v || null)} />
                </Field>
                <Field label="Paid">
                  <DateInput value={form.paid_date as string | null} onChange={v => set('paid_date', v || null)} />
                </Field>
                <Field label="Last Contact">
                  <DateInput value={form.last_contacted as string | null} onChange={v => set('last_contacted', v || null)} />
                </Field>
                <Field label="Adverse">
                  <DateInput value={form.adverse as string | null} onChange={v => set('adverse', v || null)} />
                </Field>
              </div>
              <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
                Added {form.created_at ? new Date(form.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
              </p>
            </Section>

            {/* Purchase Contingencies — sits right under Key Dates, purchases only */}
            {form.loan_purpose === 'Purchase' && (
              <Section title="Purchase Contingencies" icon={<Calendar className="w-4 h-4" />}>
                <p className="text-[11px] text-slate-500 mb-3 leading-snug">
                  Dates from the purchase agreement. CA defaults: inspection / appraisal ~17 days, loan ~21 days, close ~30 days from start.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start of Escrow">
                    <DateInput value={form.escrow_start_date as string | null} onChange={v => set('escrow_start_date', v || null)} />
                  </Field>
                  <Field label="Close of Escrow">
                    <DateInput value={form.close_of_escrow_date as string | null} onChange={v => set('close_of_escrow_date', v || null)} />
                  </Field>
                  <Field label="Inspection">
                    <DateInput value={form.inspection_contingency_date as string | null} onChange={v => set('inspection_contingency_date', v || null)} />
                  </Field>
                  <Field label="Appraisal">
                    <DateInput value={form.appraisal_contingency_date as string | null} onChange={v => set('appraisal_contingency_date', v || null)} />
                  </Field>
                  <Field label="Loan">
                    <DateInput value={form.loan_contingency_date as string | null} onChange={v => set('loan_contingency_date', v || null)} />
                  </Field>
                </div>
                {/* Quick-glance status pills (past due / soon / future) */}
                <ContingencyStatusBar
                  inspection={form.inspection_contingency_date as string | null}
                  appraisal={form.appraisal_contingency_date as string | null}
                  loan={form.loan_contingency_date as string | null}
                  close={form.close_of_escrow_date as string | null}
                />
              </Section>
            )}
          </div>
        </div>
      </div>

      {/* Loan History — other loans for the same contact (matched by email/phone/name) */}
      <div className="mt-6">
        <LoanHistory
          currentDealId={form.id as string}
          borrowerId={form.borrower_id as string | null}
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
