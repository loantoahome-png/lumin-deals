'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { notifyTask } from '@/lib/notifyTask'
import { TIME_OPTIONS } from '@/lib/utils'
import { DealTask, TASK_ASSIGNEES } from '@/lib/types'
import {
  CheckCircle2, Circle, Trash2, Plus, X, Calendar, User,
  ExternalLink, Flame,
} from 'lucide-react'

// ── Date helpers (same shape as EscrowTracker's, kept local for portability) ─
// A blank time is stored as 23:59 ("end of day") — the 15-min picker can never
// produce it, so it doubles as an "all day / no specific time" marker.
const ALL_DAY_TIME = '23:59'
function isAllDay(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  return !isNaN(d.getTime()) && d.getHours() === 23 && d.getMinutes() === 59
}
function splitDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: hhmm === ALL_DAY_TIME ? '' : hhmm,
  }
}
function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const d = new Date(`${date}T${time || ALL_DAY_TIME}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
function relativeDue(iso: string | null): { label: string; tone: 'red' | 'amber' | 'slate' } {
  if (!iso) return { label: 'No due date', tone: 'slate' }
  const due = new Date(iso)
  const now = new Date()
  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const today = new Date(); today.setHours(0,0,0,0)
  const dueDay = new Date(due); dueDay.setHours(0,0,0,0)
  const dayDelta = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000)

  // All-day tasks: no time shown, not "overdue" until the day fully passes.
  if (isAllDay(iso)) {
    if (dayDelta < 0)  return { label: dayDelta === -1 ? 'Overdue · yesterday' : `Overdue ${-dayDelta}d`, tone: 'red' }
    if (dayDelta === 0) return { label: 'Today', tone: 'amber' }
    if (dayDelta === 1) return { label: 'Tomorrow', tone: 'slate' }
    return { label: due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'slate' }
  }

  const ms = due.getTime() - now.getTime()
  const days = Math.floor(ms / 86_400_000)
  if (ms < 0) {
    const ago = Math.abs(days)
    return { label: ago === 0 ? `Overdue · was ${time}` : `Overdue ${ago}d`, tone: 'red' }
  }
  if (dayDelta === 0) return { label: `Today · ${time}`, tone: 'amber' }
  if (dayDelta === 1) return { label: `Tomorrow · ${time}`, tone: 'slate' }
  return {
    label: `${due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`,
    tone: 'slate',
  }
}

const PRIORITY_STYLES: Record<string, string> = {
  high:   'bg-red-100 text-red-700 border-red-200',
  normal: 'bg-slate-100 text-slate-700 border-slate-200',
  low:    'bg-blue-50 text-blue-600 border-blue-200',
}

type Props = {
  /** When set, the panel shows only that deal's tasks and auto-links new ones. */
  dealId?: string
  /** Optional title override (default depends on dealId presence). */
  title?: string
  /** Optionally show the deal name on each task row (useful in the global Tasks page). */
  showDealLink?: boolean
  /** Map of deal id → name for showDealLink mode. */
  dealNames?: Map<string, string>
}

export default function DealTasks({ dealId, title, showDealLink, dealNames }: Props) {
  const [tasks, setTasks] = useState<DealTask[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('deal_tasks').select('*').order('completed_at', { ascending: true, nullsFirst: true }).order('due_at', { ascending: true, nullsFirst: false })
    if (dealId) q = q.eq('deal_id', dealId)
    const { data } = await q
    setTasks((data as DealTask[]) || [])
    setLoading(false)
  }, [dealId])
  useEffect(() => { fetchTasks() }, [fetchTasks])

  async function toggleComplete(task: DealTask) {
    const newCompleted = task.completed_at ? null : new Date().toISOString()
    await supabase.from('deal_tasks').update({ completed_at: newCompleted }).eq('id', task.id)
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed_at: newCompleted } : t))
    // Email both assignee + assigner only when marking DONE (not when un-completing)
    if (newCompleted) notifyTask('completed', task)
  }

  async function deleteTask(id: string) {
    if (!confirm('Delete this task?')) return
    await supabase.from('deal_tasks').delete().eq('id', id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  async function createTask(payload: Omit<DealTask, 'id' | 'created_at'>) {
    const { data, error } = await supabase.from('deal_tasks').insert(payload).select().single()
    if (error) { alert('Save failed: ' + error.message); return }
    if (data) {
      setTasks(prev => [data as DealTask, ...prev])
      notifyTask('assigned', data as DealTask)   // email the assignee
    }
    setShowForm(false)
  }

  const [editingId, setEditingId] = useState<string | null>(null)
  async function updateTask(id: string, patch: Omit<DealTask, 'id' | 'created_at'>) {
    const prevAssignee = tasks.find(t => t.id === id)?.assignee ?? null
    const { error } = await supabase.from('deal_tasks').update(patch).eq('id', id)
    if (error) { alert('Update failed: ' + error.message); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    setEditingId(null)
    // If reassigned to a new person, notify them
    if (patch.assignee && patch.assignee !== prevAssignee) {
      notifyTask('assigned', { ...patch, id })
    }
  }

  // Sort: incomplete first (by due asc), then completed (most recent first)
  const sorted = [...tasks].sort((a, b) => {
    if (!a.completed_at && b.completed_at) return -1
    if (a.completed_at && !b.completed_at) return 1
    if (!a.completed_at && !b.completed_at) {
      const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
      const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
      return da - db
    }
    return new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime()
  })

  const open = sorted.filter(t => !t.completed_at).length
  const done = sorted.filter(t => t.completed_at).length

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-slate-500">
          {loading ? 'Loading…' : (
            <>
              <span className="font-semibold text-slate-700">{open}</span> open
              {done > 0 && <span> · {done} completed</span>}
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add task
        </button>
      </div>

      {showForm && (
        <TaskForm
          onSubmit={t => createTask({ ...t, deal_id: dealId ?? t.deal_id ?? null })}
          onCancel={() => setShowForm(false)}
          forcedDealId={dealId}
        />
      )}

      {sorted.length === 0 && !loading ? (
        <p className="text-sm text-slate-400 italic">No tasks yet — click <strong>Add task</strong> above to create one.</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map(task => editingId === task.id ? (
            <TaskForm
              key={task.id}
              initialTask={task}
              onSubmit={t => updateTask(task.id, { ...t, deal_id: dealId ?? t.deal_id ?? null })}
              onCancel={() => setEditingId(null)}
              forcedDealId={dealId}
            />
          ) : (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => toggleComplete(task)}
              onDelete={() => deleteTask(task.id)}
              onEdit={() => setEditingId(task.id)}
              dealName={showDealLink && task.deal_id ? dealNames?.get(task.deal_id) : undefined}
              showDealLink={!!showDealLink && !!task.deal_id}
            />
          ))}
        </div>
      )}
      {title}
    </div>
  )
}

// ── Task row (used in both deal page + tasks tab) ───────────────────────────
function TaskRow({ task, onToggle, onDelete, onEdit, dealName, showDealLink }: {
  task: DealTask
  onToggle: () => void
  onDelete: () => void
  onEdit?: () => void
  dealName?: string
  showDealLink?: boolean
}) {
  const due = relativeDue(task.due_at)
  const done = !!task.completed_at
  // GHL-mirrored tasks are read-only here — managed in GoHighLevel.
  const isGhl = task.source === 'ghl'

  return (
    <div className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border transition group ${done ? 'bg-slate-50 border-slate-100 opacity-70' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}>
      <button
        type="button"
        onClick={isGhl ? undefined : onToggle}
        disabled={isGhl}
        className="shrink-0 mt-0.5 disabled:cursor-default"
        title={isGhl ? 'Completion is managed in GoHighLevel' : done ? 'Mark incomplete' : 'Mark complete'}
      >
        {done ? <CheckCircle2 className="w-5 h-5 text-emerald-500" /> : <Circle className="w-5 h-5 text-slate-300 hover:text-slate-500 transition" />}
      </button>

      {/* The whole info area is click-to-edit (disabled for GHL-mirrored tasks) */}
      <button
        type="button"
        onClick={isGhl ? undefined : onEdit}
        disabled={!onEdit || isGhl}
        className="flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default"
        title={isGhl ? 'Synced from GoHighLevel — edit it there' : onEdit ? 'Click to edit' : undefined}
      >
        <div className={`text-sm flex items-center gap-1.5 ${done ? 'line-through text-slate-400' : 'text-slate-900'}`}>
          <span>{task.title}</span>
          {isGhl && (
            <span className="shrink-0 text-[9px] font-bold text-blue-700 bg-blue-100 border border-blue-200 rounded px-1 py-0.5 no-underline">GHL</span>
          )}
        </div>
        {task.description && (
          <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-wrap">{task.description}</div>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px]">
          {task.due_at && (
            <span className={`flex items-center gap-0.5 ${
              due.tone === 'red' ? 'text-red-700 font-semibold' :
              due.tone === 'amber' ? 'text-amber-700 font-semibold' :
              'text-slate-500'
            }`}>
              <Calendar className="w-3 h-3" /> {due.label}
            </span>
          )}
          {task.assignee && (
            <span className="flex items-center gap-0.5 text-slate-500">
              <User className="w-3 h-3" /> {task.assignee}
            </span>
          )}
          {task.assigned_by && (
            <span className="text-slate-400">
              by <span className="font-medium text-slate-500">{task.assigned_by}</span>
            </span>
          )}
          {task.priority === 'high' && (
            <span className="flex items-center gap-0.5 text-red-700 font-medium">
              <Flame className="w-3 h-3" /> High
            </span>
          )}
        </div>
      </button>

      {/* Deal link kept outside the edit button so clicking it navigates */}
      {showDealLink && task.deal_id && (
        <Link
          href={`/deals/${task.deal_id}`}
          onClick={e => e.stopPropagation()}
          className="shrink-0 self-center flex items-center gap-0.5 text-[11px] text-blue-600 hover:text-blue-700 font-medium"
        >
          <ExternalLink className="w-3 h-3" /> {dealName || 'Deal'}
        </Link>
      )}

      {!isGhl && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 self-start p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
          title="Delete task"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

// ── Task form (create or edit) ──────────────────────────────────────────────
function TaskForm({ initialTask, onSubmit, onCancel, forcedDealId }: {
  initialTask?: DealTask
  onSubmit: (t: Omit<DealTask, 'id' | 'created_at'>) => void
  onCancel: () => void
  forcedDealId?: string
}) {
  const isEdit = !!initialTask
  // No default due date/time on create — leave blank so a task has no deadline
  // unless the user explicitly sets one. Edit mode pulls from initialTask.due_at.
  const initialDT = initialTask?.due_at ? splitDateTime(initialTask.due_at) : { date: '', time: '' }

  const [title, setTitle] = useState(initialTask?.title || '')
  const [description, setDescription] = useState(initialTask?.description || '')
  const [date, setDate] = useState(initialDT.date)
  const [time, setTime] = useState(initialDT.time)
  const [assignee, setAssignee] = useState<string>(initialTask?.assignee || '')
  const [assignedBy, setAssignedBy] = useState<string>(initialTask?.assigned_by || '')
  const [priority, setPriority] = useState<string>(initialTask?.priority || 'normal')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    onSubmit({
      deal_id: forcedDealId ?? initialTask?.deal_id ?? null,
      title: title.trim(),
      description: description.trim() || null,
      due_at: combineDateTime(date, time),
      assignee: assignee || null,
      assigned_by: assignedBy || null,
      priority,
      completed_at: initialTask?.completed_at ?? null, // preserve completed state when editing
    })
  }

  return (
    <form onSubmit={handleSubmit} className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{isEdit ? 'Edit Task' : 'New Task'}</h4>
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
        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Details (optional)"
        rows={2}
        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />
      <div className="grid grid-cols-2 gap-2">
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
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due time</label>
          <select
            value={time}
            onChange={e => setTime(e.target.value)}
            className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm bg-white"
          >
            <option value="">— Pick a time —</option>
            {time && !TIME_OPTIONS.some(o => o.value === time) && <option value={time}>{time}</option>}
            {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned to</label>
          <select
            value={assignee}
            onChange={e => setAssignee(e.target.value)}
            className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm bg-white"
          >
            <option value="">— Unassigned —</option>
            {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned by</label>
          <select
            value={assignedBy}
            onChange={e => setAssignedBy(e.target.value)}
            className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm bg-white"
          >
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
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded">
          Cancel
        </button>
        <button type="submit" disabled={!title.trim()} className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-40">
          {isEdit ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </form>
  )
}
