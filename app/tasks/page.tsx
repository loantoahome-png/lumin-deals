'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { DealTask, Deal, TASK_ASSIGNEES } from '@/lib/types'
import {
  ClipboardList, Plus, X, Search, CheckCircle2, Circle,
  Calendar, User, Flame, ExternalLink, Trash2, Pencil,
} from 'lucide-react'

type FilterMode = 'open' | 'today' | 'overdue' | 'week' | 'completed' | 'all'

function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const d = new Date(`${date}T${time || '09:00'}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
function splitDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23,59,59,999); return x }

function relativeDue(iso: string | null): { label: string; tone: 'red' | 'amber' | 'slate' } {
  if (!iso) return { label: 'No due date', tone: 'slate' }
  const due = new Date(iso)
  const now = new Date()
  const ms = due.getTime() - now.getTime()
  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  if (ms < 0) {
    const days = Math.floor((now.getTime() - due.getTime()) / 86_400_000)
    return { label: days === 0 ? `Overdue · was ${time}` : `Overdue ${days}d`, tone: 'red' }
  }
  const today = startOfDay()
  const dueDay = startOfDay(due)
  const dayDelta = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000)
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

export default function TasksPage() {
  const [tasks, setTasks] = useState<DealTask[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterMode>('open')
  const [search, setSearch] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all')
  const [showForm, setShowForm] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [tasksRes, dealsRes] = await Promise.all([
      supabase.from('deal_tasks').select('*'),
      supabase.from('deals').select('id, name, loan_officer'),
    ])
    setTasks((tasksRes.data as DealTask[]) || [])
    setDeals((dealsRes.data as Deal[]) || [])
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const dealNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of deals) m.set(d.id, d.name)
    return m
  }, [deals])

  // Apply filters
  const filtered = useMemo(() => {
    const now = new Date()
    const today0 = startOfDay()
    const todayEnd = endOfDay()
    const week = new Date(today0.getTime() + 7 * 86_400_000)
    const q = search.trim().toLowerCase()

    return tasks.filter(t => {
      // Filter mode
      const due = t.due_at ? new Date(t.due_at) : null
      switch (filter) {
        case 'open':      if (t.completed_at) return false; break
        case 'completed': if (!t.completed_at) return false; break
        case 'overdue':   if (t.completed_at || !due || due >= now) return false; break
        case 'today':     if (t.completed_at || !due || due < today0 || due > todayEnd) return false; break
        case 'week':      if (t.completed_at || !due || due < now || due > week) return false; break
        case 'all':       break
      }
      // Assignee filter
      if (assigneeFilter !== 'all' && t.assignee !== assigneeFilter) return false
      // Search
      if (q) {
        const dealName = t.deal_id ? (dealNames.get(t.deal_id) || '').toLowerCase() : ''
        const hay = `${t.title} ${t.description ?? ''} ${t.assignee ?? ''} ${dealName}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      // Open tasks first, by due asc; completed tasks last, by completed_at desc
      if (!a.completed_at && b.completed_at) return -1
      if (a.completed_at && !b.completed_at) return 1
      if (!a.completed_at && !b.completed_at) {
        const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
        const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
        return da - db
      }
      return new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime()
    })
  }, [tasks, filter, search, assigneeFilter, dealNames])

  // Counts for filter pills
  const counts = useMemo(() => {
    const now = new Date()
    const today0 = startOfDay()
    const todayEnd = endOfDay()
    const week = new Date(today0.getTime() + 7 * 86_400_000)
    let open = 0, overdue = 0, today = 0, weekly = 0, completed = 0
    for (const t of tasks) {
      if (t.completed_at) { completed++; continue }
      open++
      const due = t.due_at ? new Date(t.due_at) : null
      if (due) {
        if (due < now) overdue++
        else if (due <= todayEnd) today++
        if (due >= now && due <= week) weekly++
      }
    }
    return { open, overdue, today, week: weekly, completed, all: tasks.length }
  }, [tasks])

  async function toggleComplete(task: DealTask) {
    const newCompleted = task.completed_at ? null : new Date().toISOString()
    await supabase.from('deal_tasks').update({ completed_at: newCompleted }).eq('id', task.id)
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed_at: newCompleted } : t))
  }

  async function deleteTask(id: string) {
    if (!confirm('Delete this task?')) return
    await supabase.from('deal_tasks').delete().eq('id', id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  async function createTask(payload: Omit<DealTask, 'id' | 'created_at'>) {
    const { data, error } = await supabase.from('deal_tasks').insert(payload).select().single()
    if (error) { alert('Save failed: ' + error.message); return }
    if (data) setTasks(prev => [data as DealTask, ...prev])
    setShowForm(false)
  }

  async function clearCompleted() {
    const doneIds = tasks.filter(t => t.completed_at).map(t => t.id)
    if (doneIds.length === 0) return
    if (!confirm(`Delete ${doneIds.length} completed task${doneIds.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    const { error } = await supabase.from('deal_tasks').delete().in('id', doneIds)
    if (error) { alert('Clear failed: ' + error.message); return }
    setTasks(prev => prev.filter(t => !t.completed_at))
  }

  const [editingId, setEditingId] = useState<string | null>(null)
  async function updateTask(id: string, patch: Omit<DealTask, 'id' | 'created_at'>) {
    const { error } = await supabase.from('deal_tasks').update(patch).eq('id', id)
    if (error) { alert('Update failed: ' + error.message); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    setEditingId(null)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-blue-600" /> Tasks
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            All tasks across your pipeline. Create one here or directly on any deal page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {counts.completed > 0 && (
            <button
              onClick={clearCompleted}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-red-50 hover:text-red-700 hover:border-red-200 transition"
              title="Delete all completed tasks"
            >
              <Trash2 className="w-3.5 h-3.5" /> Clear completed ({counts.completed})
            </button>
          )}
          <button
            onClick={() => setShowForm(v => !v)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> New Task
          </button>
        </div>
      </div>

      {/* Filter chips + search */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex bg-slate-100 rounded-lg p-1 gap-0.5">
          <FilterChip active={filter==='open'}      onClick={() => setFilter('open')}      label="Open"      count={counts.open} />
          <FilterChip active={filter==='overdue'}   onClick={() => setFilter('overdue')}   label="Overdue"   count={counts.overdue} tone="red" />
          <FilterChip active={filter==='today'}     onClick={() => setFilter('today')}     label="Today"     count={counts.today} tone="amber" />
          <FilterChip active={filter==='week'}      onClick={() => setFilter('week')}      label="This week" count={counts.week} />
          <FilterChip active={filter==='completed'} onClick={() => setFilter('completed')} label="Completed" count={counts.completed} />
          <FilterChip active={filter==='all'}       onClick={() => setFilter('all')}       label="All"       count={counts.all} />
        </div>
        <select
          value={assigneeFilter}
          onChange={e => setAssigneeFilter(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All assignees</option>
          {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          <option value="">— Unassigned —</option>
        </select>
      </div>

      {showForm && (
        <NewTaskForm
          deals={deals}
          onSubmit={createTask}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* List */}
      {loading ? (
        <p className="text-sm text-slate-400">Loading tasks…</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">
            {tasks.length === 0 ? 'No tasks yet' : 'Nothing matches this filter'}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {tasks.length === 0
              ? 'Click "New Task" or open a deal and add one there.'
              : 'Try a different filter or clear your search.'}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(t => editingId === t.id ? (
            <NewTaskForm
              key={t.id}
              deals={deals}
              initialTask={t}
              onSubmit={patch => updateTask(t.id, patch)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <TaskRow
              key={t.id}
              task={t}
              dealName={t.deal_id ? dealNames.get(t.deal_id) : undefined}
              onToggle={() => toggleComplete(t)}
              onDelete={() => deleteTask(t.id)}
              onEdit={() => setEditingId(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({ active, onClick, label, count, tone }: {
  active: boolean; onClick: () => void; label: string; count: number; tone?: 'red' | 'amber'
}) {
  const activeColor = tone === 'red'
    ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
    : tone === 'amber'
    ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
    : 'bg-white text-slate-900 shadow-sm'
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-md transition ${active ? activeColor : 'text-slate-500 hover:text-slate-800'}`}
    >
      {label}
      {count > 0 && <span className={`ml-1.5 text-[10px] tabular-nums ${active ? '' : 'text-slate-400'}`}>{count}</span>}
    </button>
  )
}

function TaskRow({ task, dealName, onToggle, onDelete, onEdit }: {
  task: DealTask; dealName?: string; onToggle: () => void; onDelete: () => void; onEdit?: () => void
}) {
  const due = relativeDue(task.due_at)
  const done = !!task.completed_at
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border transition group ${done ? 'bg-slate-50 border-slate-100 opacity-70' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}>
      <button onClick={onToggle} className="shrink-0 mt-0.5" title={done ? 'Mark incomplete' : 'Mark complete'}>
        {done ? <CheckCircle2 className="w-5 h-5 text-emerald-500" /> : <Circle className="w-5 h-5 text-slate-300 hover:text-slate-500 transition" />}
      </button>
      <div className="flex-1 min-w-0">
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
          {task.assignee && (
            <span className="flex items-center gap-1 text-slate-500">
              <User className="w-3 h-3" /> {task.assignee}
            </span>
          )}
          {task.priority === 'high' && (
            <span className="flex items-center gap-1 text-red-700 font-medium">
              <Flame className="w-3 h-3" /> High
            </span>
          )}
          {task.deal_id && (
            <Link href={`/deals/${task.deal_id}`} className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium">
              <ExternalLink className="w-3 h-3" /> {dealName || 'Deal'}
            </Link>
          )}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
        {onEdit && (
          <button onClick={onEdit} className="p-1 text-slate-300 hover:text-blue-600" title="Edit task">
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={onDelete} className="p-1 text-slate-300 hover:text-red-500" title="Delete">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

// ── Task form for the global Tasks page (create + edit, includes deal picker) ─
function NewTaskForm({ deals, initialTask, onSubmit, onCancel }: {
  deals: Deal[]
  initialTask?: DealTask
  onSubmit: (t: Omit<DealTask, 'id' | 'created_at'>) => void
  onCancel: () => void
}) {
  const isEdit = !!initialTask
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const tomorrow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate() + 1)}`
  const initialDT = initialTask?.due_at ? splitDateTime(initialTask.due_at) : { date: tomorrow, time: '09:00' }

  const [title, setTitle] = useState(initialTask?.title || '')
  const [description, setDescription] = useState(initialTask?.description || '')
  const [date, setDate] = useState(initialDT.date)
  const [time, setTime] = useState(initialDT.time || '09:00')
  const [assignee, setAssignee] = useState(initialTask?.assignee || '')
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
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due time</label>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assignee</label>
          <select value={assignee} onChange={e => setAssignee(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">— Unassigned —</option>
            {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
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
