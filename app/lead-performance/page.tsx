'use client'

/**
 * Lead Performance — the purchased-lead response funnel, live.
 *
 * The dashboard version of the "Purchased Lead Performance Report" PDF:
 *   • Purchased (vendor) leads ONLY — warm/organic excluded.
 *   • Responded = engaged at least once; Ghosted counts as responded.
 *   • Opted-out / DND shown as its own bucket (not folded into responded).
 *   • Breakdown per lead source and per state, switchable by loan officer.
 *
 * All aggregation lives in lib/leadReport.ts (pure, fixture-tested).
 */

import { useEffect, useMemo, useState } from 'react'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import type { Deal } from '@/lib/types'
import {
  PURCHASED_SOURCES, segment, groupBy, sourceKey, stateKey, purchasedBook, rrBand,
  type LO, type Purpose, type Segment, type GroupRow,
} from '@/lib/leadReport'
import { RefreshCw, Download, Target } from 'lucide-react'

const LEAD_COLS = 'id,loan_officer,pipeline_group,status,source,state,lead_price,compensation_amount,loan_purpose,date_added_ghl'
const LO_TABS: LO[] = ['All', 'Matt', 'Moe']
const PURPOSE_TABS: Purpose[] = ['All', 'Purchase', 'Refinance']

const pct = (x: number) => x.toFixed(1) + '%'
const money = (x: number | null) => (x == null ? '—' : '$' + Math.round(x).toLocaleString())
const roiFmt = (x: number | null) => (x == null ? '—' : x.toFixed(1) + '×')
// Profitable (≥1×) green, underwater (<1×) red, no-spend gray.
const roiColor = (x: number | null) => (x == null ? 'text-slate-400' : x >= 1 ? 'text-emerald-600' : 'text-red-600')
const RR_COLOR: Record<'good' | 'mid' | 'bad', string> = {
  good: 'text-emerald-600', mid: 'text-amber-600', bad: 'text-red-600',
}
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 min-w-[120px] bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${color ?? 'text-slate-900'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function LeadPerformancePage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [lo, setLo] = useState<LO>('All')
  const [purpose, setPurpose] = useState<Purpose>('All')

  async function load() {
    setLoading(true)
    const rows = await fetchAllDeals(q => q.order('id', { ascending: true }), LEAD_COLS)
    setDeals(rows)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const book = useMemo(() => purchasedBook(deals, lo, purpose), [deals, lo, purpose])
  const totals: Segment = useMemo(() => segment(book), [book])
  const bySource: GroupRow[] = useMemo(() => groupBy(book, sourceKey), [book])
  const byState: GroupRow[] = useMemo(() => groupBy(book, stateKey), [book])

  const dateWindow = useMemo(() => {
    const ds = book
      .map(b => (b as Deal).date_added_ghl)
      .filter(Boolean)
      .sort() as string[]
    return ds.length ? `${fmtDate(ds[0])} – ${fmtDate(ds[ds.length - 1])}` : null
  }, [book])

  function exportCSV() {
    const head = ['Group', 'Type', 'Bucket', 'Leads', 'Responded', 'Resp%', 'NoResp', 'OptOut', 'Funded', 'Fund%', 'Spend', 'Revenue', 'ROI']
    const line = (type: string, g: GroupRow) =>
      [type, type, g.key, g.n, g.responded, g.rr.toFixed(1), g.cold, g.optout, g.funded, g.fr.toFixed(1),
        Math.round(g.spend), Math.round(g.revenue), g.roi == null ? '' : g.roi.toFixed(2)].join(',')
    const rows = [
      head.join(','),
      ...bySource.map(g => line('Source', g)),
      ...byState.map(g => line('State', g)),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lead-performance-${lo.toLowerCase()}-${purpose.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-600" /> Lead Performance
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Purchased leads only · Ghosted counts as responded
              {purpose !== 'All' && <span className="text-blue-600 font-medium"> · {purpose}</span>}
              {dateWindow && <span className="text-slate-400"> · {dateWindow}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCSV} disabled={loading || !book.length}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
            <button onClick={load} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-12">LO</span>
            <div className="flex items-center gap-1">
              {LO_TABS.map(t => (
                <button key={t} onClick={() => setLo(t)}
                  className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                    lo === t ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}>
                  {t === 'All' ? 'Matt + Moe' : t === 'Matt' ? 'Matt Park' : 'Moe Sefati'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-12">Purpose</span>
            <div className="flex items-center gap-1">
              {PURPOSE_TABS.map(t => (
                <button key={t} onClick={() => setPurpose(t)}
                  className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                    purpose === t ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}>
                  {t === 'All' ? 'All purposes' : t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            {/* KPI cards */}
            <div className="flex flex-wrap gap-3">
              <Stat label="Purchased leads" value={totals.n.toLocaleString()} sub="vendor-bought" />
              <Stat label="Responded" value={pct(totals.rr)} sub={`${totals.responded} leads`} color={RR_COLOR[rrBand(totals.rr)]} />
              <Stat label="No response" value={pct(totals.crate)} sub={`${totals.cold} leads`} />
              <Stat label="Opted out / DND" value={pct(totals.orate)} sub={`${totals.optout} leads`} />
              <Stat label="Funded" value={pct(totals.fr)} sub={`${totals.funded} loans`} color="text-emerald-600" />
              <Stat label="Spend" value={money(totals.spend)} sub="lead cost" />
              <Stat label="Revenue" value={money(totals.revenue)} sub="comp earned" color="text-emerald-600" />
              <Stat label="ROI" value={roiFmt(totals.roi)} sub="revenue ÷ spend" color={roiColor(totals.roi)} />
            </div>

            {/* Methodology */}
            <details className="bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
              <summary className="cursor-pointer px-4 py-2.5 font-semibold text-slate-700 select-none">
                Definitions &amp; methodology
              </summary>
              <div className="px-4 pb-3 space-y-1.5">
                <p><b>Purchased only:</b> {PURCHASED_SOURCES.join(', ')}. Warm/organic (Self Source, Return Client, Referrals, Arive, Unknown) excluded.</p>
                <p><b>Responded:</b> engaged at least once. <b>Ghosted counts</b> — only New Lead / Attempted Contact / Non-Responsive are &ldquo;no response.&rdquo;</p>
                <p><b>Opted out / DND:</b> STOP, DND-SMS, Remove from All Automations — shown separately, not counted as responded.</p>
                <p><b>Funded:</b> Loan Funded / Broker Check Received / Loan Finalized.</p>
                <p><b>Revenue &amp; ROI — priced leads only:</b> revenue is broker compensation earned (Arive &ldquo;Compensation Amount&rdquo;) summed across leads that have a recorded lead price; <b>ROI</b> = revenue ÷ spend as a multiple (2.5× = $2.50 back per $1 of lead spend), &mdash; when there's no priced spend. Leads with no recorded price (~16%) are excluded from <i>both</i> sides so ROI isn't inflated by revenue with no matching cost. Revenue may therefore read slightly below your total earned comp.</p>
                <p><b>Purpose filter:</b> Purchase vs Refinance — <b>Refinance includes HELOCs</b> (a HELOC is an equity refinance). ~8% of leads are untagged and appear only under &ldquo;All purposes.&rdquo;</p>
                <p className="text-slate-400">Coverage: lead price on ~84% of leads (money columns use these only); state on ~90%; loan purpose on ~92%.</p>
              </div>
            </details>

            <BreakdownTable title="Per Lead Source" rows={bySource} keyHeader="Source" total={totals} showRevenueCols />
            <BreakdownTable title="Per State" rows={byState} keyHeader="State" total={totals} showRevenueCols />

            <p className="text-[11px] text-slate-400 pt-1">
              Response-rate color: <span className="text-emerald-600 font-semibold">≥28%</span> ·{' '}
              <span className="text-amber-600 font-semibold">20–28%</span> ·{' '}
              <span className="text-red-600 font-semibold">&lt;20%</span>. Live from the Lumin pipeline.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function BreakdownTable({
  title, rows, keyHeader, total, showRevenueCols,
}: { title: string; rows: GroupRow[]; keyHeader: string; total: Segment; showRevenueCols?: boolean }) {
  return (
    <div>
      <h2 className="text-sm font-bold text-slate-700 mb-2">{title}</h2>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400 bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-2 text-left">{keyHeader}</th>
              <th className="px-3 py-2 text-right">Leads</th>
              <th className="px-3 py-2 text-right">Resp.</th>
              <th className="px-3 py-2 text-right">Resp %</th>
              <th className="px-3 py-2 text-right">No Resp</th>
              <th className="px-3 py-2 text-right">Opt-out</th>
              <th className="px-3 py-2 text-right">Funded</th>
              <th className="px-3 py-2 text-right">Fund %</th>
              <th className="px-3 py-2 text-right">Spend</th>
              {showRevenueCols && <>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">ROI</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {rows.map(g => (
              <tr key={g.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-700">{g.key}</td>
                <td className="px-3 py-2 text-right tabular-nums">{g.n}</td>
                <td className="px-3 py-2 text-right tabular-nums">{g.responded}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${RR_COLOR[rrBand(g.rr)]}`}>{pct(g.rr)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{g.cold}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{g.optout}</td>
                <td className="px-3 py-2 text-right tabular-nums">{g.funded}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{pct(g.fr)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{money(g.spend)}</td>
                {showRevenueCols && <>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{money(g.revenue)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${roiColor(g.roi)}`}>{roiFmt(g.roi)}</td>
                </>}
              </tr>
            ))}
            <tr className="font-bold bg-slate-100 border-t-2 border-slate-300">
              <td className="px-3 py-2 text-slate-800">TOTAL</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.n}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.responded}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${RR_COLOR[rrBand(total.rr)]}`}>{pct(total.rr)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.cold}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.optout}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.funded}</td>
              <td className="px-3 py-2 text-right tabular-nums">{pct(total.fr)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(total.spend)}</td>
              {showRevenueCols && <>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{money(total.revenue)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${roiColor(total.roi)}`}>{roiFmt(total.roi)}</td>
              </>}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
