'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { Search, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils'

type SearchResult = Pick<Deal, 'id' | 'name' | 'status' | 'pipeline_group' | 'property_address' | 'loan_amount'>

export default function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timeout = setTimeout(async () => {
      setLoading(true)
      const { data } = await supabase
        .from('deals')
        .select('id, name, status, pipeline_group, property_address, loan_amount')
        .or(`name.ilike.%${query}%,property_address.ilike.%${query}%,email.ilike.%${query}%,investor.ilike.%${query}%`)
        .order('created_at', { ascending: false })
        .limit(8)
      setResults(data || [])
      setLoading(false)
    }, 200)
    return () => clearTimeout(timeout)
  }, [query])

  function navigate(id: string) {
    router.push(`/deals/${id}`)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className="relative px-3 mb-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder="Search deals…"
          className="w-full pl-8 pr-7 py-2 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults([]) }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && query && (
        <div className="absolute top-full left-3 right-3 mt-1 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden z-[100]">
          {loading ? (
            <div className="px-4 py-3 text-xs text-slate-400">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-400">No deals match &quot;{query}&quot;</div>
          ) : (
            <>
              {results.map((d, i) => (
                <button
                  key={d.id}
                  onMouseDown={() => navigate(d.id)}
                  className={`w-full text-left px-4 py-2.5 hover:bg-blue-50 transition-colors ${i < results.length - 1 ? 'border-b border-slate-100' : ''}`}
                >
                  <p className="text-sm font-semibold text-slate-900 truncate">{d.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium leading-none ${STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'}`}>
                      {d.status}
                    </span>
                    {d.loan_amount && (
                      <span className="text-xs text-slate-500">{formatCurrency(d.loan_amount)}</span>
                    )}
                    {d.property_address && (
                      <span className="text-xs text-slate-400 truncate max-w-[140px]">{d.property_address}</span>
                    )}
                  </div>
                </button>
              ))}
              <div className="px-4 py-2 bg-slate-50 border-t border-slate-100">
                <button
                  onMouseDown={() => { router.push(`/deals?search=${encodeURIComponent(query)}`); setOpen(false); setQuery('') }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  View all results for &quot;{query}&quot; →
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
