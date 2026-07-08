'use client'

/**
 * Lead Cohort Responsiveness — "are the leads we got this week less responsive
 * than a prior week?" Two cohorts defined by CREATED DATE (date_added_ghl),
 * compared side by side and normalized by maturity so it's a fair test.
 *
 *   • As-of-today responded % — uses current stage, works immediately.
 *   • 7- and 14-day window rates — "responded within N days of its OWN created
 *     date", backed by the forward-only stage_events log. Leads too young for a
 *     window are excluded (not counted as a no); responders with no logged
 *     crossing are excluded from window timing (never counted as a no) but still
 *     count in as-of-today totals. Timing/maturity coverage shown so it's honest.
 *
 * All aggregation lives in lib/cohortReport.ts (pure, fixture-tested).
 */

import { useEffect, useMemo, useState } from 'react'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import type { Deal } from '@/lib/types'
import type { LO } from '@/lib/leadReport'
import {
  analyzeCohort, cohortDelta, WINDOWS,
  type CohortLead, type FirstRespondedMap, type CohortInput,
  type CohortResult, type CohortSegment, type BreakdownRow,
} from '@/lib/cohortReport'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { RefreshCw, Users, Clock, Target, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react'

const COLS = 'id,ghl_opportunity_id,loan_officer,pipeline_group,status,source,state,loan_purpose,date_added_ghl'
const LO_TABS: LO[] = ['All', 'Moe', 'Matt']
type Dim = 'Source' | 'State' | 'Purpose'
const DIM_TABS: Dim[] = ['Source', 'State', 'Purpose']

// ── formatters ──────────────────────────────────────────────────────────────
const pctFmt = (x: number | null) => (x == null ? '—' : x.toFixed(1) + '%')
const numFmt = (x: number) => x.toLocaleString()
const hoursFmt = (h: number | null) => {
  if (h == null) return '—'
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}
const ptsFmt = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} pts`)
const cntDelta = (x: number) => `${x >= 0 ? '+' : ''}${x}`

// ── delta arrow ─────────────────────────────────────────────────────────────
function Delta({ value, higherIsBetter = true, fmt }: { value: number | null; higherIsBetter?: boolean; fmt: (x: number | null) => string }) {
  if (value == null) return <span className="text-slate-400 text-xs">n/a</span>
  const flat = Math.abs(value) < 0.05
  const good = higherIsBetter ? value > 0 : value < 0
  const cls = flat ? 'text-slate-400' : good ? 'text-emerald-600' : 'text-red-600'
  const Icon = flat ? Minus : good ? TrendingUp : TrendingDown
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${cls}`}>
      <Icon size={13} />{fmt(value)}
    </span>
  )
}

// ── generic comparison row ──────────────────────────────────────────────────
function Row({ label, a, b, delta, hint }: { label: string; a: React.ReactNode; b: React.ReactNode; delta?: React.ReactNode; hint?: string }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="py-2.5 pr-3 text-sm text-slate-600">
        {label}{hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </td>
      <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-slate-900">{a}</td>
      <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-slate-900">{b}</td>
      <td className="py-2.5 pl-3 text-right">{delta ?? null}</td>
    </tr>
  )
}

export default function LeadCohortsPage() {
  const [deals, setDeals] = useState<CohortLead[]>([])
  const [firstResp, setFirstResp] = useState<FirstRespondedMap>(new Map())
  const [loadedAt, setLoadedAt] = useState<Date>(() => new Date())
  const [loading, setLoading] = useState(true)
  const [lo, setLo] = useState<LO>('All')
  const [dim, setDim] = useState<Dim>('Source')
  // Defaults from the spec example (A = prior week, B = this week).
  const [aStart, setAStart] = useState('2026-06-22')
  const [aEnd, setAEnd]     = useState('2026-06-26')
  const [bStart, setBStart] = useState('2026-06-29')
  const [bEnd, setBEnd]     = useState('2026-07-03')

  async function load() {
    setLoading(true)
    // First-responded timing map (forward-only log; empty pre-migration).
    let fr: FirstRespondedMap = new Map()
    try {
      const res = await fetch('/api/stage-events/first-responded')
      const json = await res.json()
      fr = new Map<string, string>(Object.entries(json.firstResponded ?? {}))
    } catch { /* leave empty — report still renders as-of-today */ }
    const rows = await fetchAllDeals(q => q.order('id', { ascending: true }), COLS) as unknown as CohortLead[]
    setFirstResp(fr)
    setDeals(rows)
    setLoadedAt(new Date())
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const A: CohortInput = { label: 'Cohort A', start: aStart, end: aEnd }
  const B: CohortInput = { label: 'Cohort B', start: bStart, end: bEnd }

  const ra: CohortResult = useMemo(() => analyzeCohort(deals, firstResp, loadedAt, A, lo), [deals, firstResp, loadedAt, aStart, aEnd, lo])
  const rb: CohortResult = useMemo(() => analyzeCohort(deals, firstResp, loadedAt, B, lo), [deals, firstResp, loadedAt, bStart, bEnd, lo])
  const d = useMemo(() => cohortDelta(ra.seg, rb.seg), [ra, rb])

  const sa = ra.seg, sb = rb.seg
  const timingBackfilled = firstResp.size === 0

  const breakdown = (r: CohortResult): BreakdownRow[] =>
    dim === 'Source' ? r.bySource : dim === 'State' ? r.byState : r.byPurpose

  // Bar-chart data: as-of-today responded% by category, A vs B, union of keys.
  const chartData = useMemo(() => {
    const keys = new Set<string>([...breakdown(ra).map(x => x.key), ...breakdown(rb).map(x => x.key)])
    const aMap = new Map(breakdown(ra).map(x => [x.key, x.seg]))
    const bMap = new Map(breakdown(rb).map(x => [x.key, x.seg]))
    return [...keys]
      .map(key => ({
        key,
        A: aMap.get(key)?.respondedNowPct ?? 0,
        B: bMap.get(key)?.respondedNowPct ?? 0,
        n: (aMap.get(key)?.total ?? 0) + (bMap.get(key)?.total ?? 0),
      }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 12)
  }, [ra, rb, dim])

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Users className="text-indigo-600" size={24} /> Lead Cohort Responsiveness
        </h1>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Are the leads from one week less responsive than another? Two cohorts by created date (GHL date-added), normalized by maturity.
      </p>

      {/* Forward-only notice */}
      <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 rounded-lg p-3 mb-5 text-[13px] text-amber-800">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <b>Window timing is forward-only.</b> The 7/14-day rates rely on the stage-change event log, which only has events
          from the day it went live. Responders whose crossing predates the log are counted in <i>as-of-today</i> totals but
          excluded from window timing (never counted as a no) — see each cohort&apos;s <b>timing coverage</b>.
          {timingBackfilled && <> <b>Right now the log is empty</b>, so window rates will read n/a until stage changes accumulate.</>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 mb-5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Loan Officer</div>
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
            {LO_TABS.map(t => (
              <button key={t} onClick={() => setLo(t)}
                className={`px-3 py-1.5 text-sm ${lo === t ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{t}</button>
            ))}
          </div>
        </div>
        <CohortDates label="Cohort A (prior)" start={aStart} end={aEnd} setStart={setAStart} setEnd={setAEnd} accent="text-slate-700" />
        <CohortDates label="Cohort B (this)" start={bStart} end={bEnd} setStart={setBStart} setEnd={setBEnd} accent="text-indigo-700" />
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm py-20 text-center">Loading…</div>
      ) : (
        <>
          {/* Headline scorecard */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="text-left font-semibold py-2.5 pr-3 pl-4">Metric</th>
                  <th className="text-right font-semibold py-2.5 px-3">Cohort A<span className="block normal-case text-slate-400 font-normal">{aStart} → {aEnd} · n={sa.total}</span></th>
                  <th className="text-right font-semibold py-2.5 px-3">Cohort B<span className="block normal-case text-indigo-400 font-normal">{bStart} → {bEnd} · n={sb.total}</span></th>
                  <th className="text-right font-semibold py-2.5 pl-3 pr-4">Δ B−A</th>
                </tr>
              </thead>
              <tbody className="pl-4">
                <tr><td colSpan={4} className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">As of today (not maturity-normalized)</td></tr>
                <RowP>
                  <Row label="Total leads" a={numFmt(sa.total)} b={numFmt(sb.total)} delta={<Delta value={d.total} fmt={v => cntDelta(v!)} />} />
                  <Row label="Responded (as of today)" hint="current stage; Ghosted counts"
                    a={`${sa.respondedNow} · ${pctFmt(sa.respondedNowPct)}`} b={`${sb.respondedNow} · ${pctFmt(sb.respondedNowPct)}`}
                    delta={<Delta value={d.respondedNowPct} fmt={ptsFmt} />} />
                  <Row label="Converted" hint="reached Arive Lead or later"
                    a={`${sa.converted} · ${pctFmt(sa.convertedPct)}`} b={`${sb.converted} · ${pctFmt(sb.convertedPct)}`}
                    delta={<Delta value={d.convertedPct} fmt={ptsFmt} />} />
                </RowP>
                <tr><td colSpan={4} className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Timing (logged crossings only)</td></tr>
                <RowP>
                  <Row label="Median time to first response" a={hoursFmt(sa.ttrMedianH)} b={hoursFmt(sb.ttrMedianH)}
                    delta={<Delta value={d.ttrMedianH} higherIsBetter={false} fmt={v => v == null ? 'n/a' : hoursFmt(Math.abs(v)) + (v < 0 ? ' faster' : ' slower')} />} />
                  <Row label="Avg time to first response" a={hoursFmt(sa.ttrAvgH)} b={hoursFmt(sb.ttrAvgH)} />
                  <Row label="Timing coverage" hint="responders with a logged crossing"
                    a={pctFmt(sa.timingCoverage)} b={pctFmt(sb.timingCoverage)}
                    delta={<Delta value={d.timingCoverage} fmt={ptsFmt} />} />
                </RowP>
              </tbody>
            </table>
          </div>

          {/* Maturation windows */}
          <h2 className="text-sm font-bold text-slate-700 mb-2">Responded within N days of created date (maturity-normalized)</h2>
          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            {WINDOWS.map((N, i) => {
              const wa = sa.windows[i], wb = sb.windows[i]
              const wd = d.windows[i]
              return (
                <div key={N} className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-bold text-slate-700">{N}-day window</div>
                    <Delta value={wd?.rate ?? null} fmt={ptsFmt} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <WindowCol label="Cohort A" w={wa} total={sa.total} />
                    <WindowCol label="Cohort B" w={wb} total={sb.total} accent />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Three-state honesty strip */}
          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            <StatesStrip label="Cohort A" seg={sa} />
            <StatesStrip label="Cohort B" seg={sb} accent />
          </div>

          {/* Breakdowns */}
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-slate-700">Breakdown by {dim.toLowerCase()}</h2>
            <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
              {DIM_TABS.map(t => (
                <button key={t} onClick={() => setDim(t)}
                  className={`px-3 py-1.5 text-sm ${dim === t ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{t}</button>
              ))}
            </div>
          </div>

          {/* Bar chart — as-of-today responded % by category, A vs B */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Responded % (as of today) by {dim.toLowerCase()}</div>
            <div style={{ width: '100%', height: Math.max(200, chartData.length * 34 + 40) }}>
              <ResponsiveContainer>
                <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} fontSize={11} stroke="#94a3b8" />
                  <YAxis type="category" dataKey="key" width={90} fontSize={11} stroke="#94a3b8" />
                  <Tooltip formatter={(v) => `${Number(v).toFixed(1)}%`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="A" name="Cohort A" fill="#94a3b8" radius={[0, 3, 3, 0]} />
                  <Bar dataKey="B" name="Cohort B" fill="#6366f1" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Breakdown table */}
          <BreakdownTable dim={dim} a={breakdown(ra)} b={breakdown(rb)} />
        </>
      )}
    </div>
  )
}

// ── sub-components ───────────────────────────────────────────────────────────
function RowP({ children }: { children: React.ReactNode }) { return <>{children}</> }

function CohortDates({ label, start, end, setStart, setEnd, accent }: {
  label: string; start: string; end: string; setStart: (s: string) => void; setEnd: (s: string) => void; accent: string
}) {
  return (
    <div>
      <div className={`text-[11px] font-semibold uppercase tracking-wider mb-1 ${accent}`}>{label}</div>
      <div className="inline-flex items-center gap-1.5">
        <input type="date" value={start} onChange={e => setStart(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5" />
        <span className="text-slate-400">→</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-2 py-1.5" />
      </div>
    </div>
  )
}

function WindowCol({ label, w, total, accent }: { label: string; w: CohortSegment['windows'][number]; total: number; accent?: boolean }) {
  const comparable = w.rate != null
  return (
    <div className={`rounded-lg p-3 ${accent ? 'bg-indigo-50' : 'bg-slate-50'}`}>
      <div className={`text-[11px] font-semibold uppercase tracking-wider mb-1 ${accent ? 'text-indigo-500' : 'text-slate-400'}`}>{label}</div>
      {comparable ? (
        <>
          <div className="text-2xl font-bold tabular-nums text-slate-900 flex items-center gap-1">
            {pctFmt(w.rate)} <Clock size={13} className="text-slate-300" />
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{w.responded} of {w.eligible} eligible</div>
          <div className="text-[11px] text-slate-400">maturity coverage {w.maturityCoverage.toFixed(0)}% of {total}</div>
        </>
      ) : (
        <div className="text-[13px] text-slate-400 py-2">Not enough maturity to compare<span className="block text-[11px]">0 eligible of {total}</span></div>
      )}
    </div>
  )
}

function StatesStrip({ label, seg, accent }: { label: string; seg: CohortSegment; accent?: boolean }) {
  const cell = (n: number, txt: string, cls: string) => (
    <div className="flex-1">
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{n}</div>
      <div className="text-[11px] text-slate-500 leading-tight mt-0.5">{txt}</div>
    </div>
  )
  return (
    <div className={`border rounded-xl p-4 ${accent ? 'border-indigo-200' : 'border-slate-200'} bg-white`}>
      <div className={`text-[11px] font-semibold uppercase tracking-wider mb-2 ${accent ? 'text-indigo-500' : 'text-slate-400'}`}>{label} — response states</div>
      <div className="flex gap-3">
        {cell(seg.respondedTimed, 'responded, timed (usable in windows)', 'text-emerald-600')}
        {cell(seg.respondedUntimed, 'responded, pre-log (no timestamp)', 'text-amber-600')}
        {cell(seg.notResponded, 'not responded', 'text-slate-500')}
      </div>
    </div>
  )
}

function BreakdownTable({ dim, a, b }: { dim: Dim; a: BreakdownRow[]; b: BreakdownRow[] }) {
  const keys = [...new Set<string>([...a.map(x => x.key), ...b.map(x => x.key)])]
  const aMap = new Map(a.map(x => [x.key, x.seg]))
  const bMap = new Map(b.map(x => [x.key, x.seg]))
  const ordered = keys.map(k => ({ k, n: (aMap.get(k)?.total ?? 0) + (bMap.get(k)?.total ?? 0) })).sort((x, y) => y.n - x.n)
  const win = (seg: CohortSegment | undefined, i: number) => seg ? (seg.windows[i]?.rate == null ? '—' : pctFmt(seg.windows[i].rate)) : '—'
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-10">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
            <th className="text-left font-semibold py-2.5 pl-4 pr-3">{dim}</th>
            <th className="text-right font-semibold py-2.5 px-2">A n</th>
            <th className="text-right font-semibold py-2.5 px-2">A resp%</th>
            <th className="text-right font-semibold py-2.5 px-2">A 7d</th>
            <th className="text-right font-semibold py-2.5 px-2">A 14d</th>
            <th className="text-right font-semibold py-2.5 px-2 border-l border-slate-100">B n</th>
            <th className="text-right font-semibold py-2.5 px-2">B resp%</th>
            <th className="text-right font-semibold py-2.5 px-2">B 7d</th>
            <th className="text-right font-semibold py-2.5 px-2 pr-4">B 14d</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ k }) => {
            const av = aMap.get(k), bv = bMap.get(k)
            return (
              <tr key={k} className="border-t border-slate-50 tabular-nums">
                <td className="py-2 pl-4 pr-3 text-slate-700 font-medium">{k}</td>
                <td className="py-2 px-2 text-right text-slate-500">{av?.total ?? 0}</td>
                <td className="py-2 px-2 text-right text-slate-900">{pctFmt(av?.respondedNowPct ?? null)}</td>
                <td className="py-2 px-2 text-right text-slate-500">{win(av, 0)}</td>
                <td className="py-2 px-2 text-right text-slate-500">{win(av, 1)}</td>
                <td className="py-2 px-2 text-right text-slate-500 border-l border-slate-100">{bv?.total ?? 0}</td>
                <td className="py-2 px-2 text-right text-slate-900">{pctFmt(bv?.respondedNowPct ?? null)}</td>
                <td className="py-2 px-2 text-right text-slate-500">{win(bv, 0)}</td>
                <td className="py-2 px-2 text-right text-slate-500 pr-4">{win(bv, 1)}</td>
              </tr>
            )
          })}
          {ordered.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-slate-400">No leads in either cohort for this filter.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
