'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate, titleCase } from '@/lib/utils'
import { scoreFundedBook, PLAY_LABEL, DEFAULT_PAR, RadarDeal, RefiPlay, ParRates } from '@/lib/refiRadar'
import Link from 'next/link'
import { RefreshCw, Ban } from 'lucide-react'

const PLAY_PILL: Record<RefiPlay, string> = {
  'second-lien': 'bg-amber-100 text-amber-800',
  'first-lien':  'bg-blue-100 text-blue-700',
  'non-qm':      'bg-violet-100 text-violet-700',
  'fha-mip':     'bg-slate-100 text-slate-600',
  'va-irrrl':    'bg-teal-100 text-teal-700',
}
const PAR_FIELDS: { k: keyof ParRates; label: string }[] = [
  { k: 'conv', label: 'Conv' }, { k: 'fha', label: 'FHA' }, { k: 'va', label: 'VA' }, { k: 'nonqm', label: 'Non-QM' },
]

const RADAR_COLS = 'id, borrower_id, name, loan_type, rate, loan_amount, funded_date, estimated_value, current_balance, ltv, compensation_amount, dnd, last_contacted, pipeline_group'

export default function RadarPage() {
  const [deals, setDeals] = useState<RadarDeal[]>([])
  const [par, setPar] = useState<ParRates>(DEFAULT_PAR)
  const [draft, setDraft] = useState<ParRates>(DEFAULT_PAR)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [playFilter, setPlayFilter] = useState<'all' | RefiPlay>('all')

  const fetchData = useCallback(async () => {
    setLoading(true)
    const loadDeals = async () => {
      const all: RadarDeal[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('deals').select(RADAR_COLS).eq('pipeline_group', 'Funded')
          .order('id', { ascending: true }).range(from, from + 999)
        if (error) { console.error('[radar] fetch failed:', error.message); break }
        const rows = (data ?? []) as RadarDeal[]
        all.push(...rows)
        if (rows.length < 1000) break
      }
      return all
    }
    const loadPar = async (): Promise<ParRates> => {
      try {
        const res = await fetch('/api/radar/par-rates', { cache: 'no-store' })
        const j = await res.json() as { ok: boolean; par?: ParRates }
        return j.ok && j.par ? j.par : DEFAULT_PAR
      } catch { return DEFAULT_PAR }
    }
    const [d, p] = await Promise.all([loadDeals(), loadPar()])
    setDeals(d); setPar(p); setDraft(p); setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const candidates = useMemo(() => scoreFundedBook(deals, par), [deals, par])
  const actionable = useMemo(() => candidates.filter(c => c.eligible), [candidates])
  const maturing = useMemo(() => candidates.filter(c => c.tooNew).length, [candidates])

  const playCounts = useMemo(() => {
    const m: Record<string, number> = { all: actionable.length }
    for (const c of actionable) m[c.play] = (m[c.play] ?? 0) + 1
    return m
  }, [actionable])
  const playsPresent = useMemo(
    () => (['second-lien', 'first-lien', 'non-qm', 'fha-mip', 'va-irrrl'] as RefiPlay[]).filter(p => (playCounts[p] ?? 0) > 0),
    [playCounts],
  )
  const rows = playFilter === 'all' ? actionable : actionable.filter(c => c.play === playFilter)

  const parDirty = PAR_FIELDS.some(f => draft[f.k] !== par[f.k])
  const savePar = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/radar/par-rates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      })
      const j = await res.json() as { ok: boolean; par?: ParRates }
      if (j.ok && j.par) { setPar(j.par); setDraft(j.par) }
    } catch { /* no-op */ } finally { setSaving(false) }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Refi Radar</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              <span className="font-semibold text-slate-800">{actionable.length}</span> actionable
              {maturing > 0 && <span className="text-slate-400"> · {maturing} maturing (&lt;6mo)</span>}
            </p>
          </div>
          <button onClick={fetchData} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Par-rate config */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <span className="text-[11px] uppercase tracking-wide text-slate-400">Your par rates</span>
          {PAR_FIELDS.map(f => (
            <label key={f.k} className="flex items-center gap-1.5 text-sm text-slate-600">
              {f.label}
              <div className="relative">
                <input
                  type="number" step="0.125" min="0" max="25"
                  value={draft[f.k]}
                  onChange={e => setDraft(prev => ({ ...prev, [f.k]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                  className="w-16 pl-2 pr-5 py-1 text-sm border border-slate-200 rounded-md tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">%</span>
              </div>
            </label>
          ))}
          <button
            onClick={savePar}
            disabled={!parDirty || saving}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* Play filter */}
        <div className="flex items-center gap-1 mt-3 flex-wrap">
          {(['all', ...playsPresent] as const).map(p => (
            <button
              key={p}
              onClick={() => setPlayFilter(p)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                playFilter === p ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {p === 'all' ? 'All' : PLAY_LABEL[p]} <span className={playFilter === p ? 'text-slate-300' : 'text-slate-400'}>({playCounts[p] ?? 0})</span>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">
            No actionable refi candidates{playFilter !== 'all' ? ' for this play' : ''}. Adjust your par rates above, or
            check back as more loans season past 6 months{maturing > 0 ? ` (${maturing} maturing now)` : ''}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Play</th>
                <th className="px-3 py-2">Why now</th>
                <th className="px-3 py-2 text-right">Seasoned</th>
                <th className="px-3 py-2 text-right">Est. saving</th>
                <th className="px-3 py-2 text-right">Comp</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => {
                const href = c.deal.borrower_id ? `/contacts/${c.deal.borrower_id}` : `/deals/${c.deal.id}`
                const name = titleCase(c.deal.name) || c.deal.name || '(no name)'
                return (
                  <tr key={c.deal.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Link href={href} className="font-medium text-blue-600 hover:text-blue-700">{name}</Link>
                        {c.deal.dnd && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200" title="Do Not Contact">
                            <Ban className="w-2.5 h-2.5" /> DND
                          </span>
                        )}
                      </div>
                      {c.deal.last_contacted && (
                        <span className="text-[11px] text-slate-400">Last contact {formatDate(c.deal.last_contacted)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${PLAY_PILL[c.play]}`}>{PLAY_LABEL[c.play]}</span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 max-w-[360px]">{c.reason}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{c.monthsSeasoned != null ? `${c.monthsSeasoned}mo` : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {c.estMonthly != null
                        ? <span className="text-emerald-700 font-medium">~{formatCurrency(c.estMonthly)}/mo</span>
                        : c.needsEquity
                          ? <span className="text-slate-400">needs equity</span>
                          : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                      {c.deal.compensation_amount && c.deal.compensation_amount > 0 ? formatCurrency(c.deal.compensation_amount) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
