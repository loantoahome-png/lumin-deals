'use client'

// Task composers for the Follow-Up Cockpit. Two systems live on that page, so
// there are two composers and each task lands where it belongs:
//
//   • NewDashTaskModal — a dashboard task (deal_tasks), same shape and the same
//     23:59 "all day" convention the /tasks page uses, so both surfaces agree.
//   • NewFubTaskModal  — a real FollowUpBoss task on one of that LO's people,
//     created through /api/fub/tasks/create (the server holds the API keys).
//
// Both are modals so they can be opened from a panel header OR from a row with
// the deal/person pre-filled.

import { useEffect, useMemo, useState } from 'react'
import { X, ListTodo, ClipboardList, Search } from 'lucide-react'
import { TASK_ASSIGNEES, type DealTask } from '@/lib/types'

const ALL_DAY_TIME = '23:59'   // matches app/tasks/page.tsx — blank time = all day

/** Local YYYY-MM-DD (never toISOString, which shifts the date west of UTC). */
export function todayYmdLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function combineDateTime(date: string, time: string): string | null {
  if (!date) return null
  const d = new Date(`${date}T${time || ALL_DAY_TIME}`)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

const TIME_OPTIONS = [
  '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
].map(v => ({ value: v, label: new Date(`2000-01-01T${v}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }))

function Shell({ title, icon, accent, onClose, children }: {
  title: string; icon: React.ReactNode; accent: string; onClose: () => void; children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-20" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100" style={{ borderLeft: `3px solid ${accent}` }}>
          <span style={{ color: accent }}>{icon}</span>
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

const inputCls = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const labelCls = 'block text-[10px] font-medium text-slate-500 mb-0.5'

// ── Dashboard task (deal_tasks) ──────────────────────────────────────────────

export type DealOption = { id: string; name: string | null }

export function NewDashTaskModal({ lo, deals, initialDealId, onCreate, onClose }: {
  lo: string
  deals: DealOption[]
  initialDealId?: string | null
  onCreate: (t: Omit<DealTask, 'id' | 'created_at'>) => Promise<void>
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [assignee, setAssignee] = useState(lo)
  const [priority, setPriority] = useState('normal')
  const [dealId, setDealId] = useState(initialDealId ?? '')
  const [dealSearch, setDealSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const matching = useMemo(() => {
    const q = dealSearch.toLowerCase().trim()
    const list = q ? deals.filter(d => d.name?.toLowerCase().includes(q)) : deals
    return list.slice(0, 20)
  }, [deals, dealSearch])
  const selected = deals.find(d => d.id === dealId)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await onCreate({
        deal_id: dealId || null,
        title: title.trim(),
        description: description.trim() || null,
        due_at: combineDateTime(date, time),
        assignee: assignee || null,
        // Created from this LO's own cockpit — record who it came from so the
        // completion email has an assigner, matching /tasks behavior.
        assigned_by: lo,
        priority,
        completed_at: null,
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Shell title="New dashboard task" icon={<ClipboardList className="w-4 h-4" />} accent="#10b981" onClose={onClose}>
      <form onSubmit={submit} className="p-5 space-y-3">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} required
          placeholder="What needs to happen?" className={inputCls} />
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
          placeholder="Details (optional)" className={`${inputCls} resize-none`} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center justify-between">
              <label className={labelCls}>Due date</label>
              {(date || time) && (
                <button type="button" onClick={() => { setDate(''); setTime('') }}
                  className="text-[10px] text-slate-400 hover:text-red-600">Clear</button>
              )}
            </div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Due time</label>
            <select value={time} onChange={e => setTime(e.target.value)} className={`${inputCls} bg-white`}>
              <option value="">All day</option>
              {TIME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Assigned to</label>
            <select value={assignee} onChange={e => setAssignee(e.target.value)} className={`${inputCls} bg-white`}>
              <option value="">— Unassigned —</option>
              {TASK_ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Priority</label>
            <select value={priority} onChange={e => setPriority(e.target.value)} className={`${inputCls} bg-white`}>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls}>Link to a deal (optional)</label>
          {selected ? (
            <div className="flex items-center gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <span className="truncate">{selected.name ?? 'Deal'}</span>
              <button type="button" onClick={() => { setDealId(''); setDealSearch('') }}
                className="ml-auto text-xs text-slate-400 hover:text-red-600">change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={dealSearch} onChange={e => setDealSearch(e.target.value)}
                  placeholder="Type to search your deals…" className={`${inputCls} pl-8`} />
              </div>
              {dealSearch.trim() && (
                <div className="mt-1 max-h-36 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {matching.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches</p>}
                  {matching.map(d => (
                    <button type="button" key={d.id} onClick={() => { setDealId(d.id); setDealSearch('') }}
                      className="block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 truncate">
                      {d.name ?? 'Unnamed deal'}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="submit" disabled={!title.trim() || saving}
            className="px-4 py-1.5 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Create task'}
          </button>
        </div>
      </form>
    </Shell>
  )
}

// ── FollowUpBoss task ────────────────────────────────────────────────────────

export type FubPersonOption = { fub_id: number; name?: string | null; stage?: string | null }
const FUB_TASK_TYPES = ['Follow Up', 'Call', 'Text', 'Email', 'Appointment']

export function NewFubTaskModal({ people, initialPersonId, onCreate, onClose }: {
  people: FubPersonOption[]
  initialPersonId?: number | null
  onCreate: (t: { personId: number; name: string; type: string; dueDate: string | null }) => Promise<boolean>
  onClose: () => void
}) {
  const [personId, setPersonId] = useState<number | null>(initialPersonId ?? null)
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('Follow Up')
  const [date, setDate] = useState(todayYmdLocal())
  const [saving, setSaving] = useState(false)

  const matching = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return []
    return people.filter(p => p.name?.toLowerCase().includes(q)).slice(0, 20)
  }, [people, search])
  const selected = people.find(p => p.fub_id === personId)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!personId || !name.trim() || saving) return
    setSaving(true)
    try {
      const ok = await onCreate({ personId, name: name.trim(), type, dueDate: date || null })
      if (ok) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Shell title="New FollowUpBoss task" icon={<ListTodo className="w-4 h-4" />} accent="#6366f1" onClose={onClose}>
      <form onSubmit={submit} className="p-5 space-y-3">
        <div>
          <label className={labelCls}>Contact <span className="text-slate-400">(required — the task is created on their FUB record)</span></label>
          {selected ? (
            <div className="flex items-center gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <span className="truncate font-medium">{selected.name ?? `FUB contact #${selected.fub_id}`}</span>
              {selected.stage && <span className="text-[10px] text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5">{selected.stage}</span>}
              <button type="button" onClick={() => { setPersonId(null); setSearch('') }}
                className="ml-auto text-xs text-slate-400 hover:text-red-600">change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search your FollowUpBoss contacts…" className={`${inputCls} pl-8`} />
              </div>
              {search.trim() && (
                <div className="mt-1 max-h-40 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {matching.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches in your FUB book</p>}
                  {matching.map(p => (
                    <button type="button" key={p.fub_id} onClick={() => { setPersonId(p.fub_id); setSearch('') }}
                      className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50">
                      <span className="truncate">{p.name ?? `#${p.fub_id}`}</span>
                      {p.stage && <span className="ml-auto shrink-0 text-[10px] text-slate-500">{p.stage}</span>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <input value={name} onChange={e => setName(e.target.value)} required
          placeholder="What's the follow-up? (shows as the task in FUB)" className={inputCls} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Type</label>
            <select value={type} onChange={e => setType(e.target.value)} className={`${inputCls} bg-white`}>
              {FUB_TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Due date <span className="text-slate-400">(FUB tasks have no time)</span></label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="submit" disabled={!personId || !name.trim() || saving}
            className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'Creating in FUB…' : 'Create in FollowUpBoss'}
          </button>
        </div>
      </form>
    </Shell>
  )
}
