'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate, titleCase, cleanSource } from '@/lib/utils'
import { scoreFundedBook, PLAY_LABEL, DEFAULT_PAR, RadarDeal, RefiPlay, ParRates } from '@/lib/refiRadar'
import { findReturningClients, ReturningClient } from '@/lib/repeatReferral'
import Link from 'next/link'
import { RefreshCw, Ban, UserCheck } from 'lucide-react'

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

// Superset projection: refi scoring (RadarDeal) + returning-client detection
// (RepeatDeal) off one paged fetch of the whole book.
const RADAR_COLS = 'id, borrower_id, name, loan_type, rate, loan_amount, funded_date, estimated_value, current_balance, ltv, compensation_amount, dnd, last_contacted, pipeline_group, status, created_at, source, lead_price'
type RadarRow = RadarDeal & {
  status: string | null; created_at: string; source: string | null; lead_price: number | null
}

export default function RadarPage() {
  const [deals, setDeals] = useState<RadarRow[]>([])
  const [par, setPar] = useState<ParRates>(DEFAULT_PAR)
  const [draft, setDraft] = useState<ParRates>(DEFAULT_PAR)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [playFilter, setPlayFilter] = useState<'all' | RefiPlay>('all')

  const fetchData = useCallback(async () => {
    setLoading(true)
    const loadDeals = async () => {
      // Whole book, not just Funded — returning-client detection needs the person's
      // post-funding deals too. scoreFundedBook filters to Funded itself.
      const all: RadarRow[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('deals').select(RADAR_COLS)
          .order('id', { ascending: true }).range(from, from + 999)
        if (error) { console.error('[radar] fetch failed:', error.message); break }
        const rows = (data ?? []) as RadarRow[]
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

  // Returning clients — people with a funded loan who came back with a new deal.
  const returning = useMemo(() => findReturningClients(deals), [deals])
  const returningActive = useMemo(() => returning.filter(r => r.active), [returning])
  const returningDormant = useMemo(() => returning.filter(r => !r.active), [returning])
  const [showDormant, setShowDormant] = useState(false)

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
            <h1 className="text-xl font-bold text-slate-900">Opportunity Radar</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              <span className="font-semibold text-slate-800">{returningActive.length}</span> returning
              <span className="text-slate-300"> · </span>
              <span className="font-semibold text-slate-800">{actionable.length}</span> refi actionable
              {maturing > 0 && <span className="text-slate-400"> · {maturing} maturing (&lt;6mo)</span>}
            </p>
          </div>
          <button onClick={fetchData} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Par-rate config */}
        <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-400">Your par rates</div>
              <div className="text-xs text-slate-400 mt-0.5">Today&apos;s rate per product — each loan is scored against these.</div>
            </div>
            <button
              onClick={savePar}
              disabled={!parDirty || saving}
              className="text-xs font-semibold px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            {PAR_FIELDS.map(f => (
              <label key={f.k} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-slate-500">{f.label}</span>
                <div className="relative w-24">
                  <input
                    type="number" step="0.125" min="0" max="25"
                    value={draft[f.k]}
                    onChange={e => setDraft(prev => ({ ...prev, [f.k]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                    className="w-full pl-3 pr-7 py-2 text-sm border border-slate-200 rounded-md tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">%</span>
                </div>
              </label>
            ))}
          </div>
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
        {/* ── Returning clients ─────────────────────────────────────────── */}
        {!loading && returning.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <UserCheck className="w-4 h-4 text-violet-600" />
              <h2 className="text-sm font-semibold text-slate-800">
                Returning clients <span className="text-slate-400 font-normal">({returningActive.length} active)</span>
              </h2>
              {returningDormant.length > 0 && (
                <button
                  onClick={() => setShowDormant(v => !v)}
                  className="text-xs text-slate-400 hover:text-slate-600 ml-auto"
                >
                  {showDormant ? 'Hide' : 'Show'} {returningDormant.length} not currently active
                </button>
              )}
            </div>
            <div className="border border-violet-200 bg-violet-50/40 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-violet-100">
                    <th className="px-3 py-2">Client</th>
                    <th className="px-3 py-2">Funded history</th>
                    <th className="px-3 py-2">New deal</th>
                    <th className="px-3 py-2 text-right">Came back</th>
                  </tr>
                </thead>
                <tbody>
                  {(showDormant ? returning : returningActive).map(r => (
                    <ReturningRow key={r.borrowerId} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Refi candidates ───────────────────────────────────────────── */}
        {!loading && (
          <h2 className="text-sm font-semibold text-slate-800 mb-2">
            Refi candidates <span className="text-slate-400 font-normal">({actionable.length} actionable)</span>
          </h2>
        )}
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

function ReturningRow({ r }: { r: ReturningClient }) {
  const name = titleCase(r.name) || r.name || '(no name)'
  const src = cleanSource(r.newDeal.source)
  return (
    <tr className={`border-b border-violet-100 last:border-0 ${r.active ? 'bg-white' : 'bg-slate-50/60'}`}>
      <td className="px-3 py-2.5">
        <Link href={`/contacts/${r.borrowerId}`} className="font-medium text-blue-600 hover:text-blue-700">{name}</Link>
        {r.taggedReturn && (
          <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">tagged return</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-slate-600">
        {r.fundedCount} funded{r.totalFundedVolume > 0 && <> · {formatCurrency(r.totalFundedVolume)}</>}
        {r.lastFundedAt && <span className="text-slate-400"> · last {formatDate(r.lastFundedAt)}</span>}
      </td>
      <td className="px-3 py-2.5">
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
          r.active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
        }`}>
          {r.newDeal.status || r.newDeal.pipeline_group || '—'}
        </span>
        {src && <span className="ml-2 text-[11px] text-slate-400">{src}</span>}
        {r.newDeal.loan_amount != null && r.newDeal.loan_amount > 0 && (
          <span className="ml-2 text-[11px] text-slate-500 tabular-nums">{formatCurrency(r.newDeal.loan_amount)}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{formatDate(r.newDeal.created_at)}</td>
    </tr>
  )
}
