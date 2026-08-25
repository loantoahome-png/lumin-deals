'use client'

/**
 * Monthly Reports — "what did the leads we bought in <month> actually become?"
 *
 * Every number on this page belongs to the month the lead CAME IN. Pick May and
 * you see May's leads, May's spend, and how many of those exact leads have funded
 * since — whether they closed in May, June or August.
 *
 * That is deliberately NOT what /lead-roi does. There a funded loan anchors on its
 * funded_date, so a May lead that closes in August puts its cost in May and its
 * revenue in August. Both views are right; they answer different questions. This
 * one is the buy decision: was that month's spend worth it?
 *
 * Scope is purchased leads, one LO at a time (Efrain, 2026-08-10). The math lives
 * in lib/monthlyCohort.ts, locked by scripts/monthly-cohort-check.ts.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { LOAN_OFFICERS, type Deal } from '@/lib/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { LO_SPLIT, type CostRow } from '@/lib/leadRoi'
import { isFunded } from '@/lib/leadReport'
import { totalComp } from '@/lib/comp'
import {
  monthsInData, monthPeriod, customPeriod, monthSpan, cohortOf, daysToFund,
  totals, bySource, monthlyRows, scopeLeads, undated, maturity, medianDaysToFundAll, ageOf,
  type CohortLead, type Period,
} from '@/lib/monthlyCohort'
import {
  RefreshCw, Users, CalendarRange, TrendingUp, DollarSign, Target, Hourglass,
} from 'lucide-react'

const COLS = 'id,name,source,loan_officer,pipeline_group,status,loan_amount,state,loan_purpose,loan_type,lead_price,compensation_amount,broker_corr,net_discount_points,date_added_ghl,funded_date,created_at,last_inbound_at'

const SPLIT_LABEL = `${(LO_SPLIT * 100).toFixed(LO_SPLIT * 100 % 1 === 0 ? 0 : 1)}%`
const LO_ACCENT: Record<string, string> = {
  'Matt Park': 'bg-blue-600 border-blue-600',
  'Moe Sefati': 'bg-violet-600 border-violet-600',
  'Randy Mathis': 'bg-teal-600 border-teal-600',
  'Daniel McGrail-Granger': 'bg-sky-600 border-sky-600',
}
const pct = (x: number) => `${x.toFixed(1)}%`
const mult = (x: number | null) => (x == null ? '—' : `${x.toFixed(2)}×`)
const days = (x: number | null) => (x == null ? '—' : `${Math.round(x)}d`)

// Gross ROI needed to break even AFTER the LO split — 1 ÷ 0.85 ≈ 1.18×. A source
// at 1.05× gross clears its cost on paper and still loses money in the pocket.
const BREAKEVEN = 1 / LO_SPLIT

const MATURITY_COPY: Record<'mature' | 'partial' | 'young', { label: string; cls: string }> = {
  mature: { label: 'Mature', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partial: { label: 'Still filling in', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  young: { label: 'Too new to judge', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

export default function MonthlyReportsPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [costs, setCosts] = useState<Map<string, CostRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [lo, setLo] = useState<string>('Moe Sefati')
  const [monthKey, setMonthKey] = useState<string>('')     // '' until data lands
  const [useCustom, setUseCustom] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  async function load() {
    setLoading(true)
    setDeals(await fetchAllDeals(q => q.order('created_at', { ascending: false }), COLS))
    try {
      const res = await fetch('/api/lead-source-costs', { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; costs?: CostRow[] }
      if (data.ok && data.costs) setCosts(new Map(data.costs.map(c => [c.source, c])))
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Purchased leads for the selected LO — the population every cohort is cut from.
  const book = useMemo(() => scopeLeads(deals as CohortLead[], lo), [deals, lo])
  const months = useMemo(() => monthsInData(book), [book])
  const missing = useMemo(() => undated(book), [book])

  // Default to the newest month with data, and follow it when the LO changes.
  useEffect(() => {
    if (!months.length) return
    if (!months.some(m => m.key === monthKey)) setMonthKey(months[0].key)
  }, [months, monthKey])

  const period: Period | null = useMemo(() => {
    if (useCustom) return customPeriod(from, to)
    return monthKey ? monthPeriod(monthKey) : null
  }, [useCustom, from, to, monthKey])

  const retainerPerMonth = useMemo(
    () => [...costs.values()].reduce((a, c) => a + (Number(c.cost_per_month) || 0), 0),
    [costs],
  )

  const cohort = useMemo(() => (period ? cohortOf(book, period) : []), [book, period])
  const span = useMemo(() => (period ? monthSpan(period) : 1), [period])
  const t = useMemo(() => totals(cohort, retainerPerMonth, span), [cohort, retainerPerMonth, span])
  const sources = useMemo(() => bySource(cohort, costs, span), [cohort, costs, span])
  const rows = useMemo(() => monthlyRows(book, costs, new Date()), [book, costs])
  const medianAll = useMemo(() => medianDaysToFundAll(book), [book])

  const fundedInCohort = useMemo(
    () => cohort.filter(isFunded).sort((a, b) => (daysToFund(a) ?? 0) - (daysToFund(b) ?? 0)),
    [cohort],
  )

  const periodMaturity = useMemo(
    () => (period ? maturity(ageOf(period, new Date()), medianAll) : null),
    [period, medianAll],
  )

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <CalendarRange className="w-6 h-6 text-blue-600" />
            Monthly Reports
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            What the leads that came in during a period actually became — spend and outcome in the same row.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-500 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* LO tabs — one at a time, never combined (same rule as /lead-roi) */}
      <div className="flex gap-2 mb-3">
        {LOAN_OFFICERS.map(name => {
          const active = lo === name
          return (
            <button key={name} onClick={() => setLo(name)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-base font-bold border-2 transition-all ${
                active ? `${LO_ACCENT[name] ?? 'bg-slate-700 border-slate-700'} text-white shadow-md`
                       : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
              }`}>
              <Users className="w-4 h-4" />
              {name}
            </button>
          )
        })}
      </div>

      {/* Period picker */}
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap mb-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Period</label>
        <select
          value={useCustom ? '__custom' : monthKey}
          onChange={e => {
            if (e.target.value === '__custom') { setUseCustom(true); return }
            setUseCustom(false); setMonthKey(e.target.value)
          }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          {months.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          <option value="__custom">Custom range…</option>
        </select>

        {useCustom && (
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700" />
            <span className="text-slate-400 text-sm">to</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700" />
            {!period && <span className="text-xs text-amber-600">pick both dates</span>}
          </div>
        )}

        {period && periodMaturity && (
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-full border ${MATURITY_COPY[periodMaturity].cls}`}>
            {MATURITY_COPY[periodMaturity].label}
          </span>
        )}
        <span className="text-xs text-slate-400 ml-auto">
          Agg leads only · {lo}
          {missing.length > 0 && <> · {missing.length} lead{missing.length === 1 ? '' : 's'} without a lead-in date excluded</>}
        </span>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm py-16 text-center">Loading…</div>
      ) : !period ? (
        <div className="text-slate-400 text-sm py-16 text-center">Choose a period to report on.</div>
      ) : (
        <>
          {/* ── Headline ─────────────────────────────────────────────────── */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4">
            <h2 className="text-lg font-bold text-slate-900 mb-1">{period.label}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              {t.leads === 0 ? (
                <>No purchased leads came in during this period for {lo}.</>
              ) : (
                <>
                  <b className="text-slate-900">{t.leads}</b> leads came in, costing{' '}
                  <b className="text-rose-600">{formatCurrency(t.spend)}</b>
                  {t.retainer > 0 && <span className="text-slate-400"> ({formatCurrency(t.leadSpend)} in lead prices + {formatCurrency(t.retainer)} retainer)</span>}.{' '}
                  <b className="text-slate-900">{t.funded}</b> of them {t.funded === 1 ? 'has' : 'have'} funded so far
                  {' '}({pct(t.fundedPct)}), earning <b className="text-emerald-700">{formatCurrency(t.netRevenue)}</b> net
                  after the {SPLIT_LABEL} split —{' '}
                  <b className={t.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                    {t.netProfit >= 0 ? 'a profit of ' : 'a loss of '}{formatCurrency(Math.abs(t.netProfit))}
                  </b>.
                  {t.inFlight > 0 && <> <b className="text-amber-600">{t.inFlight}</b> {t.inFlight === 1 ? 'is' : 'are'} still live and unfunded.</>}
                </>
              )}
            </p>
            {periodMaturity !== 'mature' && t.leads > 0 && medianAll != null && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3 flex items-start gap-2">
                <Hourglass className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  This cohort is still maturing. Funded loans from this LO take a median of{' '}
                  <b>{medianAll} days</b> from lead-in — Larisa Fuchs came in May 1 and funded June 2 — so
                  the funded count above will keep rising. Don&apos;t read it as final.
                </span>
              </p>
            )}
          </div>

          {/* ── KPIs ─────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">
            <Kpi label="Leads in" value={String(t.leads)} icon={<Users className="w-4 h-4 text-blue-500" />} />
            <Kpi label="Spend" value={formatCurrency(t.spend)} sub={t.costPerLead != null ? `${formatCurrency(t.costPerLead)}/lead` : undefined}
              icon={<DollarSign className="w-4 h-4 text-rose-500" />} />
            <Kpi label="Funded" value={String(t.funded)} sub={pct(t.fundedPct)} icon={<Target className="w-4 h-4 text-emerald-500" />} />
            <Kpi label="Cost / funded" value={t.costPerFunded != null ? formatCurrency(t.costPerFunded) : '—'}
              icon={<DollarSign className="w-4 h-4 text-amber-500" />} />
            <Kpi label={`Net revenue (${SPLIT_LABEL})`} value={formatCurrency(t.netRevenue)} sub={`${formatCurrency(t.grossRevenue)} gross`}
              icon={<TrendingUp className="w-4 h-4 text-emerald-500" />} />
            <Kpi label="Net profit" value={formatCurrency(t.netProfit)} tone={t.netProfit >= 0 ? 'good' : 'bad'}
              icon={<TrendingUp className="w-4 h-4 text-violet-500" />} />
            <Kpi label="ROI (gross)" value={mult(t.roi)} tone={t.roi == null ? undefined : t.roi >= BREAKEVEN ? 'good' : 'bad'}
              sub={`break-even ${BREAKEVEN.toFixed(2)}×`} icon={<Target className="w-4 h-4 text-blue-500" />} />
          </div>

          {/* ── By source ────────────────────────────────────────────────── */}
          <Panel title={`Where ${period.label}'s leads came from`} icon={<Target className="w-4 h-4 text-blue-500" />}>
            {sources.length === 0 ? (
              <Empty>No leads in this period.</Empty>
            ) : (
              <table className="w-full text-sm">
                <Head cols={['Source', 'Leads', 'Spend', 'Responded', 'Funded', 'Funded %', 'Cost / funded', `Net rev (${SPLIT_LABEL})`, 'Net profit', 'ROI']} />
                <tbody className="divide-y divide-slate-100">
                  {sources.map((s, i) => (
                    <tr key={s.source} className={i % 2 ? 'bg-slate-50/40' : 'bg-white'}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{s.source}</td>
                      <Num>{s.leads}</Num>
                      <Num className="text-rose-600">{formatCurrency(s.spend)}</Num>
                      <Num className="text-slate-500">{s.responded} <span className="text-[11px] text-slate-400">/ {pct(s.respondedPct)}</span></Num>
                      <Num className="font-semibold text-slate-800">{s.funded}</Num>
                      <Num className="text-slate-500">{pct(s.fundedPct)}</Num>
                      <Num>{s.costPerFunded != null ? formatCurrency(s.costPerFunded) : '—'}</Num>
                      <Num className="text-emerald-700">{formatCurrency(s.netRevenue)}</Num>
                      <Num className={s.netProfit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'}>{formatCurrency(s.netProfit)}</Num>
                      <Num className={s.roi == null ? 'text-slate-400' : s.roi >= BREAKEVEN ? 'text-emerald-600 font-semibold' : 'text-red-600 font-semibold'}>{mult(s.roi)}</Num>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-800">
                    <td className="px-4 py-2.5">Total</td>
                    <Num>{t.leads}</Num>
                    <Num className="text-rose-600">{formatCurrency(t.spend)}</Num>
                    <Num>{t.responded}</Num>
                    <Num>{t.funded}</Num>
                    <Num>{pct(t.fundedPct)}</Num>
                    <Num>{t.costPerFunded != null ? formatCurrency(t.costPerFunded) : '—'}</Num>
                    <Num className="text-emerald-700">{formatCurrency(t.netRevenue)}</Num>
                    <Num className={t.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>{formatCurrency(t.netProfit)}</Num>
                    <Num className={t.roi == null ? 'text-slate-400' : t.roi >= BREAKEVEN ? 'text-emerald-600' : 'text-red-600'}>{mult(t.roi)}</Num>
                  </tr>
                </tfoot>
              </table>
            )}
          </Panel>

          {/* ── The funded loans this cohort produced ────────────────────── */}
          {fundedInCohort.length > 0 && (
            <Panel title={`What ${period.label} produced`} icon={<DollarSign className="w-4 h-4 text-emerald-500" />}
              note={`${fundedInCohort.length} funded loan${fundedInCohort.length === 1 ? '' : 's'} from leads that came in during this period — whenever they closed.`}>
              <table className="w-full text-sm">
                <Head cols={['Borrower', 'Source', 'Lead in', 'Funded', 'Days', 'Loan amount', 'Revenue', `Net (${SPLIT_LABEL})`]} />
                <tbody className="divide-y divide-slate-100">
                  {fundedInCohort.map((d, i) => (
                    <tr key={d.id} className={i % 2 ? 'bg-slate-50/40' : 'bg-white'}>
                      <td className="px-4 py-2.5">
                        <Link href={`/deals/${d.id}`} className="font-medium text-slate-900 hover:text-blue-700">{d.name || '(no name)'}</Link>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{(d.source ?? '').trim() || '—'}</td>
                      <Num className="text-slate-500">{formatDate(d.date_added_ghl)}</Num>
                      <Num className="text-slate-600">{formatDate(d.funded_date)}</Num>
                      <Num className="text-slate-500">{days(daysToFund(d))}</Num>
                      <Num className="font-medium text-slate-800">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</Num>
                      <Num className="text-slate-500">{totalComp(d) ? formatCurrency(totalComp(d)) : '—'}</Num>
                      <Num className="text-emerald-700 font-medium">{totalComp(d) ? formatCurrency(totalComp(d) * LO_SPLIT) : '—'}</Num>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          {/* ── Every month, side by side ────────────────────────────────── */}
          <Panel title="Every month, by the month leads came in"
            icon={<CalendarRange className="w-4 h-4 text-violet-500" />}
            note="Each row is a cohort: the leads that arrived that month, what they cost, and everything they have earned since. Recent months are still filling in.">
            <table className="w-full text-sm">
              <Head cols={['Month', '', 'Leads', 'Spend', 'Funded', 'Funded %', 'Cost / funded', `Net rev (${SPLIT_LABEL})`, 'Net profit', 'ROI', 'Median days']} />
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => {
                  const m = maturity(r.ageDays, medianAll)
                  const selected = !useCustom && r.period.key === monthKey
                  return (
                    <tr key={r.period.key}
                      onClick={() => { setUseCustom(false); setMonthKey(r.period.key) }}
                      className={`cursor-pointer ${selected ? 'bg-blue-50' : i % 2 ? 'bg-slate-50/40' : 'bg-white'} hover:bg-blue-50/60`}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{r.period.label}</td>
                      <td className="px-2 py-2.5">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${MATURITY_COPY[m].cls}`}>{MATURITY_COPY[m].label}</span>
                      </td>
                      <Num>{r.leads}</Num>
                      <Num className="text-rose-600">{formatCurrency(r.spend)}</Num>
                      <Num className="font-semibold text-slate-800">{r.funded}</Num>
                      <Num className="text-slate-500">{pct(r.fundedPct)}</Num>
                      <Num>{r.costPerFunded != null ? formatCurrency(r.costPerFunded) : '—'}</Num>
                      <Num className="text-emerald-700">{formatCurrency(r.netRevenue)}</Num>
                      <Num className={r.netProfit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'}>{formatCurrency(r.netProfit)}</Num>
                      <Num className={r.roi == null ? 'text-slate-400' : r.roi >= BREAKEVEN ? 'text-emerald-600 font-semibold' : 'text-red-600 font-semibold'}>{mult(r.roi)}</Num>
                      <Num className="text-slate-500">{days(r.medianDaysToFund)}</Num>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Panel>

          {/* ── Methodology ──────────────────────────────────────────────── */}
          <details className="mt-6 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
            <summary className="cursor-pointer px-4 py-2.5 font-semibold text-slate-700 select-none">
              How this page differs from Lead ROI
            </summary>
            <div className="px-4 pb-3 space-y-1.5">
              <p><b>The anchor:</b> every figure here belongs to the month the lead <b>came in</b> (<code>date_added_ghl</code>). A lead bought in May that funds in August counts its cost <i>and</i> its revenue in May. On <Link href="/lead-roi" className="text-blue-700 hover:underline">/lead-roi</Link> that same loan puts spend in May and revenue in August, because funded loans anchor on <code>funded_date</code> there. Neither is wrong — this one answers &ldquo;was that month&apos;s buy any good&rdquo;, that one answers &ldquo;how did that month close&rdquo;.</p>
              <p><b>Scope:</b> purchased/aggregator leads only, one LO at a time. Warm and organic sources are excluded on purpose: only about a third of their funded loans carry a lead-in date, so a cohort built from them would silently under-report funding.</p>
              <p><b>Spend:</b> Σ lead prices of the cohort + any monthly retainer × months the period spans. A lead price is charged <b>per opportunity</b> — the same borrower bought twice is two real charges and is never deduped.</p>
              <p><b>Revenue:</b> Arive compensation on funded loans only (plus the Non-Del Final Price credit where it applies). <b>Net</b> is the loan officer&apos;s {SPLIT_LABEL} share, which is the only figure profit is measured against. Because of that split, gross ROI has to clear <b>{BREAKEVEN.toFixed(2)}×</b> to break even — anything between 1.00× and {BREAKEVEN.toFixed(2)}× looks profitable and isn&apos;t.</p>
              <p><b>Maturity:</b> a cohort keeps earning after its month ends, so recent months always look worse than they will. A month is marked <i>Mature</i> once it is older than twice the median lead-to-funding time, <i>Still filling in</i> past one median, and <i>Too new to judge</i> before that.</p>
              <p><b>Excluded:</b> leads with no lead-in date can&apos;t be placed in any month and are left out entirely; the count is shown next to the period picker rather than folded silently into a denominator.</p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

// ── Small presentational helpers ────────────────────────────────────────────
function Kpi({ label, value, sub, icon, tone }: {
  label: string; value: string; sub?: string; icon?: React.ReactNode; tone?: 'good' | 'bad'
}) {
  const toneCls = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : 'text-slate-900'
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {icon}{label}
      </div>
      <div className={`text-xl font-bold mt-1 tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400 tabular-nums">{sub}</div>}
    </div>
  )
}

function Panel({ title, icon, note, children }: {
  title: string; icon?: React.ReactNode; note?: string; children: React.ReactNode
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">{icon}{title}</h3>
        {note && <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{note}</p>}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function Head({ cols }: { cols: string[] }) {
  return (
    <thead className="bg-slate-50 border-b border-slate-200">
      <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
        {cols.map((c, i) => (
          <th key={`${c}-${i}`} className={`py-2.5 ${i === 0 ? 'px-4' : 'px-3 text-right'}`}>{c}</th>
        ))}
      </tr>
    </thead>
  )
}

function Num({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${className}`}>{children}</td>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-slate-400">{children}</div>
}
