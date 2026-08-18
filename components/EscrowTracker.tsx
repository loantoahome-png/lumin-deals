'use client'

import { useCallback, useMemo, useState, useEffect } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import {
  DndContext, useSensors, useSensor, PointerSensor,
  useDraggable, useDroppable, type DragEndEvent,
} from '@dnd-kit/core'
import { supabase } from '@/lib/supabase'
import { Deal, DealTask, STATUS_COLORS, STAGE_SLA_DAYS, Communication, PROCESSORS } from '@/lib/types'
import { toBoardTask, type BoardTask, type GhlTaskRow } from '@/lib/ghlTasks'
import { formatCurrency } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import NextStepLog from '@/components/NextStepLog'
import DealTasks from '@/components/DealTasks'
import {
  AlertTriangle, Clock, ChevronRight, Calendar,
  Flame, ExternalLink, CheckCircle2, Lock, Search,
  Phone, GripVertical, UserCog, ListTodo, Plus, X, User,
} from 'lucide-react'


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

// ── Rate lock ───────────────────────────────────────────────────────────────
// `locked` is a 'Yes'/'No' string and `lock_expiration` a DATE-ONLY column, so
// `new Date('2026-08-25')` is UTC midnight — a full day early in Pacific. Parse
// the parts as local midnight, the same way lib/utils formatDate does.
function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s)
}
/** Whole days from today (local midnight) to the lock expiry (local midnight). */
function lockDaysLeft(iso: string | null): number | null {
  if (!iso) return null
  const exp = parseLocalDate(iso)
  if (isNaN(exp.getTime())) return null
  return Math.round((startOfDay(exp).getTime() - startOfDay(new Date()).getTime()) / MS_PER_DAY)
}
const fmtShortDate = (iso: string) => {
  const d = parseLocalDate(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type LockTone = 'slate' | 'green' | 'amber' | 'red'
type LockInfo = { locked: boolean; label: string; short: string | null; tone: LockTone; days: number | null; alert: boolean }

/**
 * Lock summary for one deal.
 *
 * ⚠️ The EXPIRATION DATE is the evidence of a lock here, not the `locked`
 * Yes/No flag. `lock_expiration` is imported from Arive ('Lock Expiration' in
 * lib/ariveCsv.ts); `locked` has NO import mapping at all — it is hand-set on
 * the deal page and defaults to 'No', so it goes stale immediately. Checked
 * 2026-08-18: of 18 active escrows, 12 carry an Arive lock expiry but only 2
 * have locked = 'Yes' (Tommy Moua is at Docs Signed with a Sep 4 expiry and
 * locked = 'No'). Gating on the flag would print "Not locked" over a live lock
 * and silence the expiry alert the card has always shown.
 */
function lockInfo(deal: Deal): LockInfo {
  const flagged = (deal.locked || '').trim().toLowerCase() === 'yes'
  if (!deal.lock_expiration) {
    return flagged
      ? { locked: true, label: 'Locked · no expiry', short: 'No expiry', tone: 'amber', days: null, alert: true }
      : { locked: false, label: 'Not locked', short: null, tone: 'slate', days: null, alert: false }
  }
  const d = lockDaysLeft(deal.lock_expiration)
  const exp = fmtShortDate(deal.lock_expiration)
  if (d == null) return { locked: true, label: `Locked · ${exp}`, short: exp, tone: 'green', days: null, alert: false }
  if (d < 0)  return { locked: true, label: `Expired ${exp} · ${-d}d ago`, short: `Expired ${-d}d`, tone: 'red', days: d, alert: true }
  if (d === 0) return { locked: true, label: `Expires today · ${exp}`, short: 'Expires today', tone: 'amber', days: d, alert: true }
  if (d <= 7) return { locked: true, label: `${exp} · ${d}d left`, short: `${d}d left`, tone: 'amber', days: d, alert: true }
  return { locked: true, label: `${exp} · ${d}d left`, short: `${d}d left`, tone: 'green', days: d, alert: false }
}

const LOCK_TONE: Record<LockTone, string> = {
  slate: 'text-slate-500 bg-slate-100 border-slate-200',
  green: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  amber: 'text-amber-700 bg-amber-50 border-amber-200',
  red:   'text-red-700 bg-red-50 border-red-200',
}

// ── Tasks ───────────────────────────────────────────────────────────────────
// A blank time is stored as 23:59 by the task form ("all day") — same marker
// DealTasks uses. Kept compact here: the card only has room for a chip.
function taskDue(iso: string | null): { label: string; tone: 'red' | 'violet' | 'slate' } | null {
  if (!iso) return null
  const due = new Date(iso)
  if (isNaN(due.getTime())) return null
  const allDay = due.getHours() === 23 && due.getMinutes() === 59
  const dayDelta = Math.round((startOfDay(new Date(due)).getTime() - startOfDay(new Date()).getTime()) / MS_PER_DAY)
  if (due < new Date()) return { label: dayDelta === 0 ? 'Overdue' : `Overdue ${-dayDelta || 1}d`, tone: 'red' }
  if (dayDelta === 0) return { label: allDay ? 'Today' : `Today ${due.toLocaleTimeString('en-US', { hour: 'numeric' })}`, tone: 'violet' }
  if (dayDelta === 1) return { label: 'Tomorrow', tone: 'slate' }
  return { label: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), tone: 'slate' }
}
const TASK_DUE_TONE = { red: 'text-red-700 bg-red-50', violet: 'text-violet-700 bg-violet-50', slate: 'text-slate-500 bg-slate-100' }

const NO_TASKS: BoardTask[] = []

// PostgREST caps a bare .select() at 1000 rows — page until exhausted or the
// board silently stops showing tasks past the cap. Same shape as fetchAllDeals.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function pageAll<T>(table: string, refine?: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    let q: any = supabase.from(table).select('*')
    if (refine) q = refine(q)
    const { data, error } = await q.range(offset, offset + PAGE - 1)
    if (error) { console.error(`[EscrowTracker] ${table} page failed:`, error.message); break }
    const rows = (data as T[]) ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  // Processor facet — independent of the quick-filter; null = all processors.
  const [processorFilter, setProcessorFilter] = useState<string | null>(null)

  // ── Open tasks, per deal ──────────────────────────────────────────────────
  // Loaded ONCE for the whole board, not per card — 26 cards fetching their own
  // rows is 52 round trips for two tables that fit in one pass each. Both
  // sources the /tasks board renders: our `deal_tasks` rows and the GHL mirror
  // (which stores OPEN rows only, so it needs no completed filter).
  const [tasksByDeal, setTasksByDeal] = useState<Map<string, BoardTask[]>>(new Map())
  const loadTasks = useCallback(async () => {
    const [ours, ghl] = await Promise.all([
      pageAll<DealTask>('deal_tasks', q => q.is('completed_at', null)),
      pageAll<GhlTaskRow>('ghl_tasks'),
    ])
    const m = new Map<string, BoardTask[]>()
    const add = (t: BoardTask) => {
      if (!t.deal_id) return
      const arr = m.get(t.deal_id) ?? []
      arr.push(t)
      m.set(t.deal_id, arr)
    }
    for (const t of ours) add(t as BoardTask)
    for (const r of ghl) add(toBoardTask(r))
    // Soonest due first; undated tasks last.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
        const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
        return da - db
      })
    }
    setTasksByDeal(m)
  }, [])
  useEffect(() => { void loadTasks() }, [loadTasks])

  // The soonest open-task due date on a deal — the board's date filters read it
  // alongside next_action_due. With the card's follow-up picker replaced by
  // tasks, a task due date IS the follow-up here; leaving the chips on
  // next_action_due alone would count 0 Overdue while cards ring red.
  const nextTaskDue = useCallback((dealId: string): Date | null => {
    let soonest: number | null = null
    for (const t of tasksByDeal.get(dealId) ?? []) {
      if (!t.due_at) continue
      const ms = new Date(t.due_at).getTime()
      if (isNaN(ms)) continue
      if (soonest == null || ms < soonest) soonest = ms
    }
    return soonest == null ? null : new Date(soonest)
  }, [tasksByDeal])

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

      // Processor facet — composes with the quick-filter + search.
      if (processorFilter) {
        const p = d.processor_status || d.processor || 'Unassigned'
        if (p !== processorFilter) return false
      }

      // Earliest of the deal's own follow-up date and its soonest open task.
      const actionDue = d.next_action_due ? new Date(d.next_action_due) : null
      const taskDueAt = nextTaskDue(d.id)
      const due = actionDue && taskDueAt
        ? (actionDue < taskDueAt ? actionDue : taskDueAt)
        : (actionDue ?? taskDueAt)

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
  }, [deals, filter, search, currentUser, processorFilter, nextTaskDue])

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
  }, [membershipKey, filter, search, currentUser, processorFilter])

  const displayList = useMemo(() => {
    const byId = new Map(filteredAndSorted.map(d => [d.id, d]))
    const inOrder = orderedIds.map(id => byId.get(id)).filter((d): d is Deal => !!d)
    const seen = new Set(orderedIds)
    for (const d of filteredAndSorted) if (!seen.has(d.id)) inOrder.push(d) // new cards → end
    return inOrder
  }, [filteredAndSorted, orderedIds])

  // Counts for filter chips — same due-date rule as the filters above (deal
  // follow-up OR soonest open task), or a chip would read 0 next to a board
  // full of red cards.
  const counts = useMemo(() => {
    const now = new Date()
    const today = startOfDay(new Date())
    const weekFromNow = new Date(today.getTime() + 7 * MS_PER_DAY)
    const dueOf = (d: Deal): Date | null => {
      const a = d.next_action_due ? new Date(d.next_action_due) : null
      const t = nextTaskDue(d.id)
      return a && t ? (a < t ? a : t) : (a ?? t)
    }
    return {
      all: deals.length,
      mine: currentUser ? deals.filter(d => d.next_action_assignee === currentUser || d.loan_officer === currentUser).length : 0,
      overdue: deals.filter(d => { const due = dueOf(d); return due != null && due < now }).length,
      today: deals.filter(d => {
        const due = dueOf(d)
        return due != null && due >= today && due <= endOfDay(new Date())
      }).length,
      week: deals.filter(d => {
        const due = dueOf(d)
        return due != null && due >= now && due <= weekFromNow
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
  }, [deals, currentUser, nextTaskDue])

  // How many active escrows each processor is carrying, across the current
  // (LO-filtered) set — the same processor field the report shows
  // (processor_status, falling back to processor). Known processors in PROCESSORS
  // order, any legacy/unknown values next, Unassigned last (only when > 0).
  const processorCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of deals) {
      const p = d.processor_status || d.processor || 'Unassigned'
      m.set(p, (m.get(p) ?? 0) + 1)
    }
    const ordered: { name: string; count: number }[] = []
    for (const p of PROCESSORS) if (m.has(p)) { ordered.push({ name: p, count: m.get(p)! }); m.delete(p) }
    const unassigned = m.get('Unassigned') ?? 0
    m.delete('Unassigned')
    for (const [name, count] of m) ordered.push({ name, count })
    if (unassigned > 0) ordered.push({ name: 'Unassigned', count: unassigned })
    return ordered
  }, [deals])

  // If the selected processor drops out of the current set (e.g. an LO-filter
  // change leaves them with 0 escrows), clear the facet so the board can't get
  // stuck on a filter with no chip left to toggle off.
  useEffect(() => {
    if (processorFilter && !processorCounts.some(p => p.name === processorFilter)) {
      setProcessorFilter(null)
    }
  }, [processorCounts, processorFilter])

  return (
    <div className="p-4 space-y-4">
      {/* Per-processor workload — click a chip to filter the board to that processor */}
      {deals.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap bg-white border border-slate-200 rounded-xl px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <UserCog className="w-3.5 h-3.5" /> By processor
          </span>
          {processorCounts.map(({ name, count }) => {
            const active = processorFilter === name
            const isUnassigned = name === 'Unassigned'
            return (
              <button
                key={name}
                onClick={() => setProcessorFilter(active ? null : name)}
                title={active ? 'Clear processor filter' : `Show only ${name}`}
                className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2 py-1 border transition-colors ${
                  active
                    ? 'text-white bg-blue-600 border-blue-600'
                    : isUnassigned
                      ? 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100'
                      : 'text-slate-700 bg-slate-50 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {name}
                <span className={`text-[11px] font-bold tabular-nums rounded-full px-1.5 border ${active ? 'text-blue-700 bg-white border-white' : 'text-slate-900 bg-white border-slate-200'}`}>{count}</span>
              </button>
            )
          })}
          {processorFilter && (
            <button
              onClick={() => setProcessorFilter(null)}
              className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 underline decoration-dotted ml-0.5"
            >
              Clear
            </button>
          )}
        </div>
      )}

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
          <FilterChip active={filter==='today'}      onClick={() => setFilter('today')}      label="Today"         count={counts.today} tone="violet" />
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
        <KanbanColumns deals={displayList} onUpdate={onUpdate} tasksByDeal={tasksByDeal} onTasksChanged={loadTasks} />
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

function KanbanColumns({ deals, onUpdate, tasksByDeal, onTasksChanged }: {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  tasksByDeal: Map<string, BoardTask[]>
  onTasksChanged: () => void
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
                tasksByDeal={tasksByDeal}
                onTasksChanged={onTasksChanged}
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
              tasksByDeal={tasksByDeal}
              onTasksChanged={onTasksChanged}
              isOtherColumn
            />
          )}
        </div>
      </div>
    </DndContext>
  )
}

function KanbanColumn({ stage, deals, totalVolume, accentClass, onUpdate, tasksByDeal, onTasksChanged, isOtherColumn }: {
  stage: string
  deals: Deal[]
  totalVolume: number
  accentClass: string
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  tasksByDeal: Map<string, BoardTask[]>
  onTasksChanged: () => void
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
          deals.map(d => (
            <DraggableEscrowCard
              key={d.id}
              deal={d}
              onUpdate={onUpdate}
              tasks={tasksByDeal.get(d.id) ?? NO_TASKS}
              onTasksChanged={onTasksChanged}
            />
          ))
        )}
      </div>
    </div>
  )
}

function DraggableEscrowCard({ deal, onUpdate, tasks, onTasksChanged }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  tasks: BoardTask[]
  onTasksChanged: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 as const }
    : undefined
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-40' : ''}>
      <EscrowCard
        deal={deal}
        onUpdate={onUpdate}
        tasks={tasks}
        onTasksChanged={onTasksChanged}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  )
}

function FilterChip({ active, onClick, label, count, tone, disabled }: {
  active: boolean; onClick: () => void; label: string; count: number; tone?: 'red'|'amber'|'violet'; disabled?: boolean
}) {
  // ⚠️ 'violet' = due today, matching the task board's DueTone. 'amber' is
  //    still Blocked — a genuinely different warning, kept distinct on purpose.
  const activeColor = tone === 'red'
    ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
    : tone === 'violet'
    ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-200'
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
function EscrowCard({ deal, onUpdate, tasks, onTasksChanged, dragHandleProps }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  /** Open tasks on this loan — `deal_tasks` plus the GHL mirror. */
  tasks: BoardTask[]
  onTasksChanged: () => void
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
}) {
  const [savingFlash, setSavingFlash] = useState(false)
  // null = closed. 'new' opens straight into the create form (the "Add task"
  // button is a create action); 'list' just shows what's on the file.
  const [taskPanel, setTaskPanel] = useState<null | 'new' | 'list'>(null)

  async function saveField<K extends keyof Deal>(field: K, value: Deal[K]) {
    if (value === deal[field]) return
    setSavingFlash(true)
    await onUpdate(deal.id, { [field]: value })
    setTimeout(() => setSavingFlash(false), 800)
  }

  // Overdue/today now count TASKS too — with the follow-up picker gone, a task
  // due date is the follow-up on this board. next_action_due is still honoured
  // (it's set from the deal page and Pipeline) so nothing already on the board
  // stops flagging.
  const taskOverdue = tasks.some(t => isOverdue(t.due_at))
  const overdue = isOverdue(deal.next_action_due) || taskOverdue
  const today = !overdue && (isToday(deal.next_action_due) || tasks.some(t => isToday(t.due_at)))
  const lock = lockInfo(deal)
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'
  // Last communication summary (if any)
  const comms = (deal.communications as Communication[] | null) || []
  const lastComm = comms.length > 0 ? [...comms].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )[0] : null
  const lastCommDays = lastComm ? daysSince(lastComm.timestamp) : null

  const borderClass = overdue
    ? 'border-red-300 ring-2 ring-red-100'
    : today
    ? 'border-violet-300 ring-2 ring-violet-100'
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
      {(overdue || today || lock.alert || deal.escrow_priority === 'high') && (
        <div className="px-4 py-1.5 flex items-center gap-2 flex-wrap text-[10px] font-semibold uppercase tracking-wider bg-slate-50/50 border-b border-slate-100">
          {overdue && (
            <span className="flex items-center gap-0.5 text-red-700">
              <AlertTriangle className="w-3 h-3" /> Overdue
            </span>
          )}
          {today && (
            <span className="flex items-center gap-0.5 text-violet-700">
              <Clock className="w-3 h-3" /> Today
            </span>
          )}
          {/* Priority is no longer editable here (Efrain, 2026-08-18: the boxes
              went), but a high-priority file still has to announce itself. Set
              it on the deal page, Pipeline or the processing desk. */}
          {deal.escrow_priority === 'high' && (
            <span className="flex items-center gap-0.5 text-red-700">
              <Flame className="w-3 h-3" /> High
            </span>
          )}
          {lock.alert && (
            <span className={`flex items-center gap-0.5 ${lock.tone === 'red' ? 'text-red-700' : 'text-orange-700'}`}>
              <Lock className="w-3 h-3" /> Lock {lock.short}
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Quick stats — Channel · Amount on top; LO · Lender on the bottom (2×2) */}
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5 space-y-2">
          {/* Row 1 — channel · amount (hero) */}
          <div className="grid grid-cols-2 gap-2 items-center">
            <div className="min-w-0">
              <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">Channel</p>
              <p className="text-xs font-semibold text-slate-700 truncate mt-0.5" title={deal.broker_corr || undefined}>{deal.broker_corr || '—'}</p>
            </div>
            <div className="min-w-0 text-right">
              <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">Amount</p>
              <p className="text-lg font-extrabold text-slate-900 tabular-nums leading-tight whitespace-nowrap">
                {deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}
              </p>
            </div>
          </div>
          {/* Row 2 — LO · lender */}
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200/70">
            <div className="min-w-0">
              <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">LO</p>
              <p className="text-xs font-semibold text-slate-700 truncate mt-0.5" title={deal.loan_officer || undefined}>{deal.loan_officer || '—'}</p>
            </div>
            <div className="min-w-0 text-right">
              <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px]">Lender</p>
              <p className="text-xs font-semibold text-slate-700 truncate mt-0.5" title={deal.investor || undefined}>{deal.investor || '—'}</p>
            </div>
          </div>
          {/* Row 3 — rate lock. Read-only here; set it on the deal page,
              Pipeline, or the processing desk's expanded row. */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/70">
            <p className="text-slate-400 uppercase tracking-wider font-semibold text-[9px] flex items-center gap-1">
              <Lock className="w-3 h-3" /> Lock
            </p>
            <span
              title={deal.lock_expiration ? `Lock expiration ${deal.lock_expiration.slice(0, 10)}` : undefined}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${LOCK_TONE[lock.tone]}`}
            >
              {lock.label}
            </span>
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
          <NextStepLog deal={deal} onUpdate={onUpdate} />
          {/* Tasks replaced the follow-up date picker here (Efrain, 2026-08-18).
              These are the SAME `deal_tasks` rows the /tasks board and the
              processing desk render — plus this contact's open GHL tasks — so a
              task raised from a card lands in the assignee's column, and the
              date lives on the task instead of a card-only field. */}
          <div className="mt-2 pt-2 border-t border-orange-200">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                <ListTodo className="w-3 h-3" /> Tasks
                {tasks.length > 0 && (
                  <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-1.5 tabular-nums">
                    {tasks.length}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setTaskPanel('new')}
                title={`Add a task on ${deal.name}`}
                className="flex items-center gap-0.5 text-[10px] font-bold text-blue-700 bg-white border border-blue-200 rounded-md px-2 py-1 hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add task
              </button>
            </div>

            {tasks.length === 0 ? (
              <p className="text-[11px] italic text-slate-400">No open tasks on this loan.</p>
            ) : (
              <div className="space-y-1">
                {tasks.slice(0, 3).map(t => {
                  const due = taskDue(t.due_at)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTaskPanel('list')}
                      title={t.description || 'Open tasks on this loan'}
                      className="w-full text-left bg-white border border-slate-200 rounded-md px-2 py-1 hover:border-blue-300 hover:shadow-sm transition"
                    >
                      <p className="text-[11px] font-medium text-slate-800 truncate">
                        {t.title}
                        {t.source === 'ghl' && (
                          <span className="ml-1 align-middle text-[8px] font-bold tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1">
                            GHL
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {due && (
                          <span className={`inline-flex items-center gap-0.5 text-[9px] font-semibold rounded px-1 ${TASK_DUE_TONE[due.tone]}`}>
                            <Calendar className="w-2.5 h-2.5" /> {due.label}
                          </span>
                        )}
                        {t.assignee && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] text-slate-500 truncate">
                            <User className="w-2.5 h-2.5 shrink-0" /> {t.assignee}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
                {tasks.length > 3 && (
                  <button
                    type="button"
                    onClick={() => setTaskPanel('list')}
                    className="text-[10px] font-semibold text-blue-700 hover:underline"
                  >
                    +{tasks.length - 3} more task{tasks.length - 3 === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {taskPanel && (
          <TaskPanel
            deal={deal}
            startAdding={taskPanel === 'new'}
            onClose={() => { setTaskPanel(null); onTasksChanged() }}
            onChanged={onTasksChanged}
          />
        )}

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

        {/* Open link — the priority boxes that used to sit here are gone
            (Efrain, 2026-08-18); a high-priority file shows in the alerts row. */}
        <div className="flex items-center justify-end pt-1">
          <Link
            href={`/deals/${deal.id}`}
            className="flex items-center gap-0.5 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Open <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </div>
  )
}


/**
 * Full task list for one loan, in a modal.
 *
 * Portaled to <body> like NextStepLog's popup: the card sits inside a dnd-kit
 * transform with `overflow-hidden` columns, so anything rendered in place gets
 * clipped. Body is the shared DealTasks panel — same `deal_tasks` rows as
 * /tasks and the processing desk, plus this contact's mirrored GHL tasks — so
 * there is no second task system to keep in sync.
 */
function TaskPanel({ deal, startAdding, onClose, onChanged }: {
  deal: Deal
  startAdding: boolean
  onClose: () => void
  onChanged: () => void
}) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-4 my-8"
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 truncate">Tasks — {deal.name}</h3>
            <p className="text-[11px] text-slate-500">
              {deal.status}
              {deal.loan_officer ? ` · ${deal.loan_officer}` : ''}
              {deal.processor_status ? ` · ${deal.processor_status}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <DealTasks dealId={deal.id} startAdding={startAdding} onChanged={onChanged} />
        <div className="flex items-center justify-between pt-3 mt-3 border-t border-slate-100">
          <Link href={`/deals/${deal.id}`} className="text-xs font-medium text-blue-600 hover:text-blue-700">
            Open the full file
          </Link>
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded">
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
