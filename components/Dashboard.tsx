'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_STAGE_MAP } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import {
  DollarSign, TrendingUp, Users, CheckCircle, Clock, AlertCircle
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend
} from 'recharts'
import Link from 'next/link'

const LO_COLORS: Record<string, string> = {
  'Efrain Ramirez': '#3b82f6',
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
  const avgDealSize = activeDeals.length > 0
    ? activeDeals.reduce((s, d) => s + (d.loan_amount || 0), 0) / activeDeals.filter(d => d.loan_amount).length
    : 0

  // Pipeline stage breakdown
  const stageData = Object.entries(PIPELINE_STAGE_MAP).map(([stage, statuses]) => {
    const stageDeals = deals.filter(d => statuses.includes(d.status))
    return {
      stage,
      count: stageDeals.length,
      revenue: stageDeals.reduce((s, d) => s + (d.revenue || 0), 0),
    }
  })

  // LO revenue breakdown
  const loData = ['Efrain Ramirez', 'Matt', 'Moe Sefati'].map(lo => {
    const loDeals = deals.filter(d => d.loan_officer?.includes(lo))
    return {
      name: lo === 'Efrain Ramirez' ? 'Efrain' : lo,
      revenue: loDeals.reduce((s, d) => s + (d.revenue || 0), 0),
      deals: loDeals.length,
    }
  })

  // Loan type breakdown
  const loanTypeMap: Record<string, number> = {}
  deals.forEach(d => {
    if (d.loan_type) {
      loanTypeMap[d.loan_type] = (loanTypeMap[d.loan_type] || 0) + 1
    }
  })
  const loanTypeData = Object.entries(loanTypeMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, value]) => ({ name, value }))

  // At-risk: active deals missing key info
  const atRisk = activeDeals.filter(d =>
    !d.loan_officer || !d.loan_type || !d.loan_amount
  ).slice(0, 5)

  // Recent deals
  const recentDeals = deals.slice(0, 5)

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#f97316', '#8b5cf6', '#ec4899']

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">Lumin Lending — Mortgage Pipeline Overview</p>
        </div>
        <Link
          href="/deals/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + New Deal
        </Link>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label="Active Pipeline"
          value={formatCurrency(totalPipelineRevenue)}
          sub={`${activeDeals.length} active deals`}
          icon={<TrendingUp className="w-5 h-5" />}
          color="blue"
        />
        <KPICard
          label="Total Revenue Earned"
          value={formatCurrency(totalPaidRevenue)}
          sub={`${paidDeals.length} closed deals`}
          icon={<DollarSign className="w-5 h-5" />}
          color="green"
        />
        <KPICard
          label="Total Deals"
          value={deals.length.toString()}
          sub={`${activeDeals.length} active`}
          icon={<Users className="w-5 h-5" />}
          color="purple"
        />
        <KPICard
          label="Avg Loan Size"
          value={formatCurrency(avgDealSize)}
          sub="active deals"
          icon={<CheckCircle className="w-5 h-5" />}
          color="amber"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Pipeline Funnel */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Pipeline by Stage</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stageData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="stage" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
              />
              <Bar dataKey="count" name="deals" radius={[4, 4, 0, 0]}>
                {stageData.map((entry) => (
                  <Cell key={entry.stage} fill={STAGE_COLORS[entry.stage] || '#94a3b8'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Loan Type Pie */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Loan Types</h2>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={loanTypeData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
                dataKey="value"
              >
                {loanTypeData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* LO Performance + At Risk + Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LO Performance */}
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
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${loData[0].revenue > 0 ? (lo.revenue / loData.reduce((m, l) => Math.max(m, l.revenue), 0)) * 100 : 0}%`,
                      backgroundColor: LO_COLORS[lo.name === 'Efrain' ? 'Efrain Ramirez' : lo.name] || '#3b82f6',
                    }}
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">{lo.deals} deals</p>
              </div>
            ))}
          </div>
        </div>

        {/* At-Risk Deals */}
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
                <Link
                  key={deal.id}
                  href={`/deals/${deal.id}`}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">{deal.name}</p>
                    <p className="text-xs text-amber-600">
                      Missing: {[
                        !deal.loan_officer && 'LO',
                        !deal.loan_type && 'Loan Type',
                        !deal.loan_amount && 'Amount',
                      ].filter(Boolean).join(', ')}
                    </p>
                  </div>
                  <span className="text-xs text-slate-400">{deal.status}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent Deals */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-blue-500" />
            <h2 className="font-semibold text-slate-800">Recent Deals</h2>
          </div>
          <div className="space-y-2">
            {recentDeals.map(deal => (
              <Link
                key={deal.id}
                href={`/deals/${deal.id}`}
                className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 transition-colors"
              >
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
          <Link href="/deals" className="block text-center text-blue-600 text-xs font-medium mt-3 hover:underline">
            View all deals →
          </Link>
        </div>
      </div>
    </div>
  )
}

function KPICard({
  label, value, sub, icon, color
}: {
  label: string; value: string; sub: string; icon: React.ReactNode; color: 'blue' | 'green' | 'purple' | 'amber'
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
    amber: 'bg-amber-50 text-amber-600',
  }
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-500 font-medium">{label}</p>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors[color]}`}>
          {icon}
        </div>
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-400 mt-1">{sub}</p>
    </div>
  )
}
