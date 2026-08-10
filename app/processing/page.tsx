'use client'

// ── Processing Desk ─────────────────────────────────────────────────────────
// Every active escrow assigned to one processor, in one screen, with the task
// hand-off built in. Built 2026-08-10 for Hanh (Efrain: "a page for Hanh,
// Brianne and me to look at all the active escrows Hanh is assigned to; Hanh
// should be able to create tasks and assign them to me or Brianne").
//
// Scope rule — the whole page is these two conditions ANDed:
//     pipeline_group = 'Loans in Process'   AND   processor_status = <processor>
// `processor_status` is the field already surfaced on the escrow card and in
// Pipeline; it is the assignment of record. The legacy `processor` column is
// read as a FALLBACK only (they agree on every populated row today, but a blank
// processor_status with a populated processor would otherwise vanish here).
//
// Who sees what:
//   - admin (Efrain, Brianne, Moe, Matt — any account with no `role` in
//     app_metadata) can switch the processor selector to anyone in PROCESSORS.
//   - a `processor` account is PINNED to their own display_name and the
//     selector renders as a static label. See lib/roles.ts.
//
// Tasks are the shared `deal_tasks` rows — the exact same table /tasks renders.
// A task raised here shows up in the assignee's column on the board, and vice
// versa. No second task system.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { pushStageToGHL } from '@/lib/pushStage'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { mergeChecklist, checklistProgress } from '@/lib/processorChecklist'
import type { ChecklistState } from '@/lib/processorChecklist'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import { formatCurrency } from '@/lib/utils'
import {
  Deal, DealTask, PROCESSORS, PIPELINE_STATUSES, STATUS_COLORS,
  STAGE_SLA_DAYS, WAITING_ON_OPTIONS,
} from '@/lib/types'
// The scope rule and its counters live in lib/ so scripts/processor-desk-check.ts
// can assert them against real rows — this page renders empty under the local
// auth-bypass server, so the UI can't be where that logic is verified.
import {
  deskDeals, deskKpis, openTasksByDeal, sortDesk, pastSla,
  daysUntil, daysSince, ESCROW_PIPELINE, DEFAULT_PROCESSOR,
} from '@/lib/processorDesk'
import DealTasks from '@/components/DealTasks'
import EscrowTracker from '@/components/EscrowTracker'
import {
  UserCog, ChevronRight, ChevronDown, ExternalLink, AlertTriangle, Lock,
  ClipboardList, CalendarClock, LayoutGrid, List as ListIcon, RefreshCw,
  CheckCircle2, Flame,
} from 'lucide-react'

const ESCROW_STAGES = PIPELINE_STATUSES[ESCROW_PIPELINE]

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtDue(iso: string | null | undefined): { label: string; tone: 'red' | 'violet' | 'slate' } {
  if (!iso) return { label: 'No due date', tone: 'slate' }
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { label: 'No due date', tone: 'slate' }
  const days = daysUntil(iso)
  if (d < new Date()) return { label: `Overdue · ${fmtDate(iso)}`, tone: 'red' }
  if (days === 0) return { label: 'Today', tone: 'violet' }
  return { label: fmtDate(iso), tone: 'slate' }
}

export default function ProcessingPage() {
  const me = useCurrentUser()
  const [deals, setDeals] = useState<Deal[]>([])
  const [tasks, setTasks] = useState<DealTask[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'cards'>('list')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [stageFilter, setStageFilter] = useState<string>('All')

  // A processor account is PINNED to its own desk — no switching to someone
  // else's files. Admins keep the selector.
  //
  // Derived, not an effect: `useCurrentUser` resolves a tick after mount, and
  // pinning via useEffect would both cascade a render and leave a frame where a
  // processor sees the default desk. The pin wins unconditionally, so a
  // processor can't land on someone else's files even for that frame.
  const pinned = me.loaded && me.role === 'processor'
  const [picked, setPicked] = useState<string | null>(null)
  const processor = pinned ? (me.name ?? DEFAULT_PROCESSOR) : (picked ?? DEFAULT_PROCESSOR)

  const refresh = useCallback(async () => {
    setLoading(true)
    // Only `deal_tasks` here — the GHL mirror is fetched per-deal by DealTasks
    // when a row is expanded. The header counts are deliberately about OUR
    // tasks (the ones this desk creates and hands off), not GHL follow-ups.
    const [all, tasksRes] = await Promise.all([
      fetchAllDeals(q => q.eq('pipeline_group', 'Loans in Process')),
      supabase.from('deal_tasks').select('*'),
    ])
    setDeals(all)
    setTasks((tasksRes.data as DealTask[]) || [])
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // ── The desk ──────────────────────────────────────────────────────────────
  const mine = useMemo(() => deskDeals(deals, processor), [deals, processor])

  const shown = useMemo(() => {
    const list = stageFilter === 'All' ? mine : mine.filter(d => d.status === stageFilter)
    return sortDesk(list)
  }, [mine, stageFilter])

  const openByDeal = useMemo(() => openTasksByDeal(tasks), [tasks])
  const kpis = useMemo(() => deskKpis(mine, openByDeal), [mine, openByDeal])

  const stagesPresent = useMemo(() => {
    const present = new Set(mine.map(d => d.status))
    return ESCROW_STAGES.filter(s => present.has(s))
  }, [mine])

  async function patchDeal(id: string, patch: Record<string, unknown>) {
    setDeals(prev => prev.map(d => (d.id === id ? ({ ...d, ...patch } as Deal) : d)))
    const { error } = await supabase.from('deals').update(patch).eq('id', id)
    if (error) { console.error('[processing] update failed', error); refresh(); return }
    // Same bidirectional rule the other escrow surfaces follow — a stage change
    // here has to reach GHL or the next sync pass overwrites it back.
    if (typeof patch.status === 'string') void pushStageToGHL(id, patch.status)
  }

  function toggleRow(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="p-6 space-y-4">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-cyan-100 flex items-center justify-center shrink-0">
            <UserCog className="w-5 h-5 text-cyan-700" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 leading-tight">Processing Desk</h1>
            <p className="text-xs text-slate-500">
              Active escrows assigned to{' '}
              {pinned ? (
                <span className="font-semibold text-slate-700">{processor}</span>
              ) : (
                <select
                  value={processor}
                  onChange={e => { setPicked(e.target.value); setStageFilter('All'); setExpanded(new Set()) }}
                  className="font-semibold text-slate-700 bg-transparent border-b border-dashed border-slate-300 hover:border-slate-500 focus:outline-none cursor-pointer"
                >
                  {PROCESSORS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${view === 'list' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <ListIcon className="w-3.5 h-3.5" /> Desk
            </button>
            <button
              onClick={() => setView('cards')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${view === 'cards' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" /> Board
            </button>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* ── KPIs ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Active files" value={kpis.files} icon={<ClipboardList className="w-4 h-4 text-cyan-600" />} />
        <Kpi label="Open tasks" value={kpis.openTasks} icon={<CheckCircle2 className="w-4 h-4 text-blue-600" />} />
        <Kpi label="Overdue tasks" value={kpis.overdueTasks} icon={<AlertTriangle className="w-4 h-4 text-red-500" />} tone={kpis.overdueTasks > 0 ? 'red' : undefined} />
        <Kpi label="No open task" value={kpis.noTask} icon={<Circleish />} tone={kpis.noTask > 0 ? 'amber' : undefined} />
        <Kpi label="Lock ≤ 7 days" value={kpis.lockSoon} icon={<Lock className="w-4 h-4 text-amber-600" />} tone={kpis.lockSoon > 0 ? 'amber' : undefined} />
        <Kpi label="Past stage SLA" value={kpis.overSla} icon={<CalendarClock className="w-4 h-4 text-orange-600" />} tone={kpis.overSla > 0 ? 'amber' : undefined} />
      </div>

      {/* ── Stage filter ──────────────────────────────────────────────────── */}
      {stagesPresent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <StageChip label="All" count={mine.length} active={stageFilter === 'All'} onClick={() => setStageFilter('All')} />
          {stagesPresent.map(s => (
            <StageChip
              key={s}
              label={s}
              count={mine.filter(d => d.status === s).length}
              active={stageFilter === s}
              onClick={() => setStageFilter(s)}
            />
          ))}
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-600" />
        </div>
      ) : mine.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <UserCog className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">No active escrows for {processor}</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            A file lands here once its <strong>Processor</strong> is set to {processor}{' '}
            and it&apos;s in the Loans in Process pipeline. Set that on the deal page or in Pipeline.
          </p>
        </div>
      ) : view === 'cards' ? (
        // The shared kanban, scoped to this desk. Reused rather than rebuilt so
        // the card and its inline edits can never drift from /deals.
        <div className="-mx-6">
          <EscrowTracker deals={shown} onUpdate={patchDeal} currentUser={me.name} />
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
          {shown.map(deal => {
            const open = expanded.has(deal.id)
            const openTasks = openByDeal.get(deal.id) ?? []
            const overdue = openTasks.filter(t => t.due_at && new Date(t.due_at) < new Date())
            const lock = daysUntil(deal.lock_expiration)
            const sla = STAGE_SLA_DAYS[deal.status]
            const inStage = daysSince(deal.stage_changed_at) ?? daysSince(deal.created_at)
            const overSla = pastSla(deal)
            const chk = checklistProgress(
              mergeChecklist(deal.processor_checklist as ChecklistState[] | null, undefined, deal.loan_purpose)
            )
            const due = fmtDue(deal.next_action_due)

            return (
              <div key={deal.id} className={open ? 'bg-slate-50/60' : ''}>
                {/* ── Row ──────────────────────────────────────────────── */}
                <div className="flex items-start gap-3 px-4 py-3">
                  <button
                    onClick={() => toggleRow(deal.id)}
                    className="mt-0.5 text-slate-400 hover:text-slate-700 shrink-0"
                    aria-label={open ? 'Collapse' : 'Expand'}
                  >
                    {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/deals/${deal.id}`} className="font-semibold text-slate-900 text-sm hover:text-blue-600 truncate">
                        {deal.name}
                      </Link>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[deal.status] || 'bg-slate-100 text-slate-600'}`}>
                        {deal.status}
                      </span>
                      {deal.escrow_priority === 'high' && (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded">
                          <Flame className="w-3 h-3" /> High
                        </span>
                      )}
                      {overSla && (
                        <span className="text-[10px] font-semibold text-orange-700 bg-orange-50 border border-orange-100 px-1.5 py-0.5 rounded">
                          {inStage}d in stage · SLA {sla}d
                        </span>
                      )}
                      {lock != null && lock <= 7 && (
                        <span className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${lock < 0 ? 'text-red-700 bg-red-50 border-red-100' : 'text-amber-700 bg-amber-50 border-amber-100'}`}>
                          <Lock className="w-3 h-3" />
                          {lock < 0 ? `Lock expired ${-lock}d ago` : `Lock ${lock}d`}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-slate-500">
                      <span>{deal.loan_officer || 'No LO'}</span>
                      {deal.loan_amount != null && <span className="tabular-nums">{formatCurrency(deal.loan_amount)}</span>}
                      {deal.loan_type && <span>{deal.loan_type}</span>}
                      {deal.investor && <span className="truncate max-w-[160px]">{deal.investor}</span>}
                      {/* Checklist progress used to sit here as dead text. It's
                          now the clickable pill in the row actions — one place,
                          and that one place goes somewhere. */}
                      {deal.waiting_on && deal.waiting_on !== 'No one' && (
                        <span className="text-amber-700">Waiting on {deal.waiting_on}</span>
                      )}
                    </div>

                    {deal.next_action && (
                      <p className="mt-1 text-xs text-slate-700 truncate">
                        <span className="text-slate-400">Next:</span> {deal.next_action}{' '}
                        <span className={due.tone === 'red' ? 'text-red-600 font-medium' : due.tone === 'violet' ? 'text-violet-600 font-medium' : 'text-slate-400'}>
                          · {due.label}
                        </span>
                        {deal.next_action_assignee && <span className="text-slate-400"> · {deal.next_action_assignee}</span>}
                      </p>
                    )}
                  </div>

                  {/* Row actions — the two things a processor does from here.
                      Both live on the COLLAPSED row on purpose (Efrain
                      2026-08-10): the checklist is the daily work, and burying
                      it behind an expand made it a three-click job. */}
                  <div className="flex items-center gap-2 shrink-0">
                    {overdue.length > 0 && (
                      <span className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5 tabular-nums">
                        {overdue.length} overdue
                      </span>
                    )}
                    {/* Straight to THIS loan's processor checklist. */}
                    <Link
                      href={`/deals/${deal.id}/checklist?from=processing`}
                      title={`Open the processor checklist for ${deal.name} — ${chk.done} of ${chk.total} complete`}
                      className={`flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5 tabular-nums border transition ${
                        chk.total > 0 && chk.done === chk.total
                          ? 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                          : chk.done > 0
                          ? 'text-cyan-700 bg-cyan-50 border-cyan-200 hover:bg-cyan-100'
                          : 'text-slate-500 bg-slate-50 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <ClipboardList className="w-3 h-3" />
                      Checklist {chk.done}/{chk.total}
                    </Link>
                    <button
                      onClick={() => toggleRow(deal.id)}
                      className={`text-[10px] font-semibold rounded-full px-2 py-0.5 tabular-nums border transition ${
                        openTasks.length > 0
                          ? 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100'
                          : 'text-slate-500 bg-slate-50 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {openTasks.length > 0 ? `${openTasks.length} task${openTasks.length === 1 ? '' : 's'}` : '+ task'}
                    </button>
                  </div>
                </div>

                {/* ── Expanded ─────────────────────────────────────────── */}
                {open && (
                  <div className="px-4 pb-4 pl-11 space-y-3">
                    {/* Quick edits — the fields a processor actually moves during
                        the day. Everything else lives on the deal page. */}
                    <div className="flex flex-wrap items-end gap-3 bg-white border border-slate-200 rounded-lg p-3">
                      <Field label="Stage">
                        <select
                          value={deal.status}
                          onChange={e => patchDeal(deal.id, { status: e.target.value })}
                          className="border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        >
                          {ESCROW_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </Field>
                      <Field label="Waiting on">
                        <select
                          value={deal.waiting_on || ''}
                          onChange={e => patchDeal(deal.id, { waiting_on: e.target.value || null })}
                          className="border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        >
                          <option value="">—</option>
                          {WAITING_ON_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
                        </select>
                      </Field>
                      <Field label="Priority">
                        <select
                          value={deal.escrow_priority || 'normal'}
                          onChange={e => patchDeal(deal.id, { escrow_priority: e.target.value })}
                          className="border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        >
                          <option value="high">High</option>
                          <option value="normal">Normal</option>
                          <option value="low">Low</option>
                        </select>
                      </Field>
                      <Field label="Lock expires">
                        <input
                          type="date"
                          value={deal.lock_expiration ? deal.lock_expiration.slice(0, 10) : ''}
                          onChange={e => patchDeal(deal.id, { lock_expiration: e.target.value || null })}
                          className="border border-slate-200 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                      </Field>
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!deal.processor_handoff}
                          onChange={e => patchDeal(deal.id, { processor_handoff: e.target.checked })}
                          className="rounded border-slate-300"
                        />
                        Processor handoff
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!deal.subbed}
                          onChange={e => patchDeal(deal.id, { subbed: e.target.checked })}
                          className="rounded border-slate-300"
                        />
                        Subbed on teams
                      </label>

                      <div className="ml-auto flex items-center gap-2 text-[11px]">
                        <Link href={`/deals/${deal.id}/checklist?from=processing`} className="flex items-center gap-1 text-cyan-700 hover:text-cyan-900 font-medium">
                          <ClipboardList className="w-3.5 h-3.5" /> Checklist ({chk.pct}%)
                        </Link>
                        <Link href={`/deals/${deal.id}`} className="flex items-center gap-1 text-slate-600 hover:text-slate-900 font-medium">
                          Full file <ChevronRight className="w-3 h-3" />
                        </Link>
                        {deal.ghl_contact_id && (
                          <a
                            href={ghlContactUrl(deal) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-slate-500 hover:text-slate-800"
                          >
                            GHL <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {deal.arive_file_no && (
                          <a
                            href={ariveUrl(deal.arive_file_no) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-slate-500 hover:text-slate-800"
                          >
                            Arive <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Tasks — the shared component, so a task raised here is the
                        same `deal_tasks` row the /tasks board renders. It fetches
                        its own rows (including the GHL mirror for this contact),
                        so refresh the page counters when it changes. */}
                    <div className="bg-white border border-slate-200 rounded-lg p-3">
                      <DealTasks dealId={deal.id} title="Tasks on this file" />
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {shown.length === 0 && (
            <div className="p-10 text-center text-sm text-slate-500">
              No files in <strong>{stageFilter}</strong>.
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        Scope: <code className="text-slate-500">pipeline_group = &lsquo;Loans in Process&rsquo;</code> and{' '}
        <code className="text-slate-500">Processor = {processor}</code>. Tasks are the same ones on the{' '}
        <Link href="/tasks" className="text-blue-600 hover:underline">task board</Link>.
      </p>
    </div>
  )
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Kpi({ label, value, icon, tone }: {
  label: string; value: number; icon: React.ReactNode; tone?: 'red' | 'amber'
}) {
  const ring = tone === 'red' ? 'ring-1 ring-red-200' : tone === 'amber' ? 'ring-1 ring-amber-200' : ''
  return (
    <div className={`bg-white border border-slate-200 rounded-xl px-4 py-3 ${ring}`}>
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-[11px] font-medium text-slate-500">{label}</p>
      </div>
      <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">{value}</p>
    </div>
  )
}

function StageChip({ label, count, active, onClick }: {
  label: string; count: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition ${
        active
          ? 'bg-cyan-50 text-cyan-800 border-cyan-200'
          : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800 hover:border-slate-300'
      }`}
    >
      {label}
      <span className="ml-1.5 text-[10px] tabular-nums text-slate-400">{count}</span>
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  )
}

/** Hollow marker for the "no open task" KPI — deliberately not a checkmark. */
function Circleish() {
  return <span className="w-4 h-4 rounded-full border-2 border-amber-500 inline-block" />
}
