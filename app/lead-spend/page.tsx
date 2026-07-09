'use client'

import React, { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_GROUPS, PIPELINE_STATUSES } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import {
  RefreshCw, BarChart3, TrendingUp, DollarSign, Users, CheckCircle2,
  Download, ChevronDown, ChevronRight, ExternalLink, Calendar, Pencil, Check, X,
  Filter, ArrowRight, Save, ChevronsUpDown, ChevronsDownUp, FileText,
} from 'lucide-react'

// ── Date range presets ────────────────────────────────────────────────────────
type RangeKey = 'this_month' | 'last_month' | '90d' | 'all' | 'custom'
const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '90d',        label: 'Last 90 days' },
  { key: 'all',        label: 'All time' },
  { key: 'custom',     label: 'Custom range…' },
]
function rangeBounds(key: RangeKey, customFrom: string, customTo: string): { start: Date | null; end: Date | null } {
  const now = new Date()
  if (key === 'all') return { start: null, end: null }
  if (key === 'custom') {
    return {
      start: customFrom ? new Date(customFrom + 'T00:00:00') : null,
      end:   customTo   ? new Date(customTo   + 'T23:59:59') : null,
    }
  }
  if (key === 'this_month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  }
  if (key === 'last_month') {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999), // last day of prior month
    }
  }
  // '90d'
  return { start: new Date(now.getTime() - 90 * 86_400_000), end: now }
}
/** Approximate number of months a date range spans (used for cost rollup). */
function monthsBetween(start: Date | null, end: Date | null): number {
  if (!start) return 12   // for "all time" assume 12 months of spend — user can override per-source
  const e = end ?? new Date()
  const ms = e.getTime() - start.getTime()
  const days = ms / 86_400_000
  return Math.max(0.1, days / 30.4375)   // average month length, floor at 0.1 to avoid div-by-0
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type LO = 'All' | 'Matt' | 'Moe' | 'Randy'

// Green/teal palette for the funded-share donut (positive, "money in" feel).
const DONUT_COLORS = ['#059669', '#10b981', '#34d399', '#0d9488', '#14b8a6', '#22c55e', '#16a34a', '#84cc16', '#5eead4']

// ── Cost lookup ──────────────────────────────────────────────────────────────
type CostRow = { source: string; cost_per_month: number; notes: string | null; updated_at: string }

// ── Page ─────────────────────────────────────────────────────────────────────
export default function LeadSpendPage() {
  const [deals, setDeals]         = useState<Deal[]>([])
  const [costs, setCosts]         = useState<Map<string, CostRow>>(new Map())
  const [loading, setLoading]     = useState(true)
  const [range, setRange]         = useState<RangeKey>('this_month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo]   = useState('')
  const [lo, setLo]               = useState<LO>('Moe')
  // Stage filter — '' = all stages. Otherwise either a pipeline group name
  // (e.g. 'Funded') or a specific status (e.g. 'Pitching').
  const [stage, setStage]         = useState<string>('')
  const [expanded, setExpanded]   = useState<Set<string>>(new Set())
  const [editingCost, setEditingCost] = useState<string | null>(null)
  const [editCostValue, setEditCostValue] = useState<string>('')
  const [editCostNotes, setEditCostNotes] = useState<string>('')
  // Source filter — null = "all sources visible". When set, only these sources show.
  const [includedSources, setIncludedSources] = useState<Set<string> | null>(null)
  const [showSourceFilter, setShowSourceFilter]   = useState(false)
  // When on, hides organic/no-spend sources (referrals, return clients, self-sourced)
  // so the page reflects paid-lead ROI only. Affects the table, KPIs, and donut.
  const [paidOnly, setPaidOnly]   = useState(true)

  async function fetchAll() {
    setLoading(true)
    // Deals (paginated)
    const all: Deal[] = []
    let offset = 0
    const PAGE = 1000
    for (;;) {
      const { data } = await supabase
        .from('deals')
        .select('id,name,source,loan_officer,pipeline_group,status,loan_amount,created_at,date_added_ghl,funded_date,lead_price,compensation_amount')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1)
      const rows = (data ?? []) as Deal[]
      all.push(...rows)
      if (rows.length < PAGE) break
      offset += PAGE
    }
    setDeals(all)
    // Costs
    try {
      const res = await fetch('/api/lead-source-costs', { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; costs?: CostRow[] }
      if (data.ok && data.costs) {
        const m = new Map<string, CostRow>()
        for (const c of data.costs) m.set(c.source, c)
        setCosts(m)
      }
    } catch {}
    setLoading(false)
  }
  useEffect(() => { fetchAll() }, [])

  // ── Apply filters ─────────────────────────────────────────────────────────
  const { start, end } = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo])
  const months = useMemo(() => monthsBetween(start, end), [start, end])

  // Is `stage` a pipeline-group name (vs. a specific status)?
  const stageIsGroup = useMemo(() => (PIPELINE_GROUPS as readonly string[]).includes(stage), [stage])

  const filtered = useMemo(() => {
    const startMs = start?.getTime() ?? 0
    const endMs   = end?.getTime() ?? Infinity
    const isBounded = start != null || end != null   // a real date range is active (not "All time")
    const loLower = lo.toLowerCase()
    return deals.filter(d => {
      // LO + stage filters apply to EVERY deal — including funded loans with no
      // funded_date. Otherwise the date-less early-return below short-circuits before
      // these run, so a Matt-Park deal with no funded_date leaks into Moe's view under
      // "All time" (and vice versa). See the funded-loans list for the symptom.
      if (lo !== 'All') {
        if (!d.loan_officer || !d.loan_officer.toLowerCase().includes(loLower)) return false
      }
      if (stage) {
        if (stageIsGroup) { if ((d.pipeline_group ?? '') !== stage) return false }
        else              { if ((d.status ?? '')         !== stage) return false }
      }
      // Anchor each deal on a REAL date, never created_at (that's the DB
      // migration date — identical for every row, so it can't segment ranges):
      //   • Funded loans → funded_date STRICTLY (the month money landed). Do NOT
      //     fall back to date_added_ghl: a funded loan with no funded_date has an
      //     unknown funding month, and anchoring it on the lead-in date mis-counts
      //     a loan that funded in a prior month as "funded this month".
      //   • Everything else → date_added_ghl (when the lead actually came in)
      const dateStr = d.pipeline_group === 'Funded'
        ? d.funded_date
        : d.date_added_ghl
      // No usable date → can't place it in time. Show it only under "All time",
      // never inside a bounded range (where it would distort the month's totals).
      if (!dateStr) return !isBounded
      // Date-only values ("2026-05-01") parse as UTC midnight, which can fall
      // just before the LOCAL month start (e.g. Pacific) and wrongly drop
      // 1st-of-month loans. Parse them as LOCAL midnight so they align with the
      // local range bounds. Full ISO timestamps already carry a timezone.
      const ct = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
        ? new Date(dateStr + 'T00:00:00').getTime()
        : Date.parse(dateStr)
      if (isNaN(ct) || ct < startMs || ct > endMs) return false
      return true
    })
  }, [deals, start, end, lo, stage, stageIsGroup])

  // ── Group + tally per source ──────────────────────────────────────────────
  type SourceStats = {
    source: string
    total: number
    active: number
    funded: number
    lost: number
    open: number
    byMatt: number
    byMoe: number
    byRandy: number
    fundedByMatt: number
    fundedByMoe: number
    fundedByRandy: number
    fundedVolume: number
    fundedAvg: number
    deals: Deal[]
    costPerMonth: number
    totalSpend: number
    costPerFunded: number | null    // null when funded === 0
    // ── Profit/ROI from actual GHL lead price + Arive compensation ──────────
    leadCost: number                // Σ lead_price across this source's leads
    revenue: number                 // Σ compensation_amount on funded deals
    netProfit: number               // revenue − leadCost
    roi: number | null              // netProfit ÷ leadCost (null when leadCost === 0)
  }

  const sources = useMemo<SourceStats[]>(() => {
    const map = new Map<string, SourceStats>()
    function get(src: string): SourceStats {
      let s = map.get(src)
      if (!s) {
        const c = costs.get(src)
        const costPerMonth = c?.cost_per_month ?? 0
        const totalSpend   = costPerMonth * months
        s = {
          source: src, total: 0, active: 0, funded: 0, lost: 0, open: 0,
          byMatt: 0, byMoe: 0, byRandy: 0, fundedByMatt: 0, fundedByMoe: 0, fundedByRandy: 0,
          fundedVolume: 0, fundedAvg: 0, deals: [],
          costPerMonth, totalSpend, costPerFunded: null,
          leadCost: 0, revenue: 0, netProfit: 0, roi: null,
        }
        map.set(src, s)
      }
      return s
    }
    for (const d of filtered) {
      const src = (d.source ?? '').trim() || '(no source set)'
      const s = get(src)
      s.total++
      s.deals.push(d)
      const grp = d.pipeline_group ?? ''
      if (grp === 'Loans in Process')  s.active++
      else if (grp === 'Funded')        s.funded++
      else if (grp === 'Not Ready')     s.lost++
      else                              s.open++

      // Actual lead cost — sum the per-lead price for every lead from this source
      s.leadCost += (d.lead_price ?? 0)

      const lo = (d.loan_officer ?? '').toLowerCase()
      const isMatt = lo.includes('matt') || lo.includes('park')
      const isMoe  = lo.includes('moe')  || lo.includes('sefati')
      const isRandy = lo.includes('randy') || lo.includes('mathis')
      if (isMatt) s.byMatt++
      if (isMoe)  s.byMoe++
      if (isRandy) s.byRandy++

      if (grp === 'Funded') {
        s.fundedVolume += (d.loan_amount ?? 0)
        s.revenue      += (d.compensation_amount ?? 0)   // comp earned on funded deals
        if (isMatt) s.fundedByMatt++
        if (isMoe)  s.fundedByMoe++
        if (isRandy) s.fundedByRandy++
      }
    }
    for (const s of map.values()) {
      s.fundedAvg     = s.funded > 0 ? s.fundedVolume / s.funded : 0
      s.costPerFunded = s.funded > 0 && s.totalSpend > 0 ? s.totalSpend / s.funded : null
      s.netProfit     = s.revenue - s.leadCost
      s.roi           = s.leadCost > 0 ? (s.netProfit / s.leadCost) * 100 : null
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }, [filtered, costs, months])

  // Apply the source-filter (and optional paid-only filter) on top of the computed sources
  const visibleSources = useMemo(() => {
    let list = includedSources ? sources.filter(s => includedSources.has(s.source)) : sources
    if (paidOnly) list = list.filter(s => s.leadCost > 0 || s.totalSpend > 0)
    return list
  }, [sources, includedSources, paidOnly])

  // Funded loans within the current timeframe + active filters (range/LO/stage/source/
  // paid-only). Mirrors what the Funded KPI counts, so the list and the KPI agree.
  const fundedView = useMemo(() => {
    const names = new Set(visibleSources.map(s => s.source))
    const list = filtered
      .filter(d => (d.pipeline_group ?? '') === 'Funded' && names.has((d.source ?? '').trim() || '(no source set)'))
      .sort((a, b) => new Date(b.funded_date || b.created_at).getTime() - new Date(a.funded_date || a.created_at).getTime())
    const volume = list.reduce((a, d) => a + (d.loan_amount ?? 0), 0)
    const comp = list.reduce((a, d) => a + (d.compensation_amount ?? 0), 0)
    return { list, volume, comp }
  }, [filtered, visibleSources])

  const rangeLabel = useMemo(() => RANGE_OPTIONS.find(o => o.key === range)?.label ?? 'All time', [range])

  // How many sources are being hidden by the paid-only filter (for the toggle label).
  const noCostCount = useMemo(() => {
    const base = includedSources ? sources.filter(s => includedSources.has(s.source)) : sources
    return base.filter(s => !(s.leadCost > 0 || s.totalSpend > 0)).length
  }, [sources, includedSources])

  // Full canonical list of source names (across ALL deals, not just filtered) —
  // used for the filter chips AND the per-deal "Reassign source" dropdown.
  const allKnownSources = useMemo<string[]>(() => {
    const set = new Set<string>()
    for (const d of deals) {
      const src = (d.source ?? '').trim()
      if (src) set.add(src)
    }
    // Plus anything that exists in lead_source_costs (in case a source was created with a cost but no deals yet)
    for (const k of costs.keys()) set.add(k)
    return Array.from(set).sort()
  }, [deals, costs])

  // ── KPIs (reflect the source filter) ──────────────────────────────────────
  const kpis = useMemo(() => {
    let totalLeads = 0, totalActive = 0, totalFunded = 0, totalVolume = 0, totalSpend = 0
    let totalLeadCost = 0, totalRevenue = 0
    for (const s of visibleSources) {
      totalLeads    += s.total
      totalActive   += s.active
      totalFunded   += s.funded
      totalVolume   += s.fundedVolume
      totalSpend    += s.totalSpend
      totalLeadCost += s.leadCost
      totalRevenue  += s.revenue
    }
    const netProfit = totalRevenue - totalLeadCost
    return {
      totalLeads, totalActive, totalFunded, totalVolume, totalSpend,
      totalLeadCost, totalRevenue, netProfit,
      roi: totalLeadCost > 0 ? (netProfit / totalLeadCost) * 100 : null,
      conversionRate: totalLeads > 0 ? (totalFunded / totalLeads) * 100 : 0,
      costPerFunded:  totalFunded > 0 && totalSpend > 0 ? totalSpend / totalFunded : null,
    }
  }, [visibleSources])

  // ── Donut data — share of funded loans by source (top 8 + "Other") ────────
  const donutData = useMemo(() => {
    const withFunded = visibleSources.filter(s => s.funded > 0).sort((a, b) => b.funded - a.funded)
    const TOP = 8
    const top = withFunded.slice(0, TOP)
    const rest = withFunded.slice(TOP)
    const data = top.map(s => ({ name: s.source, funded: s.funded, volume: s.fundedVolume, isOther: false }))
    if (rest.length) {
      data.push({
        name: `Other (${rest.length})`,
        funded: rest.reduce((a, s) => a + s.funded, 0),
        volume: rest.reduce((a, s) => a + s.fundedVolume, 0),
        isOther: true,
      })
    }
    return data
  }, [visibleSources])
  const donutTotal = useMemo(() => donutData.reduce((a, d) => a + d.funded, 0), [donutData])

  // Tooltip for the donut — shows funded count, share %, and funded volume.
  const renderDonutTooltip = (props: {
    active?: boolean
    payload?: Array<{ payload: { name: string; funded: number; volume: number } }>
  }) => {
    if (!props.active || !props.payload || !props.payload.length) return null
    const d = props.payload[0].payload
    const pct = donutTotal > 0 ? ((d.funded / donutTotal) * 100).toFixed(1) : '0'
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
        <p className="font-semibold text-slate-900">{d.name}</p>
        <p className="text-emerald-700 font-medium">{d.funded} funded · {pct}%</p>
        <p className="text-slate-500">{formatCurrency(d.volume)} volume</p>
      </div>
    )
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  function exportCsv() {
    const headers = [
      'Source', 'Leads', 'Open', 'Active', 'Lost', 'Funded', 'Conv %',
      'Funded Volume', 'Avg Funded', 'Funded by Matt', 'Funded by Moe', 'Funded by Randy',
      'Lead Cost', 'Revenue (Comp)', 'Net Profit', 'ROI %',
      'Monthly Cost',
    ]
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = visibleSources.map(s => {
      const conv = s.total > 0 ? (s.funded / s.total) * 100 : 0
      return [
        s.source, s.total, s.open, s.active, s.lost, s.funded, conv.toFixed(1),
        s.fundedVolume, s.fundedAvg.toFixed(0), s.fundedByMatt, s.fundedByMoe, s.fundedByRandy,
        s.leadCost.toFixed(0), s.revenue.toFixed(0), s.netProfit.toFixed(0),
        s.roi == null ? '' : s.roi.toFixed(0),
        s.costPerMonth,
      ].map(escape).join(',')
    })
    const csv = '﻿' + [headers.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const ts = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `lumin-lead-spend-${ts}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Visual report — opens a styled, printable report in a new tab ─────────
  function openVisualReport() {
    const rangeLabel = RANGE_OPTIONS.find(o => o.key === range)?.label ?? 'All time'
    const filterBits = [
      `Range: ${rangeLabel}${range === 'custom' && (customFrom || customTo) ? ` (${customFrom || '…'} → ${customTo || '…'})` : ''}`,
      `LO: ${lo === 'All' ? 'All LOs' : lo}`,
      stage ? `Stage: ${stage}` : 'Stage: All',
      includedSources ? `${includedSources.size} of ${allKnownSources.length} sources` : `All ${allKnownSources.length} sources`,
    ]
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
    ))
    const fc = (n: number) => formatCurrency(n)

    // Best & worst by ROI (only sources with lead cost)
    const withRoi = visibleSources.filter(s => s.roi != null)
    const bestRoi  = [...withRoi].sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))[0]
    const worstRoi = [...withRoi].sort((a, b) => (a.roi ?? 0) - (b.roi ?? 0))[0]
    const topFunded = [...visibleSources].sort((a, b) => b.funded - a.funded)[0]

    const chartMaxFunded = Math.max(1, ...visibleSources.map(s => s.funded))
    const chartHtml = [...visibleSources]
      .sort((a, b) => b.funded - a.funded).slice(0, 10)
      .map(s => `
        <div class="bar-row">
          <div class="bar-label">${esc(s.source)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(s.funded / chartMaxFunded) * 100}%"></div></div>
          <div class="bar-val"><b>${s.funded}</b> funded · ${fc(s.fundedVolume)}</div>
        </div>`).join('')

    const rowsHtml = visibleSources.map(s => {
      const conv = s.total > 0 ? (s.funded / s.total) * 100 : 0
      const npClass = (s.revenue === 0 && s.leadCost === 0) ? 'muted' : s.netProfit >= 0 ? 'pos' : 'neg'
      const roiClass = s.roi == null ? 'muted' : s.roi >= 0 ? 'pos' : 'neg'
      return `<tr>
        <td class="src">${esc(s.source)}</td>
        <td class="r">${s.total}</td>
        <td class="r">${s.open}</td>
        <td class="r">${s.active}</td>
        <td class="r">${s.lost}</td>
        <td class="r b">${s.funded}</td>
        <td class="r">${conv.toFixed(1)}%</td>
        <td class="r">${s.fundedVolume > 0 ? fc(s.fundedVolume) : '—'}</td>
        <td class="r neg">${s.leadCost > 0 ? fc(s.leadCost) : '—'}</td>
        <td class="r pos">${s.revenue > 0 ? fc(s.revenue) : '—'}</td>
        <td class="r b ${npClass}">${(s.revenue === 0 && s.leadCost === 0) ? '—' : fc(s.netProfit)}</td>
        <td class="r b ${roiClass}">${s.roi == null ? '—' : s.roi.toFixed(0) + '%'}</td>
      </tr>`
    }).join('')

    const kpiCard = (label: string, value: string, cls = '') =>
      `<div class="kpi ${cls}"><div class="kpi-l">${esc(label)}</div><div class="kpi-v">${esc(value)}</div></div>`

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Lumin Lending — Lead Spend Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; margin: 0; padding: 32px 40px; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 4px; }
  .filters { display:flex; flex-wrap:wrap; gap:6px; margin: 12px 0 22px; }
  .filters span { background:#f1f5f9; color:#475569; font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; }
  .kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; }
  .kpis.money { grid-template-columns:repeat(4,1fr); }
  .kpi { border:1px solid #e2e8f0; border-radius:10px; padding:10px 12px; }
  .kpi-l { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; font-weight:700; }
  .kpi-v { font-size:19px; font-weight:800; margin-top:3px; }
  .kpi.good { border-color:#6ee7b7; background:#ecfdf5; } .kpi.good .kpi-v { color:#047857; }
  .kpi.bad  { border-color:#fca5a5; background:#fef2f2; } .kpi.bad  .kpi-v { color:#b91c1c; }
  .kpi.hl   { border-color:#a5b4fc; background:#eef2ff; } .kpi.hl   .kpi-v { color:#4338ca; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:24px 0 10px; }
  .bar-row { display:flex; align-items:center; gap:12px; font-size:13px; margin-bottom:6px; }
  .bar-label { width:150px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar-track { flex:1; background:#f1f5f9; border-radius:5px; height:18px; overflow:hidden; }
  .bar-fill { background:linear-gradient(90deg,#34d399,#059669); height:100%; border-radius:5px; }
  .bar-val { width:200px; text-align:right; color:#334155; font-size:11px; font-weight:600; }
  .highlights { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .hcard { border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; }
  .hcard .t { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; font-weight:700; }
  .hcard .n { font-size:15px; font-weight:800; margin:4px 0 1px; }
  .hcard .d { font-size:12px; color:#475569; }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-top:8px; }
  th { text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.04em; color:#64748b; border-bottom:2px solid #e2e8f0; padding:6px 8px; }
  td { padding:6px 8px; border-bottom:1px solid #f1f5f9; }
  td.r, th.r { text-align:right; } td.src { font-weight:600; } td.b { font-weight:700; }
  td.pos { color:#047857; } td.neg { color:#dc2626; } td.muted { color:#cbd5e1; }
  tfoot td, tr.total td { font-weight:800; border-top:2px solid #e2e8f0; background:#f8fafc; }
  .foot { margin-top:26px; color:#94a3b8; font-size:10px; }
  @media print { body { padding:0; } .noprint { display:none; } }
  .noprint { margin-bottom:18px; }
  .btn { background:#4f46e5; color:#fff; border:0; border-radius:8px; padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; }
</style></head><body>
  <div class="noprint"><button class="btn" onclick="window.print()">🖨 Print / Save as PDF</button></div>
  <h1>Lumin Lending — Lead Spend Report</h1>
  <div class="sub">Generated ${esc(new Date().toLocaleString())}</div>
  <div class="filters">${filterBits.map(b => `<span>${esc(b)}</span>`).join('')}</div>

  <div class="kpis">
    ${kpiCard('Total Leads', kpis.totalLeads.toLocaleString())}
    ${kpiCard('Active Escrows', kpis.totalActive.toLocaleString())}
    ${kpiCard('Funded', kpis.totalFunded.toLocaleString())}
    ${kpiCard('Funded Volume', fc(kpis.totalVolume))}
    ${kpiCard('Conversion', kpis.conversionRate.toFixed(1) + '%', 'hl')}
  </div>
  <div class="kpis money">
    ${kpiCard('Lead Cost', kpis.totalLeadCost > 0 ? fc(kpis.totalLeadCost) : '—')}
    ${kpiCard('Revenue (comp)', kpis.totalRevenue > 0 ? fc(kpis.totalRevenue) : '—')}
    ${kpiCard('Net Profit', (kpis.totalRevenue > 0 || kpis.totalLeadCost > 0) ? fc(kpis.netProfit) : '—', kpis.netProfit >= 0 ? 'good' : 'bad')}
    ${kpiCard('ROI', kpis.roi == null ? '—' : kpis.roi.toFixed(0) + '%', kpis.roi != null && kpis.roi >= 0 ? 'good' : kpis.roi != null ? 'bad' : '')}
  </div>

  <div class="highlights">
    ${topFunded ? `<div class="hcard"><div class="t">Most funded</div><div class="n">${esc(topFunded.source)}</div><div class="d">${topFunded.funded} funded · ${fc(topFunded.fundedVolume)}</div></div>` : ''}
    ${bestRoi ? `<div class="hcard"><div class="t">Best ROI</div><div class="n" style="color:#047857">${esc(bestRoi.source)}</div><div class="d">${bestRoi.roi?.toFixed(0)}% · ${fc(bestRoi.netProfit)} net</div></div>` : ''}
    ${worstRoi && worstRoi.source !== bestRoi?.source ? `<div class="hcard"><div class="t">Worst ROI</div><div class="n" style="color:#dc2626">${esc(worstRoi.source)}</div><div class="d">${worstRoi.roi?.toFixed(0)}% · ${fc(worstRoi.netProfit)} net</div></div>` : ''}
  </div>

  <h2>Top sources by funded count</h2>
  ${chartHtml || '<p style="color:#94a3b8;font-size:13px">No funded deals in range.</p>'}

  <h2>Source breakdown</h2>
  <table>
    <thead><tr>
      <th>Source</th><th class="r">Leads</th><th class="r">Open</th><th class="r">Active</th>
      <th class="r">Lost</th><th class="r">Funded</th><th class="r">Conv %</th><th class="r">Funded Vol</th>
      <th class="r">Lead Cost</th><th class="r">Revenue</th><th class="r">Net Profit</th><th class="r">ROI</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot><tr class="total">
      <td>Total</td><td class="r">${kpis.totalLeads}</td>
      <td class="r">${visibleSources.reduce((s, r) => s + r.open, 0)}</td>
      <td class="r">${kpis.totalActive}</td>
      <td class="r">${visibleSources.reduce((s, r) => s + r.lost, 0)}</td>
      <td class="r">${kpis.totalFunded}</td>
      <td class="r">${kpis.conversionRate.toFixed(1)}%</td>
      <td class="r">${fc(kpis.totalVolume)}</td>
      <td class="r neg">${kpis.totalLeadCost > 0 ? fc(kpis.totalLeadCost) : '—'}</td>
      <td class="r pos">${kpis.totalRevenue > 0 ? fc(kpis.totalRevenue) : '—'}</td>
      <td class="r ${kpis.netProfit >= 0 ? 'pos' : 'neg'}">${(kpis.totalRevenue > 0 || kpis.totalLeadCost > 0) ? fc(kpis.netProfit) : '—'}</td>
      <td class="r ${kpis.roi == null ? '' : kpis.roi >= 0 ? 'pos' : 'neg'}">${kpis.roi == null ? '—' : kpis.roi.toFixed(0) + '%'}</td>
    </tr></tfoot>
  </table>

  <div class="foot">
    Lead Cost = Σ lead price (GHL) · Revenue = Σ compensation on funded deals (Arive) · Net Profit = Revenue − Lead Cost · ROI = Net Profit ÷ Lead Cost.
  </div>
</body></html>`

    const w = window.open('', '_blank')
    if (!w) { alert('Please allow pop-ups to view the visual report.'); return }
    w.document.write(html)
    w.document.close()
  }

  // ── Cost editing ──────────────────────────────────────────────────────────
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
      // Update local map immediately
      setCosts(prev => {
        const next = new Map(prev)
        next.set(src, { source: src, cost_per_month: cpm, notes, updated_at: new Date().toISOString() })
        return next
      })
      setEditingCost(null)
    }
  }
  function cancelEditCost() { setEditingCost(null); setEditCostValue(''); setEditCostNotes('') }

  function toggleExpand(src: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src); else next.add(src)
      return next
    })
  }

  // Are every currently-visible source rows expanded?
  const allExpanded = visibleSources.length > 0 && visibleSources.every(s => expanded.has(s.source))
  function toggleExpandAll() {
    if (allExpanded) setExpanded(new Set())
    else setExpanded(new Set(visibleSources.map(s => s.source)))
  }

  // ── Recategorize: change a single deal's source ───────────────────────────
  async function changeDealSource(dealId: string, newSource: string) {
    const trimmed = newSource.trim()
    if (!trimmed) return
    // Optimistic update
    setDeals(prev => prev.map(d => d.id === dealId ? ({ ...d, source: trimmed } as Deal) : d))
    const { error } = await supabase.from('deals').update({ source: trimmed }).eq('id', dealId)
    if (error) {
      console.error('Reassign source failed:', error.message)
      // Optionally re-fetch to revert
    }
  }

  // ── Bulk reassign: move all N deals from one source → another source ─────
  async function bulkReassignSource(fromSource: string, toSource: string) {
    const trimmed = toSource.trim()
    if (!trimmed || trimmed === fromSource) return
    const realSource = fromSource === '(no source set)' ? null : fromSource
    const dealsToMove = deals.filter(d => (d.source ?? null) === (realSource ?? null))
    if (dealsToMove.length === 0) return
    if (!confirm(`Reassign ${dealsToMove.length} deal${dealsToMove.length === 1 ? '' : 's'} from "${fromSource}" to "${trimmed}"?`)) return

    const ids = dealsToMove.map(d => d.id)
    // Optimistic update
    setDeals(prev => prev.map(d => ids.includes(d.id) ? ({ ...d, source: trimmed } as Deal) : d))

    const { error } = realSource === null
      ? await supabase.from('deals').update({ source: trimmed }).is('source', null)
      : await supabase.from('deals').update({ source: trimmed }).eq('source', realSource)
    if (error) {
      console.error('Bulk reassign failed:', error.message)
      alert(`Bulk reassign failed: ${error.message}`)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-500" />
              Lead Spend
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Conversion + ROI by lead source. Click a row to see the deals from that source.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={toggleExpandAll} disabled={visibleSources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-40">
              {allExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
            <button onClick={openVisualReport} disabled={visibleSources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-40">
              <FileText className="w-3.5 h-3.5" /> Visual Report
            </button>
            <button onClick={exportCsv} disabled={visibleSources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
            <button onClick={fetchAll} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* LO tabs — fully separate Moe's vs Matt's lead spend */}
        <div className="flex gap-2 mb-3">
          {([
            { key: 'Moe',  label: 'Moe Sefati', accent: 'bg-indigo-600 border-indigo-600' },
            { key: 'Matt', label: 'Matt Park',  accent: 'bg-emerald-600 border-emerald-600' },
            { key: 'Randy', label: 'Randy Mathis', accent: 'bg-violet-600 border-violet-600' },
          ] as const).map(t => {
            const active = lo === t.key
            return (
              <button
                key={t.key}
                onClick={() => setLo(t.key)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-base font-bold border-2 transition-all ${
                  active ? `${t.accent} text-white shadow-md` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                <Users className="w-4 h-4" />
                {t.label}&apos;s Lead Spend
              </button>
            )
          })}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Range</label>
            <select
              value={range} onChange={e => setRange(e.target.value as RangeKey)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
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
          {/* Stage filter — pick a whole pipeline group or a single status */}
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stage</label>
            <select
              value={stage} onChange={e => setStage(e.target.value)}
              className={`text-sm border rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                stage ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-700'
              }`}
            >
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
          {/* Source filter — multi-select dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowSourceFilter(v => !v)}
              className={`flex items-center gap-1.5 text-sm border rounded-lg px-3 py-1.5 transition-colors ${
                includedSources
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              {includedSources
                ? `${includedSources.size} of ${allKnownSources.length} sources`
                : `All ${allKnownSources.length} sources`}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showSourceFilter && (
              <div
                className="absolute top-full mt-1 left-0 z-30 bg-white border border-slate-200 rounded-lg shadow-xl w-72 max-h-80 overflow-hidden flex flex-col"
                onMouseLeave={() => setShowSourceFilter(false)}
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 text-xs">
                  <button
                    onClick={() => setIncludedSources(null)}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => setIncludedSources(new Set())}
                    className="text-slate-500 hover:text-slate-800"
                  >
                    Clear all
                  </button>
                </div>
                <div className="overflow-y-auto flex-1">
                  {allKnownSources.map(src => {
                    const isOn = !includedSources || includedSources.has(src)
                    return (
                      <label key={src} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => {
                            setIncludedSources(prev => {
                              // Switching from "all" → explicit list
                              const base = prev ?? new Set(allKnownSources)
                              const next = new Set(base)
                              if (next.has(src)) next.delete(src); else next.add(src)
                              return next
                            })
                          }}
                          className="rounded accent-blue-600"
                        />
                        <span className="flex-1 truncate text-slate-700">{src}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Paid-sources-only toggle — hides organic/no-spend sources everywhere */}
          <button
            onClick={() => setPaidOnly(v => !v)}
            title="Hide organic sources with no lead spend (referrals, return clients, self-sourced). Recalculates KPIs and the donut for paid-lead ROI only."
            className={`flex items-center gap-1.5 text-sm border rounded-lg px-3 py-1.5 transition-colors ${
              paidOnly
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
            }`}
          >
            <DollarSign className="w-3.5 h-3.5" />
            Paid sources only
            {noCostCount > 0 && (
              <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${paidOnly ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {paidOnly ? `${noCostCount} hidden` : `${noCostCount} organic`}
              </span>
            )}
          </button>

          <span className="text-[11px] text-slate-400 ml-auto">
            Range covers ~{months.toFixed(1)} months
          </span>
        </div>
      </div>

      {/* Everything below the pinned filters scrolls together (KPIs, donut, tables) */}
      <div className="flex-1 overflow-auto">

      {/* KPIs */}
      <div className="px-6 py-4 bg-slate-50/60 border-b border-slate-200 space-y-3">
        {/* Row 1: volume / conversion */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Kpi icon={<Users className="w-4 h-4 text-blue-500" />}            label="Total Leads"      value={kpis.totalLeads.toLocaleString()} />
          <Kpi icon={<TrendingUp className="w-4 h-4 text-amber-500" />}      label="Active Escrows"   value={kpis.totalActive.toLocaleString()} />
          <Kpi icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />}  label="Funded"           value={kpis.totalFunded.toLocaleString()} />
          <Kpi icon={<DollarSign className="w-4 h-4 text-emerald-600" />}    label="Funded Volume"    value={formatCurrency(kpis.totalVolume)} />
          <Kpi icon={<TrendingUp className="w-4 h-4 text-indigo-500" />}     label="Conversion"       value={`${kpis.conversionRate.toFixed(1)}%`} highlight />
        </div>
        {/* Row 2: the money — lead cost, revenue, net profit, ROI */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Kpi icon={<DollarSign className="w-4 h-4 text-rose-500" />}    label="Lead Cost"   value={kpis.totalLeadCost > 0 ? formatCurrency(kpis.totalLeadCost) : '—'} />
          <Kpi icon={<DollarSign className="w-4 h-4 text-emerald-600" />} label="Revenue (comp)" value={kpis.totalRevenue > 0 ? formatCurrency(kpis.totalRevenue) : '—'} />
          <Kpi icon={<DollarSign className="w-4 h-4 text-emerald-700" />} label="Net Profit"
               value={kpis.totalRevenue > 0 || kpis.totalLeadCost > 0 ? formatCurrency(kpis.netProfit) : '—'}
               highlight={kpis.netProfit >= 0 ? 'good' : 'bad'} />
          <Kpi icon={<TrendingUp className="w-4 h-4 text-emerald-700" />} label="ROI"
               value={kpis.roi == null ? '—' : `${kpis.roi.toFixed(0)}%`}
               highlight={kpis.roi != null && kpis.roi >= 0 ? 'good' : kpis.roi != null ? 'bad' : undefined} />
        </div>
      </div>

      {/* Donut — share of funded loans by source */}
      {donutTotal > 0 && (
        <div className="px-6 py-4 bg-white border-b border-slate-200">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Share of funded loans by source</h3>
          <div className="flex items-center gap-8 flex-wrap">
            {/* Donut with total in the center */}
            <div className="relative shrink-0" style={{ width: 220, height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="funded"
                    nameKey="name"
                    cx="50%" cy="50%"
                    innerRadius={68} outerRadius={100}
                    paddingAngle={2}
                    stroke="#fff" strokeWidth={2}
                    isAnimationActive
                  >
                    {donutData.map((d, i) => (
                      <Cell key={d.name} fill={d.isOther ? '#94a3b8' : DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={renderDonutTooltip as never} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-3xl font-bold text-slate-900 tabular-nums leading-none">{donutTotal}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mt-1">Funded</span>
              </div>
            </div>
            {/* Legend */}
            <div className="flex-1 min-w-[260px] grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
              {donutData.map((d, i) => (
                <div key={d.name} className="flex items-center gap-2 text-sm">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.isOther ? '#94a3b8' : DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span className="flex-1 truncate text-slate-700">{d.name}</span>
                  <span className="tabular-nums font-semibold text-slate-800">{d.funded}</span>
                  <span className="tabular-nums text-slate-400 w-10 text-right">{donutTotal > 0 ? Math.round((d.funded / donutTotal) * 100) : 0}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : visibleSources.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
            <BarChart3 className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-700">No sources match the current filters</p>
            <p className="text-xs text-slate-500 mt-1">Try widening the date range, LO, or source filter.</p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  <th className="px-3 py-2.5 w-6"></th>
                  <th className="px-3 py-2.5">Source</th>
                  <th className="px-3 py-2.5 text-right">Leads</th>
                  <th className="px-3 py-2.5 text-right">Open</th>
                  <th className="px-3 py-2.5 text-right">Active</th>
                  <th className="px-3 py-2.5 text-right">Lost</th>
                  <th className="px-3 py-2.5 text-right" title="Loan Funded · Broker Check Received · Loan Finalized">Funded</th>
                  <th className="px-3 py-2.5 text-right">Conv. %</th>
                  <th className="px-3 py-2.5 text-right">Funded Volume</th>
                  <th className="px-3 py-2.5 text-right border-l border-slate-200" title="Σ Lead Price across this source's leads (from GHL)">Lead Cost</th>
                  <th className="px-3 py-2.5 text-right" title="Σ Compensation Amount on funded deals (from Arive)">Revenue</th>
                  <th className="px-3 py-2.5 text-right" title="Revenue − Lead Cost">Net Profit</th>
                  <th className="px-3 py-2.5 text-right" title="Net Profit ÷ Lead Cost">ROI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleSources.map((s, i) => {
                  const conv = s.total > 0 ? (s.funded / s.total) * 100 : 0
                  const convTone = conv >= 10 ? 'bg-emerald-50 text-emerald-700' : conv >= 5 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'
                  const isExpanded = expanded.has(s.source)
                  const isEditing  = editingCost === s.source
                  // "Quiet" sources — no funded loans and no active escrows. Dimmed so
                  // the sources that are actually producing/costing money stand out.
                  const isQuiet = s.funded === 0 && s.active === 0
                  return (
                    <React.Fragment key={s.source}>
                      <tr className={`transition-colors ${
                        isExpanded ? 'bg-indigo-50/50' : i % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'
                      } hover:bg-slate-50 ${isQuiet ? 'opacity-55' : ''}`}>
                        <td className="px-3 py-2">
                          <button onClick={() => toggleExpand(s.source)} className="text-slate-400 hover:text-slate-700">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-900">
                          <button onClick={() => toggleExpand(s.source)} className="hover:text-blue-700 text-left">
                            {s.source}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-700">{s.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{s.open || <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{s.active ? <span className="text-amber-700 font-medium">{s.active}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{s.lost || <span className="text-slate-300">—</span>}</td>
                        {/* Funded — emphasized as a chip */}
                        <td className="px-3 py-2 text-right">
                          {s.funded > 0
                            ? <span className="inline-flex items-center justify-center min-w-[1.6rem] px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-semibold tabular-nums">{s.funded}</span>
                            : <span className="tabular-nums text-slate-300">—</span>}
                        </td>
                        {/* Conv % — tone pill */}
                        <td className="px-3 py-2 text-right">
                          {s.total > 0
                            ? <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums ${convTone}`}>{conv.toFixed(1)}%</span>
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{s.fundedVolume > 0 ? formatCurrency(s.fundedVolume) : <span className="text-slate-300">—</span>}</td>
                        {/* ── money group (visual divider) ── */}
                        <td className="px-3 py-2 text-right tabular-nums text-rose-600 border-l border-slate-200">{s.leadCost > 0 ? formatCurrency(s.leadCost) : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{s.revenue > 0 ? formatCurrency(s.revenue) : <span className="text-slate-300">—</span>}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                          (s.revenue === 0 && s.leadCost === 0) ? 'text-slate-300' : s.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}>
                          {(s.revenue === 0 && s.leadCost === 0) ? '—' : formatCurrency(s.netProfit)}
                        </td>
                        {/* ROI — tone pill */}
                        <td className="px-3 py-2 text-right">
                          {s.roi == null
                            ? <span className="text-slate-300">—</span>
                            : <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-bold tabular-nums ${s.roi >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{s.roi.toFixed(0)}%</span>}
                        </td>
                      </tr>
                      {/* Drill-down — monthly-cost editor + deals from this source */}
                      {isExpanded && (
                        <tr className="bg-indigo-50/30">
                          <td colSpan={13} className="px-6 py-3">
                            {/* Flat monthly cost (relocated from its own column) */}
                            <div className="flex items-center flex-wrap gap-2 mb-3 text-xs bg-white border border-slate-200 rounded px-3 py-2">
                              <span className="text-slate-500 font-medium whitespace-nowrap">Flat monthly cost:</span>
                              {isEditing ? (
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
                              <span className="text-[10px] text-slate-400 ml-1">For sources billed a flat retainer (not per-lead).</span>
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
                {/* Totals row */}
                <tr className="bg-slate-100 font-bold text-slate-700 border-t-2 border-slate-200">
                  <td></td>
                  <td className="px-3 py-2.5">Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{kpis.totalLeads}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{visibleSources.reduce((s, r) => s + r.open, 0)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{kpis.totalActive}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{visibleSources.reduce((s, r) => s + r.lost, 0)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{kpis.totalFunded}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{kpis.conversionRate.toFixed(1)}%</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(kpis.totalVolume)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-rose-600 border-l border-slate-200">{kpis.totalLeadCost > 0 ? formatCurrency(kpis.totalLeadCost) : '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{kpis.totalRevenue > 0 ? formatCurrency(kpis.totalRevenue) : '—'}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${kpis.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    {(kpis.totalRevenue > 0 || kpis.totalLeadCost > 0) ? formatCurrency(kpis.netProfit) : '—'}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${kpis.roi == null ? '' : kpis.roi >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    {kpis.roi == null ? '—' : `${kpis.roi.toFixed(0)}%`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Definitions footer */}
        {visibleSources.length > 0 && (
          <div className="mt-4 text-[11px] text-slate-400 leading-relaxed">
            <strong>Open</strong> = still in Leads pipeline ·
            <strong> Active</strong> = Loans in Process ·
            <strong> Lost</strong> = Not Ready ·
            <strong> Funded</strong> = Loan Funded · Broker Check Received · Loan Finalized ·
            <strong> Conv.%</strong> = Funded ÷ Total Leads ·
            <strong> Lead Cost</strong> = Σ Lead Price across this source&apos;s leads (GHL) ·
            <strong> Revenue</strong> = Σ Compensation Amount on funded deals (Arive) ·
            <strong> Net Profit</strong> = Revenue − Lead Cost ·
            <strong> ROI</strong> = Net Profit ÷ Lead Cost ·
            Expand a source row to see its deals, set an optional flat <strong>monthly cost</strong> (for retainer-billed sources), or recategorize.
          </div>
        )}

        {/* Funded loans for the current timeframe (matches the Funded KPI) */}
        {!loading && fundedView.list.length > 0 && (
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
                    <th className="px-3 py-2.5">LO</th>
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
                      <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{d.loan_officer || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtDate(d.funded_date)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-slate-800">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 pr-4">{d.compensation_amount ? formatCurrency(d.compensation_amount) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-800">
                    <td className="px-4 py-2.5" colSpan={4}>Total</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(fundedView.volume)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 pr-4">{formatCurrency(fundedView.comp)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function Kpi({ icon, label, value, highlight }: {
  icon: React.ReactNode
  label: string
  value: string
  highlight?: boolean | 'good' | 'bad'
}) {
  const box =
    highlight === 'good' ? 'border-emerald-300 ring-1 ring-emerald-200' :
    highlight === 'bad'  ? 'border-red-300 ring-1 ring-red-200'         :
    highlight            ? 'border-indigo-300 ring-1 ring-indigo-200'   :
                           'border-slate-200'
  const text =
    highlight === 'good' ? 'text-emerald-700' :
    highlight === 'bad'  ? 'text-red-700'     :
    highlight            ? 'text-indigo-700'  :
                           'text-slate-800'
  return (
    <div className={`border rounded-lg px-3 py-2 bg-white ${box}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        {icon}
        <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <p className={`text-lg font-bold tabular-nums ${text}`}>{value}</p>
    </div>
  )
}

// ── Drill-down: list of deals from one source + recategorize controls ───────
function SourceDealsList({
  sourceLabel, deals, allSources, onChangeDealSource, onBulkReassign,
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
      // Funded first, then Active, then Open, then Lost
      const rank = (g: string | null) => g === 'Funded' ? 0 : g === 'Loans in Process' ? 1 : g === 'Leads' ? 2 : 3
      return rank(a.pipeline_group) - rank(b.pipeline_group)
    }), [deals])
  const visible = showAll ? sorted : sorted.slice(0, 12)
  const remaining = sorted.length - visible.length

  return (
    <div>
      {/* Bulk reassign — wholesale move every deal in this source */}
      <div className="flex items-center gap-2 mb-3 text-xs bg-white border border-slate-200 rounded px-3 py-2">
        <span className="text-slate-500 font-medium whitespace-nowrap">
          Reassign all {sorted.length}:
        </span>
        <span className="text-slate-800 font-semibold">{sourceLabel}</span>
        <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
        <select
          value={bulkTarget}
          onChange={e => setBulkTarget(e.target.value)}
          className="border border-slate-200 rounded px-2 py-1 text-xs flex-1 max-w-[200px] focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Pick a target source…</option>
          {allSources.filter(s => s !== sourceLabel).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="…or type a new source"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim()
              if (v) { setBulkTarget(v); (e.target as HTMLInputElement).value = '' }
            }
          }}
          className="border border-slate-200 rounded px-2 py-1 text-xs w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={() => { if (bulkTarget) onBulkReassign(sourceLabel, bulkTarget) }}
          disabled={!bulkTarget}
          className="px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-40 flex items-center gap-1"
        >
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
            <span className="text-slate-400 text-[10px] shrink-0 hidden lg:inline w-24 truncate">{d.loan_officer ?? '—'}</span>
            {/* Inline source dropdown for recategorization */}
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
        <input
          type="text"
          autoFocus
          value={customValue}
          onChange={e => setCustomValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { commit(customValue.trim()); setMode('select') }
            if (e.key === 'Escape') { setMode('select'); setCustomValue(currentSource) }
          }}
          placeholder="Type new source"
          className="border border-blue-300 rounded px-1.5 py-0.5 text-[11px] w-32 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
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
      <select
        value={currentSource}
        onChange={e => {
          const v = e.target.value
          if (v === '__custom__') { setMode('custom'); setCustomValue('') }
          else commit(v)
        }}
        disabled={saving}
        className={`text-[11px] rounded border px-1.5 py-0.5 max-w-[120px] focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          savedFlash ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'
        }`}
        title="Reassign this deal to a different source"
      >
        {!allSources.includes(currentSource) && currentSource && (
          <option value={currentSource}>{currentSource}</option>
        )}
        <option value="">(no source)</option>
        {allSources.map(s => <option key={s} value={s}>{s}</option>)}
        <option value="__custom__">— Type a new source… —</option>
      </select>
      {savedFlash && <Check className="w-3 h-3 text-emerald-600" />}
    </div>
  )
}
