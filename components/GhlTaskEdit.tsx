'use client'

import { useEffect, useState } from 'react'
import {
  fetchGhlAssignees, reassignGhlTask, rescheduleGhlTask, sameDueDate, type BoardTask,
} from '@/lib/ghlTasks'
import { combineDateTime, splitDateTime } from '@/components/TaskBoard'
import { TIME_OPTIONS, openDatePicker } from '@/lib/utils'
import { Calendar, X } from 'lucide-react'

// Inline editor for a mirrored GHL task — DUE DATE and OWNER.
//
// Was reassign-only until 2026-08-31. Rescheduling was added because the
// alternative people reached for was completing a task that wasn't done: the
// mirror holds OPEN tasks only, so completing one drops it off the board and
// buries it in GHL's history. Pushing the date out is the honest version of
// that action, and it had to be done in GHL by hand.
//
// Still NOT a full edit form: title and description live in GHL and are edited
// there. When to do a task and who owns it are dashboard-shaped decisions; what
// the task says is not (Efrain 2026-08-04: "lets not make this super
// complicated").
//
// GHL's task update takes a PARTIAL body, so each field is sent on its own and
// leaves the rest alone — which is also why this fires one call per CHANGED
// field rather than a single PUT of everything.

/** The board's local `YYYY-MM-DD`, shifted forward by `days`.
 *
 *  ⚠️ The base is the LATER of the date in the form and today. "+3 days" on a
 *  task that is 30 days overdue must land three days from NOW — shifting from
 *  the stale date would leave it still overdue, which defeats the entire point
 *  of pushing it out. */
function shiftDays(current: string, days: number): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const parsed = current ? new Date(`${current}T00:00:00`) : null
  const base = !parsed || isNaN(parsed.getTime()) || parsed < today ? today : parsed
  base.setDate(base.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
}

const PUSH_OUT: { label: string; days: number }[] = [
  { label: '+1 day', days: 1 },
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
]

export default function GhlTaskEdit({ task, onDone, onCancel }: {
  task: BoardTask
  /** Called with what GHL confirmed, once nothing is left to save. */
  onDone: (patch: { assignee: string | null; due_at: string | null }) => void
  onCancel: () => void
}) {
  // Derived, never state: whether the row can be written to at all is a fact
  // about the row, so an effect must not have to setState to say so.
  const taskId = task.ghl_task_id ?? null
  const initialDT = splitDateTime(task.due_at)
  const [date, setDate] = useState(initialDT.date)
  const [time, setTime] = useState(initialDT.time)
  const [assignees, setAssignees] = useState<string[]>([])
  const [choice, setChoice] = useState<string>(task.assignee ?? '')
  const [loading, setLoading] = useState(!!taskId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What GHL has actually confirmed so far. Seeded from the row, then advanced
  // one field at a time — so a half-failed save (owner landed, date didn't)
  // leaves the panel open showing the error, a retry only redoes the half that
  // failed, and closing still hands the parent the half that worked instead of
  // leaving a stale card behind.
  const [landedAssignee, setLandedAssignee] = useState<string | null>(task.assignee ?? null)
  const [landedDue, setLandedDue] = useState<string | null>(task.due_at ?? null)

  useEffect(() => {
    if (!taskId) return
    let live = true
    fetchGhlAssignees(taskId).then(({ assignees, error }) => {
      if (!live) return
      if (error) setError(error)
      else setAssignees(assignees)
      setLoading(false)
    })
    return () => { live = false }
  }, [taskId])

  const nextDue = combineDateTime(date, time)
  const dueChanged = !!nextDue && !sameDueDate(nextDue, landedDue)
  const ownerChanged = !!choice && choice !== landedAssignee
  const anythingLanded = landedAssignee !== (task.assignee ?? null) || !sameDueDate(landedDue, task.due_at)
  const close = () => anythingLanded ? onDone({ assignee: landedAssignee, due_at: landedDue }) : onCancel()

  async function save() {
    if (!taskId) { close(); return }
    if (!date) {
      // GHL rejects an undated task outright; say so instead of letting the
      // user discover it as a 400 from the route.
      setError('GHL tasks must have a due date — pick one.')
      return
    }
    if (!ownerChanged && !dueChanged) { close(); return }

    setSaving(true)
    setError(null)

    if (ownerChanged) {
      const err = await reassignGhlTask(taskId, choice)
      if (err) { setSaving(false); setError(err); return }
      setLandedAssignee(choice)
    }
    if (dueChanged && nextDue) {
      const { due_at, error } = await rescheduleGhlTask(taskId, nextDue)
      if (error) {
        setSaving(false)
        // Be explicit when half of it landed — "it failed" would be a lie.
        setError(ownerChanged ? `Owner updated, but the date didn't: ${error}` : error)
        return
      }
      setLandedDue(due_at ?? nextDue)
      setSaving(false)
      onDone({ assignee: ownerChanged ? choice : landedAssignee, due_at: due_at ?? nextDue })
      return
    }

    setSaving(false)
    onDone({ assignee: ownerChanged ? choice : landedAssignee, due_at: landedDue })
  }

  return (
    <div className="px-4 py-3 rounded-lg border border-indigo-200 bg-indigo-50/40">
      <div className="flex items-center gap-2 mb-2.5">
        <Calendar className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
        <span className="text-xs font-semibold text-slate-800 truncate">{task.title}</span>
        <span className="text-[9px] font-bold tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1 py-px shrink-0">GHL</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due date (required by GHL)</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            onClick={openDatePicker}
            disabled={saving}
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white disabled:opacity-60"
          />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due time</label>
          <select
            value={time}
            onChange={e => setTime(e.target.value)}
            disabled={saving}
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white disabled:opacity-60"
          >
            <option value="">— All day —</option>
            {/* A GHL follow-up can carry any time, not just one off our list —
                keep whatever it already had rather than silently re-timing it. */}
            {time && !TIME_OPTIONS.some(o => o.value === time) && <option value={time}>{time}</option>}
            {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-[10px] font-medium text-slate-500">Push out</span>
        {PUSH_OUT.map(p => (
          <button
            key={p.days}
            type="button"
            onClick={() => setDate(d => shiftDays(d, p.days))}
            disabled={saving}
            className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-indigo-700 bg-white border border-indigo-200 hover:bg-indigo-100 disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-2.5">
        <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned to</label>
        {loading ? (
          <p className="text-xs text-slate-500 py-1">Loading who this can go to…</p>
        ) : (
          <select
            value={choice}
            onChange={e => setChoice(e.target.value)}
            disabled={saving || assignees.length === 0}
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white disabled:opacity-60"
          >
            {/* The current owner may not be a user in this sub-account (a task
                can arrive assigned to someone since removed), so seed the list
                with it rather than silently showing someone else as selected. */}
            {choice && !assignees.includes(choice) && (
              <option value={choice}>{choice} (current)</option>
            )}
            {assignees.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2.5">
        <button
          onClick={save}
          disabled={saving || !taskId || !date || (!ownerChanged && !dueChanged)}
          className="px-3 py-1 text-xs font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-default"
        >
          {saving ? 'Saving to GHL…' : 'Save to GHL'}
        </button>
        <button
          onClick={close}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
        >
          <X className="w-3 h-3" /> {anythingLanded ? 'Close' : 'Cancel'}
        </button>
      </div>

      {!taskId && <p className="text-xs text-red-600 mt-2">This row has no GHL task id — it can&apos;t be edited here.</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {!loading && !error && assignees.length === 0 && (
        <p className="text-xs text-amber-700 mt-2">That GHL sub-account returned no users — the date can still be changed.</p>
      )}
    </div>
  )
}
