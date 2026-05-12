'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, LOAN_OFFICERS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import FundedTracker from '@/components/FundedTracker'

export default function FundedPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loFilter, setLoFilter] = useState<'All' | string>('All')

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('deals')
      .select('*')
      .eq('pipeline_group', 'Funded')
      .order('funded_date', { ascending: false, nullsFirst: false })
    setDeals((data as Deal[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // LO filter applied client-side
  const filtered = deals.filter(d => {
    if (loFilter === 'All') return true
    return d.loan_officer?.toLowerCase().includes(loFilter.toLowerCase())
  })

  const totalVolume = filtered.reduce((s, d) => s + (d.loan_amount || 0), 0)

  async function handleUpdate(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('deals').update(patch).eq('id', id)
    if (!error) {
      setDeals(prev => prev.map(d => d.id === id ? { ...d, ...patch } as Deal : d))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Funded Loans</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} deal{filtered.length !== 1 ? 's' : ''} · {formatCurrency(totalVolume)} funded volume
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            <Link href="/deals/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
              + New Deal
            </Link>
          </div>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-3">
          <select
            value={loFilter}
            onChange={e => setLoFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All LOs</option>
            {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
          </select>
          {loFilter !== 'All' && (
            <button onClick={() => setLoFilter('All')} className="text-sm text-blue-600 hover:underline">
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Tracker */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <FundedTracker deals={filtered} onUpdate={handleUpdate} />
        </div>
      )}
    </div>
  )
}
