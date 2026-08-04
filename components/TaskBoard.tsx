'use client'

// Shared task-board pieces — the ONE definition of how a dashboard task looks.
//
// Extracted from app/tasks/page.tsx on 2026-07-30 so the Follow-Up cockpit can
// render the identical card instead of a look-alike copy (Efrain: "mimic the
// same design as the main tasks page"). Both /tasks and /follow-up/[lo] import
// from here, so a styling change lands on both and they cannot drift.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Calendar, CheckCircle2, Circle, ExternalLink, Flame, Plus, Trash2, User, X } from 'lucide-react'
import { TIME_OPTIONS } from '@/lib/utils'
import { TASK_ASSIGNEES, type Deal, type DealTask } from '@/lib/types'

// ── Time helpers (all-day tasks are stored at 23:59 local) ───────────────────


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

/**
 * When a task was finished. A completed row shows this INSTEAD of its due date:
 * "Overdue 34d" on something already done is both wrong and alarming, and the
 * completion time is the only thing a "recently completed" view is actually for.
 *
 * For a mirrored GHL row the stamp is GHL's `dateUpdated` (last modified) —
 * see [[GhlCompletedTaskRow]] in lib/ghlTasks.ts.
 */
export function relativeCompleted(iso: string | null): string {
  if (!iso) return 'Completed'
  const at = new Date(iso)
  const now = new Date()
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const dayDelta = Math.round((startOfDay(at).getTime() - startOfDay().getTime()) / 86_400_000)
  if (dayDelta === 0) {
    const mins = Math.floor((now.getTime() - at.getTime()) / 60_000)
    if (mins < 1) return 'Completed just now'
    if (mins < 60) return `Completed ${mins}m ago`
    return `Completed today · ${time}`
  }
  if (dayDelta === -1) return `Completed yesterday · ${time}`
  if (dayDelta > -7) return `Completed ${-dayDelta}d ago`
  return `Completed ${at.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })}`
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
  // Show the year once it isn't this one. Mirrored GHL follow-ups are routinely
  // years out ("Ch 7 bk seasoning ends july 2027"), and a bare "Sun, Jul 25"
  // reads as this July.
  const dateStr = due.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(due.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })

  // All-day tasks: no time shown, and not "overdue" until the day fully passes.
  if (allDay) {
    if (dayDelta < 0)   return { label: dayDelta === -1 ? 'Overdue · yesterday' : `Overdue ${-dayDelta}d`, tone: 'red' }
    if (dayDelta === 0) return { label: 'Today', tone: 'amber' }
    if (dayDelta === 1) return { label: 'Tomorrow', tone: 'slate' }
    return { label: dateStr, tone: 'slate' }
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
  return { label: `${dateStr} ${time}`, tone: 'slate' }
}

// Undated tasks count as "now": with no date they'd otherwise sit in Future
// forever and never get worked. They sort last inside the column (due = Infinity).
export function isDueNow(t: DealTask, todayEnd: number): boolean {
  if (!t.due_at) return true
  const due = new Date(t.due_at).getTime()
  return isNaN(due) || due <= todayEnd
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

export function TaskRow({ task, dealName, ghlUrl, hideAssignee, badge, contactName, onToggle, toggleDisabled, toggleTitle, onDelete, onEdit }: {
  task: DealTask; dealName?: string; ghlUrl?: string; hideAssignee?: boolean
  /** Marks a row that lives in another system (e.g. 'GHL') — see lib/ghlTasks.ts. */
  badge?: string
  /** Shown when the row has no deal to link to, so it still names a person. */
  contactName?: string | null
  onToggle: () => void
  /** Row can't be un-done from here (a completed GHL task isn't in our mirror,
   *  and GHL has no verified reopen endpoint). `toggleTitle` says why on hover. */
  toggleDisabled?: boolean
  toggleTitle?: string
  onDelete?: () => void; onEdit?: () => void
}) {
  const due = relativeDue(task.due_at)
  const done = !!task.completed_at
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border transition group ${done ? 'bg-slate-50 border-slate-100 opacity-70' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}>
      <button
        onClick={onToggle}
        disabled={toggleDisabled}
        className="shrink-0 mt-0.5 disabled:cursor-default"
        title={toggleTitle ?? (done ? 'Mark incomplete' : 'Mark complete')}
      >
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
          {badge && (
            <span className="ml-1.5 align-middle text-[9px] font-bold tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1 py-px">
              {badge}
            </span>
          )}
        </div>
        {task.description && (
          <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-wrap">{task.description}</div>
        )}
        <div className="flex items-center gap-3 mt-1.5 flex-wrap text-[11px]">
          {/* A done task shows WHEN it was done, never its due date — an
              "Overdue 34d" chip on something already completed is wrong and
              reads as an alarm. */}
          {done ? (
            <span className="flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="w-3 h-3" /> {relativeCompleted(task.completed_at)}
            </span>
          ) : task.due_at && (
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
          {contactName && !task.deal_id && (
            <span className="flex items-center gap-1 text-slate-500">
              <User className="w-3 h-3" /> {contactName}
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
  const { now, future } = useMemo(() => {
    const due = tasks.filter(t => isDueNow(t, todayEnd))
    return {
      // Undated leads THIS bucket only (Efrain 2026-08-03) — the incoming order
      // is urgency-sorted and All keeps it, so the float-to-top happens here.
      now:    [...due.filter(t => !t.due_at), ...due.filter(t => t.due_at)],
      future: tasks.filter(t => !isDueNow(t, todayEnd)),
    }
  }, [tasks, todayEnd])
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

// ── Task form (create + edit) ────────────────────────────────────────────────
// Moved here from app/tasks/page.tsx 2026-07-30 so the Follow-Up cockpit opens
// the SAME form in a modal (Efrain: "make a pop up that is made when creating a
// new task"), and editing a task looks identical wherever you do it.

export const ALL_DAY_TIME = '23:59'
export function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const d = new Date(`${date}T${time || ALL_DAY_TIME}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
export function splitDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: hhmm === ALL_DAY_TIME ? '' : hhmm,   // all-day → leave the picker blank
  }
}

export const PRIORITY_STYLES: Record<string, string> = {
  high:   'bg-red-100 text-red-700 border-red-200',
  normal: 'bg-slate-100 text-slate-700 border-slate-200',
  low:    'bg-blue-50 text-blue-600 border-blue-200',
}

export function NewTaskForm({ deals, initialTask, initialAssignee, onSubmit, onCancel }: {
  deals: Deal[]
  initialTask?: DealTask
  initialAssignee?: string
  onSubmit: (t: Omit<DealTask, 'id' | 'created_at'>) => void
  onCancel: () => void
}) {
  const isEdit = !!initialTask
  // No default due date/time on create — blank unless the user sets one.
  const initialDT = initialTask?.due_at ? splitDateTime(initialTask.due_at) : { date: '', time: '' }

  const [title, setTitle] = useState(initialTask?.title || '')
  const [description, setDescription] = useState(initialTask?.description || '')
  const [date, setDate] = useState(initialDT.date)
  const [time, setTime] = useState(initialDT.time)
  const [assignee, setAssignee] = useState(initialTask?.assignee || initialAssignee || '')
  const [assignedBy, setAssignedBy] = useState(initialTask?.assigned_by || '')
  const [priority, setPriority] = useState(initialTask?.priority || 'normal')
  const [dealId, setDealId] = useState<string>(initialTask?.deal_id || '')
  const [dealSearch, setDealSearch] = useState('')

  const matchingDeals = useMemo(() => {
    if (!dealSearch.trim()) return deals.slice(0, 50)
    const q = dealSearch.toLowerCase().trim()
    return deals.filter(d => d.name?.toLowerCase().includes(q)).slice(0, 30)
  }, [deals, dealSearch])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    onSubmit({
      deal_id: dealId || null,
      title: title.trim(),
      description: description.trim() || null,
      due_at: combineDateTime(date, time),
      assignee: assignee || null,
      assigned_by: assignedBy || null,
      priority,
      completed_at: initialTask?.completed_at ?? null, // preserve complete state when editing
    })
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-5 mb-5 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{isEdit ? 'Edit Task' : 'New Task'}</h3>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-700">
          <X className="w-4 h-4" />
        </button>
      </div>
      <input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="What needs to happen?"
        required
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Details (optional)"
        rows={2}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center justify-between mb-0.5">
            <label className="block text-[10px] font-medium text-slate-500">Due date</label>
            {(date || time) && (
              <button type="button" onClick={() => { setDate(''); setTime('') }}
                className="text-[10px] font-medium text-slate-400 hover:text-red-600">
                Clear
              </button>
            )}
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due time</label>
          <select value={time} onChange={e => setTime(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">— Pick a time —</option>
            {time && !TIME_OPTIONS.some(o => o.value === time) && <option value={time}>{time}</option>}
            {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned to</label>
          <select value={assignee} onChange={e => setAssignee(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">— Unassigned —</option>
            {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned by</label>
          <select value={assignedBy} onChange={e => setAssignedBy(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">—</option>
            {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Priority</label>
          <div className="flex gap-1">
            {(['high','normal','low'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={`flex-1 text-xs font-medium px-1.5 py-1.5 rounded border transition capitalize ${
                  priority === p ? PRIORITY_STYLES[p] : 'border-slate-200 text-slate-400 hover:border-slate-300'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
            Linked deal {dealId ? '' : '(optional)'}
          </label>
          {dealId ? (
            <div className="flex items-center gap-2 px-3 py-1.5 border border-blue-200 bg-blue-50 rounded-md">
              <span className="text-sm text-slate-800 flex-1">{deals.find(d => d.id === dealId)?.name || 'Selected'}</span>
              <button type="button" onClick={() => setDealId('')} className="text-slate-400 hover:text-red-500">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={dealSearch}
                onChange={e => setDealSearch(e.target.value)}
                placeholder="Type to search deals…"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {dealSearch && matchingDeals.length > 0 && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {matchingDeals.map(d => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => { setDealId(d.id); setDealSearch('') }}
                      className="w-full text-left text-sm px-3 py-1.5 hover:bg-slate-50"
                    >
                      {d.name} {d.loan_officer && <span className="text-xs text-slate-400">· {d.loan_officer}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
        <button type="submit" disabled={!title.trim()} className="px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-40">
          {isEdit ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </form>
  )
}

// ── Combined "Bulletin/Tasks" page — one tab each ────────────────────────────
