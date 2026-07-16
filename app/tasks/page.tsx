'use client'

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { notifyTask } from '@/lib/notifyTask'
import { TIME_OPTIONS } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { DealTask, Deal, TASK_ASSIGNEES } from '@/lib/types'
import {
  ClipboardList, Plus, X, Search, CheckCircle2, Circle,
  Calendar, User, Flame, ExternalLink, Trash2, StickyNote,
} from 'lucide-react'
import NotesBoard from '@/components/NotesBoard'

type FilterMode = 'open' | 'today' | 'overdue' | 'week' | 'completed' | 'all'

// A blank time is stored as 23:59 ("end of day"), which the 15-min picker can
// never produce — so it doubles as an "all day / no specific time" marker.
const ALL_DAY_TIME = '23:59'
function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const d = new Date(`${date}T${time || ALL_DAY_TIME}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
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
    time: hhmm === ALL_DAY_TIME ? '' : hhmm,   // all-day → leave the picker blank
  }
}
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23,59,59,999); return x }

function relativeDue(iso: string | null): { label: string; tone: 'red' | 'amber' | 'slate' } {
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
    if (dayDelta < 0)  return { label: dayDelta === -1 ? 'Overdue · yesterday' : `Overdue ${-dayDelta}d`, tone: 'red' }
    if (dayDelta === 0) return { label: 'Today', tone: 'amber' }
    if (dayDelta === 1) return { label: 'Tomorrow', tone: 'slate' }
    return { label: due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'slate' }
  }

  const ms = due.getTime() - now.getTime()
  if (ms < 0) {
    const days = Math.floor((now.getTime() - due.getTime()) / 86_400_000)
    return { label: days === 0 ? `Overdue · was ${time}` : `Overdue ${days}d`, tone: 'red' }
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

// The board is one column per person, laid out 2×2: Efrain / Brianne on top,
// Moe / Matt below. Anyone NOT in this list (Randy, an unassigned task, a
// legacy name) falls into the "Unassigned & other" column so no task can be
// hidden just because it doesn't belong to one of the four.
const BOARD_COLUMNS = ['Efrain Ramirez', 'Brianne Han', 'Moe Sefati', 'Matt Park'] as const
const OTHER_COLUMN = 'Unassigned & other'
const COLUMN_STYLES: Record<string, string> = {
  'Efrain Ramirez':    'text-blue-800 bg-blue-50 border-blue-100',
  'Brianne Han':       'text-violet-800 bg-violet-50 border-violet-100',
  'Moe Sefati':        'text-emerald-800 bg-emerald-50 border-emerald-100',
  'Matt Park':         'text-amber-800 bg-amber-50 border-amber-100',
  [OTHER_COLUMN]:      'text-slate-600 bg-slate-50 border-slate-200',
}

function TasksSection() {
  const [tasks, setTasks] = useState<DealTask[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterMode>('open')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [tasksRes, dealsData] = await Promise.all([
      supabase.from('deal_tasks').select('*'),
      // Paginate past PostgREST's 1000-row cap — the table has >1000 deals, so a
      // bare select dropped the oldest, leaving their tasks unable to resolve a
      // deal name / LO.
      // ghl_opportunity_id is needed for ghlContactUrl's known-bad-id guard.
      fetchAllDeals(undefined, 'id, name, loan_officer, ghl_contact_id, ghl_opportunity_id, ghl_location_id'),
    ])
    setTasks((tasksRes.data as DealTask[]) || [])
    setDeals(dealsData)
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const dealNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of deals) m.set(d.id, d.name)
    return m
  }, [deals])

  // deal id → GHL contact URL (for the one-click "GHL" button on task rows)
  const dealGhlUrls = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of deals) {
      const url = ghlContactUrl(d)
      if (url) m.set(d.id, url)
    }
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
  }, [tasks, filter, search, dealNames])

  // Split the filtered list into the four per-person columns + the catch-all.
  // Search and the status chips above still apply across every column.
  const columns = useMemo(() => {
    const byPerson = new Map<string, DealTask[]>(BOARD_COLUMNS.map(n => [n, [] as DealTask[]]))
    const other: DealTask[] = []
    for (const t of filtered) {
      const col = t.assignee && byPerson.has(t.assignee) ? byPerson.get(t.assignee)! : other
      col.push(t)
    }
    return { byPerson, other }
  }, [filtered])

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
      notifyTask('assigned', data as DealTask)
    }
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
    const prevAssignee = tasks.find(t => t.id === id)?.assignee ?? null
    const { error } = await supabase.from('deal_tasks').update(patch).eq('id', id)
    if (error) { alert('Update failed: ' + error.message); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    setEditingId(null)
    if (patch.assignee && patch.assignee !== prevAssignee) {
      notifyTask('assigned', { ...patch, id })
    }
  }

  // A row renders the same in every column; the column header already names the
  // person, so the per-row assignee chip is dropped as redundant.
  const renderTask = (t: DealTask) => editingId === t.id ? (
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
      hideAssignee
      dealName={t.deal_id ? dealNames.get(t.deal_id) : undefined}
      ghlUrl={t.deal_id ? dealGhlUrls.get(t.deal_id) : undefined}
      onToggle={() => toggleComplete(t)}
      onDelete={() => deleteTask(t.id)}
      onEdit={() => setEditingId(t.id)}
    />
  )

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
        <>
          {/* Efrain / Brianne on top, Moe / Matt below */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {BOARD_COLUMNS.map(name => (
              <AssigneeColumn key={name} name={name} tasks={columns.byPerson.get(name)!} renderTask={renderTask} />
            ))}
          </div>
          {/* Only appears when a task sits outside the four columns (unassigned,
              Randy, a legacy name) — so nothing is hidden by the split. */}
          {columns.other.length > 0 && (
            <div className="mt-4">
              <AssigneeColumn name={OTHER_COLUMN} tasks={columns.other} renderTask={renderTask} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AssigneeColumn({ name, tasks, renderTask }: {
  name: string
  tasks: DealTask[]
  renderTask: (t: DealTask) => React.ReactNode
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className={`flex items-center justify-between gap-2 px-4 py-2.5 border-b ${COLUMN_STYLES[name]}`}>
        <h3 className="text-sm font-bold flex items-center gap-1.5 min-w-0">
          <User className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="truncate">{name}</span>
        </h3>
        <span className="text-[11px] font-bold tabular-nums rounded-full px-2 py-0.5 bg-white/70 shrink-0">
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-8">No tasks</p>
      ) : (
        // Capped so one long column (Brianne's auto-tasks under "Completed"/"All"
        // run to ~1,900px) can't push the bottom row off-screen — each column
        // scrolls in place and the 2×2 stays a quadrant.
        <div className="p-2 space-y-1.5 max-h-[30rem] overflow-y-auto">{tasks.map(renderTask)}</div>
      )}
    </section>
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

function TaskRow({ task, dealName, ghlUrl, hideAssignee, onToggle, onDelete, onEdit }: {
  task: DealTask; dealName?: string; ghlUrl?: string; hideAssignee?: boolean
  onToggle: () => void; onDelete: () => void; onEdit?: () => void
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

      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
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
  // No default due date/time on create — blank unless the user sets one.
  const initialDT = initialTask?.due_at ? splitDateTime(initialTask.due_at) : { date: '', time: '' }

  const [title, setTitle] = useState(initialTask?.title || '')
  const [description, setDescription] = useState(initialTask?.description || '')
  const [date, setDate] = useState(initialDT.date)
  const [time, setTime] = useState(initialDT.time)
  const [assignee, setAssignee] = useState(initialTask?.assignee || '')
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
type PageTab = 'tasks' | 'bulletin'

const TABS: { key: PageTab; label: string; icon: typeof ClipboardList; accent: string }[] = [
  { key: 'tasks',    label: 'Tasks',    icon: ClipboardList, accent: 'bg-blue-600 border-blue-600' },
  { key: 'bulletin', label: 'Bulletin', icon: StickyNote,    accent: 'bg-amber-500 border-amber-500' },
]

function BulletinTasksPageInner() {
  // ?tab=tasks|bulletin deep-links a tab (default: tasks).
  const searchParams = useSearchParams()
  const initialTab: PageTab = searchParams.get('tab') === 'bulletin' ? 'bulletin' : 'tasks'
  const [tab, setTab] = useState<PageTab>(initialTab)

  // Each panel fetches its own data (tasks pulls the whole deal list), so a panel
  // is mounted on first visit and then kept mounted behind `hidden` — switching
  // tabs never refetches, and the tab you never open never fetches at all.
  const [mounted, setMounted] = useState<Set<PageTab>>(() => new Set([initialTab]))
  function show(next: PageTab) {
    setTab(next)
    setMounted(prev => prev.has(next) ? prev : new Set(prev).add(next))
  }

  return (
    <div>
      <div className="max-w-6xl mx-auto px-6 pt-6">
        <div className="flex gap-2">
          {TABS.map(t => {
            const active = tab === t.key
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => show(t.key)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold border-2 transition-all ${
                  active ? `${t.accent} text-white shadow-md` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {mounted.has('tasks') && (
        <div className={tab === 'tasks' ? undefined : 'hidden'}><TasksSection /></div>
      )}
      {mounted.has('bulletin') && (
        <div className={tab === 'bulletin' ? undefined : 'hidden'}><NotesBoard embedded /></div>
      )}
    </div>
  )
}

// useSearchParams requires a Suspense boundary in the App Router.
export default function BulletinTasksPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <BulletinTasksPageInner />
    </Suspense>
  )
}
