'use client'

// ── Work List ───────────────────────────────────────────────────────────────
// Replaces the "Tasklist for Bri and Efrain" Google Doc.
//
// The Processing Desk answers "where is this file at" — one loan, its steps.
// This page answers the opposite question, the one the doc actually answered:
// "what do I have to order today, and on which files."
//
//     Payoff
//       a. Ciarmoli
//       b. Rugley
//
// Same data as the per-loan checklist, transposed. Ticking here writes the same
// `deals.processor_checklist` the checklist page reads, so the two can never
// disagree — there is no second task system.
//
// Three states, from the doc: TO DO → REQUESTED (ordered, waiting on a third
// party, with where it went and who sent it) → DONE. The middle one is the
// reason the doc outlived the checklist; a binary tick can't say "payoff faxed
// to 916-464-2477 on 8/10 by Bri, still nothing back."
//
// Scope: Hanh's active escrows (Efrain, 2026-08-10). Visible to everyone.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import DOMPurify from 'dompurify'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { deskDeals, ESCROW_PIPELINE, DEFAULT_PROCESSOR } from '@/lib/processorDesk'
import {
  mergeChecklist, toState, toggleItem, requestItem, clearRequest,
  addCustomRow, type ChecklistState,
} from '@/lib/processorChecklist'
import {
  buildWorkItems, groupsForState, workCounts, sortByWait, recentlyCompleted,
  workState, type WorkItem,
} from '@/lib/workList'
import type { Deal } from '@/lib/types'
import RichTextEditor from '@/components/RichTextEditor'
import {
  ListChecks, Clock, CheckCircle2, Circle, Send, Plus, X, RefreshCw,
  StickyNote, Pencil, ChevronDown, ChevronRight, AlertTriangle,
} from 'lucide-react'

type Tab = 'todo' | 'waiting' | 'done'

/** A wait older than this is called out — the doc had no way to notice. */
const STALE_WAIT_DAYS = 3

export default function WorkListPage() {
  const me = useCurrentUser()
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('todo')
  const [busy, setBusy] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const all = await fetchAllDeals(q => q.eq('pipeline_group', ESCROW_PIPELINE))
    setDeals(deskDeals(all, DEFAULT_PROCESSOR))
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const items = useMemo(() => buildWorkItems(deals), [deals])
  const counts = useMemo(() => workCounts(items, STALE_WAIT_DAYS), [items])

  // ── Writes ────────────────────────────────────────────────────────────────
  // Every mutation goes through the SAME merge → mutate → toState path the
  // checklist page uses, so this page can't write a shape that page can't read.
  const mutate = useCallback(async (
    dealId: string,
    fn: (rows: ReturnType<typeof mergeChecklist>) => ReturnType<typeof mergeChecklist>,
  ) => {
    const deal = deals.find(d => d.id === dealId)
    if (!deal) return
    setBusy(dealId)
    setSaveError(null)
    const next = fn(mergeChecklist(
      deal.processor_checklist as ChecklistState[] | null, undefined, deal.loan_purpose,
    ))
    const state = toState(next)

    // Optimistic — the list re-groups instantly, which is the whole feel of the page.
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, processor_checklist: state } as Deal : d))

    // ⚠️ `.select()` is required: an RLS-blocked client write returns NO error
    //    and zero rows, so without it every tick would look saved and be lost.
    const { data, error } = await supabase
      .from('deals').update({ processor_checklist: state }).eq('id', dealId).select('id')
    setBusy(null)
    if (error) { setSaveError(error.message); refresh(); return }
    if (!data || data.length === 0) {
      setSaveError('Not saved — the update was refused (row-level security). Nothing was written.')
      refresh()
    }
  }, [deals, refresh])

  const onToggle = (i: WorkItem) =>
    mutate(i.dealId, rows => toggleItem(rows, i.itemId, me.name, new Date().toISOString()))
  const onRequest = (i: WorkItem, from: string) =>
    mutate(i.dealId, rows => requestItem(rows, i.itemId, from, me.name, new Date().toISOString()))
  const onClearRequest = (i: WorkItem) =>
    mutate(i.dealId, rows => clearRequest(rows, i.itemId))

  const groups = useMemo(
    () => groupsForState(items, tab === 'done' ? 'done' : tab),
    [items, tab],
  )
  const completed = useMemo(() => recentlyCompleted(items), [items])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center">
            <ListChecks className="w-5 h-5 text-indigo-700" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-tight">Work List</h1>
            <p className="text-xs text-slate-500">
              What needs ordering across {DEFAULT_PROCESSOR}&apos;s active files — grouped by action.
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <NotesBlock myName={me.name} />

      {saveError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {saveError}
        </div>
      )}

      {/* ⚠️ First-run reality check. An unticked box means "not recorded", NOT
          "needs doing" — and on day one nothing is recorded, so every action on
          every file reads as outstanding. Verified against live data on
          2026-08-10: 63 to-do rows across 9 files, all of them just untouched
          history (Ciarmoli is Approved w/ Conditions; it plainly has an
          appraisal and title already).

          This says so out loud rather than letting the page look like a crisis.
          It disappears on its own the moment anything is ticked. */}
      {!loading && counts.done === 0 && counts.waiting === 0 && counts.todo > 0 && (
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 text-blue-900 text-sm px-4 py-3 rounded-lg">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
          <span>
            <strong>First time here?</strong> Everything shows as “to do” because nothing has been
            ticked yet — not because it all needs doing. Work down the list once, ticking what&apos;s
            already handled and marking what&apos;s been ordered as <em>Requested</em>. After that
            pass the page only shows real work.
          </span>
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5">
        <TabChip label="To do"    count={counts.todo}    active={tab === 'todo'}    onClick={() => setTab('todo')} />
        <TabChip label="Waiting on" count={counts.waiting} active={tab === 'waiting'} onClick={() => setTab('waiting')}
                 warn={counts.overdueWaits > 0 ? counts.overdueWaits : undefined} />
        <TabChip label="Done"     count={counts.done}    active={tab === 'done'}    onClick={() => setTab('done')} />
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
        </div>
      ) : tab === 'done' ? (
        <CompletedLog items={completed} />
      ) : groups.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <CheckCircle2 className="w-9 h-9 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">
            {tab === 'todo' ? 'Nothing waiting to be ordered' : 'Nothing outstanding'}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {tab === 'todo'
              ? 'Every tracked order on these files has been placed.'
              : 'Nothing has been requested and left hanging.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <section key={g.itemId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-800">{g.label}</h2>
                <span className="text-[11px] font-semibold text-slate-500 bg-white border border-slate-200 rounded-full px-2 py-0.5 tabular-nums">
                  {g.items.length}
                </span>
              </div>
              <div className="divide-y divide-slate-100">
                {(tab === 'waiting' ? sortByWait(g.items) : g.items).map(i => (
                  <WorkRow
                    key={`${i.dealId}:${i.itemId}`}
                    item={i}
                    busy={busy === i.dealId}
                    onToggle={() => onToggle(i)}
                    onRequest={from => onRequest(i, from)}
                    onClearRequest={() => onClearRequest(i)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!loading && <AddCustomRow deals={deals} onAdd={mutate} />}

      <p className="text-[11px] text-slate-400">
        Same data as each loan&apos;s Processor Checklist — ticking here shows up there, and the
        other way round. Scope: {DEFAULT_PROCESSOR}&apos;s files in {ESCROW_PIPELINE}.
      </p>
    </div>
  )
}

// ── Pinned notes ────────────────────────────────────────────────────────────

function NotesBlock({ myName }: { myName: string | null }) {
  const [html, setHtml] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [meta, setMeta] = useState<{ at: string | null; by: string | null }>({ at: null, by: null })
  const [open, setOpen] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/worklist-notes')
      .then(r => r.json())
      .then(d => { setHtml(d.html ?? ''); setMeta({ at: d.updated_at ?? null, by: d.updated_by ?? null }) })
      .catch(() => setHtml(''))
  }, [])

  async function save() {
    setSaving(true)
    const res = await fetch('/api/worklist-notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: draft, updated_by: myName }),
    }).then(r => r.json()).catch(() => null)
    setSaving(false)
    if (res?.ok) {
      setHtml(draft)
      setMeta({ at: res.updated_at ?? null, by: res.updated_by ?? null })
      setEditing(false)
    }
  }

  if (html === null) return null

  return (
    <section className="bg-amber-50/60 border border-amber-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-amber-200/70">
        <button onClick={() => setOpen(v => !v)} className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-800">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <StickyNote className="w-3.5 h-3.5" /> Notes
        </button>
        <div className="flex items-center gap-2">
          {meta.at && !editing && (
            <span className="text-[10px] text-amber-700/70">
              {meta.by ? `${meta.by} · ` : ''}{new Date(meta.at).toLocaleDateString()}
            </span>
          )}
          {open && !editing && (
            <button
              onClick={() => { setDraft(html); setEditing(true) }}
              className="flex items-center gap-1 text-[11px] font-semibold text-amber-800 hover:text-amber-950"
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="p-4">
          {editing ? (
            <>
              <RichTextEditor initialHtml={draft} onChange={setDraft} autofocus />
              <div className="flex gap-2 justify-end mt-2">
                <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-white">Cancel</button>
                <button onClick={save} disabled={saving} className="px-4 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : html.trim() ? (
            // Sanitized on read — the same path components/NoteContent uses.
            <div className="note-prose text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] }) }} />
          ) : (
            <p className="text-xs text-amber-800/70 italic">
              Nothing pinned yet — use Edit for standing reminders (who to CC, what to attach when ordering title).
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ── One loan's position on one action ───────────────────────────────────────

function WorkRow({ item, busy, onToggle, onRequest, onClearRequest }: {
  item: WorkItem
  busy: boolean
  onToggle: () => void
  onRequest: (from: string) => void
  onClearRequest: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [from, setFrom] = useState('')
  const state = workState(item)
  const stale = state === 'waiting' && (item.waitingDays ?? 0) >= STALE_WAIT_DAYS

  return (
    <div className={`px-4 py-2.5 ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={onToggle}
          title={item.done_at ? 'Mark not done' : 'Mark done'}
          className="mt-0.5 shrink-0"
        >
          {item.done_at
            ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            : <Circle className="w-4 h-4 text-slate-300 hover:text-slate-500" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/deals/${item.dealId}`} className={`text-sm font-medium hover:text-blue-600 ${item.done_at ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
              {item.dealName}
            </Link>
            <span className="text-[10px] text-slate-400">{item.stage}</span>
            {stale && (
              <span className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
                {item.waitingDays}d no response
              </span>
            )}
          </div>

          {/* The doc's most useful line, structured: where it went, who, when. */}
          {item.requested_at && (
            <p className="text-[11px] text-slate-500 mt-0.5">
              <span className={stale ? 'text-red-600 font-medium' : 'text-amber-700 font-medium'}>Requested</span>
              {item.requested_from ? <> from <span className="text-slate-700">{item.requested_from}</span></> : null}
              {' · '}{new Date(item.requested_at).toLocaleDateString()}
              {item.requested_by ? ` · ${item.requested_by}` : ''}
              {item.done_at && item.waitingDays == null ? null : null}
            </p>
          )}
          {item.done_at && (
            <p className="text-[11px] text-emerald-700 mt-0.5">
              Done {new Date(item.done_at).toLocaleDateString()}{item.done_by ? ` · ${item.done_by}` : ''}
            </p>
          )}
          {item.note && <p className="text-[11px] text-slate-500 mt-0.5 italic">{item.note}</p>}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!item.done_at && !item.requested_at && !asking && (
            <button
              onClick={() => setAsking(true)}
              className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 hover:bg-amber-100"
            >
              <Send className="w-3 h-3" /> Requested
            </button>
          )}
          {!item.done_at && item.requested_at && (
            <button
              onClick={onClearRequest}
              title="Undo — put this back on the To do list"
              className="text-[11px] text-slate-400 hover:text-slate-700"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {asking && (
        <div className="flex items-center gap-2 mt-2 pl-7">
          <input
            autoFocus
            value={from}
            onChange={e => setFrom(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onRequest(from); setAsking(false); setFrom('') }
              if (e.key === 'Escape') { setAsking(false); setFrom('') }
            }}
            placeholder="Where did it go? e.g. nadia.hall@trucordia.com, fax 916-464-2477"
            className="flex-1 border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
          <button
            onClick={() => { onRequest(from); setAsking(false); setFrom('') }}
            className="px-3 py-1 text-xs font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700"
          >
            Save
          </button>
          <button onClick={() => { setAsking(false); setFrom('') }} className="text-slate-400 hover:text-slate-700">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Completed log ───────────────────────────────────────────────────────────

function CompletedLog({ items }: { items: WorkItem[] }) {
  // Grouped by the DAY it was completed — the doc's "Completed 8/6" heading,
  // except nobody has to type the date.
  const byDay = useMemo(() => {
    const m = new Map<string, WorkItem[]>()
    for (const i of items) {
      const d = new Date(i.done_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      m.set(d, [...(m.get(d) ?? []), i])
    }
    return [...m.entries()]
  }, [items])

  if (items.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <p className="text-sm font-semibold text-slate-800">Nothing completed in the last two weeks</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {byDay.map(([day, rows]) => (
        <section key={day} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-800">Completed {day}</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map(i => (
              <li key={`${i.dealId}:${i.itemId}`} className="px-4 py-2 text-sm flex flex-wrap items-center gap-x-2">
                <Link href={`/deals/${i.dealId}`} className="font-medium text-slate-800 hover:text-blue-600">{i.dealName}</Link>
                <span className="text-slate-400">·</span>
                <span className="text-slate-600">{i.label}</span>
                {i.requested_from && <span className="text-[11px] text-slate-400">from {i.requested_from}</span>}
                {i.done_by && <span className="text-[11px] text-slate-400 ml-auto">{i.done_by}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ── Free row ────────────────────────────────────────────────────────────────

function AddCustomRow({ deals, onAdd }: {
  deals: Deal[]
  onAdd: (dealId: string, fn: (rows: ReturnType<typeof mergeChecklist>) => ReturnType<typeof mergeChecklist>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [dealId, setDealId] = useState('')

  function submit() {
    if (!label.trim() || !dealId) return
    // Unique-enough seed; the helper stays pure so it can't generate one itself.
    const seed = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    void onAdd(dealId, rows => addCustomRow(rows, label, seed))
    setLabel(''); setDealId(''); setOpen(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 hover:text-indigo-900"
      >
        <Plus className="w-3.5 h-3.5" /> Add something that isn&apos;t on the list
      </button>
    )
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[200px]">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Action</label>
        <input
          autoFocus value={label} onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false) }}
          placeholder="e.g. Order supps"
          className="w-full border border-slate-200 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>
      <div className="min-w-[180px]">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">On which file</label>
        <select
          value={dealId} onChange={e => setDealId(e.target.value)}
          className="w-full border border-slate-200 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="">Choose…</option>
          {deals.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <button onClick={submit} disabled={!label.trim() || !dealId}
        className="px-4 py-1.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
        Add
      </button>
      <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
        Cancel
      </button>
      <p className="w-full text-[11px] text-slate-400">
        Adds one row to that loan&apos;s checklist. Use the same wording on other files and they group together here.
      </p>
    </div>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────

function TabChip({ label, count, active, onClick, warn }: {
  label: string; count: number; active: boolean; onClick: () => void; warn?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
        active ? 'bg-indigo-50 text-indigo-800 border-indigo-200' : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
      }`}
    >
      {label}
      <span className="tabular-nums text-[11px] text-slate-400">{count}</span>
      {warn != null && (
        <span className="flex items-center gap-0.5 text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded px-1">
          <Clock className="w-2.5 h-2.5" />{warn}
        </span>
      )}
    </button>
  )
}
