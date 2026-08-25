'use client'

/**
 * Call Report — imported from GHL's Reporting → Call report CSV export.
 *
 *   • Activity  — what was DIALED in a date range: calls, connects, talk time,
 *                 daily trend, best hour/weekday to reach people, per-dialer.
 *                 This is the only tab the date filter touches.
 *   • Effort    — are the leads we paid for being worked? Lifetime per-lead
 *                 coverage across the WHOLE imported window. A date filter would
 *                 break these: a May lead dialed in May reads as never-dialed
 *                 "today", so they are deliberately unfiltered and labelled.
 *   • Economics — cost per connected conversation by source. CONTACT economics,
 *                 NOT ROI — no revenue here; that's /lead-roi with the 85% split.
 *
 * The connect signal is talk time, never GHL's "Answered" status — 724 rows in
 * the real export are 'Answered' AND dispositioned 'No Answer / Voicemail'.
 *
 * All aggregation lives in lib/callsReport.ts (pure, fixture-tested by
 * scripts/calls-check.ts). Activity arrives pre-bucketed by PT day so every
 * range — including custom — filters instantly with no refetch.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  PhoneCall, AlertTriangle, RefreshCw, DollarSign, Info, PhoneIncoming, PhoneOutgoing, Clock, TrendingUp,
  PhoneOff,
} from 'lucide-react'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts'
import { LO_COLORS } from '@/components/LoFilter'
import type { EffortRow, DialerRow, EconomicsRow, ActivityBuckets } from '@/lib/callsReport'
import { activityInRange, byHourOfDay, byWeekday, dialersInRange, accountsForDialer, ACCOUNT_TO_LO,
  UNREACHABLE_MIN_FAILURES, type UnreachableRow,
} from '@/lib/callsReport'

type ApiResponse = {
  ok: boolean
  error?: string
  totalCalls: number
  window: { start: string; end: string } | null
  dataThrough: string | null
  covered: string[]
  effort: EffortRow[]
  dialers: DialerRow[]
  economics: EconomicsRow[]
  activity: ActivityBuckets
  unreachable: UnreachableRow[]
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const fmtPhone = (v: string): string => {
  const d = v.replace(/\D/g, '').replace(/^1/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v
}
const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : '—')
const rate = (r: number) => `${Math.round(r * 100)}%`
const hours = (sec: number) => `${(sec / 3600).toFixed(1)}h`
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtTtfd(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 48) return `${h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} d`
}

// ── PT date helpers ─────────────────────────────────────────────────────────
// The office runs on Pacific time and calls are bucketed by PT calendar day, so
// "today" has to mean today IN PT — not the viewer's local day, which would slide
// the whole range for anyone in another timezone.
const PT = 'America/Los_Angeles'
const ptToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}
const ptWeekday = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()
}

type Preset = 'today' | 'week' | 'month' | 'last30' | 'all' | 'custom'
const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`)

export default function CallsPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<'activity' | 'effort' | 'economics'>('activity')
  const [preset, setPreset] = useState<Preset>('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  /** null = everyone. Filters the whole Activity tab to one dialer — the page's
   *  main job is tracking how much Brianne is calling. */
  const [dialerFilter, setDialerFilter] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch('/api/calls')
      const j = await res.json() as ApiResponse
      if (!j.ok) throw new Error(j.error || 'load failed')
      setData(j)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const daily = data?.activity?.daily ?? []
  const fullStart = daily[0]?.day ?? ''
  const fullEnd = daily[daily.length - 1]?.day ?? ''

  // Resolve the preset into a concrete PT day range.
  const [start, end] = useMemo<[string, string]>(() => {
    const today = ptToday()
    switch (preset) {
      case 'today':  return [today, today]
      // Week starts Monday — a mortgage week is Mon-Fri, and a Sunday-start week
      // makes Monday morning look like the middle of the week.
      case 'week':   { const back = (ptWeekday(today) + 6) % 7; return [addDays(today, -back), today] }
      case 'month':  return [today.slice(0, 8) + '01', today]
      case 'last30': return [addDays(today, -29), today]
      case 'all':    return [fullStart, fullEnd]
      case 'custom': return [customStart || fullStart, customEnd || fullEnd]
    }
  }, [preset, customStart, customEnd, fullStart, fullEnd])

  const act = useMemo(
    () => activityInRange(daily, start, end, dialerFilter),
    [daily, start, end, dialerFilter],
  )
  // Buckets are per day PER DIALER, so the unfiltered trend must SUM a day's rows
  // rather than render one bar per dialer per day.
  const trend = useMemo(() => {
    const byDay = new Map<string, { day: string; calls: number; connects: number }>()
    for (const d of daily) {
      if (d.day < start || d.day > end) continue
      if (dialerFilter && d.dialer !== dialerFilter) continue
      const e = byDay.get(d.day) ?? { day: d.day, calls: 0, connects: 0 }
      e.calls += d.calls; e.connects += d.connects
      byDay.set(d.day, e)
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
      .map(d => ({ ...d, label: fmtDay(d.day) }))
  }, [daily, start, end, dialerFilter])
  const hourly = useMemo(
    () => byHourOfDay(data?.activity?.hourly ?? [], start, end, dialerFilter)
      .filter(h => h.calls >= 5)     // a 1-call hour at 100% is noise, not a signal
      .map(h => ({ ...h, label: hourLabel(h.hour), ratePct: Math.round(h.rate * 100) })),
    [data?.activity?.hourly, start, end, dialerFilter],
  )
  const weekdays = useMemo(
    () => byWeekday(daily, data?.activity?.hourly ?? [], start, end, dialerFilter)
      .filter(w => w.calls >= 5)
      .map(w => ({ ...w, label: WEEKDAYS[w.weekday], ratePct: Math.round(w.rate * 100) })),
    [daily, data?.activity?.hourly, start, end, dialerFilter],
  )
  const dialers = useMemo(
    () => dialersInRange(data?.activity?.dialerDaily ?? [], start, end),
    [data?.activity?.dialerDaily, start, end],
  )
  /** Filter options come from the SELECTED RANGE, not all time — offering a name
   *  with no calls in view would render an empty page with no explanation. */
  const dialerOptions = useMemo(() => dialers.map(d => d.dialer), [dialers])
  /** When one person is selected, the dialer table becomes their per-ACCOUNT
   *  split — the thing the label alone hides, since both of Brianne's numbers
   *  carry the same name. */
  const dialerAccounts = useMemo(
    () => dialerFilter ? accountsForDialer(data?.activity?.dialerDaily ?? [], start, end, dialerFilter) : [],
    [data?.activity?.dialerDaily, start, end, dialerFilter],
  )

  // A selected person who has no calls in a newly-chosen range would silently
  // show zeros everywhere; drop back to everyone instead.
  useEffect(() => {
    if (dialerFilter && dialerOptions.length && !dialerOptions.includes(dialerFilter)) setDialerFilter(null)
  }, [dialerFilter, dialerOptions])

  const bestHour = useMemo(() => [...hourly].sort((a, b) => b.rate - a.rate)[0], [hourly])

  const staleDays = useMemo(() => {
    if (!data?.dataThrough) return null
    return Math.floor((Date.now() - Date.parse(data.dataThrough)) / 86_400_000)
  }, [data?.dataThrough])

  const dialersByLo = useMemo(() => {
    const m = new Map<string, DialerRow[]>()
    for (const d of data?.dialers ?? []) {
      const arr = m.get(d.lo) ?? []
      arr.push(d); m.set(d.lo, arr)
    }
    return m
  }, [data?.dialers])

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
        Loading call report…
      </div>
    )
  }

  if (err) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          <div className="font-semibold mb-1">Couldn&apos;t load call data</div>
          <div className="text-sm font-mono">{err}</div>
          <div className="text-sm mt-2">
            If the <code>calls</code> table doesn&apos;t exist yet, run <code>supabase-calls.sql</code> in the
            Supabase SQL editor, then import from{' '}
            <Link href="/import/calls" className="underline">Import Calls</Link>.
          </div>
        </div>
      </div>
    )
  }

  const empty = !data || data.totalCalls === 0

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <PhoneCall className="w-6 h-6 text-blue-600" />
            Call Report
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {empty ? 'No calls imported yet.' : (
              <>
                {data!.totalCalls.toLocaleString()} calls · data through{' '}
                <span className="font-medium text-gray-700">{fmtDate(data!.dataThrough)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/import/calls" className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">
            Import CSV
          </Link>
          <button onClick={() => void load()} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {staleDays != null && staleDays > 7 && (
        <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            Newest call is <strong>{staleDays} days old</strong>. These numbers are stale until you export
            again from GHL and re-import — nothing syncs automatically.
          </div>
        </div>
      )}

      {empty ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center">
          <PhoneCall className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <div className="font-medium text-gray-800 mb-1">No call data yet</div>
          <p className="text-sm text-gray-500 mb-4">
            Export Reporting → Call report from each sub-account in GHL, then import the CSVs.
          </p>
          <Link href="/import/calls" className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            Import call CSVs
          </Link>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-200 mb-5">
            {([['activity', 'Activity'], ['effort', 'Effort'], ['economics', 'Economics']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                  tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ── ACTIVITY ─────────────────────────────────────────────────── */}
          {tab === 'activity' && (
            <div className="space-y-4">
              {/* Date filter — Activity only */}
              <div className="flex flex-wrap items-center gap-2">
                {PRESETS.map(p => (
                  <button
                    key={p.key}
                    onClick={() => setPreset(p.key)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition ${
                      preset === p.key
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50 bg-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                {preset === 'custom' && (
                  <div className="flex items-center gap-2 ml-1">
                    <input
                      type="date" value={customStart} min={fullStart} max={fullEnd}
                      onChange={e => setCustomStart(e.target.value)}
                      className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                    />
                    <span className="text-gray-400 text-sm">→</span>
                    <input
                      type="date" value={customEnd} min={fullStart} max={fullEnd}
                      onChange={e => setCustomEnd(e.target.value)}
                      className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                    />
                  </div>
                )}
                <span className="text-xs text-gray-400 ml-auto">
                  {fmtDay(start)} → {fmtDay(end)} · {act.activeDays} day{act.activeDays === 1 ? '' : 's'} with calls
                </span>
              </div>

              {/* Who dialed. Everything below reflects this — the page's main job
                  is seeing how much Brianne is calling, so it belongs beside the
                  date range, not buried in the dialer table. */}
              {dialerOptions.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-gray-500 mr-1">Dialer</span>
                  <button
                    onClick={() => setDialerFilter(null)}
                    className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                      dialerFilter === null
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Everyone
                  </button>
                  {dialerOptions.map(name => (
                    <button
                      key={name}
                      onClick={() => setDialerFilter(name === dialerFilter ? null : name)}
                      className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                        dialerFilter === name
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                  {dialerFilter && (
                    <span className="text-xs text-gray-400">
                      showing {dialerFilter} only
                    </span>
                  )}
                </div>
              )}

              {act.calls === 0 ? (
                <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-gray-500">
                  <PhoneCall className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  No calls in this range.
                  {end > (data!.dataThrough ?? '').slice(0, 10) && (
                    <div className="text-sm mt-1">
                      Call data only runs through {fmtDate(data!.dataThrough)} — re-import to see anything newer.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Headline numbers */}
                  <div className="bg-white border border-gray-200 rounded-lg grid grid-cols-2 md:grid-cols-6 divide-x divide-y md:divide-y-0 divide-gray-100">
                    {[
                      ['Calls', act.calls.toLocaleString()],
                      ['Connected', `${act.connects.toLocaleString()}`],
                      ['Connect rate', rate(act.connectRate)],
                      ['Talk time', hours(act.talkSec)],
                      ['Avg conversation', mmss(act.avgTalkSec)],
                      ['Calls / active day', Math.round(act.callsPerActiveDay).toLocaleString()],
                    ].map(([label, val]) => (
                      <div key={label} className="px-4 py-3">
                        <div className="text-xs text-gray-500">{label}</div>
                        <div className="text-lg font-semibold text-gray-900">{val}</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-3 text-sm">
                    <span className="inline-flex items-center gap-1.5 bg-white border border-gray-200 rounded-full px-3 py-1.5 text-gray-700">
                      <PhoneOutgoing className="w-3.5 h-3.5 text-gray-400" /> Outbound {act.outbound.toLocaleString()}
                    </span>
                    <span className="inline-flex items-center gap-1.5 bg-white border border-gray-200 rounded-full px-3 py-1.5 text-gray-700">
                      <PhoneIncoming className="w-3.5 h-3.5 text-gray-400" /> Inbound {act.inbound.toLocaleString()}
                    </span>
                    {bestHour && (
                      <span className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-3 py-1.5 text-green-800">
                        <TrendingUp className="w-3.5 h-3.5" /> Best hour to dial: <strong>{bestHour.label}</strong> ({rate(bestHour.rate)} connect)
                      </span>
                    )}
                  </div>

                  {/* Daily trend */}
                  <div className="bg-white border border-gray-200 rounded-lg p-4">
                    <div className="text-sm font-semibold text-gray-900 mb-3">Calls per day</div>
                    <div style={{ width: '100%', height: 220 }}>
                      {/* Past ~40 days a paired bar per day collapses into invisible 3px
                          slivers, so long ranges switch to areas. Same two series either way. */}
                      <ResponsiveContainer>
                        {trend.length > 40 ? (
                          <AreaChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} interval="preserveStartEnd" minTickGap={40} />
                            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                            <Tooltip
                              contentStyle={{ fontSize: 12, borderRadius: 8 }}
                              formatter={(value, name) =>
                                [Number(value).toLocaleString(), String(name) === 'connects' ? 'Connected' : 'Calls'] as [string, string]}
                            />
                            <Area dataKey="calls" stroke="#93c5fd" fill="#dbeafe" strokeWidth={1.5} />
                            <Area dataKey="connects" stroke="#2563eb" fill="#bfdbfe" strokeWidth={1.5} />
                          </AreaChart>
                        ) : (
                          <BarChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} interval="preserveStartEnd" minTickGap={24} />
                            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                            <Tooltip
                              contentStyle={{ fontSize: 12, borderRadius: 8 }}
                              formatter={(value, name) =>
                                [Number(value).toLocaleString(), String(name) === 'connects' ? 'Connected' : 'Calls'] as [string, string]}
                            />
                            <Bar dataKey="calls" fill="#bfdbfe" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="connects" fill="#2563eb" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        )}
                      </ResponsiveContainer>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      Light = all calls · Dark = calls with real talk time
                    </div>
                  </div>

                  {/* Best time to reach people */}
                  <div className="grid md:grid-cols-3 gap-4">
                    <div className="bg-white border border-gray-200 rounded-lg p-4 md:col-span-2">
                      <div className="text-sm font-semibold text-gray-900">Connect rate by hour</div>
                      <div className="text-xs text-gray-500 mb-3">
                        Outbound only, Pacific time. Hours with under 5 dials are hidden — a single lucky call isn&apos;t a pattern.
                      </div>
                      <div style={{ width: '100%', height: 200 }}>
                        <ResponsiveContainer>
                          <BarChart data={hourly} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} unit="%" />
                            <Tooltip
                              contentStyle={{ fontSize: 12, borderRadius: 8 }}
                              formatter={(value, _name, item) => {
                                const dials = (item as { payload?: { calls?: number } } | undefined)?.payload?.calls ?? 0
                                return [`${Number(value)}% of ${dials.toLocaleString()} dials`, 'Connect rate'] as [string, string]
                              }}
                            />
                            <Bar dataKey="ratePct" radius={[3, 3, 0, 0]}>
                              {hourly.map(h => (
                                <Cell key={h.hour} fill={h.hour === bestHour?.hour ? '#16a34a' : '#93c5fd'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                      <div className="text-sm font-semibold text-gray-900">By weekday</div>
                      <div className="text-xs text-gray-500 mb-3">Outbound connect rate</div>
                      <div className="space-y-1.5">
                        {weekdays.map(w => (
                          <div key={w.weekday} className="flex items-center gap-2 text-sm">
                            <span className="w-8 text-gray-500">{w.label}</span>
                            <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                              <div className="bg-blue-500 h-full rounded-full" style={{ width: `${w.ratePct}%` }} />
                            </div>
                            <span className="w-9 text-right font-medium text-gray-800">{w.ratePct}%</span>
                            <span className="w-12 text-right text-xs text-gray-400">{w.calls.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Per dialer */}
                  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
                      By dialer
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600">
                          <tr>
                            {[dialerFilter ? 'Account' : 'Dialer', 'Calls', 'Connected', 'Connect rate', 'Talk time', 'Avg conversation'].map((h, i) => (
                              <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {/* Filtered to one person → their SUB-ACCOUNT split. The
                              dialer label merges a person's two numbers, so this is
                              the only place the per-account answer is visible. */}
                          {(dialerFilter ? dialerAccounts : dialers).map(d => {
                            const key = 'account' in d ? d.account : d.dialer
                            return (
                              <tr key={key} className="hover:bg-gray-50">
                                <td className="px-4 py-2.5 font-medium text-gray-900">
                                  {'account' in d ? (ACCOUNT_TO_LO[d.account] ?? d.account) : d.dialer}
                                </td>
                                <td className="px-4 py-2.5 text-right text-gray-700">{d.calls.toLocaleString()}</td>
                                <td className="px-4 py-2.5 text-right text-gray-700">{d.connects.toLocaleString()}</td>
                                <td className="px-4 py-2.5 text-right font-semibold text-gray-900">{rate(d.connectRate)}</td>
                                <td className="px-4 py-2.5 text-right text-gray-700">{hours(d.talkSec)}</td>
                                <td className="px-4 py-2.5 text-right text-gray-700">{mmss(d.avgTalkSec)}</td>
                              </tr>
                            )
                          })}
                          {dialerFilter && dialerAccounts.length > 1 && (
                            <tr className="bg-gray-50/60 font-semibold">
                              <td className="px-4 py-2.5 text-gray-900">Total</td>
                              <td className="px-4 py-2.5 text-right text-gray-900">
                                {dialerAccounts.reduce((s, d) => s + d.calls, 0).toLocaleString()}
                              </td>
                              <td className="px-4 py-2.5 text-right text-gray-900">
                                {dialerAccounts.reduce((s, d) => s + d.connects, 0).toLocaleString()}
                              </td>
                              <td colSpan={3} />
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-500 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      Connected means real talk time. Avg conversation divides talk time by CONNECTED calls only,
                      so voicemails don&apos;t drag it down.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── EFFORT ───────────────────────────────────────────────────── */}
          {tab === 'effort' && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 bg-blue-50/50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-gray-700">
                <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
                <div>
                  <strong>Lifetime coverage, not filtered by date.</strong> These are per-lead stats across the whole
                  imported window ({fmtDate(data!.window?.start ?? null)} – {fmtDate(data!.window?.end ?? null)}).
                  Filtering them to a single day would count a May lead dialed in May as never dialed today.
                  For dialing in a date range, use the <button onClick={() => setTab('activity')} className="text-blue-700 underline">Activity</button> tab.
                </div>
              </div>

              {data!.effort.map(row => {
                const los = dialersByLo.get(row.lo) ?? []
                return (
                  <div key={row.lo} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: LO_COLORS[row.lo] ?? '#94a3b8' }} />
                      <span className="font-semibold text-gray-900">{row.lo}</span>
                      {row.covered ? (
                        <span className="text-sm text-gray-500">
                          {row.leads.toLocaleString()} purchased leads · {money(row.spend)}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-400 italic">no call export imported</span>
                      )}
                    </div>

                    {!row.covered ? (
                      <div className="px-5 py-6 text-sm text-gray-500 flex items-start gap-2">
                        <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
                        <div>
                          No data. Nothing has been imported for {row.lo}, so their dialing activity is
                          unknown — this is <strong>not</strong> zero activity.
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-6 divide-x divide-gray-100">
                          {[
                            ['Dialed', pct(row.dialed, row.leads)],
                            ['Connected', pct(row.connected, row.leads)],
                            ['Dials / lead', row.leads ? (row.dials / row.leads).toFixed(1) : '—'],
                            ['Talk time', hours(row.talkSec)],
                            ['Median to 1st dial', fmtTtfd(row.medianTtfdHours)],
                            ['Total dials', row.dials.toLocaleString()],
                          ].map(([label, val]) => (
                            <div key={label} className="px-4 py-3">
                              <div className="text-xs text-gray-500">{label}</div>
                              <div className="text-lg font-semibold text-gray-900">{val}</div>
                            </div>
                          ))}
                        </div>

                        {los.length > 0 && (
                          <div className="px-5 py-3 border-t border-gray-100">
                            <div className="text-xs text-gray-500 mb-2">Dialed by</div>
                            <div className="flex flex-wrap gap-2">
                              {los.map(d => (
                                <span key={d.dialer} className="text-sm bg-gray-50 border border-gray-200 rounded-full px-3 py-1 text-gray-700">
                                  {d.dialer}
                                  <span className="text-gray-400"> · </span>
                                  {d.calls.toLocaleString()} calls
                                  <span className="text-gray-400"> · </span>
                                  {hours(d.talkSec)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── UNREACHABLE NUMBERS ──────────────────────────────────────── */}
          {tab === 'effort' && data.unreachable.length > 0 && (
            <div className="mt-6 bg-white border border-amber-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-amber-100 bg-amber-50/60 flex items-start gap-2">
                <PhoneOff className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
                <div className="text-sm text-gray-700">
                  <strong>Numbers that can&apos;t be called.</strong> The carrier refused these
                  {' '}{UNREACHABLE_MIN_FAILURES}+ times and nothing has ever connected — dialing again
                  will not work. Fix the number on the lead, or claim the credit back from the source.
                  {' '}This is not &ldquo;didn&apos;t pick up&rdquo;: those leads are ordinary follow-up and are
                  deliberately excluded.
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-2">Lead</th>
                    <th className="text-left font-medium px-5 py-2">Number</th>
                    <th className="text-right font-medium px-5 py-2">Refused</th>
                    <th className="text-left font-medium px-5 py-2">Source</th>
                    <th className="text-right font-medium px-5 py-2">Lead cost</th>
                    <th className="text-left font-medium px-5 py-2">Last tried</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.unreachable.map(u => (
                    <tr key={u.phone} className="hover:bg-gray-50">
                      <td className="px-5 py-2">
                        {u.dealId
                          ? <Link href={`/deals/${u.dealId}`} className="text-blue-700 hover:underline">{u.name ?? '(unnamed)'}</Link>
                          : <span className="text-gray-700">{u.name ?? '(unnamed)'}</span>}
                        {u.lo && <span className="text-gray-400"> · {u.lo}</span>}
                      </td>
                      <td className="px-5 py-2 font-mono text-gray-600">{fmtPhone(u.phone)}</td>
                      <td className="px-5 py-2 text-right">
                        <span className="font-medium text-amber-700">{u.failed}</span>
                        <span className="text-gray-400"> of {u.dials}</span>
                      </td>
                      <td className="px-5 py-2 text-gray-600">{u.source ?? '—'}</td>
                      <td className="px-5 py-2 text-right text-gray-600">{u.leadPrice ? money(u.leadPrice) : '—'}</td>
                      <td className="px-5 py-2 text-gray-500">{new Date(u.lastAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── ECONOMICS ────────────────────────────────────────────────── */}
          {tab === 'economics' && (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-start gap-2 bg-blue-50/50">
                <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
                <div className="text-sm text-gray-700">
                  <strong>Contact economics, not ROI.</strong> There&apos;s no revenue on this page — a source
                  can cost more per conversation and still be the most profitable. For revenue, see{' '}
                  <Link href="/lead-roi" className="text-blue-700 underline">Lead ROI</Link>.
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      {['Source', 'Leads', 'Spend', 'Connected', 'Dials / lead', '$ / connect', 'Funded'].map((h, i) => (
                        <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data!.economics.map(r => (
                      <tr key={r.source} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-gray-900 font-medium">{r.source}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.leads.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{money(r.spend)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{pct(r.connectedLeads, r.leads)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.dialsPerLead.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-gray-900">
                          {r.costPerConnect == null ? '—' : money(r.costPerConnect)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.funded}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-500 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" />
                Connected means real talk time — GHL&apos;s &ldquo;Answered&rdquo; status includes voicemails and is not used.
              </div>
            </div>
          )}

          <p className="mt-6 text-xs text-gray-400">
            {tab === 'activity'
              ? 'All imported calls in the selected range, bucketed by Pacific calendar day.'
              : `Purchased leads only (${data!.covered.join(' + ') || 'none'}), scoped to leads that came in between ${fmtDate(data!.window?.start ?? null)} and ${fmtDate(data!.window?.end ?? null)} — the range the imported calls cover.`}
          </p>
        </>
      )}
    </div>
  )
}
