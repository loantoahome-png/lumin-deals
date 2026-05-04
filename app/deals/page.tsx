'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, LOAN_OFFICERS, LOAN_STATUSES, STATUS_COLORS } from '@/lib/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import Link from 'next/link'
import { Search, RefreshCw, ExternalLink } from 'lucide-react'

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [loFilter, setLoFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [groupFilter, setGroupFilter] = useState('All')

  async function fetchDeals() {
    setLoading(true)
    const { data } = await supabase
      .from('deals')
      .select('*')
      .order('created_at', { ascending: false })
    setDeals(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchDeals() }, [])

  const filtered = deals.filter(d => {
    const matchSearch = !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.property_address?.toLowerCase().includes(search.toLowerCase()) ||
      d.investor?.toLowerCase().includes(search.toLowerCase())
    const matchLO = loFilter === 'All' || d.loan_officer?.includes(loFilter)
    const matchStatus = statusFilter === 'All' || d.status === statusFilter
    const matchGroup = groupFilter === 'All' || d.pipeline_group === groupFilter
    return matchSearch && matchLO && matchStatus && matchGroup
  })

  const totalRevenue = filtered.reduce((s, d) => s + (d.revenue || 0), 0)
  const totalLoanAmt = filtered.reduce((s, d) => s + (d.loan_amount || 0), 0)

  const groups = [...new Set(deals.map(d => d.pipeline_group))].filter(Boolean)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">All Deals</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} deals · {formatCurrency(totalRevenue)} revenue · {formatCurrency(totalLoanAmt)} loan volume
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
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

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, address, investor…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={loFilter}
            onChange={e => setLoFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All LOs</option>
            {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All Statuses</option>
            {LOAN_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="All">All Groups</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          {(search || loFilter !== 'All' || statusFilter !== 'All' || groupFilter !== 'All') && (
            <button
              onClick={() => { setSearch(''); setLoFilter('All'); setStatusFilter('All'); setGroupFilter('All') }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Name</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Status</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Loan Type</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Loan Amount</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Revenue</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">LO</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Investor</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Rate</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Group</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Added</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-12 text-slate-400">
                      No deals found
                    </td>
                  </tr>
                ) : (
                  filtered.map(deal => (
                    <tr key={deal.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <Link href={`/deals/${deal.id}`} className="font-semibold text-slate-900 hover:text-blue-600">
                          {deal.name}
                        </Link>
                        {deal.property_address && (
                          <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[180px]">{deal.property_address}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-1 rounded-md font-medium ${STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'}`}>
                          {deal.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{deal.loan_type || '—'}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{formatCurrency(deal.loan_amount)}</td>
                      <td className="px-4 py-3 font-medium text-emerald-700">{formatCurrency(deal.revenue)}</td>
                      <td className="px-4 py-3 text-slate-600">{deal.loan_officer || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{deal.investor || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{deal.rate ? `${deal.rate}%` : '—'}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                          {deal.pipeline_group}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{formatDate(deal.created_at)}</td>
                      <td className="px-4 py-3">
                        <Link href={`/deals/${deal.id}`} className="text-slate-400 hover:text-blue-600 transition-colors">
                          <ExternalLink className="w-4 h-4" />
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
