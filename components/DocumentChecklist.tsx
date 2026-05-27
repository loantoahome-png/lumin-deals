'use client'

/**
 * Per-deal document checklist. Stored as a JSONB `documents` array on the
 * deal (same edit-via-onChange pattern as RealEstateOwned / CommunicationsLog).
 *
 * Auto-populates from a loan-type template, then each line is tracked by
 * status as the file moves through processing.
 */

import { useState } from 'react'
import {
  FileText, Trash2, Plus, X, Check, ClipboardList, RotateCcw,
} from 'lucide-react'
import type { DealDocument } from '@/lib/types'
import { DOC_CATEGORIES, DOC_STATUSES, DOC_STATUS_LABELS } from '@/lib/types'
import { getDocumentTemplate, blankDocument } from '@/lib/documentTemplates'

const STATUS_STYLES: Record<string, string> = {
  needed:    'bg-slate-100 text-slate-600 border-slate-200',
  requested: 'bg-amber-100 text-amber-700 border-amber-200',
  received:  'bg-emerald-100 text-emerald-700 border-emerald-200',
  waived:    'bg-blue-50 text-blue-600 border-blue-200',
  na:        'bg-slate-50 text-slate-400 border-slate-200',
}

// Category display order
const CAT_ORDER = ['Identity', 'Income', 'Assets', 'Property', 'Credit', 'Other']

export default function DocumentChecklist({ value, onChange, loanType }: {
  value: DealDocument[]
  onChange: (next: DealDocument[]) => void
  loanType: string | null | undefined
}) {
  const docs = value || []
  const [addingName, setAddingName] = useState('')
  const [addingCat, setAddingCat] = useState<string>('Other')
  const [showAdd, setShowAdd] = useState(false)

  // ── Progress: "done" = received or waived; N/A excluded from the denominator ─
  const tracked = docs.filter(d => d.status !== 'na')
  const done = docs.filter(d => d.status === 'received' || d.status === 'waived').length
  const pct = tracked.length > 0 ? Math.round((done / tracked.length) * 100) : 0

  function updateDoc(id: string, patch: Partial<DealDocument>) {
    onChange(docs.map(d => d.id === id ? { ...d, ...patch, updated_at: new Date().toISOString() } : d))
  }
  function removeDoc(id: string) {
    onChange(docs.filter(d => d.id !== id))
  }
  function cycleStatus(doc: DealDocument) {
    // Click the status chip to advance: needed → requested → received → needed
    const flow = ['needed', 'requested', 'received']
    const idx = flow.indexOf(doc.status)
    const next = idx === -1 ? 'needed' : flow[(idx + 1) % flow.length]
    updateDoc(doc.id, { status: next })
  }
  function applyTemplate() {
    const template = getDocumentTemplate(loanType)
    if (docs.length === 0) {
      onChange(template)
      return
    }
    // Merge: keep existing docs, append template items not already present (by name)
    const existingNames = new Set(docs.map(d => d.name.trim().toLowerCase()))
    const toAdd = template.filter(t => !existingNames.has(t.name.trim().toLowerCase()))
    if (toAdd.length === 0) {
      alert('Every item from the ' + (loanType || 'default') + ' template is already on this checklist.')
      return
    }
    onChange([...docs, ...toAdd])
  }
  function addCustom() {
    if (!addingName.trim()) return
    onChange([...docs, { ...blankDocument(), name: addingName.trim(), category: addingCat }])
    setAddingName('')
    setAddingCat('Other')
    setShowAdd(false)
  }

  // Group by category
  const grouped: Record<string, DealDocument[]> = {}
  for (const d of docs) {
    const cat = CAT_ORDER.includes(d.category) ? d.category : 'Other'
    grouped[cat] ??= []
    grouped[cat].push(d)
  }
  const orderedCats = CAT_ORDER.filter(c => grouped[c]?.length)

  // ── Empty state ───────────────────────────────────────────────────────────
  if (docs.length === 0) {
    return (
      <div className="text-center py-6">
        <ClipboardList className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm text-slate-400 mb-3">No document checklist yet.</p>
        <button
          type="button"
          onClick={applyTemplate}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
        >
          <Plus className="w-3.5 h-3.5" />
          Generate from {loanType ? `"${loanType}"` : 'default'} template
        </button>
        <p className="text-[11px] text-slate-400 mt-2">
          Auto-builds a needs-list based on the loan type. You can edit it after.
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* Progress header */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{done}</span> of {tracked.length} collected
            {docs.length - tracked.length > 0 && <span className="text-slate-400"> · {docs.length - tracked.length} N/A</span>}
          </p>
          <span className={`text-xs font-bold ${pct === 100 ? 'text-emerald-600' : 'text-slate-500'}`}>{pct}%</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add document
        </button>
        <button
          type="button"
          onClick={applyTemplate}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition"
          title={`Add any missing items from the ${loanType || 'default'} template`}
        >
          <RotateCcw className="w-3.5 h-3.5" /> Sync template
        </button>
      </div>

      {/* Add custom doc form */}
      {showAdd && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">New Document</h4>
            <button type="button" onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <input
            autoFocus
            value={addingName}
            onChange={e => setAddingName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            placeholder="e.g. Divorce decree, LOE for large deposit…"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex items-center gap-2">
            <select
              value={addingCat}
              onChange={e => setAddingCat(e.target.value)}
              className="flex-1 px-2 py-1.5 border border-slate-200 rounded-md text-sm bg-white"
            >
              {DOC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              type="button"
              onClick={addCustom}
              disabled={!addingName.trim()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Grouped checklist */}
      <div className="space-y-4">
        {orderedCats.map(cat => (
          <div key={cat}>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{cat}</h4>
            <div className="space-y-1">
              {grouped[cat].map(doc => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  onCycle={() => cycleStatus(doc)}
                  onStatus={s => updateDoc(doc.id, { status: s })}
                  onNote={n => updateDoc(doc.id, { note: n })}
                  onRename={n => updateDoc(doc.id, { name: n })}
                  onRemove={() => removeDoc(doc.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Single document row ─────────────────────────────────────────────────────
function DocRow({ doc, onCycle, onStatus, onNote, onRename, onRemove }: {
  doc: DealDocument
  onCycle: () => void
  onStatus: (s: string) => void
  onNote: (n: string | null) => void
  onRename: (n: string) => void
  onRemove: () => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(doc.name)
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const [showNote, setShowNote] = useState(!!doc.note)

  const isDone = doc.status === 'received' || doc.status === 'waived'

  function commitName() {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== doc.name) onRename(trimmed)
    else setNameDraft(doc.name)
    setEditingName(false)
  }

  return (
    <div className={`group flex items-start gap-2 px-2.5 py-2 rounded-lg border transition ${
      isDone ? 'bg-emerald-50/40 border-emerald-100' : 'bg-white border-slate-200 hover:border-slate-300'
    }`}>
      {/* Status checkbox / quick-toggle */}
      <button
        type="button"
        onClick={onCycle}
        title="Click to advance: Needed → Requested → Received"
        className={`shrink-0 mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition ${
          doc.status === 'received' ? 'bg-emerald-500 border-emerald-500' :
          doc.status === 'requested' ? 'bg-amber-400 border-amber-400' :
          doc.status === 'waived' ? 'bg-blue-400 border-blue-400' :
          doc.status === 'na' ? 'bg-slate-200 border-slate-300' :
          'border-slate-300 bg-white hover:border-blue-400'
        }`}
      >
        {doc.status === 'received' && <Check className="w-2.5 h-2.5 text-white" />}
        {doc.status === 'waived' && <Check className="w-2.5 h-2.5 text-white" />}
        {doc.status === 'requested' && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </button>

      <div className="flex-1 min-w-0">
        {/* Name (click to rename) */}
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitName() }
              if (e.key === 'Escape') { setNameDraft(doc.name); setEditingName(false) }
            }}
            className="w-full text-sm px-1 py-0.5 border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setNameDraft(doc.name); setEditingName(true) }}
            className={`text-sm text-left ${isDone ? 'text-slate-500' : 'text-slate-800'}`}
            title="Click to rename"
          >
            {doc.name}
          </button>
        )}

        {/* Note */}
        {showNote ? (
          <input
            value={doc.note || ''}
            onChange={e => onNote(e.target.value || null)}
            onBlur={() => { if (!doc.note) setShowNote(false) }}
            placeholder="Add a note…"
            className="w-full mt-1 text-xs px-1.5 py-0.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 text-slate-600"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowNote(true)}
            className="text-[11px] text-slate-300 hover:text-slate-500 mt-0.5 opacity-0 group-hover:opacity-100 transition"
          >
            + note
          </button>
        )}
      </div>

      {/* Status chip + menu */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setShowStatusMenu(v => !v)}
          className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${STATUS_STYLES[doc.status] || STATUS_STYLES.needed}`}
        >
          {DOC_STATUS_LABELS[doc.status] || doc.status}
        </button>
        {showStatusMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowStatusMenu(false)} />
            <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 w-28">
              {DOC_STATUSES.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { onStatus(s); setShowStatusMenu(false) }}
                  className={`block w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 ${
                    s === doc.status ? 'font-semibold text-blue-600' : 'text-slate-700'
                  }`}
                >
                  {DOC_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Remove */}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 mt-0.5 p-0.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
        title="Remove document"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
