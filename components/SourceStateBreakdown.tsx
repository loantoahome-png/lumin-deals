'use client'

/**
 * One lead source, every state it bought in, every metric from the /lead-roi source
 * table. Extracted from app/lead-roi/page.tsx (which was past 1,600 lines) so the
 * component can be rendered in isolation — the page itself cannot be checked locally
 * because `deals` RLS rejects anon reads under the auth-bypass dev server.
 */

import React, { useMemo, useState } from 'react'
import { ChevronDown, MapPin } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { rrBand } from '@/lib/leadReport'
import { stateStats, LO_SPLIT, type SourceStats } from '@/lib/leadRoi'

const pct = (x: number) => x.toFixed(1) + '%'
const SPLIT_LABEL = `${(LO_SPLIT * 100).toFixed(LO_SPLIT * 100 % 1 === 0 ? 0 : 1)}%`
const RR_PILL: Record<'good' | 'mid' | 'bad', string> = {
  good: 'bg-emerald-50 text-emerald-700', mid: 'bg-amber-50 text-amber-700', bad: 'bg-red-50 text-red-600',
}

/** One lead source, EVERY state it bought in, EVERY metric from the source table.
 *
 *  The Source × state matrix answers "one metric across all sources"; this answers the
 *  other half — "one source, everything" — which is what you need to decide whether to
 *  keep buying a vendor in a given state. Tabs switch sources.
 *
 *  ⚠️ The tab strip has to survive BOTH scopes. Under "Agg leads" each LO has 5–6
 *  sources and they all fit; under "All sources" Randy has 37 (measured 2026-09-21), so
 *  the biggest MAX_TABS render as tabs and the rest fall into a "More" dropdown. Don't
 *  swap this for a plain strip without re-checking that number. */
const MAX_TABS = 6

export default function SourceStateBreakdown({ sources, selected, onSelect }: {
  sources: SourceStats[]
  selected: SourceStats
  onSelect: (source: string) => void
}) {
  const [showMore, setShowMore] = useState(false)
  // `sources` arrives sorted by lead count desc. Show the biggest as tabs — but if the
  // overflow would hold a single source, just show them all rather than a "More (1)".
  const allFit = sources.length <= MAX_TABS + 1
  const tabs = allFit ? sources : sources.slice(0, MAX_TABS)
  const overflow = allFit ? [] : sources.slice(MAX_TABS)
  // A source picked from the dropdown gets pinned into the strip, so the active tab is
  // always visible instead of hiding inside "More".
  const selectedInOverflow = overflow.some(s => s.source === selected.source)
  const rows = useMemo(() => stateStats(selected.deals, selected.retainer), [selected])

  // ⚠️ The card deliberately has NO `overflow-hidden`. The "More" dropdown is
  // absolutely positioned inside it, and clipping made the button silently dead — the
  // menu rendered with a real 220×178 box and was invisible, exactly in the 37-source
  // case the dropdown exists for. Round the child edges instead.
  return (
    <div className="mt-6 bg-white border border-slate-200 rounded-xl">
      <div className="px-4 py-3 border-b border-slate-200 rounded-t-xl">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-800">One source, every state</h3>
          <span className="text-[11px] text-slate-400">all metrics for {selected.source} across its {rows.length} state{rows.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {tabs.map(s => (
            <SourceTab key={s.source} stats={s} active={s.source === selected.source} onSelect={onSelect} />
          ))}
          {selectedInOverflow && (
            <SourceTab stats={selected} active onSelect={onSelect} />
          )}
          {overflow.length > 0 && (
            <div className="relative">
              <button onClick={() => setShowMore(v => !v)}
                className="px-2.5 py-1.5 rounded-md text-xs font-semibold border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1">
                More ({overflow.length}) <ChevronDown className="w-3 h-3" />
              </button>
              {showMore && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowMore(false)} />
                  <div className="absolute left-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 max-h-72 overflow-y-auto min-w-[220px]">
                    {overflow.map(s => (
                      <button key={s.source}
                        onClick={() => { onSelect(s.source); setShowMore(false) }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center justify-between gap-3 ${
                          s.source === selected.source ? 'text-indigo-700 font-semibold' : 'text-slate-700'
                        }`}>
                        <span className="truncate">{s.source}</span>
                        <span className="tabular-nums text-slate-400 shrink-0">{s.total}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              <th className="px-3 py-2 sticky left-0 bg-slate-50 z-10">State</th>
              <th className="px-2 py-2 text-right">Leads</th>
              <th className="px-2 py-2 text-right border-l border-slate-200" title="Engaged at least once — Ghosted counts">Resp %</th>
              <th className="px-2 py-2 text-right" title="CUSTOMER opt-outs only: STOP · DND-SMS">Opt-out</th>
              <th className="px-2 py-2 text-right border-l border-slate-200" title="An application was taken — an Arive file exists">App %</th>
              <th className="px-2 py-2 text-right" title="Reached underwriting — status at or past 'Submitted to UW'">Sub %</th>
              <th className="px-2 py-2 text-right border-l border-slate-200">Open</th>
              <th className="px-2 py-2 text-right">Active</th>
              <th className="px-2 py-2 text-right">Lost</th>
              <th className="px-2 py-2 text-right">Funded</th>
              <th className="px-2 py-2 text-right">Fund %</th>
              <th className="px-2 py-2 text-right">Volume</th>
              <th className="px-2 py-2 text-right border-l border-slate-200">Spend</th>
              <th className="px-2 py-2 text-right" title="Gross comp on funded, before the LO split">Revenue</th>
              <th className="px-2 py-2 text-right" title={`Revenue × ${SPLIT_LABEL} — the LO's share`}>Net rev</th>
              <th className="px-2 py-2 text-right" title="Net revenue − Spend">Net</th>
              <th className="px-3 py-2 text-right" title="Net revenue ÷ Spend">ROI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={r.state} className={i % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'}>
                <td className={`px-3 py-2 font-semibold text-slate-700 sticky left-0 z-10 ${i % 2 === 1 ? 'bg-slate-50' : 'bg-white'}`}>{r.state}</td>
                <td className="px-2 py-2 text-right tabular-nums font-medium text-slate-700">{r.n}</td>
                <td className="px-2 py-2 text-right border-l border-slate-200">
                  <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums ${RR_PILL[rrBand(r.rr)]}`}>{pct(r.rr)}</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-400">
                  {r.optout ? <>{r.optout} <span className="text-slate-300">·</span> <span className="text-[11px] font-medium text-slate-500">{pct(r.orate)}</span></> : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2 text-right border-l border-slate-200">
                  {r.applied > 0
                    ? <span className="inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums bg-sky-50 text-sky-700">{pct(r.ar)}</span>
                    : <span className="tabular-nums text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2 text-right">
                  {r.submitted > 0
                    ? <span className="inline-block px-1.5 py-0.5 rounded-md text-xs font-semibold tabular-nums bg-indigo-50 text-indigo-700">{pct(r.sr)}</span>
                    : <span className="tabular-nums text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-400 border-l border-slate-200">{r.open || <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.active ? <span className="text-amber-700 font-medium">{r.active}</span> : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-400">{r.lost || <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right">
                  {r.funded > 0
                    ? <span className="inline-flex items-center justify-center min-w-[1.6rem] px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-semibold tabular-nums">{r.funded}</span>
                    : <span className="tabular-nums text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-500">{pct(r.fr)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-700">{r.fundedVolume > 0 ? formatCurrency(r.fundedVolume) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums text-rose-600 border-l border-slate-200">{r.spend > 0 ? formatCurrency(r.spend) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-500">{r.revenue > 0 ? formatCurrency(r.revenue) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums text-emerald-700 font-medium">{r.netRevenue > 0 ? formatCurrency(r.netRevenue) : <span className="text-slate-300">—</span>}</td>
                <td className={`px-2 py-2 text-right tabular-nums font-semibold ${
                  (r.revenue === 0 && r.spend === 0) ? 'text-slate-300' : r.netProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                }`}>{(r.revenue === 0 && r.spend === 0) ? '—' : formatCurrency(r.netProfit)}</td>
                <td className="px-3 py-2 text-right">
                  {r.roi == null
                    ? <span className="text-slate-300">—</span>
                    : <span className={`inline-block px-1.5 py-0.5 rounded-md text-xs font-bold tabular-nums ${r.roi >= 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{r.roi.toFixed(2)}×</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[10.5px] text-slate-400 border-t border-slate-200 rounded-b-xl bg-white">
        Every state {selected.source} bought in — adds up to {selected.total} leads · {formatCurrency(selected.spend)} spend · {formatCurrency(selected.netProfit)} net, the same as its row in the table above.
        {selected.retainer > 0 && <> The {formatCurrency(selected.retainer)} retainer is billed per source, so it is split across states pro-rata by lead count.</>}
        {' '}<span className="font-semibold text-slate-500">(none)</span> is a lead with no state recorded.
      </p>
    </div>
  )
}

/** One tab in the source strip — name plus its lead count. */
function SourceTab({ stats, active, onSelect }: { stats: SourceStats; active: boolean; onSelect: (s: string) => void }) {
  return (
    <button onClick={() => onSelect(stats.source)}
      className={`px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 ${
        active ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
      }`}>
      {stats.source}
      <span className={`tabular-nums font-normal ${active ? 'text-indigo-200' : 'text-slate-400'}`}>{stats.total}</span>
    </button>
  )
}
