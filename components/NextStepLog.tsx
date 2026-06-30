'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { Deal, NextStepEntry } from '@/lib/types'

const fmt = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Next-step log for an escrow card. Each entry is timestamped and kept, so the
 * card shows the full progression of a file's next steps (newest first). The deal's
 * `next_action` mirrors the latest entry's text so existing filters/sorts still work.
 */
export default function NextStepLog({ deal, onUpdate }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const log: NextStepEntry[] = deal.next_action_log ?? []
  // Legacy deals: a next_action set before this feature existed, with no log yet.
  const legacy = log.length === 0 && deal.next_action ? deal.next_action.trim() : ''

  async function add() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    // Seed the pre-existing next_action as the first historical entry the one time
    // we transition a legacy deal into the log, so the current step isn't lost.
    const seeded: NextStepEntry[] = legacy
      ? [{ id: crypto.randomUUID(), at: deal.updated_at || new Date().toISOString(), text: legacy }]
      : []
    const entry: NextStepEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), text }
    const next = [entry, ...log, ...seeded]
    try {
      await onUpdate(deal.id, { next_action_log: next, next_action: text })
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    const next = log.filter(e => e.id !== id)
    await onUpdate(deal.id, { next_action_log: next, next_action: next[0]?.text ?? null })
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() }
  }

  const visible = showAll ? log : log.slice(0, 1)
  const hidden = log.length - visible.length

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Add a step (Enter to log, Shift+Enter for a newline) */}
      <div className="flex items-start gap-1.5">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder="Add the next step…"
          className="w-full flex-1 px-2.5 py-1.5 border border-orange-200 rounded-md text-sm font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-[#F37021] focus:border-orange-400 resize-none placeholder:text-slate-400 placeholder:font-normal"
        />
        <button
          type="button" onClick={add} disabled={busy || !draft.trim()} title="Log this next step (Enter)"
          className="shrink-0 mt-0.5 p-1.5 rounded-md bg-[#F37021] text-white hover:bg-orange-600 disabled:opacity-40 transition"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* History — newest first; the top one is the current step */}
      {(log.length > 0 || legacy) && (
        <div className="mt-2 space-y-1.5 overflow-y-auto max-h-32 pr-0.5">
          {legacy && (
            <p className="text-sm font-medium text-slate-900 leading-snug">
              {legacy}<span className="ml-1.5 text-[10px] font-normal text-slate-400">· current</span>
            </p>
          )}
          {visible.map((e, i) => (
            <div key={e.id} className="group flex items-start gap-1.5">
              <div className="flex-1 min-w-0">
                <p className={`text-sm leading-snug ${i === 0 ? 'font-medium text-slate-900' : 'text-slate-600'}`}>{e.text}</p>
                <p className="text-[10px] text-slate-400">{fmt(e.at)}{i === 0 ? ' · current' : ''}</p>
              </div>
              <button
                type="button" onClick={() => remove(e.id)} title="Remove this entry"
                className="shrink-0 mt-0.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className="text-[11px] font-medium text-[#F37021] hover:underline">
              ▸ {hidden} earlier step{hidden > 1 ? 's' : ''}
            </button>
          )}
          {showAll && log.length > 1 && (
            <button type="button" onClick={() => setShowAll(false)} className="text-[11px] text-slate-400 hover:underline">
              collapse
            </button>
          )}
        </div>
      )}
    </div>
  )
}
