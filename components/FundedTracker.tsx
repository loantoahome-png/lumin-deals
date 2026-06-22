'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Deal, STATUS_COLORS, LOAN_OFFICERS } from '@/lib/types'
import { formatCurrency, formatPercent, titleCase, cleanSource } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import {
  CheckCircle2, Search, Copy, Check, Download,
  ChevronUp, ChevronDown, ArrowUpDown,
} from 'lucide-react'

// ── Funded pipeline stages (in lifecycle order) ──────────────────────────────
const FUNDED_STAGES = ['Loan Funded', 'Broker Check Received', 'Loan Finalized'] as const
const isFundedStage = (s: string) => (FUNDED_STAGES as readonly string[]).includes(s)

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtLocation(city: string | null | undefined, state: string | null | undefined): string {
  const c = (city ?? '').trim(), s = (state ?? '').trim()
  if (c && s) return `${c}, ${s}`
  return c || s || '—'
}

// ── Sortable column header (same pattern as the Contacts list) ───────────────
type SortKey = 'name' | 'lo' | 'location' | 'source' | 'stage' | 'type' | 'rate' | 'amount' | 'comp' | 'funded' | 'paid'

function SortTh({ label, k, sortKey, sortDir, onSort, align = 'left', className = '' }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: 'asc' | 'desc'
  onSort: (k: SortKey) => void; align?: 'left' | 'right'; className?: string
}) {
  const active = sortKey === k
  return (
    <th
      onClick={() => onSort(k)}
      className={`px-3 py-2 cursor-pointer select-none hover:text-slate-600 ${align === 'right' ? 'text-right' : ''} ${className}`}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        {label}
        {active
          ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-30" />}
      </span>
    </th>
  )
}

type Props = {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}

export default function FundedTracker({ deals, onUpdate }: Props) {
  const [search, setSearch] = useState('')
  const [loFilter, setLoFilter] = useState<'all' | string>('all')
  const [stageFilter, setStageFilter] = useState<'all' | string>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | string>('all')
  const [sortKey, setSortKey] = useState<SortKey>('funded')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  // Search → LO → stage → type. Search & LO first so the tab/dropdown counts reflect them.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return deals
    return deals.filter(d => {
      const hay = [d.name, d.loan_officer, d.property_address, d.city, d.state, d.source, d.investor, d.loan_type, d.email]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [deals, search])

  const loScoped = useMemo(() => searched.filter(d => {
    if (loFilter === 'all') return true
    return (d.loan_officer ?? '').toLowerCase().includes(loFilter.toLowerCase())
  }), [searched, loFilter])

  // Stage tab counts reflect search + LO (not the stage filter itself).
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: loScoped.length }
    for (const s of FUNDED_STAGES) counts[s] = 0
    let other = 0
    for (const d of loScoped) {
      if (isFundedStage(d.status)) counts[d.status]++
      else other++
    }
    if (other > 0) counts['Other'] = other
    return counts
  }, [loScoped])

  // Distinct loan types present (for the Type dropdown), most common first.
  const typeOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of loScoped) {
      const t = d.loan_type?.trim()
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [loScoped])

  const filtered = useMemo(() => loScoped.filter(d => {
    if (stageFilter !== 'all') {
      if (stageFilter === 'Other') { if (isFundedStage(d.status)) return false }
      else if (d.status !== stageFilter) return false
    }
    if (typeFilter !== 'all' && (d.loan_type ?? '') !== typeFilter) return false
    return true
  }), [loScoped, stageFilter, typeFilter])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const stageRank = (s: string) => {
      const i = (FUNDED_STAGES as readonly string[]).indexOf(s)
      return i === -1 ? FUNDED_STAGES.length : i
    }
    const val = (d: Deal): number | string => {
      switch (sortKey) {
        case 'name':     return (d.name ?? '').toLowerCase()
        case 'lo':       return (d.loan_officer ?? '').toLowerCase()
        case 'location': return `${(d.state ?? '').trim()} ${(d.city ?? '').trim()}`.toLowerCase()
        case 'source':   return (cleanSource(d.source) ?? '').toLowerCase()
        case 'stage':    return stageRank(d.status)
        case 'type':     return (d.loan_type ?? '').toLowerCase()
        case 'rate':     return d.rate ?? 0
        case 'amount':   return d.loan_amount ?? 0
        case 'comp':   return d.compensation_amount ?? 0
        case 'funded': return new Date(d.funded_date || d.created_at).getTime()
        case 'paid':   return d.paid_date ? new Date(d.paid_date).getTime() : 0
        default:       return 0
      }
    }
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b)
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir
      return (va - vb) * dir
    })
  }, [filtered, sortKey, sortDir])

  const stats = useMemo(() => ({
    count: filtered.length,
    volume: filtered.reduce((s, d) => s + (d.loan_amount || 0), 0),
    comp: filtered.reduce((s, d) => s + (d.compensation_amount || 0), 0),
  }), [filtered])

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(['name', 'lo', 'location', 'source', 'type'].includes(k) ? 'asc' : 'desc') }
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  const allVisibleSelected = sorted.length > 0 && sorted.every(d => selected.has(d.id))
  const toggleAll = () => {
    setSelected(prev => {
      if (sorted.every(d => prev.has(d.id))) {
        const next = new Set(prev); for (const d of sorted) next.delete(d.id); return next
      }
      const next = new Set(prev); for (const d of sorted) next.add(d.id); return next
    })
  }
  const toggleOne = (id: string) => setSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const copyEmails = async () => {
    const emails = deals.filter(d => selected.has(d.id) && d.email).map(d => d.email as string)
    if (emails.length === 0) return
    try {
      await navigator.clipboard.writeText([...new Set(emails)].join(', '))
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — no-op */ }
  }

  const exportCsv = () => {
    const rows = deals.filter(d => selected.has(d.id))
    if (rows.length === 0) return
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const header = ['Borrower', 'LO', 'City', 'State', 'Source', 'Stage', 'Type', 'Rate', 'Lender', 'Property', 'Loan amount', 'Comp', 'Funded date', 'Paid date', 'Arive file #']
    const lines = [header.join(',')]
    for (const d of rows) {
      lines.push([
        titleCase(d.name) || d.name || '',
        d.loan_officer || '',
        d.city || '', d.state || '', cleanSource(d.source) || '',
        d.status || '', d.loan_type || '', d.rate ?? '',
        d.investor || '', d.property_address || '',
        d.loan_amount || 0, d.compensation_amount || 0,
        d.funded_date || '', d.paid_date || '', d.arive_file_no || '',
      ].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `funded-loans-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  if (deals.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">No funded deals yet</p>
          <p className="text-xs text-slate-500 mt-1">Deals will show up here once they hit Loan Funded.</p>
        </div>
      </div>
    )
  }

  const stageTabs = ['all', ...FUNDED_STAGES, ...(stageCounts['Other'] ? ['Other'] : [])] as string[]

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="px-6 pt-4 pb-3 bg-white border-b border-slate-200 shrink-0 space-y-3">
        {/* Stats strip — reflects the active filters */}
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span className="text-slate-500"><span className="font-semibold text-slate-800">{stats.count.toLocaleString()}</span> deal{stats.count !== 1 ? 's' : ''}</span>
          <span className="text-slate-500"><span className="font-semibold text-slate-800">{formatCurrency(stats.volume)}</span> funded volume</span>
          {stats.comp > 0 && (
            <span className="text-slate-500"><span className="font-semibold text-emerald-700">{formatCurrency(stats.comp)}</span> comp</span>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, LO, property, investor, type…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Stage tabs + LO/Type dropdowns */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {stageTabs.map(t => (
              <button
                key={t}
                onClick={() => setStageFilter(t)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                  stageFilter === t ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {t === 'all' ? 'All' : t} <span className={stageFilter === t ? 'text-slate-300' : 'text-slate-400'}>({stageCounts[t] ?? 0})</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={loFilter}
              onChange={e => setLoFilter(e.target.value)}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              title="Filter by loan officer"
            >
              <option value="all">All LOs</option>
              {LOAN_OFFICERS.map(lo => <option key={lo} value={lo}>{lo}</option>)}
            </select>
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              title="Filter by loan type"
            >
              <option value="all">All types</option>
              {typeOptions.map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Bulk-select bar */}
      {selected.size > 0 && (
        <div className="px-6 py-2 bg-blue-50 border-b border-blue-200 flex items-center gap-4 shrink-0">
          <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
          <button onClick={copyEmails} className="flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy emails'}
          </button>
          <button onClick={exportCsv} className="flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-slate-500 hover:text-slate-700 ml-auto">Clear</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-400 px-6 py-4">No funded deals match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="pl-6 pr-2 py-2 w-10">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="rounded border-slate-300" aria-label="Select all" />
                </th>
                <SortTh label="Borrower" k="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="LO" k="lo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Location" k="location" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Source" k="source" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Stage" k="stage" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Type" k="type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Rate" k="rate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortTh label="Loan amount" k="amount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortTh label="Comp" k="comp" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortTh label="Funded" k="funded" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortTh label="Paid" k="paid" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="pr-6" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((d, i) => {
                const isSel = selected.has(d.id)
                const rowBg = isSel ? 'bg-blue-50' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50'
                const ghlUrl = ghlContactUrl(d)
                const aUrl = ariveUrl(d.arive_file_no)
                const name = titleCase(d.name) || d.name || '(no name)'
                const src = cleanSource(d.source)
                const loc = fmtLocation(d.city, d.state)
                return (
                  <tr key={d.id} className={`border-b border-slate-100 ${rowBg} ${isSel ? '' : 'hover:bg-slate-100'}`}>
                    <td className="pl-6 pr-2 py-2.5 align-top">
                      <input type="checkbox" checked={isSel} onChange={() => toggleOne(d.id)} className="mt-0.5 rounded border-slate-300" aria-label={`Select ${name}`} />
                    </td>
                    {/* Borrower — name + quick links, property as sub-line */}
                    <td className="px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Link href={`/deals/${d.id}`} title={name} className="font-medium text-slate-900 hover:text-blue-700 truncate">
                            {name}
                          </Link>
                          {ghlUrl && (
                            <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
                              title="Open contact in GoHighLevel"
                              className="text-[9px] font-bold text-blue-700 hover:text-white hover:bg-blue-600 px-1.5 py-0.5 rounded border border-blue-200 transition-colors shrink-0">
                              GHL
                            </a>
                          )}
                          {aUrl && (
                            <a href={aUrl} target="_blank" rel="noopener noreferrer"
                              title="Open loan file in Arive"
                              className="text-[9px] font-bold text-orange-700 hover:text-white hover:bg-orange-600 px-1.5 py-0.5 rounded border border-orange-200 transition-colors shrink-0">
                              Arive
                            </a>
                          )}
                        </div>
                        {d.property_address && (
                          <span className="text-xs text-slate-400 truncate block">📍 {d.property_address}</span>
                        )}
                      </div>
                    </td>
                    {/* LO */}
                    <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{d.loan_officer || '—'}</td>
                    {/* Location (city, state) */}
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">
                      {loc === '—' ? <span className="text-slate-300">—</span> : loc}
                    </td>
                    {/* Lead source */}
                    <td className="px-3 py-2.5 text-slate-600">
                      <span className="block max-w-[150px] truncate" title={src ?? undefined}>{src || <span className="text-slate-300">—</span>}</span>
                    </td>
                    {/* Stage — inline editable (advances the loan + pushes to GHL) */}
                    <td className="px-3 py-2.5">
                      <StageSelect deal={d} onUpdate={onUpdate} />
                    </td>
                    {/* Type + investor */}
                    <td className="px-3 py-2.5">
                      {d.loan_type ? <span className="text-slate-700">{d.loan_type}</span> : <span className="text-slate-300">—</span>}
                      {d.investor && <span className="text-xs text-slate-400 block truncate">{d.investor}</span>}
                    </td>
                    {/* Rate */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">
                      {d.rate != null ? formatPercent(d.rate) : <span className="text-slate-300">—</span>}
                    </td>
                    {/* Loan amount */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-slate-800 whitespace-nowrap">
                      {d.loan_amount ? formatCurrency(d.loan_amount) : '—'}
                    </td>
                    {/* Comp */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">
                      {d.compensation_amount ? formatCurrency(d.compensation_amount) : '—'}
                    </td>
                    {/* Funded */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtDate(d.funded_date)}</td>
                    {/* Paid */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap pr-6">{fmtDate(d.paid_date)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// Inline stage editor — preserves the old kanban's stage-advance + GHL push, in list form.
function StageSelect({ deal, onUpdate }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const onStage = isFundedStage(deal.status)
  const pill = STATUS_COLORS[deal.status] || 'bg-slate-100 text-slate-600'
  return (
    <div className="relative inline-flex items-center">
      <select
        value={onStage ? deal.status : ''}
        onChange={e => { if (e.target.value && e.target.value !== deal.status) onUpdate(deal.id, { status: e.target.value }) }}
        className={`appearance-none cursor-pointer text-[11px] font-semibold pl-2.5 pr-6 py-0.5 rounded-full ${pill} focus:outline-none focus:ring-2 focus:ring-blue-400`}
        title="Change funded stage (pushes to GHL)"
      >
        {!onStage && <option value="">{deal.status}</option>}
        {FUNDED_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <ChevronDown className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
    </div>
  )
}
