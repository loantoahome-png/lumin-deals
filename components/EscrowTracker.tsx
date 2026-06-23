'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  DndContext, useSensors, useSensor, PointerSensor,
  useDraggable, useDroppable, type DragEndEvent,
} from '@dnd-kit/core'
import { Deal, STATUS_COLORS, STAGE_SLA_DAYS, Communication, PROCESSORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import {
  AlertTriangle, Clock, ChevronRight, CalendarClock,
  Flame, ExternalLink, CheckCircle2, Lock, Search,
  Phone, GripVertical, UserCog,
} from 'lucide-react'


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

/** Split an ISO timestamp into local date (YYYY-MM-DD) and time (HH:mm). */
function splitDateTime(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** Combine a local date + time string into an ISO timestamp. */
function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const t = time || '09:00' // default to 9 AM if user didn't pick a time
  const d = new Date(`${date}T${t}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/** Today's date in local YYYY-MM-DD format. */
function todayLocalDate(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Tomorrow's date in local YYYY-MM-DD format. */
function tomorrowLocalDate(): string {
  const d = new Date(); d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Pre-computed 30-min time slots from 7:00 AM through 8:00 PM
const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const opts: { value: string; label: string }[] = []
  for (let h = 7; h <= 20; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0')
      const mm = String(m).padStart(2, '0')
      const value = `${hh}:${mm}`
      const period = h < 12 ? 'AM' : 'PM'
      const h12 = h === 12 ? 12 : h % 12 === 0 ? 12 : h % 12
      opts.push({ value, label: `${h12}:${mm} ${period}` })
    }
  }
  return opts
})()

// ── Filter types ────────────────────────────────────────────────────────────
type FollowUpFilter = 'all' | 'mine' | 'overdue' | 'today' | 'week' | 'unassigned' | 'no_action' | 'blocked' | 'above_sla'

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
        case 'blocked':
          return !!d.waiting_on && d.waiting_on !== 'No one'
        case 'above_sla': {
          const sla = STAGE_SLA_DAYS[d.status]
          const inStage = daysSince(d.stage_changed_at) ?? daysSince(d.created_at)
          return sla != null && inStage != null && inStage > sla
        }
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

  // ── Stable display order ────────────────────────────────────────────────────
  // The sort above is by next_action_due, so the instant you set a follow-up date
  // the card floats up into the by-due order and "jumps" out from under you.
  // Freeze the order: only reflow when the SET of visible cards changes
  // (add/remove/filter/search/user) or on reload — never on an inline field edit.
  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const membershipKey = useMemo(
    () => [...filteredAndSorted.map(d => d.id)].sort().join(','),
    [filteredAndSorted],
  )
  useEffect(() => {
    setOrderedIds(filteredAndSorted.map(d => d.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey, filter, search, currentUser])

  const displayList = useMemo(() => {
    const byId = new Map(filteredAndSorted.map(d => [d.id, d]))
    const inOrder = orderedIds.map(id => byId.get(id)).filter((d): d is Deal => !!d)
    const seen = new Set(orderedIds)
    for (const d of filteredAndSorted) if (!seen.has(d.id)) inOrder.push(d) // new cards → end
    return inOrder
  }, [filteredAndSorted, orderedIds])

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
      blocked: deals.filter(d => !!d.waiting_on && d.waiting_on !== 'No one').length,
      above_sla: deals.filter(d => {
        const sla = STAGE_SLA_DAYS[d.status]
        const inStage = daysSince(d.stage_changed_at) ?? daysSince(d.created_at)
        return sla != null && inStage != null && inStage > sla
      }).length,
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
          <FilterChip active={filter==='blocked'}    onClick={() => setFilter('blocked')}    label="Blocked"       count={counts.blocked} tone="amber" />
          <FilterChip active={filter==='above_sla'}  onClick={() => setFilter('above_sla')}  label="Above SLA"     count={counts.above_sla} />
          <FilterChip active={filter==='unassigned'} onClick={() => setFilter('unassigned')} label="Unassigned"    count={counts.unassigned} />
          <FilterChip active={filter==='no_action'}  onClick={() => setFilter('no_action')}  label="No next step"  count={counts.no_action} />
        </div>
      </div>

      {/* Kanban: columns per escrow stage, cards stacked within each */}
      {displayList.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">Nothing matches this filter</p>
          <p className="text-xs text-slate-500 mt-1">Try a different filter or search term.</p>
        </div>
      ) : (
        <KanbanColumns deals={displayList} onUpdate={onUpdate} />
      )}
    </div>
  )
}

// ── Kanban layout: one column per active escrow stage ───────────────────────
const ESCROW_STAGES = [
  'Loan Setup',
  'Disclosed',
  'Submitted to UW',
  'Approved w/ Conditions',
  'Re-Submittal',
  'Clear to Close',
  'Docs Out',
  'Docs Signed',
] as const

// Subtle accent strip color per stage so columns are visually scannable
const STAGE_ACCENT: Record<string, string> = {
  'Loan Setup':              'bg-yellow-400',
  'Disclosed':               'bg-amber-500',
  'Submitted to UW':         'bg-orange-500',
  'Approved w/ Conditions':  'bg-lime-500',
  'Re-Submittal':            'bg-red-500',
  'Clear to Close':          'bg-emerald-500',
  'Docs Out':                'bg-teal-500',
  'Docs Signed':             'bg-green-600',
}

// Header tint per stage — light tone of the stage color + a tinted border
// so the card title strip echoes the column it lives in.
const STAGE_HEADER_TINT: Record<string, string> = {
  'Loan Setup':              'bg-yellow-100 border-yellow-300',
  'Disclosed':               'bg-amber-100 border-amber-300',
  'Submitted to UW':         'bg-orange-100 border-orange-300',
  'Approved w/ Conditions':  'bg-lime-100 border-lime-300',
  'Re-Submittal':            'bg-red-100 border-red-300',
  'Clear to Close':          'bg-emerald-100 border-emerald-300',
  'Docs Out':                'bg-teal-100 border-teal-300',
  'Docs Signed':             'bg-green-100 border-green-300',
}

function fmtMoneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${n}`
}

function KanbanColumns({ deals, onUpdate }: {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  // 8px activation distance so clicks inside cards (textareas, dropdowns, buttons)
  // never accidentally trigger a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // Group already-sorted deals by status. Any unknown status goes to "Other".
  const byStage: Record<string, Deal[]> = {}
  for (const stage of ESCROW_STAGES) byStage[stage] = []
  const otherDeals: Deal[] = []
  for (const d of deals) {
    if (byStage[d.status]) byStage[d.status].push(d)
    else otherDeals.push(d)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const dealId = String(active.id)
    const newStatus = String(over.id)
    const deal = deals.find(d => d.id === dealId)
    if (!deal || deal.status === newStatus) return
    if (!ESCROW_STAGES.includes(newStatus as typeof ESCROW_STAGES[number])) return // safety
    // Persist; stage_changed_at is auto-updated by the Postgres trigger
    onUpdate(dealId, { status: newStatus })
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto pb-2 -mx-4 px-4">
        <div className="flex gap-3 min-w-max">
          {ESCROW_STAGES.map(stage => {
            const stageDeals = byStage[stage]
            const totalVolume = stageDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
            return (
              <KanbanColumn
                key={stage}
                stage={stage}
                deals={stageDeals}
                totalVolume={totalVolume}
                accentClass={STAGE_ACCENT[stage] || 'bg-slate-300'}
                onUpdate={onUpdate}
              />
            )
          })}

          {otherDeals.length > 0 && (
            <KanbanColumn
              key="other"
              stage="Other"
              deals={otherDeals}
              totalVolume={otherDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)}
              accentClass="bg-slate-400"
              onUpdate={onUpdate}
              isOtherColumn
            />
          )}
        </div>
      </div>
    </DndContext>
  )
}

function KanbanColumn({ stage, deals, totalVolume, accentClass, onUpdate, isOtherColumn }: {
  stage: string
  deals: Deal[]
  totalVolume: number
  accentClass: string
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  isOtherColumn?: boolean
}) {
  // "Other" column isn't a valid drop target — only the 8 real stages accept drops
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: isOtherColumn })

  return (
    <div className="w-[360px] shrink-0 flex flex-col">
      {/* Column header */}
      <div className="bg-white rounded-t-xl border border-slate-200 border-b-0 overflow-hidden">
        <div className={`h-1 ${accentClass}`} />
        <div className="px-4 py-2.5 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800 truncate">{stage}</h3>
            {totalVolume > 0 && (
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">{fmtMoneyShort(totalVolume)} volume</p>
            )}
          </div>
          <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 rounded-full px-2 py-0.5 tabular-nums shrink-0">
            {deals.length}
          </span>
        </div>
      </div>

      {/* Column body — drop target */}
      <div
        ref={setNodeRef}
        className={`border border-t-0 rounded-b-xl p-2 space-y-2 flex-1 min-h-[160px] transition-colors ${
          isOver
            ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-200'
            : 'bg-slate-50/60 border-slate-200'
        }`}
      >
        {deals.length === 0 ? (
          <div className={`text-center text-[11px] italic py-6 ${isOver ? 'text-blue-600 font-medium' : 'text-slate-400'}`}>
            {isOver ? `Drop to move to ${stage}` : 'No deals'}
          </div>
        ) : (
          deals.map(d => <DraggableEscrowCard key={d.id} deal={d} onUpdate={onUpdate} />)
        )}
      </div>
    </div>
  )
}

function DraggableEscrowCard({ deal, onUpdate }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 as const }
    : undefined
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-40' : ''}>
      <EscrowCard deal={deal} onUpdate={onUpdate} dragHandleProps={{ ...attributes, ...listeners }} />
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
function EscrowCard({ deal, onUpdate, dragHandleProps }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
}) {
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
  const lockDaysLeft = daysUntil(deal.lock_expiration)
  const lockExpiringSoon = lockDaysLeft != null && lockDaysLeft >= 0 && lockDaysLeft <= 7
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'
  const priorityOpt = PRIORITY_OPTIONS.find(p => p.value === deal.escrow_priority)
  // Last communication summary (if any)
  const comms = (deal.communications as Communication[] | null) || []
  const lastComm = comms.length > 0 ? [...comms].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )[0] : null
  const lastCommDays = lastComm ? daysSince(lastComm.timestamp) : null

  const borderClass = overdue
    ? 'border-red-300 ring-2 ring-red-100'
    : today
    ? 'border-amber-300 ring-2 ring-amber-100'
    : 'border-slate-200'

  const ghlUrl = ghlContactUrl(deal)
  const aUrl = ariveUrl(deal.arive_file_no)

  return (
    <div className={`bg-white rounded-xl border ${borderClass} shadow-md overflow-hidden transition-shadow hover:shadow-lg flex flex-col`}>
      {/* Header — borrower name gets its OWN full-width line so it's never
          squished; the quick-links and stage badge sit on a tidy second row. */}
      <div
        {...dragHandleProps}
        className={`px-4 pt-2.5 pb-2 border-b ${
          STAGE_HEADER_TINT[deal.status] || 'bg-slate-200 border-slate-300'
        } ${dragHandleProps ? 'cursor-grab active:cursor-grabbing select-none' : ''}`}
        title={dragHandleProps ? 'Drag to move to another stage' : undefined}
      >
        {/* Row 1 — name */}
        <div className="flex items-center gap-1.5 min-w-0">
          {dragHandleProps && <GripVertical className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
          <Link
            href={`/deals/${deal.id}`}
            onPointerDown={e => e.stopPropagation()}
            title={deal.name}
            className="font-bold text-[15px] leading-tight text-slate-900 hover:text-blue-700 truncate flex items-center gap-1 group min-w-0"
          >
            <span className="truncate">{deal.name}</span>
            <ExternalLink className="w-3 h-3 text-slate-400 group-hover:text-blue-500 opacity-0 group-hover:opacity-100 transition shrink-0" />
          </Link>
          {deal.coborrowers && deal.coborrowers.length > 0 && (
            <span
              title={`${deal.coborrowers.length} co-borrower${deal.coborrowers.length === 1 ? '' : 's'}: ${deal.coborrowers.map(c => c.name || c.email || c.contact_id).join(', ')}`}
              className="shrink-0 text-[10px] font-bold text-sky-700 bg-sky-100 rounded px-1 py-0.5 leading-none">
              +{deal.coborrowers.length}
            </span>
          )}
        </div>

        {/* Row 2 — quick links + stage badge */}
        <div className="flex items-center justify-between gap-2 mt-2">
          <div className="flex items-center gap-1">
            {ghlUrl && (
              <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
                onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
                title="Open contact in GoHighLevel"
                className="flex items-center gap-0.5 text-[10px] font-bold text-blue-700 hover:text-white hover:bg-blue-600 px-2 py-1 rounded-md bg-white/70 border border-blue-200 transition-colors">
                GHL <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
            {aUrl && (
              <a href={aUrl} target="_blank" rel="noopener noreferrer"
                onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
                title="Open loan file in Arive"
                className="flex items-center gap-0.5 text-[10px] font-bold text-orange-700 hover:text-white hover:bg-orange-600 px-2 py-1 rounded-md bg-white/70 border border-orange-200 transition-colors">
                Arive <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${statusClass}`}>
            {deal.status}
          </span>
        </div>
      </div>

      {/* Alerts row */}
      {(overdue || today || lockExpiringSoon) && (
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
          {lockExpiringSoon && (
            <span className="flex items-center gap-0.5 text-orange-700">
              <Lock className="w-3 h-3" /> Lock {lockDaysLeft === 0 ? 'today' : `${lockDaysLeft}d`}
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Quick stats — Lender · Amount (hero) · LO */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5">
          <div className="self-center min-w-0">
            <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">Lender</p>
            <p className="text-xs font-semibold text-slate-700 truncate mt-0.5" title={deal.investor || undefined}>{deal.investor || '—'}</p>
          </div>
          <div className="min-w-0 px-1 text-center">
            <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">Amount</p>
            <p className="text-lg font-extrabold text-slate-900 tabular-nums leading-tight whitespace-nowrap">
              {deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}
            </p>
          </div>
          <div className="self-center min-w-0 text-right">
            <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">LO</p>
            <p className="text-xs font-semibold text-slate-700 truncate mt-0.5" title={deal.loan_officer || undefined}>{deal.loan_officer || '—'}</p>
          </div>
        </div>

        {/* Subbed on teams */}
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!deal.subbed}
            onChange={e => saveField('subbed', e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
          Subbed on teams
        </label>

        {/* Processor — dropdown + handoff checkbox */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1 shrink-0">
              <UserCog className="w-3 h-3" /> Processor
            </label>
            <select
              value={deal.processor_status || ''}
              onChange={e => saveField('processor_status', e.target.value || null)}
              className={`flex-1 px-2 py-1 border rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                deal.processor_status
                  ? 'bg-cyan-50 border-cyan-200 text-cyan-800 font-semibold'
                  : 'bg-white border-slate-200 text-slate-500'
              }`}
            >
              <option value="">— Unassigned —</option>
              {PROCESSORS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {/* Processor Handoff */}
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!deal.processor_handoff}
              onChange={e => saveField('processor_handoff', e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
            Processor Handoff
          </label>
        </div>

        {/* Next action editor — the focal point of the card (Lumin orange) */}
        <div className="flex-1 flex flex-col rounded-lg bg-orange-50 border border-orange-200 p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-[#F37021] flex items-center gap-1">
              <Flame className="w-3.5 h-3.5" /> Next Step
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
            className="w-full flex-1 px-2.5 py-1.5 border border-orange-200 rounded-md text-sm font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-[#F37021] focus:border-orange-400 resize-none placeholder:text-slate-400 placeholder:font-normal"
          />
          {/* Follow-up now lives inside the Next Step section */}
          <div className="mt-2 pt-2 border-t border-orange-200">
            <FollowUpPicker
              value={deal.next_action_due}
              onChange={v => saveField('next_action_due', v)}
              overdue={overdue}
              today={today}
            />
          </div>
        </div>

        {/* Last contact */}
        {lastComm && (
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 bg-slate-50 rounded px-2 py-1">
            <Phone className="w-3 h-3 text-slate-400 shrink-0" />
            <span className="truncate">
              <span className="font-semibold text-slate-700">
                Last: {lastCommDays === 0 ? 'Today' : lastCommDays === 1 ? '1d ago' : `${lastCommDays}d ago`}
              </span>
              {' — '}
              {lastComm.channel}
              {lastComm.with ? ` to ${lastComm.with}` : ''}
              {lastComm.outcome ? `: ${lastComm.outcome}` : ''}
            </span>
          </div>
        )}

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

/** Friendly follow-up picker — separate date + time dropdown with quick presets. */
function FollowUpPicker({ value, onChange, overdue, today }: {
  value: string | null
  onChange: (iso: string | null) => void
  overdue: boolean
  today: boolean
}) {
  // ── Local draft state ─────────────────────────────────────────────────────
  // If we commit the date the instant the user picks it, the parent re-saves,
  // the column re-sorts by `next_action_due`, and the card jumps away before
  // the user can reach the time dropdown. So we hold a draft locally and only
  // commit when:
  //   • a preset is clicked
  //   • the user picks a time
  //   • focus leaves the whole picker (e.g. they tab/click out)
  const { date: incomingDate, time: incomingTime } = splitDateTime(value)
  const [draftDate, setDraftDate] = useState(incomingDate)
  const [draftTime, setDraftTime] = useState(incomingTime)
  const editingRef = useRef(false)

  // Sync draft with upstream changes — but never while the user is mid-edit.
  useEffect(() => {
    if (!editingRef.current) {
      setDraftDate(incomingDate)
      setDraftTime(incomingTime)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function commit(d: string, t: string) {
    editingRef.current = false
    if (!d) { onChange(null); return }
    onChange(combineDateTime(d, t || '09:00'))
  }
  function handleDateChange(d: string) {
    editingRef.current = true
    setDraftDate(d)
    // Don't commit yet — wait for the user to set a time or blur out.
  }
  function handleTimeChange(t: string) {
    setDraftTime(t)
    // Time is the second half of the choice — commit both now.
    commit(draftDate || todayLocalDate(), t)
  }
  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    // Only fire when focus leaves the whole picker (not when moving from
    // date → time within it). currentTarget is the wrapper div.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    if (editingRef.current) {
      commit(draftDate, draftTime || '09:00')
    }
  }
  function applyPreset(d: string, t: string) {
    setDraftDate(d); setDraftTime(t)
    commit(d, t)
  }
  function clear() {
    setDraftDate('')
    setDraftTime('')
    onChange(null)
    editingRef.current = false
  }

  // Show "pending — pick a time" hint if user has drafted a date but no time yet
  const hasUnsavedDate = editingRef.current && draftDate && draftDate !== incomingDate

  return (
    <div onBlur={handleBlur}>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
        <CalendarClock className="w-3 h-3" /> Follow-up
      </label>
      {/* Quick presets */}
      <div className="flex gap-1 mb-1.5 flex-wrap">
        <PresetButton label="Today 9a"  onClick={() => applyPreset(todayLocalDate(),    '09:00')} />
        <PresetButton label="Today 2p"  onClick={() => applyPreset(todayLocalDate(),    '14:00')} />
        <PresetButton label="Tomorrow"  onClick={() => applyPreset(tomorrowLocalDate(), '09:00')} />
        {(value || draftDate) && <PresetButton label="Clear" onClick={clear} variant="danger" />}
      </div>
      {/* Date + time inputs — date takes ~60% of width, time dropdown ~40% */}
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <input
          type="date"
          value={draftDate}
          onChange={e => handleDateChange(e.target.value)}
          className={`w-full px-2.5 py-1.5 border rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums ${
            hasUnsavedDate ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200'
          } ${draftDate === '' ? 'date-empty' : ''}`}
        />
        <select
          value={draftTime}
          onChange={e => handleTimeChange(e.target.value)}
          className={`w-32 px-2 py-1.5 border rounded-md text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            hasUnsavedDate ? 'border-amber-300 ring-1 ring-amber-200' : 'border-slate-200'
          }`}
        >
          <option value="">— Time —</option>
          {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {hasUnsavedDate ? (
        <p className="text-[10px] mt-1 font-medium text-amber-700">
          Pick a time to save · defaults to 9:00 AM if you click away
        </p>
      ) : value ? (
        <p className={`text-[10px] mt-1 font-medium ${overdue ? 'text-red-700' : today ? 'text-amber-700' : 'text-slate-500'}`}>
          {formatDueLabel(value)}
        </p>
      ) : null}
    </div>
  )
}

function PresetButton({ label, onClick, variant }: {
  label: string; onClick: () => void; variant?: 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
        variant === 'danger'
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50'
      }`}
    >
      {label}
    </button>
  )
}
