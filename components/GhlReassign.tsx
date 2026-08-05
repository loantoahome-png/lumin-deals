'use client'

import { useEffect, useState } from 'react'
import { fetchGhlAssignees, reassignGhlTask, type BoardTask } from '@/lib/ghlTasks'
import { User, X } from 'lucide-react'

// Reassign a mirrored GHL task, inline on the board row.
//
// Deliberately reassign-ONLY, not a full edit form: the title and description
// live in GHL and are edited there, but WHO OWNS a task is a dashboard-shaped
// decision (Efrain 2026-08-04). GHL's task update takes a partial body, so
// sending just `assignedTo` leaves everything else alone.
//
// The options come from the task's OWN sub-account — GHL users are
// per-location, so the list is fetched per task rather than assumed.

export default function GhlReassign({ task, onDone, onCancel }: {
  task: BoardTask
  /** Called with the new board name once GHL has confirmed the change. */
  onDone: (assignee: string) => void
  onCancel: () => void
}) {
  const [assignees, setAssignees] = useState<string[]>([])
  const [choice, setChoice] = useState<string>(task.assignee ?? '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const id = task.ghl_task_id
    if (!id) { setError('this row has no GHL task id'); setLoading(false); return }
    fetchGhlAssignees(id).then(({ assignees, error }) => {
      if (!live) return
      if (error) setError(error)
      else setAssignees(assignees)
      setLoading(false)
    })
    return () => { live = false }
  }, [task.ghl_task_id])

  async function save() {
    const id = task.ghl_task_id
    if (!id || !choice || choice === task.assignee) { onCancel(); return }
    setSaving(true)
    setError(null)
    const err = await reassignGhlTask(id, choice)
    setSaving(false)
    if (err) { setError(err); return }
    onDone(choice)
  }

  return (
    <div className="px-4 py-3 rounded-lg border border-indigo-200 bg-indigo-50/40">
      <div className="flex items-center gap-2 mb-2">
        <User className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
        <span className="text-xs font-semibold text-slate-800 truncate">{task.title}</span>
        <span className="text-[9px] font-bold tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1 py-px shrink-0">GHL</span>
      </div>

      {loading ? (
        <p className="text-xs text-slate-500">Loading who this can go to…</p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={choice}
            onChange={e => setChoice(e.target.value)}
            disabled={saving || assignees.length === 0}
            className="px-2 py-1 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
          >
            {/* The current owner may not be a user in this sub-account (a task
                can arrive assigned to someone since removed), so seed the list
                with it rather than silently showing someone else as selected. */}
            {task.assignee && !assignees.includes(task.assignee) && (
              <option value={task.assignee}>{task.assignee} (current)</option>
            )}
            {assignees.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button
            onClick={save}
            disabled={saving || !choice || choice === task.assignee}
            className="px-3 py-1 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-default"
          >
            {saving ? 'Reassigning…' : 'Reassign in GHL'}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
          >
            <X className="w-3 h-3" /> Cancel
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {!loading && !error && assignees.length === 0 && (
        <p className="text-xs text-amber-700 mt-2">That GHL sub-account returned no users.</p>
      )}
    </div>
  )
}
