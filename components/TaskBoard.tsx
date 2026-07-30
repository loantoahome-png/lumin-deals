'use client'

// Shared task-board pieces — the ONE definition of how a dashboard task looks.
//
// Extracted from app/tasks/page.tsx on 2026-07-30 so the Follow-Up cockpit can
// render the identical card instead of a look-alike copy (Efrain: "mimic the
// same design as the main tasks page"). Both /tasks and /follow-up/[lo] import
// from here, so a styling change lands on both and they cannot drift.

import { useMemo } from 'react'
import Link from 'next/link'
import { Calendar, CheckCircle2, Circle, ExternalLink, Flame, Plus, Trash2, User } from 'lucide-react'
import type { DealTask } from '@/lib/types'

// ── Time helpers (all-day tasks are stored at 23:59 local) ───────────────────

export const ALL_DAY_TIME = '23:59'

export function startOfDay(d: Date = new Date()): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x
}
export function endOfDay(d: Date = new Date()): Date {
  const x = new Date(d); x.setHours(23, 59, 59, 999); return x
}
export function isAllDay(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  return !isNaN(d.getTime()) && d.getHours() === 23 && d.getMinutes() === 59
}

export function relativeDue(iso: string | null): { label: string; tone: 'red' | 'amber' | 'slate' } {
  if (!iso) return { label: 'No due date', tone: 'slate' }
  const due = new Date(iso)
  const now = new Date()
  const allDay = isAllDay(iso)
  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const today = startOfDay()
  const dueDay = startOfDay(due)
  const dayDelta = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000)

  // All-day tasks: no time shown, and not "overdue" until the day fully passes.
  if (allDay) {
    if (dayDelta < 0)   return { label: dayDelta === -1 ? 'Overdue · yesterday' : `Overdue ${-dayDelta}d`, tone: 'red' }
    if (dayDelta === 0) return { label: 'Today', tone: 'amber' }
    if (dayDelta === 1) return { label: 'Tomorrow', tone: 'slate' }
    return { label: due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'slate' }
  }

  const ms = due.getTime() - now.getTime()
  if (ms < 0) {
    const days = Math.floor((now.getTime() - due.getTime()) / 86_400_000)
    if (days >= 1) return { label: `Overdue ${days}d`, tone: 'red' }
    const hrs = Math.floor((now.getTime() - due.getTime()) / 3_600_000)
    return { label: hrs >= 1 ? `Overdue ${hrs}h` : 'Overdue', tone: 'red' }
  }
  if (dayDelta === 0) return { label: `Today ${time}`, tone: 'amber' }
  if (dayDelta === 1) return { label: `Tomorrow ${time}`, tone: 'slate' }
  return { label: `${due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`, tone: 'slate' }
}

export function isDueNow(t: DealTask, todayEnd: number): boolean {
  if (!t.due_at) return false
  const due = new Date(t.due_at).getTime()
  return !isNaN(due) && due <= todayEnd
}

// ── Column chrome ────────────────────────────────────────────────────────────

export const OTHER_COLUMN = 'Unassigned & other'

export type ColumnView = 'now' | 'future' | 'all'
export const COLUMN_VIEWS: { key: ColumnView; label: string }[] = [
  { key: 'now',    label: 'Overdue & today' },
  { key: 'future', label: 'Future' },
  { key: 'all',    label: 'All' },
]

export const COLUMN_STYLES: Record<string, string> = {
  'Efrain Ramirez':    'text-blue-800 bg-blue-50 border-blue-100',
  'Brianne Han':       'text-violet-800 bg-violet-50 border-violet-100',
  'Moe Sefati':        'text-emerald-800 bg-emerald-50 border-emerald-100',
  'Matt Park':         'text-amber-800 bg-amber-50 border-amber-100',
  [OTHER_COLUMN]:      'text-slate-600 bg-slate-50 border-slate-200',
}

// ── The task card ────────────────────────────────────────────────────────────

export function TaskRow({ task, dealName, ghlUrl, hideAssignee, onToggle, onDelete, onEdit }: {
  task: DealTask; dealName?: string; ghlUrl?: string; hideAssignee?: boolean
  onToggle: () => void; onDelete?: () => void; onEdit?: () => void
}) {
  const due = relativeDue(task.due_at)
  const done = !!task.completed_at
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border transition group ${done ? 'bg-slate-50 border-slate-100 opacity-70' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}>
      <button onClick={onToggle} className="shrink-0 mt-0.5" title={done ? 'Mark incomplete' : 'Mark complete'}>
        {done ? <CheckCircle2 className="w-5 h-5 text-emerald-500" /> : <Circle className="w-5 h-5 text-slate-300 hover:text-slate-500 transition" />}
      </button>
      {/* Whole info area is click-to-edit */}
      <button
        type="button"
        onClick={onEdit}
        disabled={!onEdit}
        className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default"
        title={onEdit ? 'Click to edit' : undefined}
      >
        <div className={`text-sm ${done ? 'line-through text-slate-400' : 'text-slate-900 font-medium'}`}>
          {task.title}
        </div>
        {task.description && (
          <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-wrap">{task.description}</div>
        )}
        <div className="flex items-center gap-3 mt-1.5 flex-wrap text-[11px]">
          {task.due_at && (
            <span className={`flex items-center gap-1 ${
              due.tone === 'red' ? 'text-red-700 font-semibold' :
              due.tone === 'amber' ? 'text-amber-700 font-semibold' :
              'text-slate-500'
            }`}>
              <Calendar className="w-3 h-3" /> {due.label}
            </span>
          )}
          {task.assignee && !hideAssignee && (
            <span className="flex items-center gap-1 text-slate-500">
              <User className="w-3 h-3" /> {task.assignee}
            </span>
          )}
          {task.assigned_by && (
            <span className="text-slate-400">
              by <span className="font-medium text-slate-500">{task.assigned_by}</span>
            </span>
          )}
          {task.priority === 'high' && (
            <span className="flex items-center gap-1 text-red-700 font-medium">
              <Flame className="w-3 h-3" /> High
            </span>
          )}
        </div>
      </button>

      {/* Deal link + direct GHL button, kept outside the edit button so they navigate */}
      <div className="shrink-0 self-center flex items-center gap-2">
        {ghlUrl && (
          <a
            href={ghlUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            title="Open contact in GoHighLevel"
            className="flex items-center gap-0.5 text-[10px] font-bold text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded bg-blue-100 hover:bg-blue-200 border border-blue-200 transition-colors"
          >
            GHL <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
        {task.deal_id && (
          <Link
            href={`/deals/${task.deal_id}`}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 font-medium"
          >
            <ExternalLink className="w-3 h-3" /> {dealName || 'Deal'}
          </Link>
        )}
      </div>

      {onDelete && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
          <button onClick={onDelete} className="p-1 text-slate-300 hover:text-red-500" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

// ── The per-person column ────────────────────────────────────────────────────

export function AssigneeColumn({ name, tasks, view, onViewChange, renderTask, onAdd, composing, maxHeightClass }: {
  name: string
  tasks: DealTask[]
  view: ColumnView
  onViewChange: (v: ColumnView) => void
  renderTask: (t: DealTask) => React.ReactNode
  onAdd?: () => void
  composing?: React.ReactNode
  /** Defaults to the board's 30rem cap; the cockpit gives it more room. */
  maxHeightClass?: string
}) {
  // Stable within the day, so it's a safe memo dep — the board doesn't need to
  // re-slice on every render just because the clock ticked.
  const todayEnd = endOfDay().getTime()
  const { now, future } = useMemo(() => ({
    now:    tasks.filter(t => isDueNow(t, todayEnd)),
    future: tasks.filter(t => !isDueNow(t, todayEnd)),
  }), [tasks, todayEnd])
  const counts: Record<ColumnView, number> = { now: now.length, future: future.length, all: tasks.length }
  const visible = view === 'now' ? now : view === 'future' ? future : tasks

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className={`flex items-center justify-between gap-2 px-4 py-2.5 border-b ${COLUMN_STYLES[name] ?? COLUMN_STYLES[OTHER_COLUMN]}`}>
        <h3 className="text-sm font-bold flex items-center gap-1.5 min-w-0">
          <User className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="truncate">{name}</span>
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Opens the create form right in this column, pre-assigned to this
              person — the whole point is skipping the "Assigned to" dropdown. */}
          {onAdd && (
            <button
              onClick={onAdd}
              title={name === OTHER_COLUMN ? 'New unassigned task' : `New task for ${name.split(' ')[0]}`}
              className="flex items-center gap-0.5 pl-1.5 pr-2 py-1 rounded-md text-xs font-semibold bg-white/70 hover:bg-white border border-black/5 transition"
            >
              <Plus className="w-3.5 h-3.5" /> Add Task
            </button>
          )}
          <span className="text-[11px] font-bold tabular-nums rounded-full px-2 py-0.5 bg-white/70">
            {visible.length}
          </span>
        </div>
      </div>

      {/* This person's own time cut — independent of every other column. */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-100 bg-slate-50/70">
        {COLUMN_VIEWS.map(v => {
          const active = view === v.key
          const urgent = v.key === 'now' && counts.now > 0
          return (
            <button
              key={v.key}
              onClick={() => onViewChange(v.key)}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition ${
                active
                  ? urgent
                    ? 'bg-white text-red-700 shadow-sm ring-1 ring-red-200'
                    : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-500 hover:text-slate-800 hover:bg-white/70'
              }`}
            >
              {v.label}
              <span className={`text-[10px] tabular-nums ${
                active ? 'opacity-70' : urgent ? 'text-red-500' : 'text-slate-400'
              }`}>
                {counts[v.key]}
              </span>
            </button>
          )
        })}
      </div>

      {composing && <div className="p-2 pb-0">{composing}</div>}
      {visible.length === 0 ? (
        !composing && (
          <p className="text-xs text-slate-400 text-center py-8">
            {tasks.length === 0
              ? 'No tasks'
              : view === 'now' ? 'Nothing due through today' : 'Nothing scheduled later'}
          </p>
        )
      ) : (
        // Capped so one long column can't push the rest of the layout off-screen —
        // each column scrolls in place.
        <div className={`p-2 space-y-1.5 overflow-y-auto ${maxHeightClass ?? 'max-h-[30rem]'}`}>{visible.map(renderTask)}</div>
      )}
    </section>
  )
}
