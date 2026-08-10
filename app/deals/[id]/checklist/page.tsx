'use client'

// ── Processor Checklist ─────────────────────────────────────────────────────
// "What's already been done on this file, and where are we at."
//
// Reached from the button on the deal page, which only renders for deals in
// the 'Loans in Process' pipeline. This page does NOT hard-gate on that: a
// funded loan keeps its checklist (visiting the URL still works, with a
// banner) so nothing recorded ever disappears — the button going away is what
// takes it out of the daily workflow.

import { useEffect, useState, useCallback, use, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Deal } from '@/lib/types'
import {
  ChecklistRow, mergeChecklist, toState, checklistProgress,
  toggleItem, setNote, phasesPresent, currentPhase,
} from '@/lib/processorChecklist'
import {
  ArrowLeft, ClipboardList, Loader2, MessageSquarePlus, CheckCircle2, AlertCircle,
} from 'lucide-react'

/** "brianne@…" → "Brianne". Falls back to the raw string when it isn't an email. */
function displayName(email: string | null): string | null {
  if (!email) return null
  const local = email.split('@')[0]
  if (!local) return email
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

function stamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// `?from=processing` — set by the Checklist button on the Processing Desk so the
// back link returns to the desk instead of dumping you on the deal page. The
// desk is a work queue: you open a file, tick, and go back for the next one.
// Any other value (or none) keeps the original "back to the deal" behaviour.
function ChecklistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const fromProcessing = useSearchParams().get('from') === 'processing'

  const [deal, setDeal] = useState<Deal | null>(null)
  const [rows, setRows] = useState<ChecklistRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [me, setMe] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState<string | null>(null)

  // Who's ticking. Supabase Auth is the only identity the app has — there is no
  // email→team-member table, so the local-part is prettified for display and
  // the full email is what gets stored.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.email ?? null))
  }, [])

  useEffect(() => {
    supabase.from('deals').select('*').eq('id', id).single().then(({ data }) => {
      if (data) {
        const d = data as Deal
        setDeal(d)
        // loan_purpose gates the refi-only steps (see applicableTemplate).
        setRows(mergeChecklist(d.processor_checklist, undefined, d.loan_purpose))
      }
      setLoading(false)
    })
  }, [id])

  // ⚠️ An RLS-blocked client write returns NO error and 0 rows (see the
  //    reply-inbox gotcha). `.select()` is what makes a silent refusal visible —
  //    without it this page would show every tick as saved and lose them all.
  const persist = useCallback(async (next: ChecklistRow[]) => {
    setSaveError(null)
    const { data, error } = await supabase
      .from('deals')
      .update({ processor_checklist: toState(next) })
      .eq('id', id)
      .select('id')

    if (error) { setSaveError(error.message); return }
    if (!data || data.length === 0) {
      setSaveError('Not saved — the update was refused (row-level security or a missing column). Nothing was written.')
      return
    }
    setSavedAt(Date.now())
  }, [id])

  function onToggle(itemId: string) {
    const next = toggleItem(rows, itemId, me, new Date().toISOString())
    setRows(next)
    void persist(next)
  }

  function onNoteCommit(itemId: string, value: string) {
    const next = setNote(rows, itemId, value)
    setRows(next)
    void persist(next)
  }

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading checklist…
        </div>
      </div>
    )
  }

  if (!deal) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <p className="text-slate-700 font-medium">Deal not found.</p>
        <Link href="/deals" className="text-blue-600 hover:underline text-sm mt-2 block">← Back to deals</Link>
      </div>
    )
  }

  const progress = checklistProgress(rows)
  const phase = currentPhase(rows)
  const funded = deal.pipeline_group !== 'Loans in Process'

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        href={fromProcessing ? '/processing' : `/deals/${id}`}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {fromProcessing ? 'Back to Processing Desk' : `Back to ${deal.name || 'deal'}`}
      </Link>

      {/* ── Header + progress ─────────────────────────────────────────── */}
      <div className="bg-slate-900 rounded-2xl shadow-sm overflow-hidden mb-5">
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <ClipboardList className="w-4 h-4 text-blue-300" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-300">Processor Checklist</span>
          </div>
          <h1 className="text-2xl font-bold text-white capitalize">{deal.name || 'Untitled'}</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {deal.status || '—'}
            {deal.processor_status ? <> · <span className="text-slate-300">{deal.processor_status}</span></> : null}
            {phase ? <> · currently in <span className="text-slate-200 font-medium">{phase}</span></> : null}
          </p>
        </div>

        <div className="border-t border-slate-700/70 px-5 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-300">
              {progress.done} of {progress.total} complete
            </span>
            <span className="text-xs font-bold text-white">{progress.pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-700/70 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      </div>

      {funded && (
        <div className="mb-4 flex items-start gap-2 bg-slate-100 border border-slate-200 text-slate-600 text-sm px-4 py-3 rounded-lg">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
          <span>
            This loan is no longer in processing (<strong>{deal.pipeline_group || '—'}</strong>), so the
            checklist button is hidden on the deal page. It&apos;s kept here for reference and is still editable.
          </span>
        </div>
      )}

      {saveError && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {/* ── The list, grouped by phase ────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-200">
        {phasesPresent(rows).map(ph => {
          const items = rows.filter(r => r.phase === ph)
          const doneInPhase = items.filter(i => i.done_at).length
          return (
            <div key={ph}>
              <div className="px-5 py-2.5 bg-slate-50 flex items-center justify-between">
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  {ph === 'Retired' ? 'Retired items' : ph}
                </h2>
                <span className="text-[11px] font-medium text-slate-400">{doneInPhase}/{items.length}</span>
              </div>

              {ph === 'Retired' && (
                <p className="px-5 py-2 text-xs text-slate-500 bg-amber-50 border-y border-amber-100">
                  These were removed from the checklist template but already had work recorded, so they&apos;re
                  kept rather than erased. They don&apos;t count toward progress.
                </p>
              )}

              <ul>
                {items.map(item => {
                  const by = displayName(item.done_by)
                  return (
                    <li key={item.id} className="px-5 py-3 hover:bg-slate-50/70 transition-colors">
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={item.done_at !== null}
                          onChange={() => onToggle(item.id)}
                          className="mt-0.5 w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-2 focus:ring-emerald-500 cursor-pointer shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className={`text-sm ${item.done_at ? 'text-slate-400 line-through' : 'text-slate-800 font-medium'}`}>
                              {item.label}
                            </span>
                            {item.done_at && (
                              <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 font-medium">
                                {by ? `${by} · ` : ''}{stamp(item.done_at)}
                              </span>
                            )}
                          </div>
                          {item.hint && !item.done_at && (
                            <p className="text-[11px] text-slate-400 mt-0.5">{item.hint}</p>
                          )}

                          {(item.note !== null || noteOpen === item.id) ? (
                            <textarea
                              defaultValue={item.note ?? ''}
                              autoFocus={noteOpen === item.id && item.note === null}
                              onBlur={e => { onNoteCommit(item.id, e.target.value); setNoteOpen(null) }}
                              placeholder="Note…"
                              rows={2}
                              className="mt-2 w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-700 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                            />
                          ) : (
                            <button
                              onClick={() => setNoteOpen(item.id)}
                              className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-blue-600 transition-colors"
                            >
                              <MessageSquarePlus className="w-3 h-3" /> Add note
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>

      <p className="text-[11px] text-slate-400 mt-3 text-center">
        {savedAt ? 'Saved automatically.' : 'Changes save automatically.'}
      </p>
    </div>
  )
}

// useSearchParams needs a Suspense boundary in the App Router — without it the
// whole route opts into client-side rendering and `next build` fails.
export default function ProcessorChecklistPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full py-20">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    }>
      <ChecklistPage {...props} />
    </Suspense>
  )
}
