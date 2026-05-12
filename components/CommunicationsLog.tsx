'use client'

import { useState } from 'react'
import { Phone, Trash2, Plus, X } from 'lucide-react'
import type { Communication } from '@/lib/types'
import { COMM_CHANNELS, WAITING_ON_OPTIONS } from '@/lib/types'

const inp = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors'

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  const days = Math.floor(ms / 86_400_000)
  if (days === 0) {
    const hours = Math.floor(ms / 3_600_000)
    if (hours < 1) return 'Just now'
    return `${hours}h ago`
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function CommunicationsLog({ value, onChange }: {
  value: Communication[]
  onChange: (next: Communication[]) => void
}) {
  const log = (value || []).slice().sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState<Omit<Communication, 'id' | 'timestamp'>>({
    channel: 'Call', with: 'Borrower', outcome: '', by: '',
  })
  const [date, setDate] = useState(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })

  function handleAdd() {
    const entry: Communication = {
      id: uid(),
      timestamp: new Date(date).toISOString(),
      channel: draft.channel || 'Call',
      with: draft.with?.trim() || null,
      outcome: draft.outcome?.trim() || null,
      by: draft.by?.trim() || null,
    }
    onChange([entry, ...(value || [])])
    setDraft({ channel: 'Call', with: 'Borrower', outcome: '', by: '' })
    // Reset date back to now
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setDate(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
    setShowForm(false)
  }

  function handleDelete(id: string) {
    onChange((value || []).filter(c => c.id !== id))
  }

  return (
    <div>
      {!showForm ? (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 mb-3 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition"
        >
          <Plus className="w-3.5 h-3.5" /> Log a contact
        </button>
      ) : (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">New Contact</h4>
            <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">When</label>
              <input
                type="datetime-local"
                value={date}
                onChange={e => setDate(e.target.value)}
                className={inp}
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Channel</label>
              <select
                value={draft.channel || ''}
                onChange={e => setDraft(d => ({ ...d, channel: e.target.value }))}
                className={inp}
              >
                {COMM_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">With</label>
              <select
                value={draft.with || ''}
                onChange={e => setDraft(d => ({ ...d, with: e.target.value }))}
                className={inp}
              >
                <option value="">—</option>
                {WAITING_ON_OPTIONS.filter(w => w !== 'No one').map(w => <option key={w} value={w}>{w}</option>)}
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-0.5">By (optional)</label>
              <input
                value={draft.by || ''}
                onChange={e => setDraft(d => ({ ...d, by: e.target.value }))}
                className={inp}
                placeholder="LO/processor name"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Outcome / Notes</label>
            <textarea
              value={draft.outcome || ''}
              onChange={e => setDraft(d => ({ ...d, outcome: e.target.value }))}
              rows={2}
              className={inp + ' resize-none'}
              placeholder="What was discussed? Next steps?"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
            >
              Save Contact
            </button>
          </div>
        </div>
      )}

      {log.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No contacts logged yet.</p>
      ) : (
        <div className="space-y-2">
          {log.map(c => (
            <div key={c.id} className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50/60 group">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <Phone className="w-3 h-3 text-slate-400" />
                    <span className="font-semibold text-slate-800">{c.channel}</span>
                    {c.with && <span className="text-slate-500">with {c.with}</span>}
                    {c.by && <span className="text-slate-400 text-[10px]">· by {c.by}</span>}
                  </div>
                  {c.outcome && (
                    <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{c.outcome}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-400">{formatRelative(c.timestamp)}</span>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
