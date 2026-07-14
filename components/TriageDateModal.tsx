'use client'

import { useState } from 'react'
import { Calendar, X } from 'lucide-react'

// Required check-in date picker, shown whenever a lead (or a bulk selection)
// moves to "Not Ready - Timeframe". The chosen date is the promise that we'll
// come back to this lead — it lands in deals.next_action_due and drives the
// Check-ins queue + the check-in auto-task.
//
// Also reused by the Check-ins tab to set/reschedule dates on existing
// Not Ready - Timeframe leads.

const PRESETS = [
  { label: '+1 month',  months: 1 },
  { label: '+2 months', months: 2 },
  { label: '+3 months', months: 3 },
  { label: '+6 months', months: 6 },
]

function plusMonthsYmd(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type Props = {
  title: string                 // e.g. `Not Ready — set a check-in date`
  leadNames: string[]           // shown so bulk moves are unambiguous
  confirmLabel?: string
  onConfirm: (r: { dueIso: string; note: string }) => void
  onClose: () => void
}

export default function TriageDateModal({ title, leadNames, confirmLabel = 'Set check-in', onConfirm, onClose }: Props) {
  const [ymd, setYmd] = useState(plusMonthsYmd(2))   // default: check in, in 2 months
  const [note, setNote] = useState('')

  function confirm() {
    if (!ymd) return
    // 9am local on the chosen day — matches the follow-up presets elsewhere.
    onConfirm({ dueIso: new Date(`${ymd}T09:00`).toISOString(), note: note.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-orange-500" /> {title}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="text-xs text-slate-600">
            {leadNames.length === 1 ? (
              <>When should we check back in with <span className="font-semibold text-slate-800">{leadNames[0]}</span>?</>
            ) : (
              <>When should we check back in with these <span className="font-semibold text-slate-800">{leadNames.length} leads</span>?
                <span className="block mt-1 text-slate-400 truncate">{leadNames.slice(0, 5).join(', ')}{leadNames.length > 5 ? '…' : ''}</span></>
            )}
            <span className="block mt-1 text-slate-400">A date is required — it's what keeps this lead from being forgotten.</span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {PRESETS.map(p => {
              const v = plusMonthsYmd(p.months)
              const active = ymd === v
              return (
                <button
                  key={p.label}
                  onClick={() => setYmd(v)}
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    active ? 'bg-orange-600 border-orange-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:border-orange-300'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
            <input
              type="date"
              value={ymd}
              onChange={e => setYmd(e.target.value)}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold mb-1">Note (optional)</p>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirm() }}
              placeholder="e.g. buying after lease ends in Sept"
              className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5">Cancel</button>
          <button
            onClick={confirm}
            disabled={!ymd}
            className="text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-40 rounded-lg px-4 py-1.5"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
