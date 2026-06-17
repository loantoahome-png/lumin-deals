'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import DashboardNotes from '@/components/DashboardNotes'
import UnreadInbox from '@/components/UnreadInbox'
import {
  DollarSign, TrendingUp, Users, CheckCircle, Clock, AlertCircle, Calendar, X,
  AlertTriangle, ChevronRight, Flame,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend, LineChart, Line, ReferenceLine,
} from 'recharts'
import Link from 'next/link'

// ── Date filter types & helpers ───────────────────────────────────────────────
type DatePreset = 'all' | 'mtd' | 'qtd' | 'ytd' | 'custom'

function getPresetRange(preset: DatePreset, customFrom: string, customTo: string): { start: Date | null; end: Date | null } {
  const now = new Date()
  if (preset === 'mtd') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  }
  if (preset === 'qtd') {
    const q = Math.floor(now.getMonth() / 3)
    return { start: new Date(now.getFullYear(), q * 3, 1), end: now }
  }
  if (preset === 'ytd') {
    return { start: new Date(now.getFullYear(), 0, 1), end: now }
  }
  if (preset === 'custom') {
    return {
      start: customFrom ? new Date(customFrom) : null,
      end: customTo ? new Date(customTo + 'T23:59:59') : null,
    }
  }
  return { start: null, end: null }
}

function dealDate(d: Deal): Date {
  // Use funded_date for funded deals (most business-relevant); fall back to created_at
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

// Colors for the 8 sub-stages within Loans in Process — match the kanban
// accent stripes on the Active Escrows page so the dashboard feels coherent.
const STAGE_COLORS: Record<string, string> = {
  'Setup':    '#facc15', // yellow-400
  'Disclosed':'#f59e0b', // amber-500
  'UW':       '#f97316', // orange-500
  'Cond.':    '#84cc16', // lime-500
  'Re-Sub':   '#ef4444', // red-500
  'CTC':      '#10b981', // emerald-500
  'Docs Out': '#14b8a6', // teal-500
  'Signed':   '#16a34a', // green-600
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)

  // Date filter state
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const customRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function fetchDeals() {
      // Paginate past PostgREST's 1 000-row default cap — the table has >1 000
      // deals, and a bare select('*') silently dropped the oldest ones, so older
      // escrows were missing from every dashboard metric (e.g. the "Escrows by
      // Stage" chart undercounted Docs Signed). Select only the columns the
      // dashboard reads (never raw_ghl_data) to keep egress minimal.
      const DASHBOARD_COLS =
        'id,name,status,pipeline_group,loan_amount,loan_officer,loan_type,' +
        'created_at,funded_date,next_action,next_action_assignee,next_action_due,' +
        'next_action_due'
      const data = await fetchAllDeals(
        q => q.order('created_at', { ascending: false }),
        DASHBOARD_COLS,
      )
      setDeals(data)
      setLoading(false)
    }
    fetchDeals()
  }, [])

  // Close custom popover on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (customRef.current && !customRef.current.contains(e.target as Node)) {
        setShowCustom(false)
      }
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

  const { start: rangeStart, end: rangeEnd } = getPresetRange(datePreset, customFrom, customTo)

  // Apply date filter to the full deal list, then narrow to Active Escrows only.
  // The dashboard is dedicated to the Loans-in-Process pipeline — Leads, Funded,
  // and Not Ready deals are excluded from every KPI, chart, and list below.
  const filteredDeals = deals.filter(d => inRange(d, rangeStart, rangeEnd))
  const escrowDeals = filteredDeals.filter(d => d.pipeline_group === 'Loans in Process')

  const totalPipelineLoanVol = escrowDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
  const sizedDeals = escrowDeals.filter(d => d.loan_amount)
  const avgDealSize = sizedDeals.length > 0
    ? sizedDeals.reduce((s, d) => s + (d.loan_amount || 0), 0) / sizedDeals.length
    : 0

  // "Funding soon" = escrows that are right next to the finish line
  const fundingSoon = escrowDeals.filter(d => ['Clear to Close', 'Docs Out', 'Docs Signed'].includes(d.status || ''))
  const fundingSoonVolume = fundingSoon.reduce((s, d) => s + (d.loan_amount || 0), 0)

  // Stage chart: the 8 sub-stages within Loans in Process (the actual escrow flow)
  const ESCROW_STAGES = [
    'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
    'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
  ] as const
  const STAGE_SHORT: Record<string, string> = {
    'Loan Setup': 'Setup', 'Disclosed': 'Disclosed', 'Submitted to UW': 'UW',
    'Approved w/ Conditions': 'Cond.', 'Re-Submittal': 'Re-Sub',
    'Clear to Close': 'CTC', 'Docs Out': 'Docs Out', 'Docs Signed': 'Signed',
  }
  const stageData = ESCROW_STAGES.map(stage => {
    const d = escrowDeals.filter(x => x.status === stage)
    return { stage: STAGE_SHORT[stage] || stage, count: d.length, loanVolume: d.reduce((s, x) => s + (x.loan_amount || 0), 0) }
  })

  // LO Performance: scoped to escrow deals only
  const loData = ['Matt', 'Moe Sefati'].map(lo => {
    const loDeals = escrowDeals.filter(d => d.loan_officer?.includes(lo))
    return { name: lo, loanVolume: loDeals.reduce((s, d) => s + (d.loan_amount || 0), 0), deals: loDeals.length }
  })

  // Loan Types: from escrows only
  const loanTypeMap: Record<string, number> = {}
  escrowDeals.forEach(d => { if (d.loan_type) loanTypeMap[d.loan_type] = (loanTypeMap[d.loan_type] || 0) + 1 })
  const loanTypeData = Object.entries(loanTypeMap).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => ({ name, value }))

  // Needs attention + Recent deals: from escrows only
  const atRisk = escrowDeals.filter(d => !d.loan_officer || !d.loan_type || !d.loan_amount).slice(0, 5)
  const recentDeals = [...escrowDeals]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5)
  // ── Today widget: escrows with follow-ups due today or overdue ──────────────
  const now = new Date()
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
  const escrowsInProcess = deals.filter(d => d.pipeline_group === 'Loans in Process')
  const todayItems = escrowsInProcess.filter(d => {
    if (!d.next_action_due) return false
    const due = new Date(d.next_action_due)
    return due <= endOfToday
  }).sort((a, b) =>
    new Date(a.next_action_due as string).getTime() - new Date(b.next_action_due as string).getTime()
  )
  const overdueItems = todayItems.filter(d => new Date(d.next_action_due as string) < now)
  const dueTodayItems = todayItems.filter(d => new Date(d.next_action_due as string) >= now && new Date(d.next_action_due as string) <= endOfToday)

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#f97316', '#8b5cf6', '#ec4899']

  // Preset button labels
  const PRESETS: { key: DatePreset; label: string }[] = [
    { key: 'all',    label: 'All Time' },
    { key: 'mtd',    label: 'MTD' },
    { key: 'qtd',    label: 'QTD' },
    { key: 'ytd',    label: 'YTD' },
    { key: 'custom', label: 'Custom' },
  ]

  // Human-readable range label shown in header
  const rangeLabel = datePreset === 'all' ? null
    : datePreset === 'mtd' ? `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`
    : datePreset === 'qtd' ? `Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()}`
    : datePreset === 'ytd' ? `YTD ${new Date().getFullYear()}`
    : (customFrom || customTo) ? `${customFrom || '…'} → ${customTo || '…'}`
    : null

  function handlePreset(key: DatePreset) {
    setDatePreset(key)
    if (key === 'custom') {
      setShowCustom(true)
    } else {
      setShowCustom(false)
    }
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Lumin Lending — Active Escrow Overview
            {rangeLabel && <span className="ml-2 text-blue-600 font-medium">· {rangeLabel}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Date Filter Bar */}
          <div className="flex items-center bg-slate-100 rounded-lg p-1 gap-0.5 relative">
            <Calendar className="w-3.5 h-3.5 text-slate-400 ml-1.5 mr-0.5 shrink-0" />
            {PRESETS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => handlePreset(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  datePreset === key
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {label}
              </button>
            ))}

            {/* Custom date popover */}
            {showCustom && (
              <div ref={customRef} className="absolute top-full right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-lg p-4 z-50 w-72">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-slate-800">Custom Range</p>
                  <button onClick={() => setShowCustom(false)} className="text-slate-400 hover:text-slate-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">From</label>
                    <input
                      type="date"
                      value={customFrom}
                      onChange={e => setCustomFrom(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">To</label>
                    <input
                      type="date"
                      value={customTo}
                      onChange={e => setCustomTo(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <button
                    onClick={() => setShowCustom(false)}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>

          <Link href="/deals/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            + New Deal
          </Link>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KPICard label="Active Escrow Volume"  value={formatCurrency(totalPipelineLoanVol)} sub={`${escrowDeals.length} escrow${escrowDeals.length !== 1 ? 's' : ''}`} icon={<TrendingUp className="w-5 h-5" />} color="blue" />
        <KPICard label="Funding Soon"          value={formatCurrency(fundingSoonVolume)}    sub={`${fundingSoon.length} CTC / Docs Out / Signed`} icon={<DollarSign className="w-5 h-5" />} color="green" />
        <KPICard label="Total Escrows"         value={escrowDeals.length.toString()}        sub="loans in process"                                  icon={<Users className="w-5 h-5" />} color="purple" />
        <KPICard label="Avg Loan Size"         value={formatCurrency(avgDealSize)}          sub="active escrows"                                    icon={<CheckCircle className="w-5 h-5" />} color="amber" />
      </div>

      {/* Today widget — escrow follow-ups due today + overdue */}
      {(todayItems.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-orange-500" />
              <h3 className="font-semibold text-slate-800 text-sm">Today&apos;s Escrow Follow-ups</h3>
              <span className="text-xs text-slate-500">
                {overdueItems.length > 0 && (
                  <span className="font-semibold text-red-600">{overdueItems.length} overdue</span>
                )}
                {overdueItems.length > 0 && dueTodayItems.length > 0 && ' · '}
                {dueTodayItems.length > 0 && (
                  <span className="font-semibold text-amber-600">{dueTodayItems.length} due today</span>
                )}
              </span>
            </div>
            <Link href="/deals" className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-0.5">
              Open Tracker <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
            {todayItems.slice(0, 12).map(d => {
              const due = new Date(d.next_action_due as string)
              const isOverdueRow = due < now
              const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              return (
                <Link
                  key={d.id}
                  href={`/deals/${d.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50 transition group"
                >
                  <div className={`shrink-0 w-1 h-10 rounded-full ${isOverdueRow ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <div className="shrink-0 w-20 text-right">
                    <div className={`text-xs font-semibold ${isOverdueRow ? 'text-red-700' : 'text-amber-700'}`}>
                      {isOverdueRow ? 'Overdue' : time}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {isOverdueRow ? `was ${time}` : 'today'}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 truncate">
                      {d.name}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {d.next_action || <span className="italic text-slate-400">No next step set</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs text-slate-700 font-medium">{d.next_action_assignee || d.loan_officer || '—'}</div>
                    <div className="text-[10px] text-slate-400">{d.status}</div>
                  </div>
                </Link>
              )
            })}
            {todayItems.length > 12 && (
              <Link href="/deals" className="block text-center py-2 text-xs text-blue-600 hover:bg-slate-50 font-medium">
                + {todayItems.length - 12} more in tracker →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Unread Messages — live client inbox across both GHL accounts */}
      <UnreadInbox embedded />

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Escrows by Stage</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stageData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="stage" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Bar dataKey="count" name="deals" radius={[4, 4, 0, 0]}>
                {stageData.map(entry => <Cell key={entry.stage} fill={STAGE_COLORS[entry.stage] || '#94a3b8'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Loan Types</h2>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={loanTypeData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="value">
                {loanTypeData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* LO Performance + At Risk + Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">LO Performance</h2>
          <div className="space-y-4">
            {loData.map(lo => (
              <div key={lo.name}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium text-slate-700">{lo.name}</span>
                  <span className="text-slate-500">{formatCurrency(lo.loanVolume)}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${loData.reduce((m, l) => Math.max(m, l.loanVolume), 0) > 0 ? (lo.loanVolume / loData.reduce((m, l) => Math.max(m, l.loanVolume), 0)) * 100 : 0}%`,
                    backgroundColor: LO_COLORS[lo.name] || '#3b82f6',
                  }} />
                </div>
                <p className="text-xs text-slate-400 mt-1">{lo.deals} deals</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center gap-2 mb-4">
            <AlertCircle className="w-4 h-4 text-amber-500" />
            <h2 className="font-semibold text-slate-800">Needs Attention</h2>
          </div>
          {atRisk.length === 0 ? (
            <p className="text-slate-400 text-sm">All active deals look good! ✓</p>
          ) : (
            <div className="space-y-2">
              {atRisk.map(deal => (
                <Link key={deal.id} href={`/deals/${deal.id}`} className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 transition-colors">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{deal.name}</p>
                    <p className="text-xs text-amber-600">Missing: {[!deal.loan_officer && 'LO', !deal.loan_type && 'Loan Type', !deal.loan_amount && 'Amount'].filter(Boolean).join(', ')}</p>
                  </div>
                  <span className="text-xs text-slate-400">{deal.status}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-blue-500" />
            <h2 className="font-semibold text-slate-800">Recent Deals</h2>
          </div>
          <div className="space-y-2">
            {recentDeals.map(deal => (
              <Link key={deal.id} href={`/deals/${deal.id}`} className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 transition-colors">
                <div>
                  <p className="text-sm font-medium text-slate-800">{deal.name}</p>
                  <p className="text-xs text-slate-400">{deal.loan_type || 'No loan type'}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium text-slate-700">{formatCurrency(deal.loan_amount)}</p>
                  <p className="text-xs text-slate-400">{deal.loan_officer || '—'}</p>
                </div>
              </Link>
            ))}
          </div>
          <Link href="/deals" className="block text-center text-blue-600 text-xs font-medium mt-3 hover:underline">View all deals →</Link>
        </div>
      </div>

      {/* Team notes board */}
      <DashboardNotes />
    </div>
  )
}

function KPICard({ label, value, sub, icon, color }: {
  label: string; value: string; sub: string; icon: React.ReactNode; color: 'blue' | 'green' | 'purple' | 'amber'
}) {
  const colors = { blue: 'bg-blue-50 text-blue-600', green: 'bg-emerald-50 text-emerald-600', purple: 'bg-purple-50 text-purple-600', amber: 'bg-amber-50 text-amber-600' }
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-500 font-medium">{label}</p>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors[color]}`}>{icon}</div>
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-400 mt-1">{sub}</p>
    </div>
  )
}
