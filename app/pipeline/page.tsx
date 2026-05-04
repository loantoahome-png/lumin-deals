'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_STAGE_MAP, STATUS_COLORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'

const STAGE_ORDER = ['Leads', 'Registered', 'Underwriting', 'Closing', 'Funded']

const STAGE_HEADER_COLORS: Record<string, string> = {
  'Leads':        'border-slate-300 bg-slate-50',
  'Registered':   'border-blue-300 bg-blue-50',
  'Underwriting': 'border-amber-300 bg-amber-50',
  'Closing':      'border-orange-300 bg-orange-50',
  'Funded':       'border-emerald-300 bg-emerald-50',
}
const STAGE_DOT_COLORS: Record<string, string> = {
  'Leads':        'bg-slate-400',
  'Registered':   'bg-blue-500',
  'Underwriting': 'bg-amber-500',
  'Closing':      'bg-orange-500',
  'Funded':       'bg-emerald-500',
}

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loFilter, setLoFilter] = useState('All')

  async function fetchDeals() {
    setLoading(true)
    const { data } = await supabase
      .from('deals')
      .select('*')
      .not('pipeline_group', 'in', '("Lost","Last files at WCL","Lost/Inactive/Does not qualify")')
      .order('created_at', { ascending: false })
    setDeals(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchDeals() }, [])

  const filteredDeals = loFilter === 'All'
    ? deals
    : deals.filter(d => d.loan_officer?.includes(loFilter))

  // Group by stage
  const stageMap: Record<string, Deal[]> = {}
  STAGE_ORDER.forEach(stage => { stageMap[stage] = [] })
  filteredDeals.forEach(deal => {
    for (const [stage, statuses] of Object.entries(PIPELINE_STAGE_MAP)) {
      if (statuses.includes(deal.status)) {
        stageMap[stage].push(deal)
        return
      }
    }
  })

  const totalRevenue = filteredDeals.reduce((s, d) => s + (d.revenue || 0), 0)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Pipeline Board</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {filteredDeals.length} deals · {formatCurrency(totalRevenue)} pipeline revenue
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* LO Filter */}
          <select
            value={loFilter}
            onChange={e => setLoFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All LOs</option>
            <option value="Efrain">Efrain</option>
            <option value="Matt">Matt</option>
            <option value="Moe">Moe</option>
          </select>
          <button
            onClick={fetchDeals}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            href="/deals/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + New Deal
          </Link>
        </div>
      </div>

      {/* Board */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex gap-4 p-4 overflow-x-auto flex-1 items-start">
          {STAGE_ORDER.map(stage => {
            const stageDeals = stageMap[stage] || []
            const stageRevenue = stageDeals.reduce((s, d) => s + (d.revenue || 0), 0)
            return (
              <div key={stage} className="flex flex-col shrink-0 w-72">
                {/* Column header */}
                <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border-b-2 ${STAGE_HEADER_COLORS[stage]}`}>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${STAGE_DOT_COLORS[stage]}`} />
                    <span className="font-semibold text-slate-800 text-sm">{stage}</span>
                    <span className="bg-white text-slate-500 text-xs font-medium px-1.5 py-0.5 rounded-full border border-slate-200">
                      {stageDeals.length}
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-500">{formatCurrency(stageRevenue)}</span>
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-2 pt-2 overflow-y-auto max-h-[calc(100vh-180px)]">
                  {stageDeals.length === 0 ? (
                    <div className="bg-white/50 rounded-xl border-2 border-dashed border-slate-200 p-4 text-center">
                      <p className="text-slate-400 text-xs">No deals here</p>
                    </div>
                  ) : (
                    stageDeals.map(deal => (
                      <DealCard key={deal.id} deal={deal} />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DealCard({ deal }: { deal: Deal }) {
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

  return (
    <Link href={`/deals/${deal.id}`}>
      <div className="bg-white rounded-xl border border-slate-200 p-3.5 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer group">
        {/* Name + Status */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <p className="font-semibold text-slate-900 text-sm leading-tight group-hover:text-blue-700 transition-colors">
            {deal.name}
          </p>
          <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium shrink-0 ${statusClass}`}>
            {deal.status === 'Signing Done - Waiting for Funding' ? 'Signing Done' :
             deal.status === 'Waiting on Docs from Client for final approval' ? 'Waiting on Docs' :
             deal.status}
          </span>
        </div>

        {/* Loan details */}
        {(deal.loan_type || deal.loan_amount) && (
          <div className="flex items-center gap-1.5 mb-2">
            {deal.loan_type && (
              <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                {deal.loan_type}
              </span>
            )}
            {deal.loan_amount && (
              <span className="text-xs font-medium text-slate-700">
                {formatCurrency(deal.loan_amount)}
              </span>
            )}
          </div>
        )}

        {/* Bottom row */}
        <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
          <span>{deal.loan_officer || '—'}</span>
          {deal.revenue && (
            <span className="font-medium text-emerald-600">{formatCurrency(deal.revenue)}</span>
          )}
        </div>

        {/* Investor */}
        {deal.investor && (
          <div className="mt-1.5 pt-1.5 border-t border-slate-100">
            <span className="text-xs text-slate-400">{deal.investor}</span>
          </div>
        )}
      </div>
    </Link>
  )
}
