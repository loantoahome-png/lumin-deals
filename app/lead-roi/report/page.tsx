'use client'

/**
 * Lead ROI — printable report ROUTE (replaces Lead Spend's window.open popup).
 * Shareable URL, no popup blockers, automatable. Reads the same filters as
 * /lead-roi from query params and recomputes with the same lib/leadRoi functions,
 * so the report can never disagree with the page. Chromeless via AppShell.
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { rrBand, isFunded, PURCHASED_SOURCES, type Purpose, type SourceScope } from '@/lib/leadReport'
import {
  RANGE_OPTIONS, rangeBounds, monthsBetween, filterDeals, buildSourceStats, rollupKpis,
  funnel, stateRows, monthlySeries, projection, optout7dStats, insights,
  type RangeKey, type CostRow,
} from '@/lib/leadRoi'
import { Printer } from 'lucide-react'

const LEAD_COLS = 'id,name,source,loan_officer,pipeline_group,status,loan_amount,state,loan_purpose,lead_price,compensation_amount,date_added_ghl,funded_date,created_at,ghl_opportunity_id'

const pct = (x: number) => x.toFixed(1) + '%'
const roiFmt = (x: number | null) => (x == null ? '—' : x.toFixed(2) + '×')
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const RR_TXT: Record<'good' | 'mid' | 'bad', string> = {
  good: 'text-emerald-700', mid: 'text-amber-600', bad: 'text-red-600',
}
const DONUT_COLORS = ['#059669', '#4f46e5', '#b45309', '#0369a1', '#0d9488', '#7c3aed', '#be185d', '#4d7c0f']

export default function LeadRoiReportPage() {
  return (
    <Suspense fallback={<p className="p-10 text-sm text-slate-400">Loading report…</p>}>
      <ReportBody />
    </Suspense>
  )
}

function ReportBody() {
  const sp = useSearchParams()
  const lo = useMemo(() => {
    const q = sp.get('lo')
    return (LOAN_OFFICERS as readonly string[]).includes(q ?? '') ? (q as string) : LOAN_OFFICERS[1] // default Moe Sefati
  }, [sp])
  const range = (sp.get('range') ?? 'all') as RangeKey
  const customFrom = sp.get('from') ?? ''
  const customTo = sp.get('to') ?? ''
  const scope = (sp.get('scope') === 'All' ? 'All' : 'Purchased') as SourceScope
  const purpose = (['Purchase', 'Refinance'].includes(sp.get('purpose') ?? '') ? sp.get('purpose') : 'All') as Purpose
  const stage = sp.get('stage') ?? ''
  const sourcesParam = sp.get('sources')

  const [deals, setDeals] = useState<Deal[]>([])
  const [costs, setCosts] = useState<Map<string, CostRow>>(new Map())
  const [firstOptout, setFirstOptout] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [generatedAt, setGeneratedAt] = useState('')

  useEffect(() => {
    (async () => {
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
      setGeneratedAt(new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))
      setLoading(false)
    })()
  }, [])

  const { start, end } = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo])
  const months = useMemo(() => monthsBetween(start, end), [start, end])
  const filtered = useMemo(
    () => filterDeals(deals, { lo, scope, purpose, stage, start, end }),
    [deals, lo, scope, purpose, stage, start, end],
  )
  const sources = useMemo(() => buildSourceStats(filtered, costs, months), [filtered, costs, months])
  const visibleSources = useMemo(() => {
    if (!sourcesParam) return sources
    const wanted = new Set(sourcesParam.split('|'))
    return sources.filter(s => wanted.has(s.source))
  }, [sources, sourcesParam])
  const visibleDeals = useMemo(() => visibleSources.flatMap(s => s.deals), [visibleSources])
  const kpis = useMemo(() => rollupKpis(visibleSources), [visibleSources])
  const stages = useMemo(() => funnel(kpis), [kpis])
  const states = useMemo(() => stateRows(visibleDeals), [visibleDeals])
  const retainerPerMonth = useMemo(() => visibleSources.reduce((a, s) => a + s.costPerMonth, 0), [visibleSources])
  const monthly = useMemo(() => monthlySeries(visibleDeals, retainerPerMonth), [visibleDeals, retainerPerMonth])
  const proj = useMemo(() => projection(visibleSources, kpis), [visibleSources, kpis])
  const o7 = useMemo(() => optout7dStats(visibleDeals, firstOptout), [visibleDeals, firstOptout])
  const ins = useMemo(() => insights(visibleSources), [visibleSources])

  const fundedList = useMemo(() =>
    visibleDeals
      .filter(isFunded)
      .sort((a, b) => new Date(b.funded_date || b.created_at).getTime() - new Date(a.funded_date || a.created_at).getTime()),
  [visibleDeals])

  const rangeLabel = RANGE_OPTIONS.find(o => o.key === range)?.label ?? 'All time'
  const filterChips = [
    `LO: ${lo}`,
    `Range: ${rangeLabel}${range === 'custom' && (customFrom || customTo) ? ` (${customFrom || '…'} → ${customTo || '…'})` : ''}`,
    `Scope: ${scope === 'All' ? 'All sources' : 'Purchased'}`,
    `Purpose: ${purpose === 'All' ? 'All purposes' : purpose}`,
    stage ? `Stage: ${stage}` : 'Stage: All',
    sourcesParam ? `${sourcesParam.split('|').length} sources selected` : 'All sources',
  ]

  const maxMonthVal = Math.max(1, ...monthly.flatMap(p => [p.spend, p.revenue]))
  const FUNNEL_BG = ['#c7d2fe', '#a5b4fc', '#818cf8', '#4f46e5']

  // Donut geometry (pure SVG — prints reliably, unlike a responsive chart lib)
  const donutData = useMemo(() => {
    const withFunded = visibleSources.filter(s => s.funded > 0).sort((a, b) => b.funded - a.funded)
    const top = withFunded.slice(0, 5)
    const rest = withFunded.slice(5)
    const data = top.map(s => ({ name: s.source, funded: s.funded, isOther: false }))
    if (rest.length) data.push({ name: `Other (${rest.length})`, funded: rest.reduce((a, s) => a + s.funded, 0), isOther: true })
    return data
  }, [visibleSources])
  const donutTotal = donutData.reduce((a, d) => a + d.funded, 0)
  const C = 2 * Math.PI * 60
  let acc = 0
  const donutSegs = donutData.map((d, i) => {
    const len = donutTotal > 0 ? (d.funded / donutTotal) * C : 0
    const seg = { ...d, len: Math.max(0, len - 2), offset: -acc, color: d.isOther ? '#64748b' : DONUT_COLORS[i % DONUT_COLORS.length] }
    acc += len
    return seg
  })

  if (loading) return <p className="p-10 text-sm text-slate-400">Building report…</p>

  return (
    <div className="w-full h-full overflow-auto bg-slate-100 print:bg-white print:overflow-visible">
      <style>{`
        @media print {
          body { overflow: visible !important; display: block !important; }
          .noprint { display: none !important; }
          .sheet { box-shadow: none !important; border: 0 !important; border-radius: 0 !important; margin: 0 !important; max-width: none !important; }
        }
      `}</style>
      <div className="noprint sticky top-0 z-10 flex justify-end px-6 py-3">
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow">
          <Printer className="w-4 h-4" /> Print / Save as PDF
        </button>
      </div>

      <div className="sheet max-w-[980px] mx-auto mb-10 bg-white border border-slate-200 rounded-2xl shadow-lg px-10 py-9 print:px-2 print:py-0">
        {/* Masthead */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <span className="text-[11px] font-extrabold tracking-[0.22em] uppercase text-indigo-600">Lumin Lending</span>
          <span className="text-[11px] text-slate-400 tabular-nums">Generated {generatedAt}</span>
        </div>
        <h1 className="text-[26px] font-extrabold tracking-tight text-slate-900 mt-1">Lead ROI Report — {lo}</h1>
        <p className="text-[13px] text-slate-500 mb-3.5">What leads cost, how they responded, and what they earned.</p>
        <div className="flex flex-wrap gap-1.5 pb-5 border-b-2 border-slate-900">
          {filterChips.map(c => (
            <span key={c} className="text-[11px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded-full px-2.5 py-0.5">{c}</span>
          ))}
        </div>

        {/* KPI band */}
        <Section title="Summary">
          {/* Computed narrative + best-performer callouts */}
          {kpis.totalLeads > 0 && (
            <div className="border border-indigo-200 border-l-4 border-l-indigo-500 rounded-lg px-3.5 py-3 mb-3.5">
              <p className="text-[12.5px] text-slate-700 leading-relaxed">
                <b className="text-slate-900">{kpis.totalLeads.toLocaleString()} leads</b> —{' '}
                <b className={RR_TXT[rrBand(kpis.rr)]}>{pct(kpis.rr)} responded</b>,{' '}
                <b className="text-slate-900">{kpis.funded} funded</b> ({pct(kpis.fr)}) for{' '}
                <b className="text-slate-900">{formatCurrency(kpis.volume)}</b> in volume.{' '}
                {kpis.spend > 0 && <>Spent <b className="text-rose-600">{formatCurrency(kpis.spend)}</b>, earned back{' '}
                <b className="text-emerald-700">{formatCurrency(kpis.revenue)}</b> —{' '}
                <b className={kpis.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>{kpis.netProfit >= 0 ? '+' : ''}{formatCurrency(kpis.netProfit)} net</b>
                {kpis.roi != null && <> at <b className={kpis.roi >= 1 ? 'text-emerald-700' : 'text-red-600'}>{kpis.roi.toFixed(2)}× ROI</b></>}.{' '}</>}
                {kpis.optout > 0 && <>
                  <b className="text-slate-900">{kpis.optout}</b> opted out ({pct(kpis.orate)})
                  {o7.timed > 0
                    ? <> — {o7.within} opted out within {o7.days} days of getting the lead ({(100 * o7.within / (kpis.totalLeads || 1)).toFixed(1)}% of all leads{o7.coverage < 99.5 ? `, floor — ${o7.timed}/${o7.optouts} timed` : ''}).</>
                    : <span className="text-slate-400"> — no opt-out timing logged yet.</span>}
                </>}
              </p>
              {(ins.bestRoi || ins.topNet || ins.bestResponse || ins.worstRoi) && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {ins.bestRoi && (
                    <span className="text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full px-2.5 py-0.5">
                      🏆 <b>Best performer: {ins.bestRoi.source}</b> · {ins.bestRoi.roi?.toFixed(2)}× ROI ({formatCurrency(ins.bestRoi.spend)} → {formatCurrency(ins.bestRoi.revenue)})
                    </span>
                  )}
                  {ins.topNet && ins.topNet.source !== ins.bestRoi?.source && (
                    <span className="text-[11px] bg-emerald-50/60 border border-emerald-200 text-emerald-800 rounded-full px-2.5 py-0.5">
                      Biggest earner: <b>{ins.topNet.source}</b> · +{formatCurrency(ins.topNet.netProfit)} net
                    </span>
                  )}
                  {ins.bestResponse && (
                    <span className="text-[11px] bg-blue-50 border border-blue-200 text-blue-800 rounded-full px-2.5 py-0.5">
                      Best response: <b>{ins.bestResponse.source}</b> · {pct(ins.bestResponse.rr)}
                    </span>
                  )}
                  {ins.worstRoi && (
                    <span className="text-[11px] bg-red-50 border border-red-200 text-red-700 rounded-full px-2.5 py-0.5">
                      Underwater: <b>{ins.worstRoi.source}</b> · {ins.worstRoi.roi?.toFixed(2)}×
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-7 gap-2.5">
            <RKpi label={scope === 'All' ? 'Total leads' : 'Purchased leads'} value={kpis.totalLeads.toLocaleString()} />
            <RKpi label="Responded" value={pct(kpis.rr)} sub={`${kpis.responded} leads`} valueClass={RR_TXT[rrBand(kpis.rr)]} />
            <RKpi label="No response" value={pct(kpis.crate)} sub={`${kpis.cold} leads`} />
            <RKpi label="Opted out / DND" value={pct(kpis.orate)} sub={`${kpis.optout} leads`} />
            <RKpi label="Fast opt-outs" value={o7.timed > 0 ? `${(100 * o7.within / (kpis.totalLeads || 1)).toFixed(1)}%` : '—'}
              sub={o7.timed > 0 ? `${o7.within}/${kpis.totalLeads} ≤ ${o7.days}d · ${o7.timed}/${o7.optouts} timed` : 'no timing yet'} />
            <RKpi label="Active escrows" value={kpis.active.toLocaleString()} valueClass="text-amber-600" />
            <RKpi label="Funded" value={kpis.funded.toLocaleString()} sub={`${pct(kpis.fr)} · ${formatCurrency(kpis.volume)}`} tone="good" />
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5 mt-2.5">
            <RKpi label="Spend" value={kpis.spend > 0 ? formatCurrency(kpis.spend) : '—'} sub={kpis.retainer > 0 ? 'leads + retainers' : 'lead prices'} valueClass="text-rose-600" />
            <RKpi label="Revenue" value={kpis.revenue > 0 ? formatCurrency(kpis.revenue) : '—'} sub="comp on funded only" valueClass="text-emerald-700" />
            <RKpi label="Net profit" value={(kpis.revenue > 0 || kpis.spend > 0) ? formatCurrency(kpis.netProfit) : '—'} tone={kpis.netProfit >= 0 ? 'good' : 'bad'} />
            <RKpi label="ROI" value={roiFmt(kpis.roi)} sub={kpis.roi != null ? `$${kpis.roi.toFixed(2)} back per $1` : undefined} tone={kpis.roi != null && kpis.roi >= 1 ? 'good' : kpis.roi != null ? 'bad' : undefined} />
            <RKpi label="Cost / funded" value={kpis.costPerFunded != null ? formatCurrency(kpis.costPerFunded) : '—'} sub={kpis.avgComp != null ? `vs ${formatCurrency(kpis.avgComp)} avg comp` : undefined} tone="hl" />
          </div>
        </Section>

        {/* Lifecycle funnel */}
        <Section title="Lead lifecycle">
          <div className="space-y-1.5">
            {stages.map((s, i) => {
              const prev = stages[i - 1]
              const stepConv = prev && prev.n > 0 ? (100 * s.n) / prev.n : null
              return (
                <React.Fragment key={s.key}>
                  {stepConv != null && (
                    <div className="pl-[140px] text-[10px] text-slate-400">↳ <b className="text-slate-600">{stepConv.toFixed(1)}%</b> of the stage above</div>
                  )}
                  <div className="grid grid-cols-[140px_1fr_150px] items-center gap-3">
                    <span className="text-xs font-bold text-slate-600">{s.label}<span className="block text-[10px] font-medium text-slate-400">{s.sub}</span></span>
                    <div className="bg-slate-100 rounded h-6 overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${Math.max(0.5, s.pctOfLeads)}%`, background: FUNNEL_BG[i] ?? '#4f46e5' }} />
                    </div>
                    <span className="text-xs text-right text-slate-500 tabular-nums"><b className="text-slate-800 text-[13px]">{s.n.toLocaleString()}</b> · {s.pctOfLeads.toFixed(1)}%</span>
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </Section>

        {/* Monthly trend — CSS bars, deterministic in print */}
        {monthly.length > 1 && (
          <Section title="Spend vs revenue by month">
            <div className="flex items-center gap-4 text-[11px] text-slate-600 mb-2">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-600 inline-block" /> Spend</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" /> Revenue</span>
              {retainerPerMonth > 0 && <span className="text-slate-400">incl. {formatCurrency(retainerPerMonth)}/mo retainers</span>}
            </div>
            <div className="flex items-end gap-2 h-44 border-b border-slate-200 pb-px overflow-x-auto">
              {monthly.map(p => (
                <div key={p.key} className="flex-1 min-w-[44px] flex flex-col items-center justify-end gap-1 h-full" title={`${p.label}: spend ${formatCurrency(p.spend)} · revenue ${formatCurrency(p.revenue)}`}>
                  <div className="flex items-end gap-1 w-full justify-center h-full">
                    <div className="w-[38%] max-w-[30px] rounded-t bg-rose-600" style={{ height: `${(p.spend / maxMonthVal) * 100}%` }} />
                    <div className="w-[38%] max-w-[30px] rounded-t bg-emerald-600" style={{ height: `${(p.revenue / maxMonthVal) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-1.5 overflow-x-auto">
              {monthly.map(p => (
                <div key={p.key} className="flex-1 min-w-[44px] text-center">
                  <div className="text-[10px] text-slate-500">{p.label}</div>
                  <span className={`inline-block mt-0.5 px-1 py-px rounded text-[10px] font-bold tabular-nums ${
                    p.roi == null ? 'bg-slate-100 text-slate-400' : p.roi >= 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                  }`}>{p.roi == null ? '—' : p.roi.toFixed(2) + '×'}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Source table */}
        <Section title="Per lead source">
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wide text-slate-500 bg-slate-50 border-b-2 border-slate-200">
                  <Th left>Source</Th><Th>Leads</Th><Th>Resp %</Th><Th>Opt-out</Th>
                  <Th>Open</Th><Th>Active</Th><Th>Lost</Th><Th>Funded</Th><Th>Fund %</Th>
                  <Th>Volume</Th><Th>Spend</Th><Th>Revenue</Th><Th>Net</Th><Th>ROI</Th>
                </tr>
              </thead>
              <tbody>
                {visibleSources.map(s => (
                  <tr key={s.source} className="border-b border-slate-100 last:border-0">
                    <Td left bold>{s.source}</Td>
                    <Td>{s.total}</Td>
                    <Td className={`font-semibold ${RR_TXT[rrBand(s.rr)]}`}>{pct(s.rr)}</Td>
                    <Td dim>{s.optout ? `${s.optout} · ${pct(s.orate)}` : '—'}</Td>
                    <Td dim>{s.open || '—'}</Td>
                    <Td className={s.active ? 'text-amber-600 font-semibold' : 'text-slate-300'}>{s.active || '—'}</Td>
                    <Td dim>{s.lost || '—'}</Td>
                    <Td bold>{s.funded || '—'}</Td>
                    <Td dim>{pct(s.fr)}</Td>
                    <Td>{s.fundedVolume > 0 ? formatCurrency(s.fundedVolume) : '—'}</Td>
                    <Td className="text-rose-600">{s.spend > 0 ? formatCurrency(s.spend) : '—'}</Td>
                    <Td className="text-emerald-700">{s.revenue > 0 ? formatCurrency(s.revenue) : '—'}</Td>
                    <Td bold className={(s.revenue === 0 && s.spend === 0) ? 'text-slate-300' : s.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                      {(s.revenue === 0 && s.spend === 0) ? '—' : formatCurrency(s.netProfit)}
                    </Td>
                    <Td bold className={s.roi == null ? 'text-slate-300' : s.roi >= 1 ? 'text-emerald-700' : 'text-red-600'}>{roiFmt(s.roi)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-extrabold bg-slate-50 border-t-2 border-slate-200">
                  <Td left bold>Total</Td>
                  <Td>{kpis.totalLeads}</Td>
                  <Td className={RR_TXT[rrBand(kpis.rr)]}>{pct(kpis.rr)}</Td>
                  <Td>{kpis.optout} · {pct(kpis.orate)}</Td>
                  <Td>{visibleSources.reduce((a, s) => a + s.open, 0)}</Td>
                  <Td>{kpis.active}</Td>
                  <Td>{visibleSources.reduce((a, s) => a + s.lost, 0)}</Td>
                  <Td>{kpis.funded}</Td>
                  <Td>{pct(kpis.fr)}</Td>
                  <Td>{formatCurrency(kpis.volume)}</Td>
                  <Td className="text-rose-600">{kpis.spend > 0 ? formatCurrency(kpis.spend) : '—'}</Td>
                  <Td className="text-emerald-700">{kpis.revenue > 0 ? formatCurrency(kpis.revenue) : '—'}</Td>
                  <Td className={kpis.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>{(kpis.revenue > 0 || kpis.spend > 0) ? formatCurrency(kpis.netProfit) : '—'}</Td>
                  <Td className={kpis.roi == null ? '' : kpis.roi >= 1 ? 'text-emerald-700' : 'text-red-600'}>{roiFmt(kpis.roi)}</Td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>

        {/* States + donut */}
        <div className="grid sm:grid-cols-2 gap-8 mt-7">
          <div>
            <SectionHead title="Per state" />
            <div className="space-y-1">
              {states.slice(0, 8).map((r, i) => {
                const max = states[0]?.n || 1
                return (
                  <div key={r.state} className="grid grid-cols-[40px_1fr_150px] items-center gap-2.5">
                    <span className={`text-xs font-bold ${i > 5 ? 'text-slate-400' : 'text-slate-600'}`}>{r.state}</span>
                    <div className="bg-slate-100 rounded h-3.5"><div className="h-full rounded bg-sky-700" style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }} /></div>
                    <span className="text-[11px] text-slate-500 text-right tabular-nums"><b className="text-slate-800">{r.n}</b> leads · {r.funded} funded</span>
                  </div>
                )
              })}
              {states.length > 8 && <p className="text-[10px] text-slate-400 pt-1">+ {states.length - 8} more states in the CSV export</p>}
            </div>
          </div>
          {donutTotal > 0 && (
            <div>
              <SectionHead title="Funded share" />
              <div className="flex items-center gap-5 flex-wrap">
                <svg width="140" height="140" viewBox="0 0 160 160" role="img" aria-label="Share of funded loans by source">
                  <g transform="rotate(-90 80 80)" fill="none" strokeWidth="24">
                    {donutSegs.map(s => (
                      <circle key={s.name} cx="80" cy="80" r="60" stroke={s.color}
                        strokeDasharray={`${s.len} ${C}`} strokeDashoffset={s.offset} />
                    ))}
                  </g>
                  <text x="80" y="78" textAnchor="middle" fontSize="26" fontWeight="800" fill="#0f172a">{donutTotal}</text>
                  <text x="80" y="96" textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="1" fill="#94a3b8">FUNDED</text>
                </svg>
                <div className="flex-1 min-w-[150px] space-y-1.5">
                  {donutSegs.map(s => (
                    <div key={s.name} className="flex items-center gap-2 text-xs">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                      <span className="flex-1 truncate text-slate-700">{s.name}</span>
                      <span className="tabular-nums font-bold text-slate-800">{s.funded}</span>
                      <span className="tabular-nums text-slate-400 w-9 text-right">{donutTotal > 0 ? Math.round((s.funded / donutTotal) * 100) : 0}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Projection */}
        {proj.activeCount > 0 && (
          <Section title="Projection">
            <div className="border border-violet-200 rounded-xl overflow-hidden">
              <div className="bg-violet-50 px-4 py-2.5 flex items-baseline justify-between gap-2 flex-wrap">
                <span className="text-[13px] font-extrabold text-violet-700">If all {proj.activeCount} active loans fund</span>
                <span className="text-[11px] text-slate-500 tabular-nums">adds {formatCurrency(proj.addComp)} projected comp{proj.estimatedCount > 0 ? ` · ${proj.estimatedCount} estimated at the ${formatCurrency(proj.avgComp)} average` : ''}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3.5 tabular-nums">
                {[
                  { l: 'Funded', a: kpis.funded.toLocaleString(), b: proj.projFunded.toLocaleString() },
                  { l: 'Conversion', a: pct(kpis.fr), b: proj.projConversion.toFixed(1) + '%' },
                  { l: 'Revenue', a: formatCurrency(kpis.revenue), b: formatCurrency(proj.projRevenue) },
                  { l: 'Net profit', a: formatCurrency(kpis.netProfit), b: formatCurrency(proj.projNetProfit) },
                  { l: 'ROI', a: roiFmt(kpis.roi), b: roiFmt(proj.projRoi) },
                ].map(x => (
                  <div key={x.l}>
                    <div className="text-[9.5px] font-bold uppercase tracking-wider text-slate-400">{x.l}</div>
                    <div className="mt-0.5 text-[12px] text-slate-400">{x.a} <span className="text-slate-300 px-0.5">→</span> <span className="text-[16px] font-extrabold text-emerald-700">{x.b}</span></div>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2 text-[10px] text-slate-400 border-t border-violet-100">
                Hypothetical — adds each active loan&apos;s Arive compensation to revenue with spend unchanged. Not a forecast of close probability.
              </div>
            </div>
          </Section>
        )}

        {/* Funded loans */}
        {fundedList.length > 0 && (
          <Section title="Funded loans in range">
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wide text-slate-500 bg-slate-50 border-b-2 border-slate-200">
                    <Th left>Borrower</Th><Th left>Source</Th><Th>Funded</Th><Th>Loan amount</Th><Th>Comp</Th>
                  </tr>
                </thead>
                <tbody>
                  {fundedList.slice(0, 40).map(d => (
                    <tr key={d.id} className="border-b border-slate-100 last:border-0">
                      <Td left bold>{d.name || '(no name)'}</Td>
                      <Td left dim>{(d.source ?? '').trim() || '—'}</Td>
                      <Td dim>{fmtDate(d.funded_date)}</Td>
                      <Td>{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</Td>
                      <Td className="text-emerald-700">{d.compensation_amount ? formatCurrency(d.compensation_amount) : '—'}</Td>
                    </tr>
                  ))}
                  {fundedList.length > 40 && (
                    <tr><td colSpan={5} className="px-3 py-2 text-center text-[11px] text-slate-400">… {fundedList.length - 40} more (see the dashboard)</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="font-extrabold bg-slate-50 border-t-2 border-slate-200">
                    <Td left bold>Total ({fundedList.length})</Td><Td left> </Td><Td> </Td>
                    <Td>{formatCurrency(fundedList.reduce((a, d) => a + (d.loan_amount ?? 0), 0))}</Td>
                    <Td className="text-emerald-700">{formatCurrency(fundedList.reduce((a, d) => a + (d.compensation_amount ?? 0), 0))}</Td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Section>
        )}

        {/* Methodology */}
        <Section title="Definitions">
          <div className="text-[11px] text-slate-500 leading-relaxed space-y-1">
            <p><b className="text-slate-700">Responded</b> — engaged at least once; Ghosted counts. <b className="text-slate-700">Opted out / DND</b> is its own bucket (shown as count · % of that source&apos;s leads). <b className="text-slate-700">Fast opt-outs (≤7d)</b> — the share of ALL leads whose first logged opt-out fell within 7 days of lead creation. A floor: only opt-outs with a logged timestamp count (forward-only stage log), so the coverage is shown. <b className="text-slate-700">Funded</b> — Loan Funded / Broker Check Received / Loan Finalized; funded loans anchor on funded date, everything else on the date the lead was added.</p>
            <p><b className="text-slate-700">Spend</b> — Σ per-lead price (GHL) + flat monthly retainers × months in range. <b className="text-slate-700">Revenue</b> — Σ Arive compensation on funded loans only. <b className="text-slate-700">Net profit</b> = revenue − spend. <b className="text-slate-700">ROI</b> — revenue ÷ spend as a multiple ($ back per $1).</p>
            <p>Purchased scope covers {PURCHASED_SOURCES.join(', ')}. Stats are per-LO — this report is {lo} only.</p>
          </div>
        </Section>

        <div className="mt-7 pt-3.5 border-t border-slate-200 flex justify-between gap-2 flex-wrap text-[10px] text-slate-400">
          <span>Lumin Lending · Lead ROI Report · live from the Lumin pipeline</span>
          <span>lead price coverage ~84% — money columns understate price-less leads</span>
        </div>
      </div>
    </div>
  )
}

function SectionHead({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <h2 className="text-[11.5px] font-extrabold uppercase tracking-[0.09em] text-slate-500 whitespace-nowrap">{title}</h2>
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  )
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <SectionHead title={title} />
      {children}
    </section>
  )
}
function RKpi({ label, value, sub, tone, valueClass }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'hl'; valueClass?: string
}) {
  const box =
    tone === 'good' ? 'border-emerald-200 bg-emerald-50/60' :
    tone === 'bad'  ? 'border-red-200 bg-red-50/60'         :
    tone === 'hl'   ? 'border-indigo-200 bg-indigo-50/60'   : 'border-slate-200 bg-white'
  const txt = valueClass ?? (
    tone === 'good' ? 'text-emerald-700' :
    tone === 'bad'  ? 'text-red-600'     :
    tone === 'hl'   ? 'text-indigo-700'  : 'text-slate-900')
  return (
    <div className={`border rounded-lg px-3 py-2 ${box}`}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-[19px] font-extrabold tabular-nums mt-0.5 ${txt}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 tabular-nums">{sub}</div>}
    </div>
  )
}
function Th({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return <th className={`px-2 py-2 font-bold whitespace-nowrap ${left ? 'text-left' : 'text-right'}`}>{children}</th>
}
function Td({ children, left, bold, dim, className }: {
  children: React.ReactNode; left?: boolean; bold?: boolean; dim?: boolean; className?: string
}) {
  return (
    <td className={`px-2 py-1.5 tabular-nums whitespace-nowrap ${left ? 'text-left' : 'text-right'} ${bold ? 'font-bold text-slate-800' : ''} ${dim ? 'text-slate-400' : ''} ${className ?? ''}`}>
      {children}
    </td>
  )
}
