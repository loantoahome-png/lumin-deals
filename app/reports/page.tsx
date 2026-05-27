'use client'

/**
 * Reports & Analytics — the "how's the business doing?" view.
 *
 * Pure read-only aggregation over the deals table:
 *   • Pull-through (leads → funded), conversion funnel by stage
 *   • Avg days-in-stage (where deals stall)
 *   • LO scorecard — Matt vs Moe
 *   • Funded volume trend (last 12 months)
 *   • Lead source breakdown
 *
 * Date filter mirrors the Dashboard's preset model.
 */

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid,
} from 'recharts'
import {
  TrendingUp, Users, DollarSign, Target, Clock, Activity, Calendar, X,
} from 'lucide-react'

// ── Date filter (same model as Dashboard) ───────────────────────────────────
type DatePreset = 'all' | 'mtd' | 'qtd' | 'ytd' | 'custom'

function getPresetRange(preset: DatePreset, from: string, to: string): { start: Date | null; end: Date | null } {
  const now = new Date()
  if (preset === 'mtd') return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  if (preset === 'qtd') {
    const q = Math.floor(now.getMonth() / 3)
    return { start: new Date(now.getFullYear(), q * 3, 1), end: now }
  }
  if (preset === 'ytd') return { start: new Date(now.getFullYear(), 0, 1), end: now }
  if (preset === 'custom') {
    return {
      start: from ? new Date(from) : null,
      end: to ? new Date(to + 'T23:59:59') : null,
    }
  }
  return { start: null, end: null }
}

function dealDate(d: Deal): Date {
  const raw = d.pipeline_group === 'Funded' ? (d.funded_date || d.created_at) : d.created_at
  return new Date(raw)
}
function inRange(d: Deal, start: Date | null, end: Date | null): boolean {
  if (!start && !end) return true
  const dt = dealDate(d)
  if (start && dt < start) return false
  if (end && dt > end) return false
  return true
}

const LO_COLORS: Record<string, string> = {
  'Matt': '#10b981',
  'Moe Sefati': '#f59e0b',
}

// Funnel stages in order — leads pipeline → escrow → funded
const FUNNEL = [
  { key: 'New Lead',               label: 'New Lead' },
  { key: 'Attempted Contact',      label: 'Attempted' },
  { key: 'Responded',              label: 'Responded' },
  { key: 'Pitching',               label: 'Pitching' },
  { key: 'Appointment Booked',     label: 'Appt Booked' },
  { key: 'App Intake',             label: 'App Intake' },
  { key: 'Qualification',          label: 'Qualification' },
  { key: 'Pre-Approved',           label: 'Pre-Approved' },
  { key: '__escrow__',             label: 'In Escrow' },
  { key: '__funded__',             label: 'Funded' },
]

const ESCROW_STAGES = [
  'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
  'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
]

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const d1 = new Date(a).getTime()
  const d2 = new Date(b).getTime()
  if (isNaN(d1) || isNaN(d2)) return null
  return Math.max(0, (d2 - d1) / 86_400_000)
}

// ── KPI card ────────────────────────────────────────────────────────────────
function Kpi({ label, value, sub, icon, tone = 'slate' }: {
  label: string; value: string; sub?: string; icon: React.ReactNode
  tone?: 'slate' | 'emerald' | 'blue' | 'amber'
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-700', emerald: 'text-emerald-600',
    blue: 'text-blue-600', amber: 'text-amber-600',
  }
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
        <span className="text-slate-300">{icon}</span>
      </div>
      <p className={`text-3xl font-bold mt-2 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
      <div className="mb-4">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export default function ReportsPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [datePreset, setDatePreset] = useState<DatePreset>('ytd')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const customRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function fetchDeals() {
      const all = await fetchAllDeals(q => q.order('created_at', { ascending: false }))
      setDeals(all)
      setLoading(false)
    }
    fetchDeals()
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (customRef.current && !customRef.current.contains(e.target as Node)) setShowCustom(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  const { start, end } = getPresetRange(datePreset, customFrom, customTo)
  const filtered = deals.filter(d => inRange(d, start, end))

  // ── Pull-through ──────────────────────────────────────────────────────────
  // "Started" = every deal that ever entered the funnel in range.
  // "Funded"  = deals now in the Funded pipeline.
  const fundedDeals = filtered.filter(d => d.pipeline_group === 'Funded')
  const escrowDeals = filtered.filter(d => d.pipeline_group === 'Loans in Process')
  const leadDeals   = filtered.filter(d => d.pipeline_group === 'Leads')
  const notReady    = filtered.filter(d => d.pipeline_group === 'Not Ready')
  const totalStarted = filtered.length
  const pullThrough = totalStarted > 0 ? (fundedDeals.length / totalStarted) * 100 : 0

  const fundedVolume = fundedDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
  const escrowVolume = escrowDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
  const avgFundedSize = fundedDeals.filter(d => d.loan_amount).length > 0
    ? fundedVolume / fundedDeals.filter(d => d.loan_amount).length : 0

  // ── Conversion funnel ─────────────────────────────────────────────────────
  // Count deals AT each stage. The __escrow__/__funded__ buckets aggregate.
  const funnelData = FUNNEL.map(f => {
    let count: number
    if (f.key === '__escrow__') count = escrowDeals.length
    else if (f.key === '__funded__') count = fundedDeals.length
    else count = filtered.filter(d => d.status === f.key).length
    return { stage: f.label, count }
  })

  // ── Avg days-in-stage (escrow stages) ─────────────────────────────────────
  // For deals currently in escrow we approximate "days in current stage" from
  // stage_changed_at; for time-to-fund we use created_at → funded_date.
  const stageDwell = ESCROW_STAGES.map(stage => {
    const inStage = escrowDeals.filter(d => d.status === stage)
    const dwells = inStage
      .map(d => daysBetween(d.stage_changed_at || d.created_at, new Date().toISOString()))
      .filter((n): n is number => n != null)
    const avg = dwells.length > 0 ? dwells.reduce((s, n) => s + n, 0) / dwells.length : 0
    return { stage: stage.replace('Approved w/ Conditions', 'Approved').replace('Submitted to UW', 'UW'), days: Math.round(avg * 10) / 10, count: inStage.length }
  })

  // Time to fund: created_at → funded_date for funded deals in range
  const fundTimes = fundedDeals
    .map(d => daysBetween(d.created_at, d.funded_date))
    .filter((n): n is number => n != null)
  const avgTimeToFund = fundTimes.length > 0
    ? Math.round(fundTimes.reduce((s, n) => s + n, 0) / fundTimes.length)
    : 0

  // ── LO scorecard ──────────────────────────────────────────────────────────
  const loScorecard = ['Matt', 'Moe Sefati'].map(lo => {
    const all = filtered.filter(d => d.loan_officer?.includes(lo))
    const funded = all.filter(d => d.pipeline_group === 'Funded')
    const escrow = all.filter(d => d.pipeline_group === 'Loans in Process')
    const fundedVol = funded.reduce((s, d) => s + (d.loan_amount || 0), 0)
    const sized = funded.filter(d => d.loan_amount)
    return {
      name: lo,
      total: all.length,
      funded: funded.length,
      escrow: escrow.length,
      fundedVolume: fundedVol,
      avgSize: sized.length > 0 ? fundedVol / sized.length : 0,
      pullThrough: all.length > 0 ? (funded.length / all.length) * 100 : 0,
    }
  })

  // ── Funded volume trend — last 12 calendar months (ignores date filter) ───
  const now = new Date()
  const months: { label: string; key: string }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      label: d.toLocaleString('default', { month: 'short' }),
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    })
  }
  const allFunded = deals.filter(d => d.pipeline_group === 'Funded')
  const trendData = months.map(m => {
    const inMonth = allFunded.filter(d => {
      const fd = d.funded_date || d.created_at
      return fd && fd.slice(0, 7) === m.key
    })
    return {
      month: m.label,
      volume: inMonth.reduce((s, d) => s + (d.loan_amount || 0), 0),
      units: inMonth.length,
    }
  })

  // ── Lead source breakdown ─────────────────────────────────────────────────
  const sourceMap: Record<string, { total: number; funded: number; volume: number }> = {}
  for (const d of filtered) {
    const src = (d.lead_source_agg || d.source || 'Unknown').trim() || 'Unknown'
    sourceMap[src] ??= { total: 0, funded: 0, volume: 0 }
    sourceMap[src].total++
    if (d.pipeline_group === 'Funded') {
      sourceMap[src].funded++
      sourceMap[src].volume += d.loan_amount || 0
    }
  }
  const sourceData = Object.entries(sourceMap)
    .map(([name, v]) => ({ name, ...v, conv: v.total > 0 ? (v.funded / v.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  const PRESETS: { key: DatePreset; label: string }[] = [
    { key: 'all', label: 'All Time' },
    { key: 'mtd', label: 'MTD' },
    { key: 'qtd', label: 'QTD' },
    { key: 'ytd', label: 'YTD' },
    { key: 'custom', label: 'Custom' },
  ]
  const rangeLabel = datePreset === 'all' ? 'All time'
    : datePreset === 'mtd' ? `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}`
    : datePreset === 'qtd' ? `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`
    : datePreset === 'ytd' ? `YTD ${now.getFullYear()}`
    : customFrom || customTo ? `${customFrom || '…'} → ${customTo || '…'}` : 'Custom range'

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports &amp; Analytics</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Pipeline health, conversion, and loan officer performance — <span className="font-medium text-slate-600">{rangeLabel}</span>
          </p>
        </div>
        {/* Date filter */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 relative" ref={customRef}>
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => { setDatePreset(p.key); if (p.key === 'custom') setShowCustom(true) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                datePreset === p.key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {p.label}
            </button>
          ))}
          {showCustom && datePreset === 'custom' && (
            <div className="absolute top-full right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-xl p-4 z-50 w-72">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Custom Range</span>
                <button onClick={() => setShowCustom(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
              </div>
              <label className="block text-xs text-slate-500 mb-1">From</label>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3" />
              <label className="block text-xs text-slate-500 mb-1">To</label>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </div>
          )}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Pull-Through Rate" tone="emerald" icon={<Target className="w-4 h-4" />}
          value={`${pullThrough.toFixed(1)}%`}
          sub={`${fundedDeals.length} funded of ${totalStarted} total`} />
        <Kpi label="Funded Volume" tone="blue" icon={<DollarSign className="w-4 h-4" />}
          value={formatCurrency(fundedVolume)}
          sub={`${fundedDeals.length} loans · avg ${formatCurrency(avgFundedSize)}`} />
        <Kpi label="Avg Time to Fund" tone="amber" icon={<Clock className="w-4 h-4" />}
          value={avgTimeToFund > 0 ? `${avgTimeToFund} days` : '—'}
          sub="From lead created → funded" />
        <Kpi label="Active Escrow Volume" icon={<Activity className="w-4 h-4" />}
          value={formatCurrency(escrowVolume)}
          sub={`${escrowDeals.length} in process`} />
      </div>

      {/* Pipeline snapshot strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Leads', count: leadDeals.length, color: 'bg-slate-400' },
          { label: 'In Escrow', count: escrowDeals.length, color: 'bg-amber-500' },
          { label: 'Funded', count: fundedDeals.length, color: 'bg-emerald-500' },
          { label: 'Not Ready', count: notReady.length, color: 'bg-rose-400' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${s.color}`} />
            <div>
              <p className="text-2xl font-bold text-slate-800">{s.count}</p>
              <p className="text-xs text-slate-400">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Conversion funnel */}
      <Card title="Conversion Funnel" subtitle="Deals currently at each stage — where the pipeline narrows">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={funnelData} layout="vertical" margin={{ left: 20, right: 30 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="stage" tick={{ fontSize: 11 }} width={90} />
              <Tooltip />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {funnelData.map((_, i) => (
                  <Cell key={i} fill={i >= FUNNEL.length - 2 ? '#10b981' : '#3b82f6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Days in stage */}
        <Card title="Avg Days in Stage" subtitle="How long active escrows have been sitting — flags bottlenecks">
          {stageDwell.every(s => s.count === 0) ? (
            <p className="text-sm text-slate-400 italic py-8 text-center">No active escrow deals in range.</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stageDwell} margin={{ left: 0, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="stage" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number, _n, p) => [`${v} days · ${(p.payload as { count: number }).count} deals`, 'Avg dwell']} />
                  <Bar dataKey="days" radius={[4, 4, 0, 0]} fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Funded volume trend */}
        <Card title="Funded Volume — Last 12 Months" subtitle="Monthly funded loan volume (all time, not date-filtered)">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ left: 10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number, n) => n === 'volume' ? [formatCurrency(v), 'Volume'] : [v, 'Units']} />
                <Line type="monotone" dataKey="volume" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* LO scorecard */}
      <Card title="Loan Officer Scorecard" subtitle="Head-to-head — Matt vs Moe over the selected range">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-4 font-medium">Loan Officer</th>
                <th className="py-2 px-4 font-medium text-right">Total Deals</th>
                <th className="py-2 px-4 font-medium text-right">In Escrow</th>
                <th className="py-2 px-4 font-medium text-right">Funded</th>
                <th className="py-2 px-4 font-medium text-right">Funded Volume</th>
                <th className="py-2 px-4 font-medium text-right">Avg Loan Size</th>
                <th className="py-2 pl-4 font-medium text-right">Pull-Through</th>
              </tr>
            </thead>
            <tbody>
              {loScorecard.map(lo => (
                <tr key={lo.name} className="border-b border-slate-50 last:border-0">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: LO_COLORS[lo.name] || '#94a3b8' }} />
                      <span className="font-semibold text-slate-800">{lo.name}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums text-slate-700">{lo.total}</td>
                  <td className="py-3 px-4 text-right tabular-nums text-slate-700">{lo.escrow}</td>
                  <td className="py-3 px-4 text-right tabular-nums font-semibold text-emerald-600">{lo.funded}</td>
                  <td className="py-3 px-4 text-right tabular-nums text-slate-700">{formatCurrency(lo.fundedVolume)}</td>
                  <td className="py-3 px-4 text-right tabular-nums text-slate-700">{formatCurrency(lo.avgSize)}</td>
                  <td className="py-3 pl-4 text-right tabular-nums font-semibold text-slate-800">{lo.pullThrough.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Lead source breakdown */}
      <Card title="Lead Source Breakdown" subtitle="Volume and conversion by source — where your funded loans come from">
        {sourceData.length === 0 ? (
          <p className="text-sm text-slate-400 italic py-8 text-center">No lead source data in range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 px-4 font-medium text-right">Total Leads</th>
                  <th className="py-2 px-4 font-medium text-right">Funded</th>
                  <th className="py-2 px-4 font-medium text-right">Conversion</th>
                  <th className="py-2 pl-4 font-medium text-right">Funded Volume</th>
                </tr>
              </thead>
              <tbody>
                {sourceData.map(s => (
                  <tr key={s.name} className="border-b border-slate-50 last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-slate-800">{s.name}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-slate-700">{s.total}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-emerald-600 font-semibold">{s.funded}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-slate-700">
                      <span className={s.conv >= 10 ? 'text-emerald-600 font-semibold' : s.conv > 0 ? 'text-slate-700' : 'text-slate-300'}>
                        {s.conv.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2.5 pl-4 text-right tabular-nums text-slate-700">{formatCurrency(s.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-slate-400 mt-3">
              Tip: add a cost-per-lead figure for each source and we can turn this into true cost-per-funded-loan ROI.
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
