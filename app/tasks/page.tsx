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
// GHL keeps its own per-contact tasks; they are mirrored into ghl_tasks and
// rendered right alongside deal_tasks so the board is the whole workload.
import { toBoardTask, isGhlTask, type BoardTask, type GhlTaskRow } from '@/lib/ghlTasks'
// Card + column design lives in one place so /tasks and the Follow-Up cockpit
// render the identical task card and cannot drift apart.
import {
  TaskRow, AssigneeColumn, NewTaskForm, relativeDue, isDueNow, isAllDay,
  startOfDay, endOfDay, combineDateTime, splitDateTime, ALL_DAY_TIME,
  COLUMN_VIEWS, COLUMN_STYLES, PRIORITY_STYLES, OTHER_COLUMN, type ColumnView,
} from '@/components/TaskBoard'
import {
  ClipboardList, Plus, X, Search, CheckCircle2, Circle,
  Calendar, User, Flame, ExternalLink, Trash2, StickyNote,
} from 'lucide-react'
import NotesBoard from '@/components/NotesBoard'

type FilterMode = 'open' | 'today' | 'overdue' | 'week' | 'completed' | 'all'

// A blank time is stored as 23:59 ("end of day"), which the 15-min picker can
// never produce — so it doubles as an "all day / no specific time" marker.


// The board is one column per person, laid out 2×2: Efrain / Brianne on top,
// Moe / Matt below. Anyone NOT in this list (Randy, an unassigned task, a
// legacy name) falls into the "Unassigned & other" column so no task can be
// hidden just because it doesn't belong to one of the four.
const BOARD_COLUMNS = ['Efrain Ramirez', 'Brianne Han', 'Moe Sefati', 'Matt Park'] as const

// Each column carries its own time cut on top of the global chips, so you can
// park one person on "what's on fire" while another shows everything — all in
// the same screen. Completion is owned entirely by the chips above; a column
// view only ever slices by due date, never by done/not-done.
const COLUMN_VIEWS_KEY = 'tasks:columnViews'
const DEFAULT_COLUMN_VIEW: ColumnView = 'all'

function TasksSection() {
  const [dealTasks, setDealTasks] = useState<DealTask[]>([])
  const [ghlTasks, setGhlTasks] = useState<BoardTask[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterMode>('open')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  // Which column's "+" is open (its name), pre-assigning the new task to that
  // person. Only one form is ever open — opening either closes the other.
  const [composeFor, setComposeFor] = useState<string | null>(null)
  // Per-column time cut, keyed by column name. Read from localStorage after
  // mount (not in the initializer) so the server and first client render agree.
  const [columnViews, setColumnViews] = useState<Record<string, ColumnView>>({})
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLUMN_VIEWS_KEY)
      if (raw) setColumnViews(JSON.parse(raw))
    } catch { /* ignore corrupt/blocked storage — falls back to the default */ }
  }, [])
  const setColumnView = useCallback((name: string, view: ColumnView) => {
    setColumnViews(prev => {
      const next = { ...prev, [name]: view }
      try { localStorage.setItem(COLUMN_VIEWS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    const [tasksRes, ghlRes, dealsData] = await Promise.all([
      supabase.from('deal_tasks').select('*'),
      supabase.from('ghl_tasks').select('*'),
      // Paginate past PostgREST's 1000-row cap — the table has >1000 deals, so a
      // bare select dropped the oldest, leaving their tasks unable to resolve a
      // deal name / LO.
      // ghl_opportunity_id is needed for ghlContactUrl's known-bad-id guard.
      fetchAllDeals(undefined, 'id, name, loan_officer, ghl_contact_id, ghl_opportunity_id, ghl_location_id'),
    ])
    setDealTasks((tasksRes.data as DealTask[]) || [])
    setGhlTasks(((ghlRes.data as GhlTaskRow[]) || []).map(toBoardTask))
    setDeals(dealsData)
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // One board. deal_tasks are ours (create/edit/delete); GHL rows are mirrors —
  // completable, but edited in GHL.
  const tasks = useMemo<BoardTask[]>(() => [...dealTasks, ...ghlTasks], [dealTasks, ghlTasks])

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
        const hay = `${t.title} ${t.description ?? ''} ${t.assignee ?? ''} ${dealName} ${t.contact_name ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      // Open tasks first, by due asc; completed tasks last, by completed_at desc
      if (!a.completed_at && b.completed_at) return -1
      if (a.completed_at && !b.completed_at) return 1
      if (!a.completed_at && !b.completed_at) {
        // Strict urgency order, undated last — this is what the All view shows
        // (Efrain 2026-08-03: "keep All sorted by urgency"). AssigneeColumn
        // floats undated to the top of the Overdue & today bucket on its own.
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
    const byPerson = new Map<string, BoardTask[]>(BOARD_COLUMNS.map(n => [n, [] as BoardTask[]]))
    const other: BoardTask[] = []
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

  // Completing a GHL task writes back to GHL (PUT …/completed) and drops the
  // mirror row — there is no "uncomplete", the same as the FUB cockpit button.
  const [busyGhl, setBusyGhl] = useState<Set<string>>(new Set())
  async function completeGhlTask(task: BoardTask) {
    const id = task.ghl_task_id
    if (!id || busyGhl.has(id)) return
    setBusyGhl(prev => new Set(prev).add(id))
    try {
      const res = await fetch('/api/ghl/tasks/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: id }),
      })
      const json = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !json.ok) { alert('Could not complete in GHL: ' + (json.error ?? res.status)); return }
      setGhlTasks(prev => prev.filter(t => t.ghl_task_id !== id))
    } catch (e) {
      alert('Could not complete in GHL: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusyGhl(prev => { const next = new Set(prev); next.delete(id); return next })
    }
  }

  async function toggleComplete(task: BoardTask) {
    if (isGhlTask(task)) { await completeGhlTask(task); return }
    const newCompleted = task.completed_at ? null : new Date().toISOString()
    await supabase.from('deal_tasks').update({ completed_at: newCompleted }).eq('id', task.id)
    setDealTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed_at: newCompleted } : t))
    if (newCompleted) notifyTask('completed', task)
  }

  async function deleteTask(id: string) {
    if (!confirm('Delete this task?')) return
    await supabase.from('deal_tasks').delete().eq('id', id)
    setDealTasks(prev => prev.filter(t => t.id !== id))
  }

  async function createTask(payload: Omit<DealTask, 'id' | 'created_at'>) {
    const { data, error } = await supabase.from('deal_tasks').insert(payload).select().single()
    if (error) { alert('Save failed: ' + error.message); return }
    if (data) {
      setDealTasks(prev => [data as DealTask, ...prev])
      notifyTask('assigned', data as DealTask)
    }
    setShowForm(false)
    setComposeFor(null)
  }

  async function clearCompleted() {
    const doneIds = tasks.filter(t => t.completed_at).map(t => t.id)
    if (doneIds.length === 0) return
    if (!confirm(`Delete ${doneIds.length} completed task${doneIds.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    const { error } = await supabase.from('deal_tasks').delete().in('id', doneIds)
    if (error) { alert('Clear failed: ' + error.message); return }
    setDealTasks(prev => prev.filter(t => !t.completed_at))
  }

  const [editingId, setEditingId] = useState<string | null>(null)
  async function updateTask(id: string, patch: Omit<DealTask, 'id' | 'created_at'>) {
    const prevAssignee = tasks.find(t => t.id === id)?.assignee ?? null
    const { error } = await supabase.from('deal_tasks').update(patch).eq('id', id)
    if (error) { alert('Update failed: ' + error.message); return }
    setDealTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    setEditingId(null)
    if (patch.assignee && patch.assignee !== prevAssignee) {
      notifyTask('assigned', { ...patch, id })
    }
  }

  // The create form for a column's "+", pre-assigned to that person. The catch-all
  // column seeds nothing — "Unassigned & other" isn't a person to assign to.
  const openComposer = (name: string) => { setComposeFor(name); setShowForm(false) }
  const composerFor = (name: string) => composeFor !== name ? undefined : (
    <NewTaskForm
      deals={deals}
      initialAssignee={name === OTHER_COLUMN ? '' : name}
      onSubmit={createTask}
      onCancel={() => setComposeFor(null)}
    />
  )

  // A row renders the same in every column; the column header already names the
  // person, so the per-row assignee chip is dropped as redundant.
  // GHL rows are read-only mirrors: complete (writes back to GHL) and a link
  // out to the contact, but no edit/delete — those belong in GHL.
  const renderTask = (t: BoardTask) => isGhlTask(t) ? (
    <TaskRow
      key={t.id}
      task={t}
      hideAssignee
      badge="GHL"
      contactName={t.contact_name}
      dealName={t.deal_id ? dealNames.get(t.deal_id) : undefined}
      ghlUrl={ghlContactUrl({ ghl_contact_id: t.ghl_contact_id, ghl_location_id: t.ghl_location_id }) ?? undefined}
      onToggle={() => toggleComplete(t)}
    />
  ) : editingId === t.id ? (
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
            onClick={() => { setShowForm(v => !v); setComposeFor(null) }}
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
              <AssigneeColumn
                key={name}
                name={name}
                tasks={columns.byPerson.get(name)!}
                view={columnViews[name] ?? DEFAULT_COLUMN_VIEW}
                onViewChange={v => setColumnView(name, v)}
                renderTask={renderTask}
                onAdd={() => openComposer(name)}
                composing={composerFor(name)}
              />
            ))}
          </div>
          {/* Only appears when a task sits outside the four columns (unassigned,
              Randy, a legacy name) — so nothing is hidden by the split. */}
          {columns.other.length > 0 && (
            <div className="mt-4">
              <AssigneeColumn
                name={OTHER_COLUMN}
                tasks={columns.other}
                view={columnViews[OTHER_COLUMN] ?? DEFAULT_COLUMN_VIEW}
                onViewChange={v => setColumnView(OTHER_COLUMN, v)}
                renderTask={renderTask}
                onAdd={() => openComposer(OTHER_COLUMN)}
                composing={composerFor(OTHER_COLUMN)}
              />
            </div>
          )}
        </>
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

// ── Task form for the global Tasks page (create + edit, includes deal picker) ─
// `initialAssignee` seeds the dropdown when creating from a column's + button
// (the column header already says who it's for). Every BOARD_COLUMNS name is a
// valid TASK_ASSIGNEES value — if that ever drifts, the select falls back to
// "Unassigned" rather than showing a value it can't save.

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
