'use client'

/**
 * Lead ROI — the unified lead reporting page (Lead Performance + Lead Spend merged).
 *
 * One filter bar, one set of definitions (docs/specs/2026-07-13-lead-roi-unified-spec.md):
 *   • Per-LO ONLY — single-LO tabs, no combined view (Efrain's call 2026-07-13).
 *   • ROI = revenue ÷ spend as a multiple; spend = lead prices + retainers.
 *   • Funded = isFunded (group OR funded statuses) everywhere.
 *
 * All aggregation lives in lib/leadRoi.ts (pure, fixture-tested via
 * scripts/lead-roi-check.ts). This file is rendering + the admin actions
 * (retainer editor, source recategorization) carried over from Lead Spend.
 */

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS, PIPELINE_GROUPS, PIPELINE_STATUSES } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { rrBand, isFunded, PURCHASED_SOURCES, type Purpose, type SourceScope } from '@/lib/leadReport'
import {
  RANGE_OPTIONS, rangeBounds, monthsBetween, filterDeals, buildSourceStats, rollupKpis,
  funnel, stateRows, monthlySeries, projection, optout7dStats, insights,
  type RangeKey, type CostRow,
} from '@/lib/leadRoi'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import {
  RefreshCw, Download, Target, Users, TrendingUp, DollarSign, CheckCircle2, Calendar,
  ChevronDown, ChevronRight, ChevronsUpDown, ChevronsDownUp, ExternalLink, Pencil, Check, X,
  Filter, ArrowRight, Save, FileText,
} from 'lucide-react'

const LEAD_COLS = 'id,name,source,loan_officer,pipeline_group,status,loan_amount,state,loan_purpose,lead_price,compensation_amount,date_added_ghl,funded_date,created_at,ghl_opportunity_id'

const PURPOSE_TABS: Purpose[] = ['All', 'Purchase', 'Refinance']
const SCOPE_TABS: SourceScope[] = ['Purchased', 'All']

// LO tab accents keyed by canonical name — new LOs get the fallback accent.
const LO_ACCENT: Record<string, string> = {
  'Moe Sefati':   'bg-indigo-600 border-indigo-600',
  'Matt Park':    'bg-emerald-600 border-emerald-600',
  'Randy Mathis': 'bg-violet-600 border-violet-600',
}

const pct = (x: number) => x.toFixed(1) + '%'
const money = (x: number | null | undefined) => (x == null ? '—' : formatCurrency(x))
const roiFmt = (x: number | null) => (x == null ? '—' : x.toFixed(2) + '×')
const roiColor = (x: number | null) => (x == null ? 'text-slate-400' : x >= 1 ? 'text-emerald-600' : 'text-red-600')
const RR_COLOR: Record<'good' | 'mid' | 'bad', string> = {
  good: 'text-emerald-600', mid: 'text-amber-600', bad: 'text-red-600',
}
const RR_PILL: Record<'good' | 'mid' | 'bad', string> = {
  good: 'bg-emerald-50 text-emerald-700', mid: 'bg-amber-50 text-amber-700', bad: 'bg-red-50 text-red-600',
}
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Donut palette — validated distinct hues (not the old all-green ramp); gray = Other.
const DONUT_COLORS = ['#059669', '#4f46e5', '#b45309', '#0369a1', '#0d9488', '#7c3aed', '#be185d', '#4d7c0f']

export default function LeadRoiPage() {
  const [deals, setDeals]     = useState<Deal[]>([])
  const [costs, setCosts]     = useState<Map<string, CostRow>>(new Map())
  // opportunity_id → earliest logged opt-out event (stage_events; forward-only)
  const [firstOptout, setFirstOptout] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  // Single-LO tabs — the stats are never combined across LOs.
  const [lo, setLo]           = useState<string>('Moe Sefati')
  const [range, setRange]     = useState<RangeKey>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo]     = useState('')
  const [scope, setScope]     = useState<SourceScope>('Purchased')
  const [purpose, setPurpose] = useState<Purpose>('All')
  const [stage, setStage]     = useState<string>('')
  const [includedSources, setIncludedSources] = useState<Set<string> | null>(null)
  const [showSourceFilter, setShowSourceFilter] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editingCost, setEditingCost] = useState<string | null>(null)
  const [editCostValue, setEditCostValue] = useState('')
  const [editCostNotes, setEditCostNotes] = useState('')

  async function load() {
    setLoading(true)
    const rows = await fetchAllDeals(q => q.order('created_at', { ascending: false }), LEAD_COLS)
    setDeals(rows)
    try {
      const res = await fetch('/api/lead-source-costs', { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; costs?: CostRow[] }
      if (data.ok && data.costs) setCosts(new Map(data.costs.map(c => [c.source, c])))
    } catch {}
    try {
      const res = await fetch('/api/stage-events/first-optout', { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; firstOptout?: Record<string, string> }
      if (data.ok && data.firstOptout) setFirstOptout(data.firstOptout)
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // ── Pipeline: filter → per-source stats → KPIs (all pure, lib/leadRoi) ──────
  const { start, end } = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo])
  const months = useMemo(() => monthsBetween(start, end), [start, end])
  const filtered = useMemo(
    () => filterDeals(deals, { lo, scope, purpose, stage, start, end }),
    [deals, lo, scope, purpose, stage, start, end],
  )
  const sources = useMemo(() => buildSourceStats(filtered, costs, months), [filtered, costs, months])
  const visibleSources = useMemo(
    () => includedSources ? sources.filter(s => includedSources.has(s.source)) : sources,
    [sources, includedSources],
  )
  const visibleDeals = useMemo(() => visibleSources.flatMap(s => s.deals), [visibleSources])
  const kpis = useMemo(() => rollupKpis(visibleSources), [visibleSources])
  const funnelStages = useMemo(() => funnel(kpis), [kpis])
  const states = useMemo(() => stateRows(visibleDeals), [visibleDeals])
  const retainerPerMonth = useMemo(() => visibleSources.reduce((a, s) => a + s.costPerMonth, 0), [visibleSources])
  const monthly = useMemo(() => monthlySeries(visibleDeals, retainerPerMonth), [visibleDeals, retainerPerMonth])
  const proj = useMemo(() => projection(visibleSources, kpis), [visibleSources, kpis])
  const o7 = useMemo(() => optout7dStats(visibleDeals, firstOptout), [visibleDeals, firstOptout])
  const ins = useMemo(() => insights(visibleSources), [visibleSources])

  const fundedView = useMemo(() => {
    const list = visibleDeals
      .filter(isFunded)
      .sort((a, b) => new Date(b.funded_date || b.created_at).getTime() - new Date(a.funded_date || a.created_at).getTime())
    const volume = list.reduce((a, d) => a + (d.loan_amount ?? 0), 0)
    const comp = list.reduce((a, d) => a + (d.compensation_amount ?? 0), 0)
    return { list, volume, comp }
  }, [visibleDeals])

  const allKnownSources = useMemo(() => {
    const set = new Set<string>()
    for (const d of deals) { const s = (d.source ?? '').trim(); if (s) set.add(s) }
    for (const k of costs.keys()) set.add(k)
    return [...set].sort()
  }, [deals, costs])

  const rangeLabel = useMemo(() => RANGE_OPTIONS.find(o => o.key === range)?.label ?? 'All time', [range])
  const dateWindow = useMemo(() => {
    if (start || end) return `${start ? fmtDate(start.toISOString()) : '…'} – ${end ? fmtDate(end.toISOString()) : '…'}`
    return null
  }, [start, end])

  // ── Report route link (replaces the popup Visual Report) ────────────────────
  const reportHref = useMemo(() => {
    const p = new URLSearchParams({ lo, range, scope, purpose })
    if (stage) p.set('stage', stage)
    if (range === 'custom') { if (customFrom) p.set('from', customFrom); if (customTo) p.set('to', customTo) }
    if (includedSources) p.set('sources', [...includedSources].join('|'))
    return `/lead-roi/report?${p.toString()}`
  }, [lo, range, scope, purpose, stage, customFrom, customTo, includedSources])

  // ── CSV (superset of both old exports) ──────────────────────────────────────
  function exportCsv() {
    const headers = [
      'Source', 'Leads', 'Responded', 'Resp %', 'No Resp', 'Opt-out', 'Opt-out %',
      'Open', 'Active', 'Lost', 'Funded', 'Fund %', 'Funded Volume', 'Avg Funded',
      'Lead Cost', 'Retainer', 'Spend', 'Revenue', 'Net Profit', 'ROI x', 'Cost per Funded', 'Monthly Cost',
    ]
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = visibleSources.map(s => [
      s.source, s.total, s.responded, s.rr.toFixed(1), s.cold, s.optout, s.orate.toFixed(1),
      s.open, s.active, s.lost, s.funded, s.fr.toFixed(1), s.fundedVolume, s.fundedAvg.toFixed(0),
      s.leadCost.toFixed(0), s.retainer.toFixed(0), s.spend.toFixed(0), s.revenue.toFixed(0),
      s.netProfit.toFixed(0), s.roi == null ? '' : s.roi.toFixed(2), s.costPerFunded == null ? '' : s.costPerFunded.toFixed(0),
      s.costPerMonth,
    ].map(escape).join(','))
    const csv = '﻿' + [headers.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lumin-lead-roi-${lo.split(' ')[0].toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Retainer cost editing (lead_source_costs) ───────────────────────────────
  function startEditCost(src: string) {
    setEditingCost(src)
    const c = costs.get(src)
    setEditCostValue(String(c?.cost_per_month ?? ''))
    setEditCostNotes(c?.notes ?? '')
  }
  async function saveCost(src: string) {
    const cpm = Number(editCostValue) || 0
    const notes = editCostNotes.trim() || null
    const res = await fetch('/api/lead-source-costs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, cost_per_month: cpm, notes }),
    })
    if (res.ok) {
      setCosts(prev => {
        const next = new Map(prev)
        next.set(src, { source: src, cost_per_month: cpm, notes, updated_at: new Date().toISOString() })
        return next
      })
      setEditingCost(null)
    }
  }
  function cancelEditCost() { setEditingCost(null); setEditCostValue(''); setEditCostNotes('') }

  // ── Recategorize (single + bulk) — carried over from Lead Spend ─────────────
  async function changeDealSource(dealId: string, newSource: string) {
    const trimmed = newSource.trim()
    if (!trimmed) return
    setDeals(prev => prev.map(d => d.id === dealId ? ({ ...d, source: trimmed } as Deal) : d))
    const { error } = await supabase.from('deals').update({ source: trimmed }).eq('id', dealId)
    if (error) console.error('Reassign source failed:', error.message)
  }
  async function bulkReassignSource(fromSource: string, toSource: string) {
    const trimmed = toSource.trim()
    if (!trimmed || trimmed === fromSource) return
    const realSource = fromSource === '(no source set)' ? null : fromSource
    const dealsToMove = deals.filter(d => (d.source ?? null) === (realSource ?? null))
    if (dealsToMove.length === 0) return
    if (!confirm(`Reassign ${dealsToMove.length} deal${dealsToMove.length === 1 ? '' : 's'} from "${fromSource}" to "${trimmed}"?`)) return
    const ids = dealsToMove.map(d => d.id)
    setDeals(prev => prev.map(d => ids.includes(d.id) ? ({ ...d, source: trimmed } as Deal) : d))
    const { error } = realSource === null
      ? await supabase.from('deals').update({ source: trimmed }).is('source', null)
      : await supabase.from('deals').update({ source: trimmed }).eq('source', realSource)
    if (error) { console.error('Bulk reassign failed:', error.message); alert(`Bulk reassign failed: ${error.message}`) }
  }

  function toggleExpand(src: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src); else next.add(src)
      return next
    })
  }
  const allExpanded = visibleSources.length > 0 && visibleSources.every(s => expanded.has(s.source))
  function toggleExpandAll() {
    setExpanded(allExpanded ? new Set() : new Set(visibleSources.map(s => s.source)))
  }

  // ── Donut data ───────────────────────────────────────────────────────────────
  const donutData = useMemo(() => {
    const withFunded = visibleSources.filter(s => s.funded > 0).sort((a, b) => b.funded - a.funded)
    const TOP = 8
    const top = withFunded.slice(0, TOP)
    const rest = withFunded.slice(TOP)
    const data = top.map(s => ({ name: s.source, funded: s.funded, volume: s.fundedVolume, isOther: false }))
    if (rest.length) data.push({
      name: `Other (${rest.length})`,
      funded: rest.reduce((a, s) => a + s.funded, 0),
      volume: rest.reduce((a, s) => a + s.fundedVolume, 0),
      isOther: true,
    })
    return data
  }, [visibleSources])
  const donutTotal = useMemo(() => donutData.reduce((a, d) => a + d.funded, 0), [donutData])

  const renderDonutTooltip = (props: { active?: boolean; payload?: Array<{ payload: { name: string; funded: number; volume: number } }> }) => {
    if (!props.active || !props.payload?.length) return null
    const d = props.payload[0].payload
    const share = donutTotal > 0 ? ((d.funded / donutTotal) * 100).toFixed(1) : '0'
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
        <p className="font-semibold text-slate-900">{d.name}</p>
        <p className="text-emerald-700 font-medium">{d.funded} funded · {share}%</p>
        <p className="text-slate-500">{formatCurrency(d.volume)} volume</p>
      </div>
    )
  }

  const renderMonthTooltip = (props: { active?: boolean; label?: string; payload?: Array<{ payload: { label: string; spend: number; revenue: number; roi: number | null } }> }) => {
    if (!props.active || !props.payload?.length) return null
    const p = props.payload[0].payload
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs space-y-0.5">
        <p className="font-semibold text-slate-900">{p.label}</p>
        <p className="text-rose-600">Spend {formatCurrency(p.spend)}</p>
        <p className="text-emerald-700">Revenue {formatCurrency(p.revenue)}</p>
        <p className={p.roi != null && p.roi >= 1 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'}>
          ROI {p.roi == null ? '—' : p.roi.toFixed(2) + '×'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-600" /> Lead ROI
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              What leads cost, how they responded, what they earned — {scope === 'All' ? 'all sources' : 'purchased only'} · {lo}
              {dateWindow && <span className="text-slate-400"> · {dateWindow}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={toggleExpandAll} disabled={visibleSources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-40">
              {allExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
            <Link href={reportHref} target="_blank"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg ${visibleSources.length === 0 ? 'pointer-events-none opacity-40' : ''}`}>
              <FileText className="w-3.5 h-3.5" /> Visual Report
            </Link>
            <button onClick={exportCsv} disabled={visibleSources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
            <button onClick={load} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* LO tabs — one LO at a time, never combined */}
        <div className="flex gap-2 mb-3">
          {LOAN_OFFICERS.map(name => {
            const active = lo === name
            const accent = LO_ACCENT[name] ?? 'bg-slate-700 border-slate-700'
            return (
              <button key={name} onClick={() => setLo(name)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-base font-bold border-2 transition-all ${
                  active ? `${accent} text-white shadow-md` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                }`}>
                <Users className="w-4 h-4" />
                {name}
              </button>
            )
          })}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Range</label>
            <select value={range} onChange={e => setRange(e.target.value as RangeKey)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              {RANGE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          {range === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <Calendar className="w-3.5 h-3.5" />
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700" />
              <span className="text-slate-400">to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700" />
            </div>
          )}
          {/* Scope — Purchased (vendor ROI funnel) vs All sources */}
          <div className="flex items-center gap-1">
            {SCOPE_TABS.map(t => (
              <button key={t} onClick={() => setScope(t)}
                title={t === 'Purchased' ? `Vendor-bought leads only (${PURCHASED_SOURCES.join(', ')})` : 'Every source, incl. Return Client / Referrals'}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                  scope === t ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}>
                {t === 'Purchased' ? 'Purchased' : 'All sources'}
              </button>
            ))}
          </div>
          {/* Purpose */}
          <div className="flex items-center gap-1">
            {PURPOSE_TABS.map(t => (
              <button key={t} onClick={() => setPurpose(t)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                  purpose === t ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}>
                {t === 'All' ? 'All purposes' : t}
              </button>
            ))}
          </div>
          {/* Stage */}
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stage</label>
            <select value={stage} onChange={e => setStage(e.target.value)}
              className={`text-sm border rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                stage ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-700'
              }`}>
              <option value="">All stages</option>
              {PIPELINE_GROUPS.map(g => (
                <optgroup key={g} label={`${g} (whole group)`}>
                  <option value={g}>▸ All {g}</option>
                  {(PIPELINE_STATUSES[g] ?? []).map(st => (
                    <option key={`${g}:${st}`} value={st}>&nbsp;&nbsp;{st}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {/* Source multi-select */}
          <div className="relative">
            <button onClick={() => setShowSourceFilter(v => !v)}
              className={`flex items-center gap-1.5 text-sm border rounded-lg px-3 py-1.5 transition-colors ${
                includedSources ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
              }`}>
              <Filter className="w-3.5 h-3.5" />
              {includedSources ? `${includedSources.size} of ${allKnownSources.length} sources` : `All ${allKnownSources.length} sources`}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showSourceFilter && (
              <div className="absolute top-full mt-1 left-0 z-30 bg-white border border-slate-200 rounded-lg shadow-xl w-72 max-h-80 overflow-hidden flex flex-col"
                onMouseLeave={() => setShowSourceFilter(false)}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 text-xs">
                  <button onClick={() => setIncludedSources(null)} className="text-blue-600 hover:underline font-medium">Select all</button>
                  <button onClick={() => setIncludedSources(new Set())} className="text-slate-500 hover:text-slate-800">Clear all</button>
                </div>
                <div className="overflow-y-auto flex-1">
                  {allKnownSources.map(src => {
                    const isOn = !includedSources || includedSources.has(src)
                    return (
                      <label key={src} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-sm">
                        <input type="checkbox" checked={isOn}
                          onChange={() => {
                            setIncludedSources(prev => {
                              const base = prev ?? new Set(allKnownSources)
                              const next = new Set(base)
                              if (next.has(src)) next.delete(src); else next.add(src)
                              return next
                            })
                          }}
                          className="rounded accent-blue-600" />
                        <span className="flex-1 truncate text-slate-700">{src}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          <span className="text-[11px] text-slate-400 ml-auto">Range covers ~{months.toFixed(1)} months</span>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <>
            {/* Summary — computed narrative + best-performer callouts */}
            {kpis.totalLeads > 0 && (
              <div className="px-6 pt-4 bg-slate-50/60">
                <div className="bg-white border border-indigo-200 rounded-xl overflow-hidden">
                  <div className="border-l-4 border-indigo-500 px-4 py-3.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500 mb-1.5">
                      Summary · {lo} · {rangeLabel}{scope === 'Purchased' ? ' · purchased leads' : ' · all sources'}
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      <b className="text-slate-900">{kpis.totalLeads.toLocaleString()} leads</b> —{' '}
                      <b className={RR_COLOR[rrBand(kpis.rr)]}>{pct(kpis.rr)} responded</b>,{' '}
                      <b className="text-slate-900">{kpis.funded} funded</b> ({pct(kpis.fr)}) for{' '}
                      <b className="text-slate-900">{formatCurrency(kpis.volume)}</b> in volume.{' '}
                      {kpis.spend > 0 && <>Spent <b className="text-rose-600">{formatCurrency(kpis.spend)}</b>, earned back{' '}
                      <b className="text-emerald-700">{formatCurrency(kpis.revenue)}</b> —{' '}
                      <b className={kpis.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>{kpis.netProfit >= 0 ? '+' : ''}{formatCurrency(kpis.netProfit)} net</b>
                      {kpis.roi != null && <> at <b className={roiColor(kpis.roi)}>{kpis.roi.toFixed(2)}× ROI</b></>}.{' '}</>}
                      {kpis.optout > 0 && <>
                        <b className="text-slate-900">{kpis.optout}</b> opted out ({pct(kpis.orate)})
                        {o7.timed > 0
                          ? <> — of the {o7.timed} with logged timing, <b className="text-slate-900">{o7.within} ({o7.withinPct.toFixed(0)}%)</b> opted out within {o7.days} days of creation{o7.coverage < 99.5 && <span className="text-slate-400"> (timing covers {o7.coverage.toFixed(0)}% of opt-outs)</span>}.</>
                          : <span className="text-slate-400"> — no opt-out timing logged yet (fills forward via the stage webhook).</span>}
                      </>}
                    </p>
                    {(ins.bestRoi || ins.topNet || ins.bestResponse || ins.worstRoi) && (
                      <div className="flex flex-wrap gap-2 mt-2.5">
                        {ins.bestRoi && (
                          <span className="inline-flex items-center gap-1.5 text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full px-3 py-1">
                            🏆 <b>Best performer: {ins.bestRoi.source}</b> · {ins.bestRoi.roi?.toFixed(2)}× ROI ({formatCurrency(ins.bestRoi.spend)} → {formatCurrency(ins.bestRoi.revenue)})
                          </span>
                        )}
                        {ins.topNet && ins.topNet.source !== ins.bestRoi?.source && (
                          <span className="inline-flex items-center gap-1.5 text-xs bg-emerald-50/60 border border-emerald-200 text-emerald-800 rounded-full px-3 py-1">
                            Biggest earner: <b>{ins.topNet.source}</b> · +{formatCurrency(ins.topNet.netProfit)} net · {ins.topNet.funded} funded
                          </span>
                        )}
                        {ins.bestResponse && (
                          <span className="inline-flex items-center gap-1.5 text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded-full px-3 py-1">
                            Best response: <b>{ins.bestResponse.source}</b> · {pct(ins.bestResponse.rr)}
                          </span>
                        )}
                        {ins.worstRoi && (
                          <span className="inline-flex items-center gap-1.5 text-xs bg-red-50 border border-red-200 text-red-700 rounded-full px-3 py-1">
                            Underwater: <b>{ins.worstRoi.source}</b> · {ins.worstRoi.roi?.toFixed(2)}× ({formatCurrency(ins.worstRoi.netProfit)} net)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* KPIs */}
            <div className="px-6 py-4 bg-slate-50/60 border-b border-slate-200 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <Kpi icon={<Users className="w-4 h-4 text-blue-500" />} label={scope === 'All' ? 'Total leads' : 'Purchased leads'} value={kpis.totalLeads.toLocaleString()} />
                <Kpi icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />} label="Responded" value={pct(kpis.rr)} sub={`${kpis.responded} leads`} valueClass={RR_COLOR[rrBand(kpis.rr)]} />
                <Kpi icon={<X className="w-4 h-4 text-slate-400" />} label="No response" value={pct(kpis.crate)} sub={`${kpis.cold} leads`} />
                <Kpi icon={<X className="w-4 h-4 text-rose-400" />} label="Opted out / DND" value={pct(kpis.orate)} sub={`${kpis.optout} leads`} />
                <Kpi icon={<Calendar className="w-4 h-4 text-rose-500" />} label={`Opt-out ≤ ${o7.days}d`}
                  value={o7.timed > 0 ? `${o7.withinPct.toFixed(0)}%` : '—'}
                  sub={o7.timed > 0 ? `${o7.within} of ${o7.timed} timed · covers ${o7.coverage.toFixed(0)}%` : 'no timing logged yet'} />
                <Kpi icon={<TrendingUp className="w-4 h-4 text-amber-500" />} label="Active escrows" value={kpis.active.toLocaleString()} />
                <Kpi icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} label="Funded" value={kpis.funded.toLocaleString()} sub={`${pct(kpis.fr)} · ${formatCurrency(kpis.volume)}`} highlight="good" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <Kpi icon={<DollarSign className="w-4 h-4 text-rose-500" />} label="Spend" value={kpis.spend > 0 ? formatCurrency(kpis.spend) : '—'}
                  sub={kpis.retainer > 0 ? `${formatCurrency(kpis.leadCost)} leads + ${formatCurrency(kpis.retainer)} retainers` : 'lead prices'} />
                <Kpi icon={<DollarSign className="w-4 h-4 text-emerald-600" />} label="Revenue" value={kpis.revenue > 0 ? formatCurrency(kpis.revenue) : '—'} sub="comp on funded only" />
                <Kpi icon={<DollarSign className="w-4 h-4 text-emerald-700" />} label="Net profit"
                  value={(kpis.revenue > 0 || kpis.spend > 0) ? formatCurrency(kpis.netProfit) : '—'}
                  highlight={kpis.netProfit >= 0 ? 'good' : 'bad'} />
                <Kpi icon={<TrendingUp className="w-4 h-4 text-emerald-700" />} label="ROI" value={roiFmt(kpis.roi)}
                  sub={kpis.roi != null ? `$${kpis.roi.toFixed(2)} back per $1` : 'no priced spend'}
                  highlight={kpis.roi != null && kpis.roi >= 1 ? 'good' : kpis.roi != null ? 'bad' : undefined} />
                <Kpi icon={<Target className="w-4 h-4 text-indigo-500" />} label="Cost / funded"
                  value={kpis.costPerFunded != null ? formatCurrency(kpis.costPerFunded) : '—'}
                  sub={kpis.avgComp != null ? `vs ${formatCurrency(kpis.avgComp)} avg comp` : undefined} highlight />
              </div>
            </div>

            {/* Lifecycle funnel */}
            <div className="px-6 py-4 bg-white border-b border-slate-200">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Lead lifecycle</h3>
              <div className="space-y-1.5 max-w-3xl">
                {funnelStages.map((s, i) => {
                  const prev = funnelStages[i - 1]
                  const stepConv = prev && prev.n > 0 ? (100 * s.n) / prev.n : null
                  const FUNNEL_BG = ['bg-indigo-200', 'bg-indigo-300', 'bg-indigo-400', 'bg-indigo-600']
                  return (
                    <React.Fragment key={s.key}>
                      {stepConv != null && (
                        <div className="pl-[150px] text-[10.5px] text-slate-400">
                          ↳ <b className="text-slate-600">{stepConv.toFixed(1)}%</b> of the stage above
                        </div>
                      )}
                      <div className="grid grid-cols-[150px_1fr_150px] items-center gap-3">
                        <span className="text-xs font-bold text-slate-600">{s.label}
                          <span className="block text-[10px] font-medium text-slate-400">{s.sub}</span>
                        </span>
                        <div className="bg-slate-100 rounded-md h-6 overflow-hidden">
                          <div className={`h-full rounded-md ${FUNNEL_BG[i] ?? 'bg-indigo-600'}`} style={{ width: `${Math.max(0.5, s.pctOfLeads)}%` }} />
                        </div>
                        <span className="text-xs text-right text-slate-500 tabular-nums"><b className="text-slate-800 text-sm">{s.n.toLocaleString()}</b> · {s.pctOfLeads.toFixed(1)}%</span>
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>

            {/* Monthly spend vs revenue */}
            {monthly.length > 1 && (
              <div className="px-6 py-4 bg-white border-b border-slate-200">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Spend vs revenue by month</h3>
                <p className="text-[11px] text-slate-400 mb-3">Revenue lands on the funding month; spend on the month the lead came in{retainerPerMonth > 0 ? ` (+ ${formatCurrency(retainerPerMonth)}/mo retainers)` : ''}.</p>
                <div className="flex items-center gap-4 text-[11px] text-slate-600 mb-2">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-600 inline-block" /> Spend</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" /> Revenue</span>
                </div>
                <div style={{ width: '100%', height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthly} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barGap={3}>
                      <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`} width={44} />
                      <Tooltip content={renderMonthTooltip as never} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                      <Bar dataKey="spend" fill="#e11d48" radius={[3, 3, 0, 0]} maxBarSize={34} />
                      <Bar dataKey="revenue" fill="#059669" radius={[3, 3, 0, 0]} maxBarSize={34} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* Per-month ROI chips (own scale — no second axis on the chart) */}
                <div className="flex flex-wrap gap-2 mt-2">
                  {monthly.map(p => (
                    <span key={p.key} className="text-[11px] text-slate-400">
                      {p.label}{' '}
                      <span className={`inline-block px-1.5 py-0.5 rounded font-bold tabular-nums ${
                        p.roi == null ? 'bg-slate-100 text-slate-400' : p.roi >= 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                      }`}>{p.roi == null ? '—' : p.roi.toFixed(2) + '×'}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Source table */}
            <div className="p-6">
              {visibleSources.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                  <Target className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-700">No sources match the current filters</p>
                  <p className="text-xs text-slate-500 mt-1">Try widening the date range, scope, or source filter.</p>
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                          <th className="px-2 py-2.5 w-6"></th>
                          <th className="px-2 py-2.5">Source</th>
                          <th className="px-2 py-2.5 text-right">Leads</th>
                          <th className="px-2 py-2.5 text-right border-l border-slate-200" title="Engaged at least once — Ghosted counts">Resp %</th>
                          <th className="px-2 py-2.5 text-right" title="STOP · DND-SMS · Remove from All Automations">Opt-out</th>
                          <th className="px-2 py-2.5 text-right border-l border-slate-200">Open</th>
                          <th className="px-2 py-2.5 text-right">Active</th>
                          <th className="px-2 py-2.5 text-right">Lost</th>
                          <th className="px-2 py-2.5 text-right" title="Loan Funded · Broker Check Received · Loan Finalized">Funded</th>
                          <th className="px-2 py-2.5 text-right">Fund %</th>
                          <th className="px-2 py-2.5 text-right">Volume</th>
                          <th className="px-2 py-2.5 text-right border-l border-slate-200" title="Σ lead price + monthly retainer × months in range">Spend</th>
                          <th className="px-2 py-2.5 text-right" title="Σ Compensation on funded deals (Arive)">Revenue</th>
                          <th className="px-2 py-2.5 text-right" title="Revenue − Spend">Net</th>
                          <th className="px-2 py-2.5 text-right" title="Revenue ÷ Spend, as a multiple">ROI</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {visibleSources.map((s, i) => {
                          const isExpanded = expanded.has(s.source)
                          const isQuiet = s.funded === 0 && s.active === 0
                          return (
                            <React.Fragment key={s.source}>
                              <tr className={`transition-colors ${
                                isExpanded ? 'bg-indigo-50/50' : i % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'
                              } hover:bg-slate-50 ${isQuiet ? 'opacity-55' : ''}`}>
                                <td className="px-2 py-2">
                                  <button onClick={() => toggleExpand(s.source)} className="text-slate-400 hover:text-slate-700">
                                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                  </button>
                                </td>
                                <td className="px-2 py-2 font-medium text-slate-900">
                                  <button onClick={() => toggleExpand(s.source)} className="hover:text-blue-700 text-left">{s.source}</button>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums font-medium text-slate-700">{s.total}</td>
                                <td className="px-2 py-2 text-right border-l border-slate-200">
                                  <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums ${RR_PILL[rrBand(s.rr)]}`}>{pct(s.rr)}</span>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums text-slate-400 whitespace-nowrap">
                                  {s.optout
                                    ? <>{s.optout} <span className="text-slate-300">·</span> <span className="text-[11px] font-medium text-slate-500">{pct(s.orate)}</span></>
                                    : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums text-slate-400 border-l border-slate-200">{s.open || <span className="text-slate-300">—</span>}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{s.active ? <span className="text-amber-700 font-medium">{s.active}</span> : <span className="text-slate-300">—</span>}</td>
                                <td className="px-2 py-2 text-right tabular-nums text-slate-400">{s.lost || <span className="text-slate-300">—</span>}</td>
                                <td className="px-2 py-2 text-right">
                                  {s.funded > 0
                                    ? <span className="inline-flex items-center justify-center min-w-[1.6rem] px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-semibold tabular-nums">{s.funded}</span>
                                    : <span className="tabular-nums text-slate-300">—</span>}
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums text-slate-500">{pct(s.fr)}</td>
                                <td className="px-2 py-2 text-right tabular-nums text-slate-700">{s.fundedVolume > 0 ? formatCurrency(s.fundedVolume) : <span className="text-slate-300">—</span>}</td>
                                <td className="px-2 py-2 text-right tabular-nums text-rose-600 border-l border-slate-200" title={s.retainer > 0 ? `${formatCurrency(s.leadCost)} leads + ${formatCurrency(s.retainer)} retainer` : undefined}>
                                  {s.spend > 0 ? formatCurrency(s.spend) : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums text-emerald-700">{s.revenue > 0 ? formatCurrency(s.revenue) : <span className="text-slate-300">—</span>}</td>
                                <td className={`px-2 py-2 text-right tabular-nums font-semibold ${
                                  (s.revenue === 0 && s.spend === 0) ? 'text-slate-300' : s.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                                }`}>
                                  {(s.revenue === 0 && s.spend === 0) ? '—' : formatCurrency(s.netProfit)}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {s.roi == null
                                    ? <span className="text-slate-300">—</span>
                                    : <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-bold tabular-nums ${s.roi >= 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{s.roi.toFixed(2)}×</span>}
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr className="bg-indigo-50/30">
                                  <td colSpan={15} className="px-6 py-3">
                                    <div className="flex items-center flex-wrap gap-2 mb-3 text-xs bg-white border border-slate-200 rounded px-3 py-2">
                                      <span className="text-slate-500 font-medium whitespace-nowrap">Flat monthly cost:</span>
                                      {editingCost === s.source ? (
                                        <div className="flex items-center flex-wrap gap-1.5">
                                          <span className="text-slate-400">$</span>
                                          <input type="number" value={editCostValue} onChange={e => setEditCostValue(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') saveCost(s.source); if (e.key === 'Escape') cancelEditCost() }}
                                            className="w-24 text-right border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500" autoFocus />
                                          <input type="text" value={editCostNotes} onChange={e => setEditCostNotes(e.target.value)}
                                            placeholder="notes — e.g. monthly retainer $200"
                                            className="w-64 border border-slate-200 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                          <button onClick={() => saveCost(s.source)} className="text-emerald-600 hover:text-emerald-800"><Check className="w-3.5 h-3.5" /></button>
                                          <button onClick={cancelEditCost} className="text-slate-400 hover:text-slate-700"><X className="w-3.5 h-3.5" /></button>
                                        </div>
                                      ) : (
                                        <button onClick={() => startEditCost(s.source)}
                                          className="group inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-blue-700">
                                          {s.costPerMonth > 0 ? `${formatCurrency(s.costPerMonth)}/mo` : <span className="font-normal text-slate-400">Not set — click to add</span>}
                                          <Pencil className="w-3 h-3 opacity-50 group-hover:opacity-100" />
                                        </button>
                                      )}
                                      <span className="text-[10px] text-slate-400 ml-1">For retainer-billed sources — now included in Spend and ROI.</span>
                                    </div>
                                    <SourceDealsList
                                      sourceLabel={s.source}
                                      deals={s.deals}
                                      allSources={allKnownSources}
                                      onChangeDealSource={changeDealSource}
                                      onBulkReassign={bulkReassignSource}
                                    />
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          )
                        })}
                        {/* Totals */}
                        <tr className="bg-slate-100 font-bold text-slate-700 border-t-2 border-slate-200">
                          <td></td>
                          <td className="px-2 py-2.5">Total</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{kpis.totalLeads}</td>
                          <td className={`px-2 py-2.5 text-right tabular-nums border-l border-slate-200 ${RR_COLOR[rrBand(kpis.rr)]}`}>{pct(kpis.rr)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums whitespace-nowrap">{kpis.optout} <span className="text-slate-400">·</span> <span className="text-[11px]">{pct(kpis.orate)}</span></td>
                          <td className="px-2 py-2.5 text-right tabular-nums border-l border-slate-200">{visibleSources.reduce((a, s) => a + s.open, 0)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{kpis.active}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{visibleSources.reduce((a, s) => a + s.lost, 0)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-emerald-700">{kpis.funded}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{pct(kpis.fr)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(kpis.volume)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-rose-600 border-l border-slate-200">{kpis.spend > 0 ? formatCurrency(kpis.spend) : '—'}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-emerald-700">{kpis.revenue > 0 ? formatCurrency(kpis.revenue) : '—'}</td>
                          <td className={`px-2 py-2.5 text-right tabular-nums ${kpis.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            {(kpis.revenue > 0 || kpis.spend > 0) ? formatCurrency(kpis.netProfit) : '—'}
                          </td>
                          <td className={`px-2 py-2.5 text-right tabular-nums ${roiColor(kpis.roi)}`}>{roiFmt(kpis.roi)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* State + donut */}
              {visibleSources.length > 0 && (
                <div className="mt-6 grid lg:grid-cols-2 gap-6 items-start">
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200">
                      <h3 className="text-sm font-semibold text-slate-800">Per state</h3>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                          <th className="px-4 py-2">State</th>
                          <th className="px-3 py-2 text-right">Leads</th>
                          <th className="px-3 py-2 text-right">Resp %</th>
                          <th className="px-3 py-2 text-right">Funded</th>
                          <th className="px-3 py-2 text-right pr-4">Fund %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {states.slice(0, 12).map(r => (
                          <tr key={r.state}>
                            <td className="px-4 py-2 font-semibold text-slate-700">{r.state}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{r.n}</td>
                            <td className={`px-3 py-2 text-right tabular-nums font-semibold ${RR_COLOR[rrBand(r.rr)]}`}>{pct(r.rr)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{r.funded || <span className="text-slate-300">—</span>}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-500 pr-4">{pct(r.fr)}</td>
                          </tr>
                        ))}
                        {states.length > 12 && (
                          <tr><td colSpan={5} className="px-4 py-2 text-center text-xs text-slate-400">+ {states.length - 12} more states in the CSV</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {donutTotal > 0 && (
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <h3 className="text-sm font-semibold text-slate-800 mb-3">Share of funded loans by source</h3>
                      <div className="flex items-center gap-8 flex-wrap">
                        <div className="relative shrink-0" style={{ width: 200, height: 200 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie data={donutData} dataKey="funded" nameKey="name" cx="50%" cy="50%"
                                innerRadius={60} outerRadius={90} paddingAngle={2} stroke="#fff" strokeWidth={2} isAnimationActive>
                                {donutData.map((d, i) => (
                                  <Cell key={d.name} fill={d.isOther ? '#64748b' : DONUT_COLORS[i % DONUT_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip content={renderDonutTooltip as never} />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                            <span className="text-2xl font-bold text-slate-900 tabular-nums leading-none">{donutTotal}</span>
                            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mt-1">Funded</span>
                          </div>
                        </div>
                        <div className="flex-1 min-w-[200px] grid grid-cols-1 gap-y-2">
                          {donutData.map((d, i) => (
                            <div key={d.name} className="flex items-center gap-2 text-sm">
                              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.isOther ? '#64748b' : DONUT_COLORS[i % DONUT_COLORS.length] }} />
                              <span className="flex-1 truncate text-slate-700">{d.name}</span>
                              <span className="tabular-nums font-semibold text-slate-800">{d.funded}</span>
                              <span className="tabular-nums text-slate-400 w-10 text-right">{donutTotal > 0 ? Math.round((d.funded / donutTotal) * 100) : 0}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Projection */}
              {proj.activeCount > 0 && (
                <div className="mt-6 bg-white border border-violet-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-violet-100 bg-violet-50/50 flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-violet-500" />
                      If all active loans fund
                      <span className="font-normal text-slate-400">· {proj.activeCount} in process · {rangeLabel}</span>
                    </h3>
                    <span className="text-xs text-slate-500">
                      adds <span className="font-semibold text-violet-700">{formatCurrency(proj.addComp)}</span> projected comp
                      {proj.estimatedCount > 0 && <span className="text-slate-400"> · {proj.estimatedCount} est. at avg {formatCurrency(proj.avgComp)}</span>}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 p-4">
                    {[
                      { label: 'Funded', now: kpis.funded.toLocaleString(), next: proj.projFunded.toLocaleString(), tone: 'up' as const },
                      { label: 'Conversion', now: pct(kpis.fr), next: proj.projConversion.toFixed(1) + '%', tone: 'up' as const },
                      { label: 'Revenue', now: kpis.revenue > 0 ? formatCurrency(kpis.revenue) : '—', next: formatCurrency(proj.projRevenue), tone: 'up' as const },
                      { label: 'Net profit', now: (kpis.revenue > 0 || kpis.spend > 0) ? formatCurrency(kpis.netProfit) : '—', next: formatCurrency(proj.projNetProfit), tone: (proj.projNetProfit >= 0 ? 'up' : 'down') as 'up' | 'down' },
                      { label: 'ROI', now: roiFmt(kpis.roi), next: roiFmt(proj.projRoi), tone: (proj.projRoi != null && proj.projRoi >= 1 ? 'up' : 'down') as 'up' | 'down' },
                    ].map(t => {
                      const changed = t.now !== t.next
                      const nextColor = t.tone === 'down' ? 'text-red-600' : 'text-emerald-600'
                      return (
                        <div key={t.label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t.label}</p>
                          {changed ? (
                            <div className="flex items-baseline gap-1.5 mt-1 flex-wrap">
                              <span className="text-sm text-slate-400 tabular-nums">{t.now}</span>
                              <ArrowRight className="w-3 h-3 text-slate-300 shrink-0 self-center" />
                              <span className={`text-lg font-bold tabular-nums ${nextColor}`}>{t.next}</span>
                            </div>
                          ) : (
                            <div className="mt-1 flex items-baseline gap-1.5">
                              <span className="text-lg font-bold tabular-nums text-slate-800">{t.next}</span>
                              <span className="text-[10px] text-slate-400">unchanged</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {proj.rows.length > 0 && (
                    <div className="overflow-x-auto border-t border-slate-100">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 border-b border-slate-200">
                          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                            <th className="px-4 py-2.5">Source</th>
                            <th className="px-3 py-2.5 text-right">Active</th>
                            <th className="px-3 py-2.5 text-right">+ Proj. Comp</th>
                            <th className="px-3 py-2.5 text-right">Net Profit → Proj.</th>
                            <th className="px-3 py-2.5 text-right pr-4">ROI → Proj.</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {proj.rows.map(r => (
                            <tr key={r.source}>
                              <td className="px-4 py-2.5 font-medium text-slate-800">{r.source}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{r.activeCount}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-violet-700">{formatCurrency(r.addComp)}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                                <span className="text-slate-400">{formatCurrency(r.netProfit)}</span>
                                <ArrowRight className="inline w-3 h-3 text-slate-300 mx-1" />
                                <span className={`font-semibold ${r.projNetProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(r.projNetProfit)}</span>
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap pr-4">
                                <span className="text-slate-400">{roiFmt(r.roi)}</span>
                                <ArrowRight className="inline w-3 h-3 text-slate-300 mx-1" />
                                <span className={`font-semibold ${r.projRoi == null ? 'text-slate-400' : r.projRoi >= 1 ? 'text-emerald-600' : 'text-red-600'}`}>{roiFmt(r.projRoi)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="px-4 py-2.5 text-[11px] text-slate-400 border-t border-slate-100 leading-relaxed">
                    Hypothetical — adds each <strong>Active</strong> (Loans in Process) loan&apos;s Arive compensation to revenue with spend unchanged{proj.estimatedCount > 0 ? `; ${proj.estimatedCount} without a comp yet ${proj.estimatedCount === 1 ? 'is' : 'are'} estimated at the ${formatCurrency(proj.avgComp)} average` : ''}. Not a forecast of close probability.
                  </div>
                </div>
              )}

              {/* Funded loans */}
              {fundedView.list.length > 0 && (
                <div className="mt-6 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-emerald-500" />
                      Funded loans <span className="font-normal text-slate-400">· {rangeLabel}</span>
                    </h3>
                    <span className="text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{fundedView.list.length}</span> funded
                      {' · '}<span className="font-semibold text-slate-700">{formatCurrency(fundedView.volume)}</span> volume
                      {fundedView.comp > 0 && <>{' · '}<span className="font-semibold text-emerald-700">{formatCurrency(fundedView.comp)}</span> comp</>}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                          <th className="px-4 py-2.5">Borrower</th>
                          <th className="px-3 py-2.5">Source</th>
                          <th className="px-3 py-2.5 text-right">Funded</th>
                          <th className="px-3 py-2.5 text-right">Loan Amount</th>
                          <th className="px-3 py-2.5 text-right pr-4">Revenue</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {fundedView.list.map((d, i) => (
                          <tr key={d.id} className={i % 2 ? 'bg-slate-50/40' : 'bg-white'}>
                            <td className="px-4 py-2.5">
                              <Link href={`/deals/${d.id}`} className="font-medium text-slate-900 hover:text-blue-700">{d.name || '(no name)'}</Link>
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">{(d.source ?? '').trim() || '—'}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtDate(d.funded_date)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-medium text-slate-800">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 pr-4">{d.compensation_amount ? formatCurrency(d.compensation_amount) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-800">
                          <td className="px-4 py-2.5" colSpan={3}>Total</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(fundedView.volume)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 pr-4">{formatCurrency(fundedView.comp)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Methodology */}
              <details className="mt-6 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                <summary className="cursor-pointer px-4 py-2.5 font-semibold text-slate-700 select-none">
                  Definitions &amp; methodology — one set, both old pages reconciled
                </summary>
                <div className="px-4 pb-3 space-y-1.5">
                  <p><b>LO tabs:</b> stats are per-LO only — one loan officer at a time, matched via the canonical resolver, never combined.</p>
                  <p><b>Scope:</b> <b>Purchased</b> = vendor leads only ({PURCHASED_SOURCES.join(', ')}); <b>All sources</b> includes warm/organic (Self Source, Return Client, Referrals, Arive).</p>
                  <p><b>Responded:</b> engaged at least once — <b>Ghosted counts</b>; only New Lead / Attempted Contact / Non-Responsive are &ldquo;no response.&rdquo; <b>Opted out / DND</b> is its own bucket; the table shows count · % of that source&apos;s leads.</p>
                  <p><b>Opt-out ≤ 7d:</b> share of opt-outs whose FIRST logged opt-out event (stage_events webhook) landed within 7 days of the lead&apos;s creation date. Forward-only log — opt-outs from before the webhook went live (~Jul 8) have no timing, so the card shows its coverage. The summary&apos;s best-performer picks: Best ROI needs ≥1 funded + real spend; rate picks need ≥20 leads.</p>
                  <p><b>Funded:</b> Loan Funded / Broker Check Received / Loan Finalized (or the Funded group) — used for the pipeline tallies too. Funded loans anchor on <b>funded date</b>; everything else on the date the lead was added; date-less rows appear only under All time.</p>
                  <p><b>Spend:</b> Σ per-lead price (GHL) <b>plus</b> flat monthly retainers × months in range. <b>Revenue:</b> Σ Arive compensation on funded loans only. <b>Net profit</b> = revenue − spend.</p>
                  <p><b>ROI:</b> revenue ÷ spend as a multiple — 1.62× means $1.62 back per $1 (the old Lead Spend percent is this minus one). Lead price coverage is ~84%, so spend on price-less leads is understated — set a retainer for flat-billed sources.</p>
                  <p><b>Purpose:</b> Refinance includes HELOCs; ~8% of leads are untagged and appear only under &ldquo;All purposes.&rdquo;</p>
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Kpi({ icon, label, value, sub, highlight, valueClass }: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  highlight?: boolean | 'good' | 'bad'
  valueClass?: string
}) {
  const box =
    highlight === 'good' ? 'border-emerald-300 ring-1 ring-emerald-200' :
    highlight === 'bad'  ? 'border-red-300 ring-1 ring-red-200'         :
    highlight            ? 'border-indigo-300 ring-1 ring-indigo-200'   :
                           'border-slate-200'
  const text = valueClass ?? (
    highlight === 'good' ? 'text-emerald-700' :
    highlight === 'bad'  ? 'text-red-700'     :
    highlight            ? 'text-indigo-700'  :
                           'text-slate-800')
  return (
    <div className={`border rounded-lg px-3 py-2 bg-white ${box}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        {icon}
        <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <p className={`text-lg font-bold tabular-nums ${text}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-400 mt-0.5 truncate" title={sub}>{sub}</p>}
    </div>
  )
}

// ── Drill-down: deals from one source + recategorize controls (from Lead Spend) ─
function SourceDealsList({
  sourceLabel: srcLabel, deals, allSources, onChangeDealSource, onBulkReassign,
}: {
  sourceLabel: string
  deals: Deal[]
  allSources: string[]
  onChangeDealSource: (dealId: string, newSource: string) => Promise<void>
  onBulkReassign: (fromSource: string, toSource: string) => Promise<void>
}) {
  const [showAll, setShowAll] = useState(false)
  const [bulkTarget, setBulkTarget] = useState('')
  const sorted = useMemo(() =>
    [...deals].sort((a, b) => {
      const rank = (g: string | null) => g === 'Funded' ? 0 : g === 'Loans in Process' ? 1 : g === 'Leads' ? 2 : 3
      return rank(a.pipeline_group) - rank(b.pipeline_group)
    }), [deals])
  const visible = showAll ? sorted : sorted.slice(0, 12)
  const remaining = sorted.length - visible.length

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-xs bg-white border border-slate-200 rounded px-3 py-2">
        <span className="text-slate-500 font-medium whitespace-nowrap">Reassign all {sorted.length}:</span>
        <span className="text-slate-800 font-semibold">{srcLabel}</span>
        <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
        <select value={bulkTarget} onChange={e => setBulkTarget(e.target.value)}
          className="border border-slate-200 rounded px-2 py-1 text-xs flex-1 max-w-[200px] focus:outline-none focus:ring-1 focus:ring-blue-500">
          <option value="">Pick a target source…</option>
          {allSources.filter(s => s !== srcLabel).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="text" placeholder="…or type a new source"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim()
              if (v) { setBulkTarget(v); (e.target as HTMLInputElement).value = '' }
            }
          }}
          className="border border-slate-200 rounded px-2 py-1 text-xs w-44 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <button onClick={() => { if (bulkTarget) onBulkReassign(srcLabel, bulkTarget) }} disabled={!bulkTarget}
          className="px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 flex items-center gap-1">
          <Save className="w-3 h-3" /> Apply
        </button>
      </div>

      <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
        {sorted.length} {sorted.length === 1 ? 'deal' : 'deals'} from this source
      </p>
      <div className="space-y-1">
        {visible.map(d => (
          <div key={d.id} className="group flex items-center gap-2 px-2 py-1.5 bg-white rounded border border-slate-100 hover:border-blue-200 transition-all text-xs">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
              d.pipeline_group === 'Funded'           ? 'bg-emerald-500' :
              d.pipeline_group === 'Loans in Process' ? 'bg-amber-500'   :
              d.pipeline_group === 'Not Ready'        ? 'bg-red-400'     :
                                                        'bg-slate-300'
            }`} />
            <Link href={`/deals/${d.id}`}
              className="font-semibold text-slate-800 hover:text-blue-700 truncate flex-1 flex items-center gap-1 group/link">
              {d.name}
              <ExternalLink className="w-3 h-3 text-slate-300 group-hover/link:text-blue-500 opacity-0 group-hover/link:opacity-100" />
            </Link>
            <span className="text-slate-500 tabular-nums shrink-0 w-20 text-right">
              {d.loan_amount ? formatCurrency(d.loan_amount) : '—'}
            </span>
            <span className="text-slate-400 text-[10px] shrink-0 hidden md:inline w-28 truncate">{d.status}</span>
            <DealSourceSelect
              currentSource={d.source ?? ''}
              allSources={allSources}
              onChange={next => onChangeDealSource(d.id, next)}
            />
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <button onClick={() => setShowAll(true)} className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium">
          Show {remaining} more
        </button>
      )}
    </div>
  )
}

/** Per-deal source dropdown — switches inline between a select and a free-text input. */
function DealSourceSelect({
  currentSource, allSources, onChange,
}: {
  currentSource: string
  allSources: string[]
  onChange: (next: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'select' | 'custom'>('select')
  const [customValue, setCustomValue] = useState(currentSource)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  async function commit(next: string) {
    if (!next || next === currentSource) return
    setSaving(true)
    await onChange(next)
    setSaving(false)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  if (mode === 'custom') {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <input type="text" autoFocus value={customValue} onChange={e => setCustomValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { commit(customValue.trim()); setMode('select') }
            if (e.key === 'Escape') { setMode('select'); setCustomValue(currentSource) }
          }}
          placeholder="Type new source"
          className="border border-blue-300 rounded px-1.5 py-0.5 text-[11px] w-32 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <button onClick={() => { commit(customValue.trim()); setMode('select') }} className="text-emerald-600 hover:text-emerald-800">
          <Check className="w-3 h-3" />
        </button>
        <button onClick={() => { setMode('select'); setCustomValue(currentSource) }} className="text-slate-400 hover:text-slate-700">
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <select value={currentSource}
        onChange={e => {
          const v = e.target.value
          if (v === '__custom__') { setMode('custom'); setCustomValue('') }
          else commit(v)
        }}
        disabled={saving}
        className={`text-[11px] rounded border px-1.5 py-0.5 max-w-[120px] focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          savedFlash ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'
        }`}
        title="Reassign this deal to a different source">
        {!allSources.includes(currentSource) && currentSource && <option value={currentSource}>{currentSource}</option>}
        <option value="">(no source)</option>
        {allSources.map(s => <option key={s} value={s}>{s}</option>)}
        <option value="__custom__">— Type a new source… —</option>
      </select>
      {savedFlash && <Check className="w-3 h-3 text-emerald-600" />}
    </div>
  )
}
