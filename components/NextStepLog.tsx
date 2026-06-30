'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X } from 'lucide-react'
import type { Deal, NextStepEntry } from '@/lib/types'

const fmt = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Next-step log for an escrow card. The latest entry is shown prominently as the
 * current step; pressing + opens a popup to log a new one (which becomes current).
 * Older entries are timestamped history behind an expander. `deal.next_action`
 * mirrors the latest entry's text so existing filters/sorts keep working.
 */
export default function NextStepLog({ deal, onUpdate }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const log: NextStepEntry[] = deal.next_action_log ?? []
  // Legacy: a next_action set before this feature, not yet in the log.
  const legacy = log.length === 0 && deal.next_action ? deal.next_action.trim() : ''
  const current = log[0] ?? null
  const currentText = current?.text ?? legacy
  const earlier = log.slice(1)

  async function done() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    // Seed the pre-existing next_action into the log the one time we transition a
    // legacy deal, so the current step isn't lost.
    const seeded: NextStepEntry[] = legacy
      ? [{ id: crypto.randomUUID(), at: deal.updated_at || new Date().toISOString(), text: legacy }]
      : []
    const entry: NextStepEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), text }
    const next = [entry, ...log, ...seeded]
    try {
      await onUpdate(deal.id, { next_action_log: next, next_action: text })
      setDraft('')
      setAdding(false)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    const next = log.filter(e => e.id !== id)
    await onUpdate(deal.id, { next_action_log: next, next_action: next[0]?.text ?? null })
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done() }
    if (e.key === 'Escape') { setAdding(false); setDraft('') }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Current step — the focal point — with the add button */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {currentText
            ? <p className="text-[15px] font-semibold text-slate-900 leading-snug break-words">{currentText}</p>
            : <p className="text-sm italic text-slate-400">No next step yet — tap + to add one.</p>}
          {current && <p className="text-[10px] text-slate-400 mt-0.5">{fmt(current.at)}</p>}
        </div>
        <button
          type="button" onClick={() => { setDraft(''); setAdding(true) }} title="Add a new next step"
          className="shrink-0 p-1.5 rounded-md bg-[#F37021] text-white hover:bg-orange-600 transition"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Earlier steps */}
      {earlier.length > 0 && (
        <div className="mt-1.5">
          {!showAll ? (
            <button type="button" onClick={() => setShowAll(true)} className="text-[11px] font-medium text-[#F37021] hover:underline">
              ▸ {earlier.length} earlier step{earlier.length > 1 ? 's' : ''}
            </button>
          ) : (
            <div className="space-y-1.5 overflow-y-auto max-h-28 pr-0.5">
              {earlier.map(e => (
                <div key={e.id} className="group flex items-start gap-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-slate-600 leading-snug break-words">{e.text}</p>
                    <p className="text-[10px] text-slate-400">{fmt(e.at)}</p>
                  </div>
                  <button
                    type="button" onClick={() => remove(e.id)} title="Remove this entry"
                    className="shrink-0 mt-0.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => setShowAll(false)} className="text-[11px] text-slate-400 hover:underline">collapse</button>
            </div>
          )}
        </div>
      )}

      {/* Add popup — portaled to <body> so the card's transform/overflow can't clip it */}
      {adding && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setAdding(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-slate-900">Add next step{deal.name ? ` — ${deal.name}` : ''}</h3>
              <button onClick={() => setAdding(false)} className="text-slate-400 hover:text-slate-600" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <textarea
              autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey}
              rows={3} placeholder="What's the next step?"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#F37021] focus:border-orange-400 resize-y"
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-[11px] text-slate-400">Enter to save · Shift+Enter for a new line</span>
              <div className="flex gap-2">
                <button onClick={() => setAdding(false)} className="text-sm font-medium text-slate-600 hover:text-slate-800 px-3 py-1.5">Cancel</button>
                <button
                  onClick={done} disabled={busy || !draft.trim()}
                  className="text-sm font-semibold text-white bg-[#F37021] rounded-lg px-4 py-1.5 hover:bg-orange-600 disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Done'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
