'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Deal, STATUS_COLORS, LOAN_OFFICERS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import {
  AlertTriangle, Clock, ChevronRight, User, CalendarClock,
  Flame, ExternalLink, CheckCircle2, Snowflake, Lock, Search,
} from 'lucide-react'

// ── Assignee options: LOs + common processors + Efrain ──────────────────────
const ASSIGNEE_OPTIONS = [
  ...LOAN_OFFICERS,
  'Efrain Ramirez',
  'Lexi - 3rd party',
  'Hanh - 3rd party',
  'Susan - In house',
] as const

const PRIORITY_OPTIONS = [
  { value: 'high',   label: 'High',   color: 'bg-red-100 text-red-700 border-red-200' },
  { value: 'normal', label: 'Normal', color: 'bg-slate-100 text-slate-700 border-slate-200' },
  { value: 'low',    label: 'Low',    color: 'bg-blue-50 text-blue-600 border-blue-200' },
] as const

// ── Date helpers ────────────────────────────────────────────────────────────
function startOfDay(d: Date) { d.setHours(0,0,0,0); return d }
function endOfDay(d: Date) { d.setHours(23,59,59,999); return d }
const MS_PER_DAY = 86_400_000

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.floor((Date.now() - t) / MS_PER_DAY)
}
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.floor((t - Date.now()) / MS_PER_DAY)
}
function formatDueLabel(iso: string | null): string {
  if (!iso) return 'No follow-up set'
  const due = new Date(iso)
  const now = new Date()
  const today = startOfDay(new Date())
  const tomorrow = new Date(today.getTime() + MS_PER_DAY)
  const dayAfter = new Date(today.getTime() + 2 * MS_PER_DAY)

  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (due < now) {
    const overdueDays = Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY)
    if (overdueDays === 0) return `Overdue · was due ${time}`
    return `Overdue by ${overdueDays}d`
  }
  if (due < tomorrow) return `Today · ${time}`
  if (due < dayAfter) return `Tomorrow · ${time}`
  return due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ` · ${time}`
}

function isOverdue(iso: string | null): boolean {
  return iso ? new Date(iso) < new Date() : false
}
function isToday(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const t = startOfDay(new Date())
  const e = endOfDay(new Date())
  return d >= t && d <= e
}

/** Convert ISO timestamp to value for <input type="datetime-local"> */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  // datetime-local needs YYYY-MM-DDTHH:mm in *local* time without timezone
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function localInputToISO(local: string): string | null {
  if (!local) return null
  const d = new Date(local) // treats as local time
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Filter types ────────────────────────────────────────────────────────────
type FollowUpFilter = 'all' | 'mine' | 'overdue' | 'today' | 'week' | 'unassigned' | 'no_action'

type Props = {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  /** Currently signed-in LO name, used for "My Follow-ups" filter */
  currentUser?: string | null
}

export default function EscrowTracker({ deals, onUpdate, currentUser }: Props) {
  const [filter, setFilter] = useState<FollowUpFilter>('all')
  const [search, setSearch] = useState('')

  // Filtered + sorted list
  const filteredAndSorted = useMemo(() => {
    const now = new Date()
    const today = startOfDay(new Date())
    const weekFromNow = new Date(today.getTime() + 7 * MS_PER_DAY)
    const lower = search.trim().toLowerCase()

    const filtered = deals.filter(d => {
      // Text search
      if (lower) {
        const hay = [d.name, d.loan_officer, d.property_address, d.next_action, d.next_action_assignee]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(lower)) return false
      }

      const due = d.next_action_due ? new Date(d.next_action_due) : null

      switch (filter) {
        case 'mine':
          if (!currentUser) return true
          return d.next_action_assignee === currentUser || d.loan_officer === currentUser
        case 'overdue':
          return due != null && due < now
        case 'today':
          return due != null && due >= today && due <= endOfDay(new Date())
        case 'week':
          return due != null && due >= now && due <= weekFromNow
        case 'unassigned':
          return !d.next_action_assignee
        case 'no_action':
          return !d.next_action || d.next_action.trim() === ''
        default:
          return true
      }
    })

    // Sort: overdue first, then today, then by due date, then no-due last
    return filtered.sort((a, b) => {
      // Priority bumps high to top within each group
      const prioRank = (p: string | null) => p === 'high' ? 0 : p === 'low' ? 2 : 1
      const da = a.next_action_due ? new Date(a.next_action_due).getTime() : null
      const db = b.next_action_due ? new Date(b.next_action_due).getTime() : null

      // No-due dates go to bottom
      if (da == null && db == null) return prioRank(a.escrow_priority) - prioRank(b.escrow_priority) || a.name.localeCompare(b.name)
      if (da == null) return 1
      if (db == null) return -1

      // Both have dates: overdue/today/future order is implicit by time
      return da - db || prioRank(a.escrow_priority) - prioRank(b.escrow_priority)
    })
  }, [deals, filter, search, currentUser])

  // Counts for filter chips
  const counts = useMemo(() => {
    const now = new Date()
    const today = startOfDay(new Date())
    const weekFromNow = new Date(today.getTime() + 7 * MS_PER_DAY)
    return {
      all: deals.length,
      mine: currentUser ? deals.filter(d => d.next_action_assignee === currentUser || d.loan_officer === currentUser).length : 0,
      overdue: deals.filter(d => d.next_action_due && new Date(d.next_action_due) < now).length,
      today: deals.filter(d => {
        const due = d.next_action_due ? new Date(d.next_action_due) : null
        return due && due >= today && due <= endOfDay(new Date())
      }).length,
      week: deals.filter(d => {
        const due = d.next_action_due ? new Date(d.next_action_due) : null
        return due && due >= now && due <= weekFromNow
      }).length,
      unassigned: deals.filter(d => !d.next_action_assignee).length,
      no_action: deals.filter(d => !d.next_action || d.next_action.trim() === '').length,
    }
  }, [deals, currentUser])

  return (
    <div className="p-4 space-y-4">
      {/* Filter + Search bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search escrows…"
            className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex bg-slate-100 rounded-lg p-1 gap-0.5">
          <FilterChip active={filter==='all'}        onClick={() => setFilter('all')}        label="All"           count={counts.all} />
          <FilterChip active={filter==='mine'}       onClick={() => setFilter('mine')}       label="My follow-ups" count={counts.mine} disabled={!currentUser} />
          <FilterChip active={filter==='overdue'}    onClick={() => setFilter('overdue')}    label="Overdue"       count={counts.overdue} tone="red" />
          <FilterChip active={filter==='today'}      onClick={() => setFilter('today')}      label="Today"         count={counts.today} tone="amber" />
          <FilterChip active={filter==='week'}       onClick={() => setFilter('week')}       label="This week"     count={counts.week} />
          <FilterChip active={filter==='unassigned'} onClick={() => setFilter('unassigned')} label="Unassigned"    count={counts.unassigned} />
          <FilterChip active={filter==='no_action'}  onClick={() => setFilter('no_action')}  label="No next step"  count={counts.no_action} />
        </div>
      </div>

      {/* Cards grid */}
      {filteredAndSorted.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">Nothing matches this filter</p>
          <p className="text-xs text-slate-500 mt-1">Try a different filter or search term.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredAndSorted.map(deal => (
            <EscrowCard key={deal.id} deal={deal} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({ active, onClick, label, count, tone, disabled }: {
  active: boolean; onClick: () => void; label: string; count: number; tone?: 'red'|'amber'; disabled?: boolean
}) {
  const activeColor = tone === 'red'
    ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
    : tone === 'amber'
    ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
    : 'bg-white text-slate-900 shadow-sm'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 text-xs font-medium rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed ${active ? activeColor : 'text-slate-500 hover:text-slate-800'}`}
    >
      {label}
      {count > 0 && (
        <span className={`ml-1.5 text-[10px] tabular-nums ${active ? '' : 'text-slate-400'}`}>{count}</span>
      )}
    </button>
  )
}

// ── Per-deal card ───────────────────────────────────────────────────────────
function EscrowCard({ deal, onUpdate }: { deal: Deal; onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void> }) {
  const [nextAction, setNextAction] = useState(deal.next_action || '')
  const [savingFlash, setSavingFlash] = useState(false)

  async function saveField<K extends keyof Deal>(field: K, value: Deal[K]) {
    if (value === deal[field]) return
    setSavingFlash(true)
    await onUpdate(deal.id, { [field]: value })
    setTimeout(() => setSavingFlash(false), 800)
  }

  const overdue = isOverdue(deal.next_action_due)
  const today = !overdue && isToday(deal.next_action_due)
  const daysInStage = daysSince(deal.stage_changed_at) ?? daysSince(deal.created_at)
  const stuck = daysInStage != null && daysInStage > 14
  const lockDaysLeft = daysUntil(deal.lock_expiration)
  const lockExpiringSoon = lockDaysLeft != null && lockDaysLeft >= 0 && lockDaysLeft <= 7
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'
  const priorityOpt = PRIORITY_OPTIONS.find(p => p.value === deal.escrow_priority)

  const borderClass = overdue
    ? 'border-red-300 ring-2 ring-red-100'
    : today
    ? 'border-amber-300 ring-2 ring-amber-100'
    : 'border-slate-200'

  return (
    <div className={`bg-white rounded-xl border ${borderClass} shadow-sm overflow-hidden transition-shadow hover:shadow-md flex flex-col`}>
      {/* Header strip */}
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-2">
        <Link href={`/deals/${deal.id}`} className="font-semibold text-sm text-slate-900 hover:text-blue-700 truncate flex items-center gap-1 group">
          {deal.name}
          <ExternalLink className="w-3 h-3 text-slate-300 group-hover:text-blue-500 opacity-0 group-hover:opacity-100 transition" />
        </Link>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${statusClass}`}>
          {deal.status}
        </span>
      </div>

      {/* Alerts row */}
      {(overdue || today || stuck || lockExpiringSoon) && (
        <div className="px-4 py-1.5 flex items-center gap-2 flex-wrap text-[10px] font-semibold uppercase tracking-wider bg-slate-50/50 border-b border-slate-100">
          {overdue && (
            <span className="flex items-center gap-0.5 text-red-700">
              <AlertTriangle className="w-3 h-3" /> Overdue
            </span>
          )}
          {today && (
            <span className="flex items-center gap-0.5 text-amber-700">
              <Clock className="w-3 h-3" /> Today
            </span>
          )}
          {stuck && (
            <span className="flex items-center gap-0.5 text-purple-700">
              <Snowflake className="w-3 h-3" /> Stuck {daysInStage}d
            </span>
          )}
          {lockExpiringSoon && (
            <span className="flex items-center gap-0.5 text-orange-700">
              <Lock className="w-3 h-3" /> Lock {lockDaysLeft === 0 ? 'today' : `${lockDaysLeft}d`}
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <p className="text-slate-400 uppercase tracking-wider font-medium text-[9px]">LO</p>
            <p className="text-slate-800 font-medium truncate">{deal.loan_officer || '—'}</p>
          </div>
          <div>
            <p className="text-slate-400 uppercase tracking-wider font-medium text-[9px]">Amount</p>
            <p className="text-slate-800 font-medium tabular-nums">{deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}</p>
          </div>
          <div>
            <p className="text-slate-400 uppercase tracking-wider font-medium text-[9px]">In Stage</p>
            <p className="text-slate-800 font-medium">{daysInStage == null ? '—' : `${daysInStage}d`}</p>
          </div>
        </div>

        {/* Next action editor */}
        <div className="border-t border-slate-100 pt-3 flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1">
              <Flame className="w-3 h-3" /> Next Step
            </label>
            {savingFlash && (
              <span className="text-[10px] text-emerald-600 flex items-center gap-0.5">
                <CheckCircle2 className="w-3 h-3" /> Saved
              </span>
            )}
          </div>
          <textarea
            value={nextAction}
            onChange={e => setNextAction(e.target.value)}
            onBlur={() => saveField('next_action', nextAction.trim() || null)}
            rows={2}
            placeholder="Describe the next action…"
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 resize-none placeholder:text-slate-300"
          />
        </div>

        {/* Follow-up date+time + assignee + priority */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
              <CalendarClock className="w-3 h-3" /> Follow-up
            </label>
            <input
              type="datetime-local"
              value={isoToLocalInput(deal.next_action_due)}
              onChange={e => saveField('next_action_due', localInputToISO(e.target.value))}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {deal.next_action_due && (
              <p className={`text-[10px] mt-1 font-medium ${overdue ? 'text-red-700' : today ? 'text-amber-700' : 'text-slate-500'}`}>
                {formatDueLabel(deal.next_action_due)}
              </p>
            )}
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
              <User className="w-3 h-3" /> Assigned to
            </label>
            <select
              value={deal.next_action_assignee || ''}
              onChange={e => saveField('next_action_assignee', e.target.value || null)}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-xs text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Unassigned —</option>
              {ASSIGNEE_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        {/* Priority + open link */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Priority:</span>
            <div className="flex gap-1">
              {PRIORITY_OPTIONS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => saveField('escrow_priority', deal.escrow_priority === p.value ? null : p.value)}
                  className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border transition ${
                    deal.escrow_priority === p.value
                      ? p.color
                      : 'border-slate-200 text-slate-400 hover:border-slate-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <Link
            href={`/deals/${deal.id}`}
            className="flex items-center gap-0.5 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Open <ChevronRight className="w-3 h-3" />
          </Link>
        </div>

        {/* Hint chip showing priority subtly when set */}
        {priorityOpt && deal.escrow_priority === 'high' && (
          <div className="text-[10px] text-red-700 bg-red-50 rounded px-2 py-1 font-medium flex items-center gap-1">
            <Flame className="w-3 h-3" /> Marked as high priority
          </div>
        )}
      </div>
    </div>
  )
}
