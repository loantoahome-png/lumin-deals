'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_STAGE_MAP } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import {
  DollarSign, TrendingUp, Users, CheckCircle, Clock, AlertCircle, Bell, TrendingDown
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend, LineChart, Line, ReferenceLine,
} from 'recharts'
import Link from 'next/link'

const LO_COLORS: Record<string, string> = {
  'Matt': '#10b981',
  'Moe Sefati': '#f59e0b',
}

const STAGE_COLORS: Record<string, string> = {
  'Leads': '#94a3b8',
  'Registered': '#3b82f6',
  'Underwriting': '#f59e0b',
  'Closing': '#f97316',
  'Funded': '#10b981',
}

// ── Treasury yield widget ─────────────────────────────────────────────────────
type YieldData = {
  current: number
  date: string
  dayChange: number
  weekChange: number
  sparkline: { date: string; value: number }[]
}

function TreasuryWidget() {
  const [data, setData] = useState<YieldData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [rateWatchCount, setRateWatchCount] = useState(0)

  useEffect(() => {
    fetch('/api/treasury')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setError(true); setLoading(false) })

    supabase
      .from('deals')
      .select('id', { count: 'exact' })
      .eq('rate_watch_active', true)
      .then(({ count }) => setRateWatchCount(count || 0))
  }, [])

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5 flex items-center gap-3">
        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
        <span className="text-sm text-slate-400">Loading market data…</span>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
        <p className="text-sm text-slate-400">Market data unavailable</p>
      </div>
    )
  }

  const dayUp = data.dayChange >= 0
  const weekUp = data.weekChange >= 0
  const alertedCount = data.sparkline.length > 0
    ? 0 : 0 // placeholder — rate watch alerts shown via rateWatchCount

  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-sm p-5 text-white">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">10-Year Treasury Yield</p>
          <div className="flex items-end gap-3 mt-1">
            <span className="text-4xl font-bold">{data.current.toFixed(2)}%</span>
            <div className="mb-1 flex flex-col gap-0.5">
              <span className={`text-sm font-semibold flex items-center gap-1 ${dayUp ? 'text-red-400' : 'text-emerald-400'}`}>
                {dayUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {dayUp ? '+' : ''}{data.dayChange.toFixed(3)} today
              </span>
              <span className={`text-xs flex items-center gap-1 ${weekUp ? 'text-red-300' : 'text-emerald-300'}`}>
                {weekUp ? '+' : ''}{data.weekChange.toFixed(3)} this week
              </span>
            </div>
          </div>
          <p className="text-slate-500 text-xs mt-1">As of {data.date} · Source: FRED / St. Louis Fed</p>
        </div>
        {rateWatchCount > 0 && (
          <div className="flex items-center gap-1.5 bg-amber-500 text-white px-3 py-1.5 rounded-lg text-sm font-semibold">
            <Bell className="w-3.5 h-3.5" />
            {rateWatchCount} watching
          </div>
        )}
      </div>

      {/* Sparkline */}
      <div className="h-16 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.sparkline} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <Line
              type="monotone"
              dataKey="value"
              stroke={dayUp ? '#f87171' : '#34d399'}
              strokeWidth={2}
              dot={false}
            />
            <ReferenceLine
              y={data.current}
              stroke="rgba(255,255,255,0.1)"
              strokeDasharray="3 3"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {rateWatchCount > 0 && (
        <p className="text-slate-400 text-xs mt-2">
          {rateWatchCount} deal{rateWatchCount !== 1 ? 's' : ''} on rate watch — checked Mon–Fri at 10 AM ET
        </p>
      )}
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchDeals() {
      const { data } = await supabase
        .from('deals')
        .select('*')
        .order('created_at', { ascending: false })
      setDeals(data || [])
      setLoading(false)
    }
    fetchDeals()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  const activeDeals = deals.filter(d => !['PAID', 'Lost'].includes(d.status) && d.pipeline_group !== 'Lost')
  const paidDeals = deals.filter(d => d.status === 'PAID')
  const totalPipelineRevenue = activeDeals.reduce((s, d) => s + (d.revenue || 0), 0)
  const totalPaidRevenue = paidDeals.reduce((s, d) => s + (d.revenue || 0), 0)
  const avgDealSize = activeDeals.filter(d => d.loan_amount).length > 0
    ? activeDeals.reduce((s, d) => s + (d.loan_amount || 0), 0) / activeDeals.filter(d => d.loan_amount).length
    : 0

  const stageData = Object.entries(PIPELINE_STAGE_MAP).map(([stage, statuses]) => {
    const stageDeals = deals.filter(d => statuses.includes(d.status))
    return { stage, count: stageDeals.length, revenue: stageDeals.reduce((s, d) => s + (d.revenue || 0), 0) }
  })

  const loData = ['Matt', 'Moe Sefati'].map(lo => {
    const loDeals = deals.filter(d => d.loan_officer?.includes(lo))
    return { name: lo, revenue: loDeals.reduce((s, d) => s + (d.revenue || 0), 0), deals: loDeals.length }
  })

  const loanTypeMap: Record<string, number> = {}
  deals.forEach(d => { if (d.loan_type) loanTypeMap[d.loan_type] = (loanTypeMap[d.loan_type] || 0) + 1 })
  const loanTypeData = Object.entries(loanTypeMap).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => ({ name, value }))

  const atRisk = activeDeals.filter(d => !d.loan_officer || !d.loan_type || !d.loan_amount).slice(0, 5)
  const recentDeals = deals.slice(0, 5)
  const rateWatchAlerted = deals.filter(d => d.rate_watch_active && d.rate_watch_alerted_at)

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#f97316', '#8b5cf6', '#ec4899']

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">Lumin Lending — Mortgage Pipeline Overview</p>
        </div>
        <Link href="/deals/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
          + New Deal
        </Link>
      </div>

      {/* Market Pulse + KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-1">
          <TreasuryWidget />
        </div>
        <div className="lg:col-span-3 grid grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
          <KPICard label="Active Pipeline" value={formatCurrency(totalPipelineRevenue)} sub={`${activeDeals.length} active deals`} icon={<TrendingUp className="w-5 h-5" />} color="blue" />
          <KPICard label="Total Revenue Earned" value={formatCurrency(totalPaidRevenue)} sub={`${paidDeals.length} closed deals`} icon={<DollarSign className="w-5 h-5" />} color="green" />
          <KPICard label="Total Deals" value={deals.length.toString()} sub={`${activeDeals.length} active`} icon={<Users className="w-5 h-5" />} color="purple" />
          <KPICard label="Avg Loan Size" value={formatCurrency(avgDealSize)} sub="active deals" icon={<CheckCircle className="w-5 h-5" />} color="amber" />
        </div>
      </div>

      {/* Rate Watch Alerts Banner */}
      {rateWatchAlerted.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="w-4 h-4 text-amber-600" />
            <h3 className="font-semibold text-amber-800 text-sm">Rate Watch Triggered — {rateWatchAlerted.length} deal{rateWatchAlerted.length !== 1 ? 's' : ''} hit their target yield</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {rateWatchAlerted.map(d => (
              <Link key={d.id} href={`/deals/${d.id}`} className="text-xs bg-amber-100 text-amber-800 hover:bg-amber-200 px-3 py-1 rounded-full font-medium transition-colors">
                {d.name} → {d.rate_watch_target}% target
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Pipeline by Stage</h2>
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
                  <span className="text-slate-500">{formatCurrency(lo.revenue)}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${loData.reduce((m, l) => Math.max(m, l.revenue), 0) > 0 ? (lo.revenue / loData.reduce((m, l) => Math.max(m, l.revenue), 0)) * 100 : 0}%`,
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
                  <p className="text-xs font-medium text-slate-700">{formatCurrency(deal.revenue)}</p>
                  <p className="text-xs text-slate-400">{deal.loan_officer || '—'}</p>
                </div>
              </Link>
            ))}
          </div>
          <Link href="/deals" className="block text-center text-blue-600 text-xs font-medium mt-3 hover:underline">View all deals →</Link>
        </div>
      </div>
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
