'use client'

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals, DEAL_COLUMNS } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { pushStageToGHL } from '@/lib/pushStage'
import { RefreshCw, Flame } from 'lucide-react'
import HotLeadsTracker from '@/components/HotLeadsTracker'
import TriageQueue, { type Disposition } from '@/components/TriageQueue'
import CheckinQueue from '@/components/CheckinQueue'
import TriageDateModal from '@/components/TriageDateModal'
import { LoFilter, useLoFilter, loSelected } from '@/components/LoFilter'
import { isOpenLead, onTriageClock, triageTier, checkinTier, NOT_READY_TIMEFRAME } from '@/lib/triage'

const MS_PER_DAY = 86_400_000

// The hottest, highest-intent stages — leads we cannot afford to let slip.
// These are fetched WITH raw_ghl_data (the tracker's stage-time fallback reads it).
const HOT_STATUSES = ['Responded', 'Pitching', 'App Intake']

// The rest of the triage universe: undecided early stages (the 7-day decision
// clock — spec: docs/specs/2026-07-14-lead-triage-spec.md) plus the parked
// Not Ready - Timeframe leads that the Check-ins tab resurfaces. Fetched
// without the raw blob — these views only read real columns.
const TRIAGE_EXTRA_STATUSES = [
  'New Lead', 'Attempted Contact', 'Ghosted', 'Appointment Booked', NOT_READY_TIMEFRAME,
]
// Statuses this page keeps in local state; moving a deal anywhere else drops it.
const TRACKED_STATUSES = [...HOT_STATUSES, ...TRIAGE_EXTRA_STATUSES]

// Four views: the 7-day triage queue, the two original hot-lead trackers,
// and the Not Ready check-in queue.
type LeadView = 'triage' | 'pitching' | 'intake' | 'checkins'
const VIEW_STATUSES: Record<'pitching' | 'intake', string[]> = {
  pitching: ['Responded', 'Pitching'],
  intake:   ['App Intake'],
}

function HotLeadsPageInner() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const { selectedLOs, toggleLO } = useLoFilter()
  // ?view=triage|pitching|intake|checkins deep-links a tab (default: triage).
  const searchParams = useSearchParams()
  const urlView = searchParams.get('view') as LeadView | null
  const [view, setView] = useState<LeadView>(
    urlView && ['triage', 'pitching', 'intake', 'checkins'].includes(urlView) ? urlView : 'triage',
  )
  // Leads pending the required check-in date (Not Ready - Timeframe move).
  const [dateModalIds, setDateModalIds] = useState<string[] | null>(null)

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    // Paginate past PostgREST's 1000-row cap so no hot lead is dropped as volume grows.
    const [hot, extra] = await Promise.all([
      // oldest-first → most-stalled surfaces at the top within each bucket
      fetchAllDeals(q => q
        .in('status', HOT_STATUSES)
        .order('stage_changed_at', { ascending: true, nullsFirst: false })),
      fetchAllDeals(q => q
        .in('status', TRIAGE_EXTRA_STATUSES)
        .order('created_at', { ascending: true }), DEAL_COLUMNS),
    ])
    // Dedup by id (a deal that flips status mid-fetch could appear in both).
    const seen = new Set<string>()
    setDeals([...hot, ...extra].filter(d => !seen.has(d.id) && seen.add(d.id)))
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // LO filter applied client-side so toggling doesn't refetch.
  // Also exclude dead opportunities: the team now leaves a fallen-through lead
  // in its last stage (e.g. App Intake) and just flips the GHL status to
  // Lost/Abandoned — so this page must hide anything not Open. (null/unknown
  // status is kept, so a lead we haven't classified never disappears.)
  const visible = useMemo(
    () => deals.filter(d => isOpenLead(d) && loSelected(d.loan_officer, selectedLOs)),
    [deals, selectedLOs],
  )

  const now = Date.now()
  // Triage shows only leads that arrived since launch day (TRIAGE_SINCE) —
  // the pre-launch pile is out of the triage workflow ("start now").
  const triageDeals  = useMemo(() => visible.filter(onTriageClock), [visible])
  const checkinDeals = useMemo(() => visible.filter(d => d.status === NOT_READY_TIMEFRAME), [visible])
  const trackerDeals = (statuses: string[]) => visible.filter(d => statuses.includes(d.status))

  // Tier counts for tab badges + metrics.
  const tierCount = useMemo(() => {
    const c = { clock: 0, decide: 0, overdue: 0, backlog: 0 }
    for (const d of triageDeals) c[triageTier(d, now)]++
    return c
  }, [triageDeals, now])
  const checkinCount = useMemo(() => {
    const c = { overdue: 0, soon: 0, none: 0, scheduled: 0 }
    for (const d of checkinDeals) c[checkinTier(d, now)]++
    return c
  }, [checkinDeals, now])

  const pitchingViewCount = trackerDeals(VIEW_STATUSES.pitching).length
  const intakeViewCount = trackerDeals(VIEW_STATUSES.intake).length
  const triageBadge = tierCount.clock + tierCount.decide + tierCount.overdue   // current cohort (backlog shown inside)
  const checkinBadge = checkinCount.overdue + checkinCount.soon + checkinCount.none

  // Metrics for the tracker views (unchanged behavior).
  const trackerVisible = view === 'pitching' || view === 'intake' ? trackerDeals(VIEW_STATUSES[view]) : []
  const totalVolume = trackerVisible.reduce((s, d) => s + (d.loan_amount || 0), 0)
  const stalled = trackerVisible.filter(d => {
    const t = new Date(d.stage_changed_at || d.created_at).getTime()
    return Math.floor((Date.now() - t) / MS_PER_DAY) >= 4
  }).length
  const avgDays = trackerVisible.length === 0 ? 0 : Math.round(
    trackerVisible.reduce((s, d) => {
      const t = new Date(d.stage_changed_at || d.created_at).getTime()
      return s + Math.max(0, Math.floor((Date.now() - t) / MS_PER_DAY))
    }, 0) / trackerVisible.length
  )

  async function handleUpdate(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('deals').update(patch).eq('id', id)
    if (error) { console.error('Hot leads update failed:', error); return }
    // If the status moved outside everything this page tracks, drop the deal.
    if (patch.status && !TRACKED_STATUSES.includes(patch.status as string)) {
      setDeals(prev => prev.filter(d => d.id !== id))
    } else {
      setDeals(prev => prev.map(d => d.id === id ? { ...d, ...patch } as Deal : d))
    }
    // Bidirectional sync — push the new stage to GHL so the next sync doesn't revert it
    if (typeof patch.status === 'string') {
      void pushStageToGHL(id, patch.status)
    }
  }

  // Mark a lead Lost: flip the GHL opportunity status to lost — this archives it
  // in GHL and drops it off Hot Leads (this page filters out ghl_status='lost').
  // We keep the current stage and push status=lost to GHL so the next sync keeps
  // it lost (it also re-groups the deal to "Not Ready") instead of reverting to open.
  async function handleMarkLost(id: string, currentStatus: string) {
    setDeals(prev => prev.filter(d => d.id !== id))   // optimistic — leaves the view immediately
    const { error } = await supabase.from('deals').update({ ghl_status: 'lost' }).eq('id', id)
    if (error) { console.error('Mark lost failed:', error); return }
    void pushStageToGHL(id, currentStatus, 'lost')
  }

  // ── Triage dispositions (the three confirmed directions) ───────────────────
  function handleDisposition(ids: string[], disp: Disposition) {
    if (disp === 'intake') {
      for (const id of ids) void handleUpdate(id, { status: 'App Intake', pipeline_group: 'Leads' })
    } else if (disp === 'remove') {
      const n = ids.length
      if (!confirm(`Remove ${n} lead${n === 1 ? '' : 's'} from all automations? This parks ${n === 1 ? 'it' : 'them'} in the Not Ready pipeline.`)) return
      for (const id of ids) void handleUpdate(id, { status: 'Remove from All Automations', pipeline_group: 'Not Ready' })
    } else {
      setDateModalIds(ids)   // Not Ready - Timeframe → the date is required
    }
  }

  // Modal confirm: move to Not Ready - Timeframe (if not already there) and set
  // the check-in. The date lives in next_action_due; the note in next_action.
  function applyCheckinDate({ dueIso, note }: { dueIso: string; note: string }) {
    const ids = dateModalIds ?? []
    setDateModalIds(null)
    for (const id of ids) {
      const deal = deals.find(d => d.id === id)
      const patch: Record<string, unknown> = {
        next_action: note ? `Check in: ${note}` : 'Check in',
        next_action_due: dueIso,
      }
      if (deal?.status !== NOT_READY_TIMEFRAME) {
        patch.status = NOT_READY_TIMEFRAME
        patch.pipeline_group = 'Not Ready'
      }
      void handleUpdate(id, patch)
    }
  }

  const modalLeadNames = (dateModalIds ?? [])
    .map(id => deals.find(d => d.id === id)?.name)
    .filter((n): n is string => !!n)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Flame className="w-5 h-5 text-orange-500" />
              Hot Leads
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {view === 'triage'
                ? 'Every undecided lead on its 7-day clock — commit each to App Intake, Not Ready (with a check-in date), or Remove.'
                : view === 'pitching'
                ? 'Responded & Pitching leads — bucketed by how long since the borrower last replied.'
                : view === 'intake'
                ? 'App Intake leads (application in) — bucketed by how long since the borrower last replied.'
                : 'Not Ready - Timeframe leads resurfacing on their promised check-in date.'}
            </p>
          </div>
          <button
            onClick={fetchDeals}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* View tabs */}
        <div className="flex gap-2 mb-3">
          {([
            { key: 'triage'   as LeadView, label: '⏱ Triage — first 7 days', count: triageBadge,      accent: 'bg-orange-600 border-orange-600', alert: tierCount.decide + tierCount.overdue > 0 },
            { key: 'pitching' as LeadView, label: 'Responded / Pitching',     count: pitchingViewCount, accent: 'bg-violet-600 border-violet-600', alert: false },
            { key: 'intake'   as LeadView, label: 'App Intake',               count: intakeViewCount,   accent: 'bg-cyan-600 border-cyan-600',     alert: false },
            { key: 'checkins' as LeadView, label: '📅 Check-ins',             count: checkinBadge,      accent: 'bg-emerald-600 border-emerald-600', alert: checkinCount.overdue > 0 },
          ]).map(t => {
            const active = view === t.key
            return (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold border-2 transition-all ${
                  active ? `${t.accent} text-white shadow-md` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                {t.label}
                <span className={`text-xs font-semibold rounded-full px-1.5 py-0.5 tabular-nums ${
                  active ? 'bg-white/20' : t.alert ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'
                }`}>{t.count}</span>
              </button>
            )
          })}
        </div>

        {/* Metrics + LO filter (per-view) */}
        <div className="flex items-center gap-2 flex-wrap">
          {view === 'triage' ? (
            <>
              <Metric label="On the clock (0–4d)" value={tierCount.clock} />
              <Metric label="Decision due (5–7d)" value={tierCount.decide} highlight={tierCount.decide > 0 ? 'amber' : undefined} />
              <Metric label="Overdue (8–30d)" value={tierCount.overdue} highlight={tierCount.overdue > 0 ? 'red' : undefined} />
              <Metric label="Backlog (30d+)" value={tierCount.backlog} />
            </>
          ) : view === 'checkins' ? (
            <>
              <Metric label="Overdue" value={checkinCount.overdue} highlight={checkinCount.overdue > 0 ? 'red' : undefined} />
              <Metric label="Due this week" value={checkinCount.soon} highlight={checkinCount.soon > 0 ? 'amber' : undefined} />
              <Metric label="No date set" value={checkinCount.none} highlight={checkinCount.none > 0 ? 'amber' : undefined} />
              <Metric label="Scheduled" value={checkinCount.scheduled} />
            </>
          ) : (
            <>
              <Metric label="Hot leads" value={trackerVisible.length} />
              <Metric label="Volume" value={formatCurrency(totalVolume)} />
              <Metric label="Stalled 4+ days" value={stalled} highlight={stalled > 0 ? 'red' : undefined} />
              <Metric label="Avg days in stage" value={avgDays} highlight={avgDays >= 4 ? 'amber' : undefined} />
            </>
          )}

          <LoFilter selected={selectedLOs} onToggle={toggleLO} className="ml-auto" />
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {view === 'triage' ? (
            <TriageQueue deals={triageDeals} onDisposition={handleDisposition} onUpdate={handleUpdate} />
          ) : view === 'checkins' ? (
            <CheckinQueue
              deals={checkinDeals}
              onSetDate={ids => setDateModalIds(ids)}
              onIntake={id => handleDisposition([id], 'intake')}
              onRemove={id => handleDisposition([id], 'remove')}
            />
          ) : (
            <HotLeadsTracker deals={trackerVisible} onUpdate={handleUpdate} onMarkLost={handleMarkLost} />
          )}
        </div>
      )}

      {/* Required check-in date (Not Ready - Timeframe) */}
      {dateModalIds && dateModalIds.length > 0 && (
        <TriageDateModal
          title="Not Ready — set a check-in date"
          leadNames={modalLeadNames}
          onConfirm={applyCheckinDate}
          onClose={() => setDateModalIds(null)}
        />
      )}
    </div>
  )
}

// useSearchParams requires a Suspense boundary in the App Router.
export default function HotLeadsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <HotLeadsPageInner />
    </Suspense>
  )
}

function Metric({ label, value, highlight }: {
  label: string
  value: string | number
  highlight?: 'red' | 'amber'
}) {
  const bg =
    highlight === 'red'   ? 'bg-red-50 border-red-200'   :
    highlight === 'amber' ? 'bg-amber-50 border-amber-200' :
                            'bg-white border-slate-200'
  const text =
    highlight === 'red'   ? 'text-red-700'   :
    highlight === 'amber' ? 'text-amber-700' :
                            'text-slate-800'
  return (
    <div className={`border rounded-lg px-3 py-1.5 ${bg}`}>
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold leading-none mb-0.5">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${text}`}>{value}</p>
    </div>
  )
}
