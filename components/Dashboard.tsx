'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS } from '@/lib/types'
import { resolveLO } from '@/lib/loanOfficer'
import { formatCurrency } from '@/lib/utils'
import UnreadInbox from '@/components/UnreadInbox'
import {
  DollarSign, TrendingUp, Users, CheckCircle, Clock, AlertCircle,
  AlertTriangle, ChevronRight, Flame, ListChecks, Wallet, Layers,
  Check, Filter,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
  PieChart, Pie, Legend, LineChart, Line, ReferenceLine,
} from 'recharts'
import Link from 'next/link'

// (Date filter removed — the dashboard is a snapshot of what's currently in escrow.)

const LO_COLORS: Record<string, string> = {
  'Matt Park': '#10b981',
  'Moe Sefati': '#f59e0b',
  'Randy Mathis': '#8b5cf6',
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
// Compact "time since" for the latest next-step log entry.
function relAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (isNaN(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), d = Math.floor(ms / 86400000)
  if (d >= 1) return d === 1 ? 'yesterday' : `${d}d ago`
  if (h >= 1) return `${h}h ago`
  return m >= 1 ? `${m}m ago` : 'just now'
}

export default function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  // Which loan officers' escrows count toward the metrics below. All checked =
  // everyone (the default, unfiltered view). Toggled by the header checkboxes.
  const [selectedLOs, setSelectedLOs] = useState<string[]>([...LOAN_OFFICERS])
  const toggleLO = (lo: string) =>
    setSelectedLOs(prev => prev.includes(lo) ? prev.filter(x => x !== lo) : [...prev, lo])


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
        'next_action_log'
      const data = await fetchAllDeals(
        q => q.order('created_at', { ascending: false }),
        DASHBOARD_COLS,
      )
      setDeals(data)
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

  // The dashboard is a snapshot of what's CURRENTLY in escrow — the Loans-in-Process
  // pipeline. Leads, Funded, and Not Ready deals are excluded from every KPI, chart,
  // and list below. (No date range — active escrows are a present-state view.)
  // LO filter — the header checkboxes narrow every metric on this page to the
  // selected loan officers. All-selected (the default) passes everyone through,
  // including deals with no LO assigned, so the unfiltered view is unchanged.
  const allLOsSelected = selectedLOs.length === LOAN_OFFICERS.length
  const dealMatchesLO = (d: Deal) => {
    if (allLOsSelected) return true
    const lo = resolveLO(d.loan_officer)
    return lo != null && selectedLOs.includes(lo)
  }

  const escrowDeals = deals.filter(d => d.pipeline_group === 'Loans in Process' && dealMatchesLO(d))

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

  // LO Performance: scoped to escrow deals, and to the LOs currently checked in
  // the header filter (canonical order). resolveLO normalizes any loan_officer
  // spelling to the same names the checkboxes use.
  const loData = LOAN_OFFICERS.filter(lo => selectedLOs.includes(lo)).map(lo => {
    const loDeals = escrowDeals.filter(d => resolveLO(d.loan_officer) === lo)
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
  // Same set as escrowDeals (Loans in Process, LO-filtered) — reused so the
  // Today widget and Next Steps stay in lockstep with the KPIs above.
  const escrowsInProcess = escrowDeals
  const todayItems = escrowsInProcess.filter(d => {
    if (!d.next_action_due) return false
    const due = new Date(d.next_action_due)
    return due <= endOfToday
  }).sort((a, b) =>
    new Date(a.next_action_due as string).getTime() - new Date(b.next_action_due as string).getTime()
  )
  const overdueItems = todayItems.filter(d => new Date(d.next_action_due as string) < now)
  const dueTodayItems = todayItems.filter(d => new Date(d.next_action_due as string) >= now && new Date(d.next_action_due as string) <= endOfToday)

  // Next Steps section — every active escrow + its next action, soonest due first (no-due last).
  const nextStepRows = [...escrowsInProcess].sort((a, b) => {
    const ad = a.next_action_due ? new Date(a.next_action_due).getTime() : Infinity
    const bd = b.next_action_due ? new Date(b.next_action_due).getTime() : Infinity
    if (ad !== bd) return ad - bd
    return (a.name || '').localeCompare(b.name || '')
  })

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#f97316', '#8b5cf6', '#ec4899']


  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Lumin Lending — Active Escrow Overview
            {!allLOsSelected && (
              <span className="text-slate-400"> · filtered to {selectedLOs.length} of {LOAN_OFFICERS.length} LOs</span>
            )}
          </p>
        </div>

        {/* Loan-officer filter — check the LOs whose escrows should count toward
            every metric on this page. All checked = everyone (the default). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <Filter className="h-3.5 w-3.5" /> Loan Officers
          </span>
          {LOAN_OFFICERS.map(lo => {
            const active = selectedLOs.includes(lo)
            const color = LO_COLORS[lo] || '#3b82f6'
            return (
              <button
                key={lo}
                type="button"
                onClick={() => toggleLO(lo)}
                aria-pressed={active}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                  active
                    ? 'border-slate-300 bg-white text-slate-700 shadow-sm'
                    : 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-white hover:text-slate-600'
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border transition ${active ? 'border-transparent' : 'border-slate-300 bg-white'}`}
                  style={active ? { backgroundColor: color } : undefined}
                >
                  {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </span>
                {lo}
              </button>
            )
          })}
        </div>
      </div>

      {/* KPIs — a hero metric anchors the page, supported by three accent cards */}
      <div className="space-y-4">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-700 via-blue-600 to-blue-500 p-6 text-white shadow-lg shadow-blue-600/30">
          <div className="relative z-10">
            <div className="flex items-center gap-2 text-blue-100 text-sm font-medium">
              <TrendingUp className="w-4 h-4" /> Active Escrow Volume
            </div>
            <div className="text-4xl font-extrabold tracking-tight mt-1.5">{formatCurrency(totalPipelineLoanVol)}</div>
            <div className="text-blue-100/90 text-sm mt-1.5 font-medium">
              {escrowDeals.length} active escrow{escrowDeals.length !== 1 ? 's' : ''} in process
            </div>
          </div>
          <TrendingUp className="absolute -right-5 -bottom-6 w-40 h-40 text-white/10" strokeWidth={1.5} aria-hidden />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KPICard label="Funding Soon"  value={formatCurrency(fundingSoonVolume)} sub={`${fundingSoon.length} CTC / Docs Out / Signed`} icon={<DollarSign className="w-5 h-5" />} accent="emerald" />
          <KPICard label="Total Escrows" value={escrowDeals.length.toString()}     sub="loans in process"                              icon={<Layers className="w-5 h-5" />}     accent="violet" />
          <KPICard label="Avg Loan Size" value={formatCurrency(avgDealSize)}       sub="active escrows"                                icon={<Wallet className="w-5 h-5" />}     accent="amber" />
        </div>
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

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-md shadow-slate-200/60 border border-slate-200/80 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">Escrows by Stage</h2>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={stageData} margin={{ top: 22, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="barBlue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#93c5fd" /><stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
                <linearGradient id="barGreen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6ee7b7" /><stop offset="100%" stopColor="#10b981" />
                </linearGradient>
              </defs>
              <XAxis dataKey="stage" tick={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} axisLine={false} tickLine={false} interval={0} />
              <Tooltip cursor={{ fill: 'rgba(148,163,184,0.12)' }} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Bar dataKey="count" name="deals" radius={[6, 6, 0, 0]} maxBarSize={42}>
                <LabelList dataKey="count" position="top" style={{ fontSize: 12, fontWeight: 700, fill: '#0f172a' }} />
                {stageData.map(entry => (
                  <Cell key={entry.stage} fill={
                    entry.stage === 'Signed' ? 'url(#barGreen)' : 'url(#barBlue)'
                  } />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl shadow-md shadow-slate-200/60 border border-slate-200/80 p-5">
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
        <div className="bg-white rounded-xl shadow-md shadow-slate-200/60 border border-slate-200/80 p-5">
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

        <div className="bg-white rounded-xl shadow-md shadow-slate-200/60 border border-slate-200/80 p-5">
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

        <div className="bg-white rounded-xl shadow-md shadow-slate-200/60 border border-slate-200/80 p-5">
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

      {/* Next Steps — every active escrow + its next action (mirrors Active Escrows) */}
      {escrowsInProcess.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-blue-500" />
              <h3 className="font-semibold text-slate-800 text-sm">Next Steps</h3>
              <span className="text-xs text-slate-500">{escrowsInProcess.length} active escrow{escrowsInProcess.length !== 1 ? 's' : ''}</span>
            </div>
            <Link href="/deals" className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-0.5">
              Open Active Escrows <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
            {nextStepRows.map(d => {
              const due = d.next_action_due ? new Date(d.next_action_due) : null
              const overdue = due ? due < now : false
              const dueStr = due ? due.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
              const loggedAgo = d.next_action_log?.[0]?.at ? relAgo(d.next_action_log[0].at) : ''
              return (
                <Link key={d.id} href={`/deals/${d.id}`} className="flex items-start gap-3 px-5 py-2.5 hover:bg-slate-50 transition group">
                  <div className="w-48 shrink-0 min-w-0">
                    <div className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 truncate">{d.name}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {d.status}{(d.next_action_assignee || d.loan_officer) ? ` · ${d.next_action_assignee || d.loan_officer}` : ''}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-700">
                      {d.next_action || <span className="italic text-slate-400">No next step set</span>}
                      {loggedAgo && <span className="ml-1.5 text-[11px] font-normal text-slate-400">· {loggedAgo}</span>}
                    </div>
                    {due && (
                      <div className={`text-[11px] ${overdue ? 'text-red-600 font-medium' : 'text-slate-400'}`}>
                        {overdue ? 'Overdue · ' : 'Due '}{dueStr}
                      </div>
                    )}
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Unread Messages — moved below the metrics so the dashboard leads with
          the numbers, not the inbox. Live client inbox across both GHL accounts. */}
      <UnreadInbox />

    </div>
  )
}

function KPICard({ label, value, sub, icon, accent }: {
  label: string; value: string; sub: string; icon: React.ReactNode; accent: 'emerald' | 'violet' | 'amber'
}) {
  const map = {
    emerald: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-600' },
    violet:  { bar: 'bg-violet-500',  badge: 'bg-violet-100 text-violet-700' },
    amber:   { bar: 'bg-amber-500',   badge: 'bg-amber-100 text-amber-600' },
  }
  const c = map[accent]
  return (
    <div className="relative overflow-hidden bg-white rounded-xl border border-slate-200/80 p-5 shadow-md shadow-slate-200/60">
      <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${c.bar}`} aria-hidden />
      <div className="flex items-center justify-between mb-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${c.badge}`}>{icon}</div>
      </div>
      <p className="text-2xl font-bold text-slate-900 tracking-tight">{value}</p>
      <p className="text-sm font-medium text-slate-600 mt-0.5">{label}</p>
      <p className="text-xs text-slate-400 mt-1">{sub}</p>
    </div>
  )
}
