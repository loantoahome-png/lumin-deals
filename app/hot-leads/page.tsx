'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { pushStageToGHL } from '@/lib/pushStage'
import { RefreshCw, Flame } from 'lucide-react'
import HotLeadsTracker from '@/components/HotLeadsTracker'

const MS_PER_DAY = 86_400_000

// The hottest, highest-intent stages — leads we cannot afford to let slip.
const HOT_STATUSES = ['Pitching', 'App Intake']

export default function HotLeadsPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loFilter, setLoFilter] = useState<'All' | string>('All')

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    // Paginate past PostgREST's 1000-row cap so no hot lead is dropped as volume grows.
    const data = await fetchAllDeals(q => q
      .in('status', HOT_STATUSES)
      // oldest-first → most-stalled surfaces at the top within each bucket
      .order('stage_changed_at', { ascending: true, nullsFirst: false }))
    setDeals(data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // LO filter applied client-side so toggling doesn't refetch
  const filtered = deals.filter(d =>
    loFilter === 'All' || (d.loan_officer ?? '').toLowerCase().includes(loFilter.toLowerCase())
  )

  const totalVolume = filtered.reduce((s, d) => s + (d.loan_amount || 0), 0)
  // "Stalled" = 4+ days in stage with no movement (Warm threshold and beyond)
  const stalled = filtered.filter(d => {
    const t = new Date(d.stage_changed_at || d.created_at).getTime()
    return Math.floor((Date.now() - t) / MS_PER_DAY) >= 4
  }).length
  const avgDays = filtered.length === 0 ? 0 : Math.round(
    filtered.reduce((s, d) => {
      const t = new Date(d.stage_changed_at || d.created_at).getTime()
      return s + Math.max(0, Math.floor((Date.now() - t) / MS_PER_DAY))
    }, 0) / filtered.length
  )

  async function handleUpdate(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('deals').update(patch).eq('id', id)
    if (error) { console.error('Hot leads update failed:', error); return }
    // If status moved out of the hot stages, the lead leaves this view
    if (patch.status && !HOT_STATUSES.includes(patch.status as string)) {
      setDeals(prev => prev.filter(d => d.id !== id))
    } else {
      setDeals(prev => prev.map(d => d.id === id ? { ...d, ...patch } as Deal : d))
    }
    // Bidirectional sync — push the new stage to GHL so the next sync doesn't revert it
    if (typeof patch.status === 'string') {
      void pushStageToGHL(id, patch.status)
    }
  }

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
              Your highest-intent leads — Pitching &amp; App Intake — ranked by how long they&apos;ve stalled. Work the red columns first.
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

        {/* Metrics + LO filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Metric label="Hot leads" value={filtered.length} />
          <Metric label="Volume" value={formatCurrency(totalVolume)} />
          <Metric label="Stalled 4+ days" value={stalled} highlight={stalled > 0 ? 'red' : undefined} />
          <Metric label="Avg days in stage" value={avgDays} highlight={avgDays >= 4 ? 'amber' : undefined} />

          <select
            value={loFilter}
            onChange={e => setLoFilter(e.target.value)}
            className="ml-auto text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All LOs</option>
            {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
          </select>
        </div>
      </div>

      {/* Tracker */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <HotLeadsTracker deals={filtered} onUpdate={handleUpdate} />
        </div>
      )}
    </div>
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
