'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, DealTask, LOAN_OFFICERS, STATUS_COLORS, STATUS_STRONG, LOAN_TYPE_COLORS } from '@/lib/types'
import { resolveLO } from '@/lib/loanOfficer'
import { endOfDay, isDueNow, relativeDue, DUE_TONE_TEXT, DUE_TONE_BAR } from '@/components/TaskBoard'
import { toBoardTask, isGhlTask, byDueAsc, type BoardTask, type GhlTaskRow } from '@/lib/ghlTasks'
import { formatCurrency, formatDate } from '@/lib/utils'
import { unlockedEscrows, lockCounts } from '@/lib/lockStatus'
import UnreadInbox from '@/components/UnreadInbox'
import {
  DollarSign, TrendingUp, Users, CheckCircle, Clock, AlertCircle, ChevronRight,
  Flame, ListChecks, Wallet, Layers, BarChart3, Tag, CalendarClock, Lock,
} from 'lucide-react'
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell, LabelList } from 'recharts'
import Link from 'next/link'
import { LoFilter, LO_COLORS, DEFAULT_LOS } from '@/components/LoFilter'

// (Date filter removed — the dashboard is a snapshot of what's currently in escrow.)

// ── The card system ──────────────────────────────────────────────────────────
// Every section uses the same card, header row, pill and link so the page reads
// as one system. Color is reserved for meaning: blue = action / today, red =
// overdue, stage colors = STATUS_COLORS, LO colors = LO identity, orange = Next Step.
const CARD = 'overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs'

const PILL = {
  slate: 'bg-slate-100 text-slate-600',
  crit:  'bg-red-50 text-red-600',
  warn:  'bg-amber-50 text-amber-700',
  acc:   'bg-blue-100 text-blue-700',
  good:  'bg-green-50 text-green-700',
} as const

function Pill({ tone = 'slate', children }: { tone?: keyof typeof PILL; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold ${PILL[tone]}`}>
      {children}
    </span>
  )
}

function CardHeader({ badge, icon, title, meta, action }: {
  badge: string; icon: React.ReactNode; title: string; meta?: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-100 px-[18px] py-2.5">
      <span className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] ${badge}`}>{icon}</span>
      <h2 className="text-[13.5px] font-semibold text-slate-900">{title}</h2>
      {meta && <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">{meta}</div>}
      {action && <div className="ml-auto flex items-center gap-3">{action}</div>}
    </div>
  )
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-xs font-medium text-blue-700 hover:underline">
      {children} <ChevronRight className="h-3 w-3" />
    </Link>
  )
}

/** Identity dot for a loan officer; renders nothing for names that aren't LOs. */
function LoDot({ name, size = 8 }: { name?: string | null; size?: number }) {
  const lo = resolveLO(name)
  const color = lo ? LO_COLORS[lo] : undefined
  if (!color) return null
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, backgroundColor: color }} aria-hidden />
}

/** A KPI cell of the stat strip — tinted icon badge, figure, one-line sub. */
function StatTile({ label, value, sub, subClass = 'text-slate-500', icon, badge }: {
  label: string; value: string; sub: string; subClass?: string; icon: React.ReactNode; badge: string
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-slate-100 px-[22px] py-[18px] md:border-l md:border-t-0">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] ${badge}`}>{icon}</span>
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      </div>
      <p className="mt-1 text-[22px] font-semibold leading-none tracking-tight text-slate-900">{value}</p>
      <p className={`text-xs ${subClass}`}>{sub}</p>
    </div>
  )
}

type StageDatum = { stage: string; short: string; count: number; loanVolume: number }

function StageTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: StageDatum }> }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{d.stage}</p>
      <p className="text-slate-500">{d.count} escrow{d.count !== 1 ? 's' : ''} · {formatCurrency(d.loanVolume)}</p>
    </div>
  )
}

// Row anatomy shared by the Today and Tasks widgets: stripe · when · what · who.
const ROW = 'group grid grid-cols-[3px_92px_1fr_auto] items-center gap-3.5 py-2 pr-[18px] transition'

// ── Main Dashboard ────────────────────────────────────────────────────────────
// Compact "time since" for the latest next-step log entry.
function relAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (isNaN(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), d = Math.floor(ms / 86400000)
  if (d >= 1) return d === 1 ? 'yesterday' : `${d}d ago`
  if (h >= 1) return `${h}h ago`
  return m >= 1 ? `${m}m ago` : 'just now'
}

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  // Which loan officers' escrows count toward the metrics below. All checked =
  // everyone (the default, unfiltered view). Toggled by the header checkboxes.
  const [selectedLOs, setSelectedLOs] = useState<string[]>([...DEFAULT_LOS])
  const toggleLO = (lo: string) =>
    setSelectedLOs(prev => prev.includes(lo) ? prev.filter(x => x !== lo) : [...prev, lo])

  // Open tasks from BOTH sources — ours (deal_tasks) and the GHL mirror — for
  // the "due through today" widget below. Deliberately NOT filtered by the LO
  // checkboxes: tasks belong to whoever they're assigned to, and half of them
  // are Efrain's and Brianne's, who aren't loan officers at all.
  const [boardTasks, setBoardTasks] = useState<BoardTask[]>([])


  useEffect(() => {
    async function fetchDeals() {
      // Paginate past PostgREST's 1 000-row default cap — the table has >1 000
      // deals, and a bare select('*') silently dropped the oldest ones, so older
      // escrows were missing from every dashboard metric (e.g. the "Escrows by
      // Stage" chart undercounted Docs Signed). Select only the columns the
      // dashboard reads (never raw_ghl_data) to keep egress minimal.
      const DASHBOARD_COLS =
        'id,name,status,pipeline_group,loan_amount,loan_officer,loan_type,' +
        'created_at,funded_date,next_action,next_action_assignee,next_action_due,' +
        'next_action_log,locked,lock_expiration'
      const data = await fetchAllDeals(
        q => q.order('created_at', { ascending: false }),
        DASHBOARD_COLS,
      )
      setDeals(data)
      setLoadedAt(new Date())
      setLoading(false)
    }
    fetchDeals()
  }, [])

  useEffect(() => {
    async function fetchTasks() {
      const [dt, gt] = await Promise.all([
        supabase.from('deal_tasks').select('*').is('completed_at', null),
        supabase.from('ghl_tasks').select('*'),   // mirror holds OPEN tasks only
      ])
      setBoardTasks([
        ...((dt.data as DealTask[]) ?? []),
        ...((gt.data as GhlTaskRow[]) ?? []).map(toBoardTask),
      ])
    }
    fetchTasks()
  }, [])


  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  // The dashboard is a snapshot of what's CURRENTLY in escrow — the Loans-in-Process
  // pipeline. Leads, Funded, and Not Ready deals are excluded from every KPI, chart,
  // and list below. (No date range — active escrows are a present-state view.)
  // LO filter — the header checkboxes narrow every metric on this page to the
  // selected loan officers. All-selected (the default) passes everyone through,
  // including deals with no LO assigned, so the unfiltered view is unchanged.
  const allLOsSelected = selectedLOs.length === LOAN_OFFICERS.length
  const dealMatchesLO = (d: Deal) => {
    if (allLOsSelected) return true
    const lo = resolveLO(d.loan_officer)
    return lo != null && selectedLOs.includes(lo)
  }

  const escrowDeals = deals.filter(d => d.pipeline_group === 'Loans in Process' && dealMatchesLO(d))

  const totalPipelineLoanVol = escrowDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
  const sizedDeals = escrowDeals.filter(d => d.loan_amount)
  const avgDealSize = sizedDeals.length > 0
    ? sizedDeals.reduce((s, d) => s + (d.loan_amount || 0), 0) / sizedDeals.length
    : 0

  // "Funding soon" = escrows that are right next to the finish line
  const fundingSoon = escrowDeals.filter(d => ['Clear to Close', 'Docs Out', 'Docs Signed'].includes(d.status || ''))
  const fundingSoonVolume = fundingSoon.reduce((s, d) => s + (d.loan_amount || 0), 0)

  // Stage chart: the 8 sub-stages within Loans in Process (the actual escrow flow)
  const ESCROW_STAGES = [
    'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
    'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
  ] as const
  const STAGE_SHORT: Record<string, string> = {
    'Loan Setup': 'Setup', 'Disclosed': 'Disclosed', 'Submitted to UW': 'UW',
    'Approved w/ Conditions': 'Cond.', 'Re-Submittal': 'Re-Sub',
    'Clear to Close': 'CTC', 'Docs Out': 'Docs Out', 'Docs Signed': 'Signed',
  }
  const stageData: StageDatum[] = ESCROW_STAGES.map(stage => {
    const d = escrowDeals.filter(x => x.status === stage)
    return { stage, short: STAGE_SHORT[stage] || stage, count: d.length, loanVolume: d.reduce((s, x) => s + (x.loan_amount || 0), 0) }
  })
  // The stage-mix strip under the hero figure: only stages that hold an escrow.
  const stageMix = stageData.filter(s => s.count > 0)

  // LO Performance: scoped to escrow deals, and to the LOs currently checked in
  // the header filter (canonical order). resolveLO normalizes any loan_officer
  // spelling to the same names the checkboxes use.
  const loData = LOAN_OFFICERS.filter(lo => selectedLOs.includes(lo)).map(lo => {
    const loDeals = escrowDeals.filter(d => resolveLO(d.loan_officer) === lo)
    return { name: lo, loanVolume: loDeals.reduce((s, d) => s + (d.loan_amount || 0), 0), deals: loDeals.length }
  })
  const loRows = [...loData].sort((a, b) => b.loanVolume - a.loanVolume)
  const loMax = loRows.reduce((m, l) => Math.max(m, l.loanVolume), 0)

  // Loan Types: from escrows only
  const loanTypeMap: Record<string, number> = {}
  escrowDeals.forEach(d => { if (d.loan_type) loanTypeMap[d.loan_type] = (loanTypeMap[d.loan_type] || 0) + 1 })
  const loanTypeData = Object.entries(loanTypeMap).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => ({ name, value }))
  const typedCount = escrowDeals.filter(d => d.loan_type).length

  // ── Rate locks ──────────────────────────────────────────────────────────────
  // Which active escrows have NO live rate protection. The rule lives in
  // lib/lockStatus.ts (fixture-locked) because `lock_expiration` decides and the
  // hand-set `locked` flag does not — measured 2026-09-16, 25 of the 32 active
  // escrows carried a real Arive expiry and ZERO carried locked = 'Yes'.
  // escrowDeals is already both pipeline- and LO-filtered; unlockedEscrows
  // re-checks the pipeline so funded rows can never leak in (the
  // clear_lock_expiration_on_funded trigger makes every funded loan look unlocked).
  const stageDepth = (status: string | null) => {
    const i = ESCROW_STAGES.indexOf((status || '') as typeof ESCROW_STAGES[number])
    return i < 0 ? 0 : i + 1
  }
  const unlockedRows = unlockedEscrows(escrowDeals, stageDepth)
  const lockStats = lockCounts(escrowDeals)
  // The LO checkboxes default to Matt + Moe, so Randy's and Daniel's escrows are
  // hidden unless opted in. On every other metric that's fine; on a RISK list it
  // would be a blind spot, so count what the filter is hiding and say so.
  const hiddenUnlocked = allLOsSelected
    ? 0
    : unlockedEscrows(deals.filter(d => d.pipeline_group === 'Loans in Process'), stageDepth).length - unlockedRows.length

  // Needs attention + Recent deals: from escrows only
  const atRisk = escrowDeals.filter(d => !d.loan_officer || !d.loan_type || !d.loan_amount).slice(0, 5)
  const recentDeals = [...escrowDeals]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5)
  // ── Today widget: escrows with follow-ups due today or overdue ──────────────
  const now = new Date()
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
  // Same set as escrowDeals (Loans in Process, LO-filtered) — reused so the
  // Today widget and Next Steps stay in lockstep with the KPIs above.
  const escrowsInProcess = escrowDeals
  const todayItems = escrowsInProcess.filter(d => {
    if (!d.next_action_due) return false
    const due = new Date(d.next_action_due)
    return due <= endOfToday
  }).sort((a, b) =>
    new Date(a.next_action_due as string).getTime() - new Date(b.next_action_due as string).getTime()
  )
  const overdueItems = todayItems.filter(d => new Date(d.next_action_due as string) < now)
  const dueTodayItems = todayItems.filter(d => new Date(d.next_action_due as string) >= now && new Date(d.next_action_due as string) <= endOfToday)

  // ── Tasks widget: the same "Overdue & today" cut the board uses, across BOTH
  // sources, for everyone. Undated leads the list exactly like it does in the
  // board column — a task nobody has dated is the one most likely to be missed.
  const taskDueNow = boardTasks
    .filter(t => !t.completed_at && isDueNow(t, endOfDay().getTime()))
    .sort((a, b) => (a.due_at ? 1 : 0) - (b.due_at ? 1 : 0) || byDueAsc(a, b))
  const tasksOverdue = taskDueNow.filter(t => t.due_at && new Date(t.due_at) < now).length
  const tasksToday   = taskDueNow.filter(t => t.due_at && new Date(t.due_at) >= now).length
  const tasksUndated = taskDueNow.filter(t => !t.due_at).length

  // Next Steps section — every active escrow + its next action, soonest due first (no-due last).
  const nextStepRows = [...escrowsInProcess].sort((a, b) => {
    const ad = a.next_action_due ? new Date(a.next_action_due).getTime() : Infinity
    const bd = b.next_action_due ? new Date(b.next_action_due).getTime() : Infinity
    if (ad !== bd) return ad - bd
    return (a.name || '').localeCompare(b.name || '')
  })
  const noStepCount = escrowsInProcess.filter(d => !d.next_action).length
  const scheduledCount = escrowsInProcess.filter(d => d.next_action_due).length

  const selectedLoList = LOAN_OFFICERS.filter(lo => selectedLOs.includes(lo))


  return (
    <div className="mx-auto max-w-[1280px] space-y-[18px] p-7">
      {/* Header band — title, scope line and the LO filter on one line */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
            Active escrows · Loans in Process
            {!allLOsSelected && (
              <span className="text-slate-400">· {selectedLOs.length} of {LOAN_OFFICERS.length} LOs</span>
            )}
            {loadedAt && (
              <span className="font-mono text-[11px] text-slate-400">
                updated {loadedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>

        {/* Loan-officer filter — check the LOs whose escrows should count toward
            every metric on this page. All checked = everyone (the default). */}
        <LoFilter selected={selectedLOs} onToggle={toggleLO} label="Loan officers" />
      </div>

      {/* Stat strip — one card, four cells; the volume leads by size and color */}
      <section className={`${CARD} grid grid-cols-1 md:grid-cols-[1.55fr_1fr_1fr_1fr]`} aria-label="Key figures">
        <div className="bg-blue-700 px-6 py-5 text-white">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-blue-200">
            <TrendingUp className="h-3.5 w-3.5" /> Active escrow volume
          </div>
          <div className="mt-2 text-[34px] font-bold leading-none tracking-tight">{formatCurrency(totalPipelineLoanVol)}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-blue-100">
            {allLOsSelected ? (
              <span>All loan officers</span>
            ) : (
              <>
                {selectedLoList.map(lo => (
                  <span key={lo} className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-white/15 px-2 text-[11.5px] font-medium text-white">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: LO_COLORS[lo] }} />{lo}
                  </span>
                ))}
                <span>{selectedLOs.length} of {LOAN_OFFICERS.length} loan officers</span>
              </>
            )}
          </div>
          {stageMix.length > 0 && (
            <>
              {/* Stage mix — same colors as the stage pills everywhere else in the app */}
              <div
                className="mt-3 flex h-[7px] gap-0.5 rounded bg-white/10 p-px"
                title={stageMix.map(s => `${s.short} ${s.count}`).join(' · ')}
                aria-label="Escrows by stage"
              >
                {stageMix.map(s => (
                  <span key={s.stage} className="block rounded-sm" style={{ flex: s.count, backgroundColor: STATUS_STRONG[s.stage] }} />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10.5px] text-blue-200">
                <span>{stageMix[0].short}</span>
                <span>{stageMix[stageMix.length - 1].short}</span>
              </div>
            </>
          )}
        </div>

        <StatTile
          label="Funding soon"
          value={formatCurrency(fundingSoonVolume)}
          sub={`${fundingSoon.length} escrow${fundingSoon.length !== 1 ? 's' : ''} at CTC, Docs Out or Signed`}
          subClass="text-emerald-700"
          icon={<DollarSign className="h-4 w-4" />}
          badge="bg-emerald-100 text-emerald-700"
        />
        <StatTile
          label="Escrows in process"
          value={escrowDeals.length.toString()}
          sub={loData.filter(l => l.deals > 0).map(l => `${l.deals} ${l.name.split(' ')[0]}`).join(' · ') || 'loans in process'}
          icon={<Layers className="h-4 w-4" />}
          badge="bg-amber-100 text-amber-700"
        />
        <StatTile
          label="Avg loan size"
          value={formatCurrency(avgDealSize)}
          sub={`across ${sizedDeals.length} sized escrow${sizedDeals.length !== 1 ? 's' : ''}`}
          icon={<Wallet className="h-4 w-4" />}
          badge="bg-indigo-100 text-indigo-700"
        />
      </section>

      {/* Today widget — escrow follow-ups due today + overdue */}
      {(todayItems.length > 0) && (
        <section className={CARD}>
          <CardHeader
            badge="bg-orange-100 text-[#F37021]"
            icon={<CalendarClock className="h-3.5 w-3.5" />}
            title="Today's escrow follow-ups"
            meta={<>
              {overdueItems.length > 0 && <Pill tone="crit">{overdueItems.length} overdue</Pill>}
              {dueTodayItems.length > 0 && <Pill tone="acc">{dueTodayItems.length} due today</Pill>}
            </>}
            action={<CardLink href="/deals">Open Tracker</CardLink>}
          />
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {todayItems.slice(0, 12).map(d => {
              const due = new Date(d.next_action_due as string)
              const isOverdueRow = due < now
              const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              return (
                <Link key={d.id} href={`/deals/${d.id}`} className={`${ROW} hover:bg-slate-50`}>
                  <span className={`h-9 rounded-r-sm ${isOverdueRow ? 'bg-red-500' : 'bg-blue-500'}`} />
                  <div className="text-right">
                    <div className={`text-[11.5px] font-semibold ${isOverdueRow ? 'text-red-600' : 'text-blue-700'}`}>
                      {isOverdueRow ? 'Overdue' : time}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">{isOverdueRow ? `was ${time}` : 'today'}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-slate-900 group-hover:text-blue-700">{d.name}</div>
                    <div className="truncate text-[11.5px] text-slate-500">
                      {d.next_action || <span className="italic text-amber-700">No next step set</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-medium text-slate-700">{d.next_action_assignee || d.loan_officer || '—'}</div>
                    <div className="text-[10px] text-slate-400">{d.status}</div>
                  </div>
                </Link>
              )
            })}
            {todayItems.length > 12 && (
              <Link href="/deals" className="block py-2 text-center text-xs font-medium text-blue-700 hover:bg-slate-50">
                + {todayItems.length - 12} more in tracker →
              </Link>
            )}
          </div>
        </section>
      )}

      {/* Tasks widget — deal_tasks + mirrored GHL tasks, due through today */}
      {taskDueNow.length > 0 && (
        <section className={CARD}>
          <CardHeader
            badge="bg-emerald-100 text-emerald-700"
            icon={<ListChecks className="h-3.5 w-3.5" />}
            title="Tasks · overdue & today"
            meta={<>
              {tasksOverdue > 0 && <Pill tone="crit">{tasksOverdue} overdue</Pill>}
              {tasksToday > 0 && <Pill tone="acc">{tasksToday} due today</Pill>}
              {tasksUndated > 0 && <Pill>{tasksUndated} no date</Pill>}
            </>}
            action={<CardLink href="/tasks">Open Tasks</CardLink>}
          />
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {taskDueNow.slice(0, 12).map(t => {
              const due = relativeDue(t.due_at)
              const label = t.due_at ? due.label : 'No date'
              // GHL rows link to the matched deal when there is one; without a
              // deal there is nothing to open here, so the row stays a plain div.
              const inner = (
                <>
                  <span className={`h-9 rounded-r-sm ${DUE_TONE_BAR[due.tone]}`} />
                  <div className="text-right">
                    <div className={`text-[11.5px] ${DUE_TONE_TEXT[due.tone]}`}>{label}</div>
                    <div className="font-mono text-[10px] uppercase tracking-wide text-slate-400">{isGhlTask(t) ? 'GHL' : 'task'}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-slate-900 group-hover:text-blue-700">{t.title}</div>
                    <div className="truncate text-[11.5px] text-slate-500">
                      {t.contact_name || t.description || <span className="italic text-slate-400">No detail</span>}
                    </div>
                  </div>
                  <div className="text-right text-xs font-medium text-slate-700">
                    {t.assignee || <span className="text-slate-400">Unassigned</span>}
                  </div>
                </>
              )
              return t.deal_id ? (
                <Link key={t.id} href={`/deals/${t.deal_id}`} className={`${ROW} hover:bg-slate-50`}>{inner}</Link>
              ) : (
                <div key={t.id} className={ROW}>{inner}</div>
              )
            })}
            {taskDueNow.length > 12 && (
              <Link href="/tasks" className="block py-2 text-center text-xs font-medium text-blue-700 hover:bg-slate-50">
                + {taskDueNow.length - 12} more on the board →
              </Link>
            )}
          </div>
        </section>
      )}

      {/* Rate locks — active escrows with no live lock. Red = the lock already
          expired, amber = never locked. Green confirmation when everything is
          covered, so an empty card never reads as a broken one. */}
      <section className={CARD}>
        <CardHeader
          badge={lockStats.needsLock > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}
          icon={<Lock className="h-3.5 w-3.5" />}
          title="Loans without a rate lock"
          meta={<>
            {lockStats.expired > 0 && <Pill tone="crit">{lockStats.expired} expired</Pill>}
            {lockStats.unlocked > 0 && <Pill tone="warn">{lockStats.unlocked} never locked</Pill>}
            <span>{lockStats.locked} of {lockStats.total} escrow{lockStats.total !== 1 ? 's' : ''} locked</span>
            {lockStats.expiring > 0 && <Pill tone="acc">{lockStats.expiring} expiring ≤7d</Pill>}
          </>}
          action={<CardLink href="/deals">Open Tracker</CardLink>}
        />
        {lockStats.total === 0 ? (
          <p className="px-[18px] py-4 text-[12.5px] text-slate-400">No active escrows in the current view.</p>
        ) : unlockedRows.length === 0 ? (
          <div className="flex items-start gap-2.5 px-[18px] py-4 text-[12.5px] leading-relaxed text-slate-500">
            <CheckCircle className="mt-px h-[18px] w-[18px] shrink-0 text-green-700" />
            <div>
              <p className="font-semibold text-slate-700">
                Every active escrow is locked{!allLOsSelected && ' for the selected LOs'}
              </p>
              All {lockStats.total} loan{lockStats.total !== 1 ? 's' : ''} in process carry a live rate lock.
              {hiddenUnlocked > 0 && ` ${hiddenUnlocked} more under loan officers not selected above still need one.`}
            </div>
          </div>
        ) : (
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {unlockedRows.map(d => {
              const isExpired = d.lock.state === 'expired'
              return (
                <Link key={d.id} href={`/deals/${d.id}`} className={`${ROW} hover:bg-slate-50`}>
                  <span className={`h-9 rounded-r-sm ${isExpired ? 'bg-red-500' : 'bg-amber-500'}`} />
                  <div className="text-right">
                    <div className={`text-[11.5px] font-semibold ${isExpired ? 'text-red-600' : 'text-amber-700'}`}>
                      {isExpired ? `Expired ${-(d.lock.days as number)}d` : 'No lock'}
                    </div>
                    {d.lock.expiration && (
                      <div className="font-mono text-[10px] text-slate-400">{formatDate(d.lock.expiration)}</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-slate-900 group-hover:text-blue-700">{d.name}</div>
                    <div className="flex items-center gap-1.5 truncate text-[11.5px] text-slate-500">
                      <LoDot name={d.loan_officer} size={7} />{d.loan_officer || 'No LO'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[12.5px] font-semibold tabular-nums text-slate-900">{formatCurrency(d.loan_amount)}</div>
                    <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[d.status || ''] || 'bg-slate-100 text-slate-600'}`}>{d.status}</span>
                  </div>
                </Link>
              )
            })}
            {hiddenUnlocked > 0 && (
              <p className="px-[18px] py-2 text-[11.5px] text-slate-400">
                + {hiddenUnlocked} more under loan officers not selected above
              </p>
            )}
          </div>
        )}
      </section>

      {/* Charts row — stage bars (stage colors) + loan-type bars (type colors) */}
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-3">
        <section className={`${CARD} lg:col-span-2`}>
          <CardHeader
            badge="bg-blue-100 text-blue-700"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            title="Escrows by stage"
            meta={<span>{escrowDeals.length} escrow{escrowDeals.length !== 1 ? 's' : ''} · hover a bar for volume</span>}
          />
          <div className="px-[18px] pb-3 pt-3">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={stageData} margin={{ top: 22, right: 0, bottom: 0, left: 0 }}>
                <XAxis dataKey="short" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} interval={0} />
                <Tooltip cursor={{ fill: 'rgba(148,163,184,0.10)' }} content={<StageTooltip />} />
                <Bar dataKey="count" name="escrows" radius={[4, 4, 0, 0]} maxBarSize={28} minPointSize={2}>
                  <LabelList dataKey="count" position="top" style={{ fontSize: 12, fontWeight: 600, fill: '#334155' }} />
                  {stageData.map(s => (
                    <Cell key={s.stage} fill={s.count === 0 ? '#e2e8f0' : (STATUS_STRONG[s.stage] || '#94a3b8')} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* "Funding soon" bracket under the last three bands — the chart has no
                y-axis and zero side margins, so its 8 bands are 8 equal columns. */}
            <div className="mt-1 grid grid-cols-8">
              <div className="relative col-span-3 col-start-6 border-t border-emerald-700 pt-1 text-center text-[11px] font-medium text-emerald-700 before:absolute before:-top-px before:left-0 before:h-[5px] before:w-px before:bg-emerald-700 after:absolute after:-top-px after:right-0 after:h-[5px] after:w-px after:bg-emerald-700">
                Funding soon · {fundingSoon.length} · {formatCurrency(fundingSoonVolume)}
              </div>
            </div>
          </div>
        </section>

        <section className={CARD}>
          <CardHeader
            badge="bg-indigo-100 text-indigo-700"
            icon={<Tag className="h-3.5 w-3.5" />}
            title="Loan types"
            meta={<span>of {typedCount}</span>}
          />
          <div className="flex flex-col gap-[11px] px-[18px] py-4">
            {loanTypeData.length === 0 ? (
              <p className="text-sm text-slate-400">No loan types set on active escrows.</p>
            ) : loanTypeData.map(t => {
              const color = LOAN_TYPE_COLORS[t.name] || '#94a3b8'
              const pct = typedCount ? Math.round((t.value / typedCount) * 100) : 0
              return (
                <div key={t.name} className="grid grid-cols-[78px_1fr_52px] items-center gap-2.5 text-[12.5px] text-slate-700">
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />{t.name}
                  </span>
                  <div className="h-2 overflow-hidden rounded bg-slate-100">
                    <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                  <span className="text-right font-semibold tabular-nums text-slate-900">
                    {t.value}<span className="ml-1 text-[11px] font-normal text-slate-400">{pct}%</span>
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {/* LO Performance + At Risk + Recent */}
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-3">
        <section className={CARD}>
          <CardHeader
            badge="bg-violet-100 text-violet-700"
            icon={<Users className="h-3.5 w-3.5" />}
            title="LO performance"
            meta={<span>escrow volume</span>}
          />
          <div className="divide-y divide-slate-100">
            {loRows.map(lo => {
              const share = totalPipelineLoanVol > 0 ? Math.round((lo.loanVolume / totalPipelineLoanVol) * 100) : 0
              return (
                <div key={lo.name} className="px-[18px] py-2.5">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800"><LoDot name={lo.name} />{lo.name}</span>
                    <span className="font-semibold tabular-nums text-slate-900">{formatCurrency(lo.loanVolume)}</span>
                  </div>
                  <div className="my-1.5 h-[7px] overflow-hidden rounded bg-slate-100">
                    <div className="h-full rounded transition-all" style={{
                      width: `${loMax > 0 ? (lo.loanVolume / loMax) * 100 : 0}%`,
                      backgroundColor: LO_COLORS[lo.name] || '#3b82f6',
                    }} />
                  </div>
                  <p className="text-[11px] text-slate-400">{lo.deals} escrow{lo.deals !== 1 ? 's' : ''} · {share}% of volume</p>
                </div>
              )
            })}
          </div>
        </section>

        <section className={CARD}>
          <CardHeader
            badge="bg-amber-100 text-amber-700"
            icon={<AlertCircle className="h-3.5 w-3.5" />}
            title="Needs attention"
            meta={<span>missing LO, type or amount</span>}
          />
          {atRisk.length === 0 ? (
            <div className="flex items-start gap-2.5 px-[18px] py-4 text-[12.5px] leading-relaxed text-slate-500">
              <CheckCircle className="mt-px h-[18px] w-[18px] shrink-0 text-green-700" />
              <div>
                <p className="font-semibold text-slate-700">Nothing missing</p>
                Every active escrow has a loan officer, loan type and amount.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {atRisk.map(deal => (
                <Link key={deal.id} href={`/deals/${deal.id}`} className="flex items-center justify-between gap-3 px-[18px] py-2 transition-colors hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-slate-900">{deal.name}</p>
                    <p className="text-[11.5px] text-amber-700">
                      Missing: {[!deal.loan_officer && 'LO', !deal.loan_type && 'Loan Type', !deal.loan_amount && 'Amount'].filter(Boolean).join(', ')}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[deal.status || ''] || 'bg-slate-100 text-slate-600'}`}>{deal.status}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className={CARD}>
          <CardHeader
            badge="bg-sky-100 text-sky-700"
            icon={<Clock className="h-3.5 w-3.5" />}
            title="Recent escrows"
            action={<CardLink href="/deals">View all</CardLink>}
          />
          <div className="divide-y divide-slate-100">
            {recentDeals.map(deal => (
              <Link key={deal.id} href={`/deals/${deal.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 px-[18px] py-2 transition-colors hover:bg-slate-50">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-slate-900">{deal.name}</p>
                  <p className="flex items-center gap-1.5 text-[11.5px] text-slate-500">
                    {deal.loan_type && LOAN_TYPE_COLORS[deal.loan_type] && (
                      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: LOAN_TYPE_COLORS[deal.loan_type] }} />
                    )}
                    {deal.loan_type || 'No loan type'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[12.5px] font-semibold tabular-nums text-slate-900">{formatCurrency(deal.loan_amount)}</p>
                  <p className="flex items-center justify-end gap-1.5 text-[11px] text-slate-400">
                    <LoDot name={deal.loan_officer} size={7} />{deal.loan_officer || '—'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      {/* Next Steps — every active escrow + its next action (mirrors Active Escrows) */}
      {escrowsInProcess.length > 0 && (
        <section className={CARD}>
          <CardHeader
            badge="bg-orange-100 text-[#F37021]"
            icon={<Flame className="h-3.5 w-3.5" />}
            title="Next steps"
            meta={<>
              <Pill>{escrowsInProcess.length} escrow{escrowsInProcess.length !== 1 ? 's' : ''}</Pill>
              {noStepCount > 0 && <Pill tone="warn">{noStepCount} without a next step</Pill>}
              <Pill>{scheduledCount > 0 ? `${scheduledCount} scheduled` : 'none scheduled'}</Pill>
            </>}
            action={<CardLink href="/deals">Open Active Escrows</CardLink>}
          />
          <div className="grid grid-cols-[168px_150px_1fr_116px_88px] gap-3.5 border-b border-slate-100 px-[18px] py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
            <span>Borrower</span><span>Stage</span><span>Next step</span><span>Owner</span><span className="text-right">Due</span>
          </div>
          <div className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto">
            {nextStepRows.map(d => {
              const due = d.next_action_due ? new Date(d.next_action_due) : null
              const overdue = due ? due < now : false
              const dueStr = due ? due.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
              const loggedAgo = d.next_action_log?.[0]?.at ? relAgo(d.next_action_log[0].at) : ''
              const owner = d.next_action_assignee || d.loan_officer || ''
              return (
                <Link key={d.id} href={`/deals/${d.id}`} className="group grid grid-cols-[168px_150px_1fr_116px_88px] items-center gap-3.5 px-[18px] py-2 text-[12.5px] transition hover:bg-slate-50">
                  <span className="truncate font-semibold text-slate-900 group-hover:text-blue-700">{d.name}</span>
                  <span className="min-w-0">
                    <span className={`inline-block max-w-full truncate rounded-full px-2 py-0.5 align-middle text-[11px] font-semibold leading-4 ${STATUS_COLORS[d.status || ''] || 'bg-slate-100 text-slate-600'}`}>
                      {d.status || '—'}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-slate-700">
                    {d.next_action
                      ? <>{d.next_action}{loggedAgo && <span className="ml-1.5 font-mono text-[10.5px] text-slate-400">{loggedAgo}</span>}</>
                      : <span className="italic text-amber-700">No next step set</span>}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-slate-600"><LoDot name={owner} /><span className="truncate">{owner || '—'}</span></span>
                  <span className={`text-right font-mono text-[11px] ${overdue ? 'font-medium text-red-600' : 'text-slate-400'}`}>
                    {due ? `${overdue ? 'Overdue · ' : ''}${dueStr}` : '—'}
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {/* Unread Messages — moved below the metrics so the dashboard leads with
          the numbers, not the inbox. Live client inbox across both GHL accounts. */}
      <UnreadInbox />

    </div>
  )
}
