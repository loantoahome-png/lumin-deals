'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Deal } from '@/lib/types'
import { dndLabel } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { checkinTier, type CheckinTier } from '@/lib/triage'
import { CalendarClock } from 'lucide-react'

// The check-in resurfacing queue: open "Not Ready - Timeframe" leads, grouped
// by their check-in date (stored in next_action_due). This is the second half
// of "no lead falls through the cracks" — a lead parked as not-ready is a
// promise to come back, and this queue is where that promise surfaces.

type Section = { tier: CheckinTier; label: string; emoji: string; hint: string; badge: string }
const SECTIONS: Section[] = [
  { tier: 'overdue',   label: 'Check-in overdue',   emoji: '🔴', hint: 'The date we promised has passed — reach out now',        badge: 'bg-red-100 text-red-700 border-red-200' },
  { tier: 'soon',      label: 'Due this week',      emoji: '🟠', hint: 'Check-in coming up within 7 days',                        badge: 'bg-amber-100 text-amber-700 border-amber-200' },
  { tier: 'none',      label: 'No date set',        emoji: '⚠️', hint: 'Parked with no check-in date — set one so they resurface', badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  { tier: 'scheduled', label: 'Scheduled',          emoji: '🟢', hint: 'Future check-ins on the calendar',                        badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
]

type Props = {
  deals: Deal[]                                    // open Not Ready - Timeframe, LO-filtered by the page
  onSetDate: (ids: string[]) => void               // page opens the date modal
  onIntake: (id: string) => void
  onRemove: (id: string) => void
}

export default function CheckinQueue({ deals, onSetDate, onIntake, onRemove }: Props) {
  const now = Date.now()
  const byTier = useMemo(() => {
    const m: Record<CheckinTier, Deal[]> = { overdue: [], soon: [], none: [], scheduled: [] }
    for (const d of deals) m[checkinTier(d, now)].push(d)
    const dueMs = (d: Deal) => d.next_action_due ? Date.parse(d.next_action_due) : Infinity
    m.overdue.sort((a, b) => dueMs(a) - dueMs(b))      // most overdue first
    m.soon.sort((a, b) => dueMs(a) - dueMs(b))
    m.scheduled.sort((a, b) => dueMs(a) - dueMs(b))
    return m
  }, [deals, now])

  if (deals.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CalendarClock className="w-10 h-10 text-emerald-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">No check-ins pending</p>
          <p className="text-xs text-slate-500 mt-1">Leads moved to Not Ready - Timeframe show up here with their check-in date.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      {SECTIONS.map(section => {
        const rows = byTier[section.tier]
        if (rows.length === 0) return null
        return (
          <div key={section.tier} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 flex items-center gap-2">
              <span>{section.emoji}</span>
              <span className="text-sm font-semibold text-slate-800">{section.label}</span>
              <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 tabular-nums ${section.badge}`}>{rows.length}</span>
              <span className="text-[11px] text-slate-400 ml-1 hidden sm:inline">{section.hint}</span>
              {section.tier === 'none' && rows.length > 1 && (
                <button onClick={() => onSetDate(rows.map(d => d.id))}
                  className="ml-auto text-[11px] font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg px-2.5 py-1">
                  Set one date for all {rows.length}
                </button>
              )}
            </div>
            <div className="border-t border-slate-100 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                    <th className="px-3 py-2">Lead</th>
                    <th className="px-3 py-2">Check-in</th>
                    <th className="px-3 py-2">Note</th>
                    <th className="px-3 py-2">LO</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2 text-center">Action →</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(d => (
                    <CheckinRow key={d.id} deal={d} tier={section.tier}
                      onSetDate={() => onSetDate([d.id])}
                      onIntake={() => onIntake(d.id)} onRemove={() => onRemove(d.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CheckinRow({ deal, tier, onSetDate, onIntake, onRemove }: {
  deal: Deal
  tier: CheckinTier
  onSetDate: () => void
  onIntake: () => void
  onRemove: () => void
}) {
  const ghlUrl = ghlContactUrl(deal)
  const due = deal.next_action_due ? new Date(deal.next_action_due) : null
  const dueText = due
    ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'no date'
  const dueCls =
    tier === 'overdue' ? 'text-red-600 font-semibold' :
    tier === 'soon'    ? 'text-amber-700 font-semibold' :
    tier === 'none'    ? 'text-violet-600 italic' : 'text-slate-600'
  // next_action holds "Check in: <note>" — show just the note part.
  const note = (deal.next_action ?? '').replace(/^check in:?\s*/i, '')

  return (
    <tr className="hover:bg-slate-50/60 transition-colors">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Link href={`/deals/${deal.id}`} className="font-semibold text-slate-900 hover:text-blue-700 truncate">
            {deal.name}
          </Link>
          {ghlUrl && (
            <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
              className="shrink-0 text-[9px] font-bold text-blue-700 hover:text-blue-900 px-1 py-0.5 rounded bg-blue-100 border border-blue-200">
              GHL
            </a>
          )}
          {dndLabel(deal) && (
            <span className="shrink-0 text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5"
              title="Do Not Contact — opted out of one or more channels">
              🚫 {dndLabel(deal)}
            </span>
          )}
        </div>
      </td>
      <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${dueCls}`}>{dueText}</td>
      <td className="px-3 py-2 text-slate-500 truncate max-w-[200px]" title={note || undefined}>{note || '—'}</td>
      <td className="px-3 py-2 text-slate-600 truncate max-w-[110px]">{deal.loan_officer || '—'}</td>
      <td className="px-3 py-2 text-slate-600 truncate max-w-[110px]">{deal.source || '—'}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-center gap-1">
          <button onClick={onSetDate}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-violet-100 hover:bg-violet-200 text-violet-800 border border-violet-200"
            title={tier === 'none' ? 'Set the check-in date' : 'Reschedule the check-in'}>
            {tier === 'none' ? 'Set date' : 'Reschedule'}
          </button>
          <button onClick={onIntake}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-cyan-100 hover:bg-cyan-200 text-cyan-800 border border-cyan-200"
            title="Ready now — move straight to App Intake">
            App Intake
          </button>
          <button onClick={onRemove}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-red-100 hover:bg-red-200 text-red-800 border border-red-200"
            title="Remove from All Automations">
            Remove
          </button>
        </div>
      </td>
    </tr>
  )
}
