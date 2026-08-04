'use client'

// Create a task IN GoHighLevel from the dashboard. Same inline-form idiom as
// TaskBoard's NewTaskForm, but every field maps to what GHL actually needs:
//
//   • a CONTACT to hang it on — GHL has no task-on-an-opportunity, so the deal
//     picker is REQUIRED here (it's optional for a deal_task), and the deal
//     supplies both the contact and which sub-account/key to use.
//   • a DUE DATE — ⚠️ GHL rejects an undated task outright (422 "dueDate should
//     not be empty"), so the field is required rather than a discovered error.
//   • an ASSIGNEE that exists as a USER in that sub-account. Matt only exists in
//     his own location; the route answers with the location's actual user list
//     when the pick doesn't exist there.

import { useMemo, useState } from 'react'
import { Deal, TASK_ASSIGNEES } from '@/lib/types'
import { TIME_OPTIONS } from '@/lib/utils'
import { combineDateTime } from '@/components/TaskBoard'
import { toBoardTask, type BoardTask, type GhlTaskRow } from '@/lib/ghlTasks'
import { X, Loader2 } from 'lucide-react'

export default function GhlTaskForm({
  deals = [], fixedDealId, fixedDealName, defaultAssignee, onCreated, onCancel,
}: {
  deals?: Deal[]
  /** Deal page: the deal is known and locked, so no picker is shown. */
  fixedDealId?: string
  fixedDealName?: string
  defaultAssignee?: string
  onCreated: (task: BoardTask) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [assignee, setAssignee] = useState(defaultAssignee ?? '')
  const [dealId, setDealId] = useState(fixedDealId ?? '')
  const [dealSearch, setDealSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matchingDeals = useMemo(() => {
    const withContact = deals.filter(d => d.ghl_contact_id)
    if (!dealSearch.trim()) return withContact.slice(0, 50)
    const q = dealSearch.toLowerCase().trim()
    return withContact.filter(d => d.name?.toLowerCase().includes(q)).slice(0, 30)
  }, [deals, dealSearch])

  const chosenName = fixedDealName ?? deals.find(d => d.id === dealId)?.name

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim() || !dealId || !date || !assignee) return
    setSaving(true)
    try {
      const res = await fetch('/api/ghl/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId, title: title.trim(), body: note.trim() || undefined,
          dueDate: combineDateTime(date, time), assignee,
        }),
      })
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; task?: GhlTaskRow } | null
      if (!res.ok || !json?.ok || !json.task) { setError(json?.error ?? `HTTP ${res.status}`); return }
      onCreated(toBoardTask(json.task))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}
      className="bg-indigo-50/60 border border-indigo-200 rounded-lg p-3 mb-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wide text-indigo-700">NEW GHL TASK</span>
        <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-700">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="What needs to happen?"
        required
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Details (optional)"
        rows={2}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due date (required by GHL)</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} required
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Due time</label>
          <select value={time} onChange={e => setTime(e.target.value)}
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">— All day —</option>
            {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Assigned to</label>
          <select value={assignee} onChange={e => setAssignee(e.target.value)} required
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
            <option value="">— Pick a GHL user —</option>
            {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {!fixedDealId && (
          <div className="col-span-2">
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Contact (via deal) — required</label>
            {dealId ? (
              <div className="flex items-center gap-2 px-3 py-1.5 border border-indigo-200 bg-white rounded-md">
                <span className="text-sm text-slate-800 flex-1">{chosenName || 'Selected'}</span>
                <button type="button" onClick={() => setDealId('')} className="text-slate-400 hover:text-red-500">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <>
                <input
                  value={dealSearch}
                  onChange={e => setDealSearch(e.target.value)}
                  placeholder="Search deals…"
                  className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm mb-1"
                />
                <div className="max-h-28 overflow-y-auto border border-slate-200 rounded-md bg-white divide-y divide-slate-100">
                  {matchingDeals.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-400">No deal with a GHL contact matches that.</p>
                  ) : matchingDeals.map(d => (
                    <button key={d.id} type="button" onClick={() => setDealId(d.id)}
                      className="block w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50">
                      {d.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 font-medium">{error}</p>}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving || !title.trim() || !dealId || !date || !assignee}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? 'Creating in GHL…' : 'Create in GHL'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800">
          Cancel
        </button>
      </div>
    </form>
  )
}
