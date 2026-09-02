'use client'

/**
 * Import History — what each Arive import actually wrote.
 *
 * Reads the import log (supabase-import-log.sql) through /api/import/arive/history.
 * Pick a run → see every field written, grouped by field (click to filter) and
 * listed per deal with old → new. Answers "why did this number change after the
 * import?" without diffing CSVs in ~/Downloads. Preview runs are never logged.
 */

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { History, Download, Search, X, ChevronLeft, Loader2 } from 'lucide-react'
import type { ImportRunRow, ImportChangeRow } from '@/lib/importLog'

const CONSEQUENTIAL = new Set(['status', 'loan_officer', 'occupancy', 'loan_amount', 'compensation_amount', 'net_discount_points', 'broker_corr'])

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function fmt(v: string | null): string { return v == null || v === '' ? '—' : v }
function csvCell(s: string): string { return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

const ACTION_STYLE: Record<string, string> = {
  fill: 'bg-emerald-100 text-emerald-700',
  overwrite: 'bg-amber-100 text-amber-700',
  create: 'bg-blue-100 text-blue-700',
}

// useSearchParams needs a Suspense boundary for the static shell (Next build rule).
export default function ImportHistoryPage() {
  return <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}><ImportHistory /></Suspense>
}

function ImportHistory() {
  const params = useSearchParams()
  const router = useRouter()
  const runId = params.get('run')

  const [runs, setRuns] = useState<ImportRunRow[] | null>(null)
  const [run, setRun] = useState<ImportRunRow | null>(null)
  const [changes, setChanges] = useState<ImportChangeRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fieldFilter, setFieldFilter] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState<'all' | 'fill' | 'overwrite' | 'create'>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    const url = runId ? `/api/import/arive/history?run=${encodeURIComponent(runId)}` : '/api/import/arive/history'
    fetch(url).then(r => r.json()).then(d => {
      if (!alive) return
      if (!d.ok) { setError(d.error || 'load failed'); return }
      if (runId) { setRun(d.run); setChanges(d.changes) } else { setRuns(d.runs); setRun(null); setChanges(null) }
    }).catch(e => alive && setError(String(e))).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [runId])

  // Per-field counts for the selected run, split by action.
  const byField = useMemo(() => {
    const m = new Map<string, { fill: number; overwrite: number; create: number }>()
    for (const c of changes ?? []) {
      const e = m.get(c.field) ?? { fill: 0, overwrite: 0, create: 0 }
      e[c.action]++
      m.set(c.field, e)
    }
    return [...m.entries()].sort((a, b) => (b[1].fill + b[1].overwrite + b[1].create) - (a[1].fill + a[1].overwrite + a[1].create))
  }, [changes])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (changes ?? []).filter(c => {
      if (fieldFilter && c.field !== fieldFilter) return false
      if (actionFilter !== 'all' && c.action !== actionFilter) return false
      if (q && !(`${c.borrower ?? ''} ${c.arive_file_no ?? ''} ${c.field} ${c.old_value ?? ''} ${c.new_value ?? ''}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [changes, fieldFilter, actionFilter, query])

  // Group the visible changes by deal so one loan reads as one block.
  const grouped = useMemo(() => {
    const m = new Map<string, { borrower: string; arive: string | null; dealId: string | null; rows: ImportChangeRow[] }>()
    for (const c of visible) {
      const k = c.deal_id ?? `${c.borrower}|${c.arive_file_no}`
      const g = m.get(k) ?? { borrower: c.borrower ?? '(unknown)', arive: c.arive_file_no, dealId: c.deal_id, rows: [] }
      g.rows.push(c); m.set(k, g)
    }
    return [...m.values()]
  }, [visible])

  function downloadCsv() {
    if (!run || !changes) return
    const rows: string[][] = [['borrower', 'arive_file_no', 'deal_id', 'field', 'old_value', 'new_value', 'action']]
    for (const c of visible) rows.push([c.borrower ?? '', c.arive_file_no ?? '', c.deal_id ?? '', c.field, c.old_value ?? '', c.new_value ?? '', c.action])
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = `import-changes-${run.created_at.slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><History className="w-6 h-6 text-slate-500" /> Import History</h1>
          <p className="text-slate-500 text-sm mt-1">
            Every field an Arive import actually wrote — deal, field, old → new. Previews are not logged; only applied imports.
          </p>
        </div>
        <Link href="/import/arive" className="text-sm font-medium text-blue-600 hover:underline shrink-0">Import a CSV →</Link>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg p-3">{error}</div>}
      {loading && <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {/* ── Run list ─────────────────────────────────────────────────────── */}
      {!runId && runs && (
        runs.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
            No imports logged yet. The next import you apply on the Import page will show up here.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">When</th>
                  <th className="text-left px-4 py-2">File</th>
                  <th className="text-left px-4 py-2">Mode</th>
                  <th className="text-right px-4 py-2">Deals</th>
                  <th className="text-right px-4 py-2">Filled</th>
                  <th className="text-right px-4 py-2">Overwrote</th>
                  <th className="text-right px-4 py-2">New-loan fields</th>
                  <th className="text-right px-4 py-2">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/import/arive/history?run=${r.id}`)}
                      className="border-t border-slate-100 hover:bg-blue-50 cursor-pointer">
                    <td className="px-4 py-2 whitespace-nowrap text-slate-800">{fmtDate(r.created_at)}</td>
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[260px]" title={r.filename ?? ''}>{r.filename ?? '—'}</td>
                    <td className="px-4 py-2"><span className={`px-1.5 py-0.5 rounded text-xs ${r.mode === 'overwrite' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{r.mode}</span></td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.updated}{r.created > 0 && <span className="text-blue-700"> +{r.created} new</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-700">{r.fill_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-700">{r.overwrite_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-blue-700">{r.create_count}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${r.error_count ? 'text-red-700' : 'text-slate-400'}`}>{r.error_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── One run ──────────────────────────────────────────────────────── */}
      {runId && run && changes && (
        <>
          <Link href="/import/arive/history" className="text-sm text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"><ChevronLeft className="w-4 h-4" /> All imports</Link>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-semibold text-slate-900">{fmtDate(run.created_at)}</h2>
              <span className="text-sm text-slate-500 truncate" title={run.filename ?? ''}>{run.filename ?? 'no filename'}</span>
              <span className={`px-1.5 py-0.5 rounded text-xs ${run.mode === 'overwrite' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{run.mode}</span>
              {run.protected_fields?.length > 0 && <span className="text-xs text-slate-500">protected: {run.protected_fields.join(', ')}</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mt-4">
              <Metric label="Rows in CSV" value={run.rows_total} />
              <Metric label="Matched" value={run.matched} tone="emerald" />
              <Metric label="Deals updated" value={run.updated} />
              <Metric label="Filled blanks" value={run.fill_count} tone="blue" />
              <Metric label="Overwrote" value={run.overwrite_count} tone="amber" />
              <Metric label="New loans" value={run.created} />
            </div>
          </div>

          {/* By field — click to filter */}
          {byField.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Fields written — click one to filter</h3>
              <div className="flex flex-wrap gap-1.5">
                {byField.map(([field, n]) => {
                  const total = n.fill + n.overwrite + n.create
                  const active = fieldFilter === field
                  return (
                    <button key={field} onClick={() => setFieldFilter(active ? null : field)}
                      className={`text-xs px-2 py-1 rounded border ${active ? 'bg-blue-600 text-white border-blue-600' : CONSEQUENTIAL.has(field) ? 'bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100' : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                      title={`${n.fill} filled · ${n.overwrite} overwritten · ${n.create} on new loans`}>
                      <span className="font-mono">{field}</span> <span className="font-semibold">{total}</span>
                      {n.overwrite > 0 && <span className={active ? 'text-amber-200' : 'text-amber-700'}> ({n.overwrite} ow)</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Change list */}
          <div className="bg-white border border-slate-200 rounded-xl">
            <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search borrower, Arive #, field, value…"
                  className="w-full pl-8 pr-8 py-2 text-sm border border-slate-200 rounded-lg" />
                {query && <button onClick={() => setQuery('')} className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>}
              </div>
              <div className="flex gap-1">
                {(['all', 'fill', 'overwrite', 'create'] as const).map(a => (
                  <button key={a} onClick={() => setActionFilter(a)}
                    className={`text-xs px-2.5 py-1.5 rounded-md border ${actionFilter === a ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                    {a === 'all' ? 'All' : a === 'fill' ? 'Fills' : a === 'overwrite' ? 'Overwrites' : 'New loans'}
                  </button>
                ))}
              </div>
              {fieldFilter && (
                <button onClick={() => setFieldFilter(null)} className="text-xs px-2 py-1.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1">
                  <span className="font-mono">{fieldFilter}</span> <X className="w-3 h-3" />
                </button>
              )}
              <span className="text-xs text-slate-500 ml-auto">{visible.length} of {changes.length} changes · {grouped.length} deals</span>
              <button onClick={downloadCsv} className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1 text-slate-700">
                <Download className="w-3.5 h-3.5" /> CSV
              </button>
            </div>
            {grouped.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Nothing matches.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {grouped.map(g => (
                  <div key={g.dealId ?? g.borrower} className="px-4 py-3">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      {g.dealId
                        ? <Link href={`/deals/${g.dealId}`} className="font-medium text-slate-900 hover:text-blue-700 hover:underline">{g.borrower}</Link>
                        : <span className="font-medium text-slate-900">{g.borrower}</span>}
                      {g.arive && <span className="text-xs text-slate-400">Arive #{g.arive}</span>}
                      <span className="text-xs text-slate-400">{g.rows.length} field{g.rows.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="space-y-0.5">
                      {g.rows.map(c => (
                        <div key={c.id} className="flex items-center gap-2 text-xs font-mono">
                          <span className="w-40 shrink-0 text-slate-500 truncate" title={c.field}>{c.field}</span>
                          <span className="flex-1 truncate text-slate-400 line-through" title={fmt(c.old_value)}>{fmt(c.old_value)}</span>
                          <span className="text-slate-400">→</span>
                          <span className={`flex-1 truncate font-semibold ${c.action === 'overwrite' ? 'text-amber-700' : c.action === 'fill' ? 'text-emerald-700' : 'text-blue-700'}`} title={fmt(c.new_value)}>{fmt(c.new_value)}</span>
                          <span className={`px-1.5 py-0.5 rounded ${ACTION_STYLE[c.action]}`}>{c.action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'emerald' | 'amber' | 'blue' }) {
  const cls = tone === 'emerald' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
    : tone === 'amber' ? 'bg-amber-50 border-amber-200 text-amber-700'
    : tone === 'blue' ? 'bg-blue-50 border-blue-200 text-blue-700'
    : 'bg-slate-50 border-slate-200 text-slate-800'
  return (
    <div className={`border rounded-lg px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  )
}
