'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import { pushStageToGHL } from '@/lib/pushStage'
import { RefreshCw } from 'lucide-react'
import FundedTracker from '@/components/FundedTracker'

export default function FundedPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    // Paginate past PostgREST's 1000-row cap — funded loans accumulate forever
    // and will eventually cross 1000.
    const data = await fetchAllDeals(q => q
      .eq('pipeline_group', 'Funded')
      .order('funded_date', { ascending: false, nullsFirst: false }))
    setDeals(data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  async function handleUpdate(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('deals').update(patch).eq('id', id)
    if (!error) {
      setDeals(prev => prev.map(d => d.id === id ? { ...d, ...patch } as Deal : d))
    }
    if (typeof patch.status === 'string') {
      void pushStageToGHL(id, patch.status)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header — title + actions; all filters/stats live in the list below */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Funded Loans</h1>
        <div className="flex items-center gap-2">
          <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <FundedTracker deals={deals} onUpdate={handleUpdate} />
        </div>
      )}
    </div>
  )
}
