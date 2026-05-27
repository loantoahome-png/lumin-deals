'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS, LOAN_TYPES, PIPELINE_GROUPS, PIPELINE_STATUSES, STATUS_COLORS } from '@/lib/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { pushStageToGHL } from '@/lib/pushStage'
import Link from 'next/link'
import { Search, RefreshCw, ExternalLink, Download, X, CheckSquare, Pencil, LayoutGrid, Table2 } from 'lucide-react'
import EscrowTracker from '@/components/EscrowTracker'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

// ── Inline cell editing ────────────────────────────────────────────────────────
type DealsInlineCellProps = {
  deal: Deal
  field: string
  value: unknown
  type: 'text' | 'email' | 'tel' | 'number' | 'currency' | 'percent' | 'date' | 'select'
  options?: readonly string[]
  step?: string
  isEditing: boolean
  onStartEdit: () => void
  onSave: (val: unknown) => void
  onCancel: () => void
  displayRender?: React.ReactNode
}

function DealsInlineCell({
  field, value, type, options, step,
  isEditing, onStartEdit, onSave, onCancel,
  displayRender,
}: DealsInlineCellProps) {
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const [localVal, setLocalVal] = useState('')

  useEffect(() => {
    if (isEditing) {
      setLocalVal(value != null ? String(value) : '')
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          if (type !== 'select' && type !== 'date') {
            (inputRef.current as HTMLInputElement).select?.()
          }
        }
      }, 0)
    }
  }, [isEditing, value, type])

  function commit() {
    let parsed: unknown = localVal
    if (type === 'number' || type === 'currency' || type === 'percent') {
      parsed = localVal === '' ? null : parseFloat(localVal)
    }
    onSave(parsed)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    if (e.key === 'Tab') { e.preventDefault(); commit() }
  }

  const inputCls = 'w-full bg-transparent border-none outline-none text-sm text-slate-800 p-0 m-0'
  const wrapCls  = 'ring-2 ring-blue-400 ring-inset bg-white rounded px-2 py-1 min-w-[80px]'

  if (!isEditing) {
    return (
      <div
        onClick={onStartEdit}
        className="cursor-pointer rounded px-1 -mx-1 hover:bg-slate-100 transition-colors min-h-[22px] flex items-center"
        title={`Click to edit ${field}`}
      >
        {displayRender ?? (
          <span className="text-slate-600 text-sm">
            {value != null && value !== '' ? String(value) : <span className="text-slate-300">—</span>}
          </span>
        )}
      </div>
    )
  }

  if (type === 'select' && options) {
    return (
      <div className={wrapCls}>
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={localVal}
          onChange={e => setLocalVal(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className={inputCls + ' cursor-pointer'}
        >
          <option value="">—</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  if (type === 'date') {
    return (
      <div className={wrapCls}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="date"
          value={localVal}
          onChange={e => setLocalVal(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className={inputCls}
        />
      </div>
    )
  }

  const htmlType = type === 'currency' || type === 'percent' || type === 'number' ? 'number' : type

  return (
    <div className={wrapCls}>
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={htmlType}
        value={localVal}
        step={step}
        onChange={e => setLocalVal(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={inputCls}
      />
    </div>
  )
}

// ── CSV export ─────────────────────────────────────────────────────────────────
function exportToCSV(deals: Deal[]) {
  const headers = [
    'Name', 'Status', 'Pipeline Group', 'Loan Type', 'Loan Amount', 'Estimated Value',
    'Rate (%)', 'Investor', 'Loan Officer', 'Processor', 'Property Address',
    'Email', 'Phone', 'Credit Score', 'Occupancy', 'Locked', 'Lock Expiration',
    'Appraisal Status', 'Source', 'Signing Date', 'Funded Date', 'Paid Date',
    'Last Contacted', 'Arive File #', 'Investor File #', 'Created At',
  ]
  const rows = deals.map(d => [
    d.name, d.status, d.pipeline_group, d.loan_type || '', d.loan_amount || '', d.estimated_value || '',
    d.rate || '', d.investor || '', d.loan_officer || '', d.processor_status || '',
    d.property_address || '', d.email || '', d.phone || '', d.credit_score || '', d.occupancy || '',
    d.locked || '', d.lock_expiration || '', d.appraisal_status || '', d.source || '',
    d.signing_date || '', d.funded_date || '', d.paid_date || '', d.last_contacted || '',
    d.arive_file_no || '', d.investor_file_no || '', d.created_at,
  ])

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lumin-deals-${new Date().toISOString().split('T')[0]}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Inner page (needs useSearchParams) ────────────────────────────────────────
function DealsPageInner() {
  const searchParams = useSearchParams()
  const initialSearch = searchParams.get('search') || ''
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(initialSearch)
  const [loFilter, setLoFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  // This page is dedicated to active escrows — pipeline is locked to 'Loans in Process'.
  const pipelineFilter = 'Loans in Process'

  // Inline cell editing
  const [editCell, setEditCell] = useState<{ id: string; field: string } | null>(null)
  // View mode: 'tracker' is the new operational kanban-style view; 'table' is the classic table
  const [viewMode, setViewMode] = useState<'tracker' | 'table'>('tracker')

  async function handleCellUpdate(id: string, field: string, value: unknown) {
    setDeals(prev => prev.map(d =>
      d.id === id ? { ...d, [field]: value, updated_at: new Date().toISOString() } : d
    ))
    await supabase.from('deals').update({ [field]: value }).eq('id', id)
    // Bidirectional sync: a status change inline-edit should reach GHL too
    if (field === 'status' && typeof value === 'string') {
      void pushStageToGHL(id, value)
    }
  }

  // Bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkProcessing, setBulkProcessing] = useState(false)

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const all = await fetchAllDeals(q => q.order('created_at', { ascending: false }))
    setDeals(all)
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  const filtered = deals.filter(d => {
    const matchSearch = !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.property_address?.toLowerCase().includes(search.toLowerCase()) ||
      d.investor?.toLowerCase().includes(search.toLowerCase()) ||
      d.email?.toLowerCase().includes(search.toLowerCase()) ||
      d.phone?.toLowerCase().includes(search.toLowerCase())
    const matchPipeline = d.pipeline_group === pipelineFilter
    const matchLO = loFilter === 'All' || d.loan_officer?.includes(loFilter)
    const matchStatus = statusFilter === 'All' || d.status === statusFilter
    return matchSearch && matchPipeline && matchLO && matchStatus
  })

  const totalLoanAmt = filtered.reduce((s, d) => s + (d.loan_amount || 0), 0)

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allFilteredSelected = filtered.length > 0 && filtered.every(d => selectedIds.has(d.id))
  const someSelected = selectedIds.size > 0

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(d => d.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Bulk actions ──────────────────────────────────────────────────────────
  async function bulkChangeStatus(status: string) {
    if (!status || selectedIds.size === 0) return
    setBulkProcessing(true)
    const ids = [...selectedIds]
    await supabase.from('deals').update({ status }).in('id', ids)
    setDeals(prev => prev.map(d => selectedIds.has(d.id) ? { ...d, status } : d))
    // Push each affected deal's new stage to GHL. Sequential (with a brief
    // gap) to stay friendly to GHL's rate limits on bulk operations.
    ;(async () => {
      for (const id of ids) {
        await pushStageToGHL(id, status)
        await new Promise(r => setTimeout(r, 150))
      }
    })()
    setSelectedIds(new Set())
    setBulkProcessing(false)
  }

  async function bulkChangeGroup(pipeline_group: string) {
    if (!pipeline_group || selectedIds.size === 0) return
    setBulkProcessing(true)
    const ids = [...selectedIds]
    await supabase.from('deals').update({ pipeline_group }).in('id', ids)
    setDeals(prev => prev.map(d => selectedIds.has(d.id) ? { ...d, pipeline_group } : d))
    setSelectedIds(new Set())
    setBulkProcessing(false)
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return
    if (!confirm(`Permanently delete ${selectedIds.size} deal(s)? This cannot be undone.`)) return
    setBulkProcessing(true)
    const ids = [...selectedIds]
    await supabase.from('deals').delete().in('id', ids)
    setDeals(prev => prev.filter(d => !selectedIds.has(d.id)))
    setSelectedIds(new Set())
    setBulkProcessing(false)
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {search ? `Search: "${search}"` : 'Active Escrows'}
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} deal{filtered.length !== 1 ? 's' : ''} · {formatCurrency(totalLoanAmt)} loan volume
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* View mode toggle */}
            <div className="flex bg-slate-100 rounded-lg p-1 gap-0.5">
              <button
                onClick={() => setViewMode('tracker')}
                title="Tracker view — operational cards with next-step tracking"
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition ${viewMode === 'tracker' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Tracker
              </button>
              <button
                onClick={() => setViewMode('table')}
                title="Table view"
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition ${viewMode === 'table' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                <Table2 className="w-3.5 h-3.5" /> Table
              </button>
            </div>
            <button
              onClick={() => exportToCSV(filtered)}
              title="Export to CSV"
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
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
              placeholder="Search by name, address, investor, email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm w-80 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            {PIPELINE_STATUSES['Loans in Process'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {(search || loFilter !== 'All' || statusFilter !== 'All') && (
            <button
              onClick={() => { setSearch(''); setLoFilter('All'); setStatusFilter('All') }}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Tracker view (default) ────────────────────────────────────────── */}
      {!loading && viewMode === 'tracker' && (
        <div className="flex-1 overflow-y-auto">
          <EscrowTracker
            deals={filtered}
            onUpdate={async (id, patch) => {
              const { error } = await supabase.from('deals').update(patch).eq('id', id)
              if (!error) {
                // Optimistically update local state so UI reflects the change
                setDeals(prev => prev.map(d => d.id === id ? { ...d, ...patch } as Deal : d))
              }
              if (typeof patch.status === 'string') {
                void pushStageToGHL(id, patch.status)
              }
            }}
          />
        </div>
      )}

      {/* ── Table view ─────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : viewMode === 'table' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
            <table className="min-w-max w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  {/* Select-all checkbox */}
                  <th className="px-4 py-3 w-10">
                    <button onClick={toggleSelectAll} className="text-slate-400 hover:text-blue-600 transition-colors">
                      {allFilteredSelected
                        ? <CheckSquare className="w-4 h-4 text-blue-600" />
                        : <div className="w-4 h-4 rounded border-2 border-slate-300 hover:border-blue-400" />
                      }
                    </button>
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Name</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Status</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Loan Type</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Loan Amount</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">LO</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Investor</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Rate</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Added</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="text-center py-12 text-slate-400">
                      No deals found
                    </td>
                  </tr>
                ) : (
                  filtered.map(deal => {
                    const isSelected = selectedIds.has(deal.id)
                    const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

                    function ec(field: string) {
                      return editCell?.id === deal.id && editCell.field === field
                    }
                    function ic(field: string, value: unknown, type: DealsInlineCellProps['type'], opts?: readonly string[], stepVal?: string, display?: React.ReactNode) {
                      return (
                        <DealsInlineCell
                          deal={deal} field={field} value={value} type={type}
                          options={opts} step={stepVal}
                          isEditing={ec(field)}
                          onStartEdit={() => setEditCell({ id: deal.id, field })}
                          onSave={async v => { setEditCell(null); await handleCellUpdate(deal.id, field, v) }}
                          onCancel={() => setEditCell(null)}
                          displayRender={display}
                        />
                      )
                    }

                    return (
                      <tr
                        key={deal.id}
                        className={`hover:bg-slate-50 transition-colors ${isSelected ? 'bg-blue-50' : ''}`}
                      >
                        {/* Checkbox */}
                        <td className="px-4 py-3">
                          <button onClick={() => toggleSelect(deal.id)} className="text-slate-400 hover:text-blue-600 transition-colors">
                            {isSelected
                              ? <CheckSquare className="w-4 h-4 text-blue-600" />
                              : <div className="w-4 h-4 rounded border-2 border-slate-300 hover:border-blue-400" />
                            }
                          </button>
                        </td>
                        {/* Name */}
                        <td className="px-4 py-3 min-w-[160px]">
                          {ec('name') ? (
                            <DealsInlineCell
                              deal={deal} field="name" value={deal.name} type="text"
                              isEditing
                              onStartEdit={() => setEditCell({ id: deal.id, field: 'name' })}
                              onSave={async v => { setEditCell(null); await handleCellUpdate(deal.id, 'name', v) }}
                              onCancel={() => setEditCell(null)}
                            />
                          ) : (
                            <div className="group/name">
                              <div className="flex items-center gap-1">
                                <Link href={`/deals/${deal.id}`} className="font-semibold text-slate-900 hover:text-blue-600">
                                  {deal.name}
                                </Link>
                                <button
                                  onClick={() => setEditCell({ id: deal.id, field: 'name' })}
                                  className="opacity-0 group-hover/name:opacity-100 p-0.5 text-slate-400 hover:text-blue-500 transition-all"
                                  title="Edit name"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                              </div>
                              {deal.property_address && (
                                <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[180px]">{deal.property_address}</p>
                              )}
                            </div>
                          )}
                        </td>
                        {/* Status */}
                        <td className="px-4 py-3 min-w-[130px]">
                          {ic('status', deal.status, 'select', PIPELINE_STATUSES['Loans in Process'],
                            undefined,
                            <span className={`text-xs px-2 py-1 rounded-md font-medium ${statusClass}`}>
                              {deal.status}
                            </span>
                          )}
                        </td>
                        {/* Loan Type */}
                        <td className="px-4 py-3 min-w-[130px]">
                          {ic('loan_type', deal.loan_type, 'select', LOAN_TYPES)}
                        </td>
                        {/* Loan Amount */}
                        <td className="px-4 py-3 min-w-[110px]">
                          {ic('loan_amount', deal.loan_amount, 'currency',
                            undefined, undefined,
                            deal.loan_amount
                              ? <span className="font-medium text-slate-800">{formatCurrency(deal.loan_amount)}</span>
                              : <span className="text-slate-300">—</span>
                          )}
                        </td>
                        {/* Loan Officer */}
                        <td className="px-4 py-3 min-w-[110px]">
                          {ic('loan_officer', deal.loan_officer, 'select', LOAN_OFFICERS)}
                        </td>
                        {/* Investor */}
                        <td className="px-4 py-3 min-w-[100px]">
                          {ic('investor', deal.investor, 'text')}
                        </td>
                        {/* Rate */}
                        <td className="px-4 py-3 min-w-[80px]">
                          {ic('rate', deal.rate, 'percent',
                            undefined, '0.001',
                            deal.rate != null
                              ? <span className="text-slate-600">{deal.rate}%</span>
                              : <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{formatDate(deal.created_at)}</td>
                        <td className="px-4 py-3">
                          <Link href={`/deals/${deal.id}`} className="text-slate-400 hover:text-blue-600 transition-colors">
                            <ExternalLink className="w-4 h-4" />
                          </Link>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Bulk action toolbar ─────────────────────────────────────────────── */}
      {someSelected && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 z-50 border border-slate-700">
          <span className="text-sm font-semibold text-white">{selectedIds.size} selected</span>
          <div className="w-px h-5 bg-slate-600" />

          {/* Change Status */}
          <select
            disabled={bulkProcessing}
            defaultValue=""
            onChange={e => { if (e.target.value) { bulkChangeStatus(e.target.value); e.target.value = '' } }}
            className="bg-slate-800 text-white text-sm px-3 py-1.5 rounded-lg border border-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 cursor-pointer"
          >
            <option value="" disabled>Change Status…</option>
            {PIPELINE_STATUSES['Loans in Process'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Change Group */}
          <select
            disabled={bulkProcessing}
            defaultValue=""
            onChange={e => { if (e.target.value) { bulkChangeGroup(e.target.value); e.target.value = '' } }}
            className="bg-slate-800 text-white text-sm px-3 py-1.5 rounded-lg border border-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 cursor-pointer"
          >
            <option value="" disabled>Change Group…</option>
            {PIPELINE_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>

          <div className="w-px h-5 bg-slate-600" />

          {/* Delete */}
          <button
            onClick={bulkDelete}
            disabled={bulkProcessing}
            className="text-red-400 hover:text-red-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {bulkProcessing ? 'Working…' : 'Delete'}
          </button>

          {/* Dismiss */}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-slate-400 hover:text-white transition-colors ml-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Export wrapped in Suspense for useSearchParams ────────────────────────────
export default function DealsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <DealsPageInner />
    </Suspense>
  )
}
