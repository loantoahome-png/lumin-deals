'use client'

// Old Deals — historical loans parked out of the dashboard's reporting.
//
// These are loans that exist ONLY here: imported from Arive, never present in GHL
// (no ghl_opportunity_id), mostly the funded book brought over in May 2026. They
// have no lead cost and no GHL opportunity, so they inflated funded counts and
// volume without belonging to any lead source.
//
// They are marked with pipeline_group = 'Old Deals' and excluded centrally in
// fetchAllDeals, so every other page drops them automatically. This page is the
// one place that opts back in (`includeOld`), which is why it reads them directly.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { fetchAllDeals, OLD_DEALS_GROUP } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { totalComp as dealTotalComp } from '@/lib/comp'
import Link from 'next/link'
import { RefreshCw, Search, Archive, Download } from 'lucide-react'

export default function OldDealsPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const data = await fetchAllDeals(
      dq => dq.eq('pipeline_group', OLD_DEALS_GROUP)
              .order('funded_date', { ascending: false, nullsFirst: false }),
      '*',
      { includeOld: true },   // the one page that wants them
    )
    setDeals(data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return deals
    return deals.filter(d =>
      (d.name ?? '').toLowerCase().includes(s) ||
      (d.arive_file_no ?? '').toLowerCase().includes(s) ||
      (d.loan_officer ?? '').toLowerCase().includes(s))
  }, [deals, q])

  const totalVolume = useMemo(() => rows.reduce((n, d) => n + (d.loan_amount ?? 0), 0), [rows])
  const totalComp = useMemo(() => rows.reduce((n, d) => n + dealTotalComp(d), 0), [rows])

  const exportCsv = () => {
    const head = ['Name', 'Loan Officer', 'Status', 'Funded', 'Loan Amount', 'Compensation', 'Arive File #', 'Source']
    const body = rows.map(d => [
      d.name ?? '', d.loan_officer ?? '', d.status ?? '', d.funded_date ?? '',
      d.loan_amount ?? '', dealTotalComp(d) || '', d.arive_file_no ?? '', d.source ?? '',
    ])
    const csv = [head, ...body]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'old-deals.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Archive className="w-5 h-5 text-slate-400" />
              Old Deals
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Historical loans kept for the record and excluded from every report on this dashboard.
              They came from Arive and have no GHL opportunity behind them.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCsv} disabled={!rows.length}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> Export
            </button>
            <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search name, Arive #, LO…"
              className="pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span><b className="text-slate-800">{rows.length}</b> loans</span>
            <span>volume <b className="text-slate-800">{formatCurrency(totalVolume)}</b></span>
            <span>comp <b className="text-slate-800">{formatCurrency(totalComp)}</b></span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="text-sm text-slate-400 py-12 text-center">Loading…</div>
        ) : !rows.length ? (
          <div className="text-sm text-slate-400 py-12 text-center">
            {deals.length ? 'No loans match that search.' : 'No old deals.'}
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Borrower</th>
                  <th className="px-3 py-2 text-left font-medium">Loan Officer</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Funded</th>
                  <th className="px-3 py-2 text-right font-medium">Loan Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Comp</th>
                  <th className="px-3 py-2 text-left font-medium">Arive #</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(d => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link href={`/deals/${d.id}`} className="text-blue-600 hover:underline font-medium">
                        {d.name ?? '—'}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{d.loan_officer ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{d.status ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{d.funded_date ? formatDate(d.funded_date) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {d.loan_amount ? formatCurrency(d.loan_amount) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {dealTotalComp(d) ? formatCurrency(dealTotalComp(d)) : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-500 tabular-nums">{d.arive_file_no ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
