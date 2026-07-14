'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { dndLabel } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import {
  leadAgeDays, triageTier, DECIDE_BY_DAY, type TriageTier,
} from '@/lib/triage'
import { ExternalLink, ChevronDown, ChevronRight, MoreHorizontal, Timer } from 'lucide-react'

// The 7-day decision queue. Every open, undecided lead shows here with a day
// counter; the job is to commit each one to a direction before day 7:
// App Intake, Not Ready - Timeframe (check-in date required — the page opens
// the date modal), or Remove from All Automations.

type Section = { tier: TriageTier; label: string; emoji: string; hint: string; badge: string; collapsed?: boolean }
const SECTIONS: Section[] = [
  { tier: 'overdue', label: 'Overdue', emoji: '🔴', hint: 'Past day 7 with no direction — decide these first', badge: 'bg-red-100 text-red-700 border-red-200' },
  { tier: 'decide',  label: 'Decision due (day 5–7)', emoji: '🟠', hint: 'Deadline this week — commit a direction now', badge: 'bg-amber-100 text-amber-700 border-amber-200' },
  { tier: 'clock',   label: 'On the clock (day 0–4)', emoji: '🟢', hint: 'New — work them; decision due by day 7', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { tier: 'backlog', label: 'Backlog (30+ days)', emoji: '🗄️', hint: 'Historical pile — bulk-clean into a direction', badge: 'bg-slate-100 text-slate-600 border-slate-200', collapsed: true },
]

// The three confirmed directions, as row + bulk actions.
export type Disposition = 'intake' | 'not-ready' | 'remove'

const MORE_OPTIONS: { status: string; group: string }[] = [
  { status: 'Attempted Contact', group: 'Leads' },
  { status: 'Ghosted',           group: 'Leads' },
  { status: 'Responded',         group: 'Leads' },
  { status: 'Pitching',          group: 'Leads' },
  { status: 'Appointment Booked', group: 'Leads' },
  { status: 'Not Qualified - Credit', group: 'Not Ready' },
  { status: 'Not Qualified - Income', group: 'Not Ready' },
  { status: 'Not Ready - Rate',       group: 'Not Ready' },
  { status: 'Lost to Competitor',     group: 'Not Ready' },
  { status: 'Non-Responsive',         group: 'Not Ready' },
]

function compactAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

type Props = {
  deals: Deal[]                                   // open + undecided, LO-filtered by the page
  onDisposition: (ids: string[], d: Disposition) => void   // page owns the NRT date modal + confirms
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}

export default function TriageQueue({ deals, onDisposition, onUpdate }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SECTIONS.map(s => [s.tier, !s.collapsed])),
  )
  const now = Date.now()

  const byTier = useMemo(() => {
    const m: Record<TriageTier, Deal[]> = { clock: [], decide: [], overdue: [], backlog: [] }
    for (const d of deals) m[triageTier(d, now)].push(d)
    // Most at-risk on top: oldest first — except the backlog, where the most
    // RECENT are the most salvageable.
    m.clock.sort((a, b) => leadAgeDays(b, now) - leadAgeDays(a, now))
    m.decide.sort((a, b) => leadAgeDays(b, now) - leadAgeDays(a, now))
    m.overdue.sort((a, b) => leadAgeDays(b, now) - leadAgeDays(a, now))
    m.backlog.sort((a, b) => leadAgeDays(a, now) - leadAgeDays(b, now))
    return m
  }, [deals, now])

  const selectedIds = useMemo(() => deals.filter(d => selected.has(d.id)).map(d => d.id), [deals, selected])

  function toggleOne(id: string) {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  function toggleSection(tier: TriageTier) {
    const ids = byTier[tier].map(d => d.id)
    const all = ids.length > 0 && ids.every(id => selected.has(id))
    setSelected(prev => {
      const n = new Set(prev)
      for (const id of ids) { if (all) n.delete(id); else n.add(id) }
      return n
    })
  }
  function dispose(ids: string[], d: Disposition) {
    onDisposition(ids, d)
    setSelected(prev => {
      const n = new Set(prev)
      for (const id of ids) n.delete(id)
      return n
    })
  }

  if (deals.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Timer className="w-10 h-10 text-emerald-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">Triage queue is clear</p>
          <p className="text-xs text-slate-500 mt-1">Every lead has a direction. New leads show up here with a 7-day decision clock.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="sticky top-0 z-20 flex items-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2.5 shadow-lg flex-wrap">
          <span className="text-sm font-semibold tabular-nums">{selectedIds.length} selected</span>
          <span className="text-slate-400 text-sm mr-1">Direction:</span>
          <button onClick={() => dispose(selectedIds, 'intake')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white">
            App Intake
          </button>
          <button onClick={() => dispose(selectedIds, 'not-ready')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-white">
            Not Ready — set check-in
          </button>
          <button onClick={() => dispose(selectedIds, 'remove')}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white">
            Remove from Automations
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-sm text-slate-300 hover:text-white">
            Clear
          </button>
        </div>
      )}

      {SECTIONS.map(section => {
        const rows = byTier[section.tier]
        const open = openSections[section.tier]
        const sectionAll = rows.length > 0 && rows.every(d => selected.has(d.id))
        return (
          <div key={section.tier} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setOpenSections(s => ({ ...s, [section.tier]: !s[section.tier] }))}
              className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50/60 text-left"
            >
              {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              <span>{section.emoji}</span>
              <span className="text-sm font-semibold text-slate-800">{section.label}</span>
              <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 tabular-nums ${section.badge}`}>{rows.length}</span>
              <span className="text-[11px] text-slate-400 ml-1 hidden sm:inline">{section.hint}</span>
            </button>

            {open && rows.length > 0 && (
              <div className="border-t border-slate-100 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                      <th className="px-3 py-2 w-8">
                        <input type="checkbox" checked={sectionAll} onChange={() => toggleSection(section.tier)}
                          className="rounded accent-blue-600 cursor-pointer" title="Select section" />
                      </th>
                      <th className="px-3 py-2">Lead</th>
                      <th className="px-3 py-2">Stage</th>
                      <th className="px-3 py-2 text-right">Clock</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">LO</th>
                      <th className="px-3 py-2 text-right" title="Last inbound from the borrower">Borrower last</th>
                      <th className="px-3 py-2 text-right" title="Last outbound from us">You last</th>
                      <th className="px-3 py-2 text-center">Direction →</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map(d => (
                      <TriageRow key={d.id} deal={d} tier={section.tier} now={now}
                        selected={selected.has(d.id)} onToggle={() => toggleOne(d.id)}
                        onDisposition={disp => dispose([d.id], disp)} onUpdate={onUpdate} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {open && rows.length === 0 && (
              <p className="text-center text-[11px] italic py-4 text-slate-400 border-t border-slate-100">No leads here</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TriageRow({ deal, tier, now, selected, onToggle, onDisposition, onUpdate }: {
  deal: Deal
  tier: TriageTier
  now: number
  selected: boolean
  onToggle: () => void
  onDisposition: (d: Disposition) => void
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const [showMore, setShowMore] = useState(false)
  const age = leadAgeDays(deal, now)
  const ghlUrl = ghlContactUrl(deal)
  const waiting = (deal.comm_unread_count ?? 0) > 0
  const statusColor = STATUS_COLORS[deal.status] ?? 'bg-slate-100 text-slate-600'

  const clockChip =
    tier === 'clock'  ? { text: `Day ${age} of ${DECIDE_BY_DAY}`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' } :
    tier === 'decide' ? { text: `Day ${age} of ${DECIDE_BY_DAY}`, cls: 'bg-amber-50 text-amber-800 border-amber-200' } :
                        { text: `Day ${age}`, cls: 'bg-red-50 text-red-700 border-red-200' }

  return (
    <tr className={`transition-colors ${selected ? 'bg-blue-50/70' : 'hover:bg-slate-50/60'}`}>
      <td className="px-3 py-2">
        <input type="checkbox" checked={selected} onChange={onToggle} className="rounded accent-blue-600 cursor-pointer" />
      </td>
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
          {waiting && (
            <span className="shrink-0 text-[9px] font-bold text-red-700 bg-red-100 border border-red-200 rounded-full px-1.5 py-0.5"
              title={`${deal.comm_unread_count} unread — client waiting on a reply`}>
              ⏳ {deal.comm_unread_count}
            </span>
          )}
          {dndLabel(deal) && (
            <span className="shrink-0 text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5"
              title="Do Not Contact — opted out of one or more channels">
              🚫 {dndLabel(deal)}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${statusColor}`}>{deal.status}</span>
      </td>
      <td className="px-3 py-2 text-right">
        <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 tabular-nums whitespace-nowrap ${clockChip.cls}`}>
          {clockChip.text}
        </span>
      </td>
      <td className="px-3 py-2 text-slate-600 truncate max-w-[110px]">{deal.source || '—'}</td>
      <td className="px-3 py-2 text-slate-600 truncate max-w-[110px]">{deal.loan_officer || '—'}</td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
        {deal.last_inbound_at ? `${compactAgo(deal.last_inbound_at)} ago` : '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
        {deal.last_outbound_at ? `${compactAgo(deal.last_outbound_at)} ago` : '—'}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-center gap-1 relative">
          <button onClick={() => onDisposition('intake')}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-cyan-100 hover:bg-cyan-200 text-cyan-800 border border-cyan-200"
            title="Move to App Intake">
            App Intake
          </button>
          <button onClick={() => onDisposition('not-ready')}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-200"
            title="Not Ready - Timeframe — sets a required check-in date">
            Not Ready
          </button>
          <button onClick={() => onDisposition('remove')}
            className="text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap bg-red-100 hover:bg-red-200 text-red-800 border border-red-200"
            title="Remove from All Automations">
            Remove
          </button>
          <button onClick={() => setShowMore(v => !v)}
            className="text-slate-400 hover:text-slate-700 p-1 rounded hover:bg-slate-100" title="Other stages">
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {showMore && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-md shadow-lg z-10 w-48 py-1"
              onMouseLeave={() => setShowMore(false)}>
              {MORE_OPTIONS.filter(o => o.status !== deal.status).map(o => (
                <button key={o.status}
                  onClick={() => { setShowMore(false); void onUpdate(deal.id, { status: o.status, pipeline_group: o.group }) }}
                  className="block w-full text-left text-[11px] px-3 py-1.5 hover:bg-slate-50 text-slate-700">
                  {o.status}
                </button>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}
