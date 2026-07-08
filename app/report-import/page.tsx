'use client'

/**
 * Report Import — upload your own lead CSV (vendor/GHL export), map its columns
 * to the report fields once, and generate the same Lead Performance / Lead Spend
 * style report. 100% in-browser: nothing is written to the deals database, so this
 * never touches the live pipeline. Reuses lib/leadReport.ts for the exact same math.
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import {
  segment, groupBy, isPurchased, sourceKey, stateKey, rrBand,
  PURCHASED_SOURCES, COLD_STATUSES, OPTOUT_STATUSES,
  type LeadRow, type Segment, type GroupRow,
} from '@/lib/leadReport'
import { formatCurrency } from '@/lib/utils'
import { FileUp, Download, X, RefreshCw, Info } from 'lucide-react'

// ── Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines) ─────
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const all: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); all.push(row); row = []; field = '' }
    else field += c
  }
  if (field !== '' || row.length) { row.push(field); all.push(row) }
  // drop fully-empty trailing rows
  const clean = all.filter(r => r.some(v => v.trim() !== ''))
  const headers = (clean.shift() ?? []).map(h => h.trim())
  return { headers, rows: clean }
}

const parseMoney = (v: string | undefined): number | null => {
  if (v == null) return null
  const n = parseFloat(v.replace(/[$,\s]/g, ''))
  return isNaN(n) ? null : n
}

// ── Report fields the importer maps to (mirrors leadReport's LeadRow) ─────────
type FieldKey = 'source' | 'status' | 'lead_price' | 'compensation_amount' | 'loan_purpose' | 'state' | 'pipeline_group'
const FIELDS: { key: FieldKey; label: string; required: boolean; hint: string; aliases: RegExp }[] = [
  { key: 'source',              label: 'Lead Source',        required: true,  hint: 'vendor / source name',              aliases: /source|vendor|lead\s*source|channel/i },
  { key: 'status',              label: 'Status',             required: true,  hint: 'drives response + funded metrics',  aliases: /status|stage|disposition|outcome/i },
  { key: 'lead_price',          label: 'Lead Price ($)',     required: false, hint: 'per-lead cost → spend',             aliases: /price|cost|lead\s*cost|lead\s*price|spend/i },
  { key: 'compensation_amount', label: 'Compensation ($)',   required: false, hint: 'comp on funded → revenue',         aliases: /comp|compensation|revenue|commission|payout|earn/i },
  { key: 'loan_purpose',        label: 'Loan Purpose',       required: false, hint: 'Purchase / Refinance / HELOC',      aliases: /purpose|loan\s*purpose|loan\s*type/i },
  { key: 'state',               label: 'State',              required: false, hint: 'for the by-state breakdown',        aliases: /^state$|\bstate\b|province/i },
  { key: 'pipeline_group',      label: 'Pipeline Group',     required: false, hint: 'optional — a column whose value "Funded" marks funded', aliases: /pipeline|group|stage\s*group/i },
]

type Mapping = Record<FieldKey, string>   // field → header ('' = unmapped)
const emptyMapping = (): Mapping => ({ source: '', status: '', lead_price: '', compensation_amount: '', loan_purpose: '', state: '', pipeline_group: '' })

function guessMapping(headers: string[]): Mapping {
  const m = emptyMapping()
  for (const f of FIELDS) {
    const hit = headers.find(h => f.aliases.test(h))
    if (hit) m[f.key] = hit
  }
  return m
}

const sigOf = (headers: string[]) => headers.join('|').toLowerCase()
const LS_KEY = 'report-import-mappings'

// ── UI ────────────────────────────────────────────────────────────────────────
export default function ReportImportPage() {
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Mapping>(emptyMapping())
  const [generated, setGenerated] = useState(false)
  const [cohort, setCohort] = useState<'all' | 'purchased'>('all')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function loadFile(file: File) {
    setError('')
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const { headers, rows } = parseCsv(String(reader.result ?? ''))
        if (headers.length === 0 || rows.length === 0) { setError('No rows found in that file.'); return }
        // restore a saved mapping for this exact header set, else auto-guess
        let m = guessMapping(headers)
        try {
          const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')[sigOf(headers)]
          if (saved) m = { ...m, ...saved }
        } catch { /* ignore */ }
        setFileName(file.name); setHeaders(headers); setRows(rows); setMapping(m); setGenerated(false)
      } catch { setError('Could not parse that file — is it a CSV?') }
    }
    reader.readAsText(file)
  }

  function reset() {
    setFileName(''); setHeaders([]); setRows([]); setMapping(emptyMapping()); setGenerated(false); setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const colIndex = useMemo(() => {
    const idx: Record<string, number> = {}
    headers.forEach((h, i) => { idx[h] = i })
    return idx
  }, [headers])

  // Transform mapped CSV rows → LeadRow[] for leadReport.
  const leadRows = useMemo<LeadRow[]>(() => {
    const cell = (row: string[], field: FieldKey): string | undefined => {
      const h = mapping[field]; if (!h) return undefined
      return row[colIndex[h]]
    }
    return rows.map(r => ({
      loan_officer: null,
      source: (cell(r, 'source') ?? '').trim() || null,
      status: (cell(r, 'status') ?? '').trim(),
      pipeline_group: (cell(r, 'pipeline_group') ?? '').trim(),
      state: (cell(r, 'state') ?? '').trim() || null,
      loan_purpose: (cell(r, 'loan_purpose') ?? '').trim() || null,
      lead_price: parseMoney(cell(r, 'lead_price')),
      compensation_amount: parseMoney(cell(r, 'compensation_amount')),
    }))
  }, [rows, mapping, colIndex])

  const canGenerate = mapping.source && mapping.status

  function generate() {
    if (!canGenerate) { setError('Map at least Lead Source and Status.'); return }
    try {
      const store = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
      store[sigOf(headers)] = mapping
      localStorage.setItem(LS_KEY, JSON.stringify(store))
    } catch { /* non-fatal */ }
    setError(''); setGenerated(true)
  }

  // ── Report data ──────────────────────────────────────────────────────────────
  const cohortRows = useMemo(() => cohort === 'purchased' ? leadRows.filter(isPurchased) : leadRows, [leadRows, cohort])
  const overall = useMemo<Segment>(() => segment(cohortRows), [cohortRows])
  const bySource = useMemo<GroupRow[]>(() => groupBy(leadRows, sourceKey), [leadRows])
  const byState = useMemo<GroupRow[]>(() => groupBy(cohortRows, stateKey).slice(0, 12), [cohortRows])
  const purchasedSet = useMemo(() => new Set(PURCHASED_SOURCES.map(s => s.toLowerCase())), [])

  function exportCsv() {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const head = ['Source', 'Leads', 'Response %', 'Cold %', 'Opt-out %', 'Funded', 'Funded %', 'Lead Spend', 'Revenue', 'ROI ×']
    const line = (label: string, s: Segment) => [label, s.n, s.rr.toFixed(1), s.crate.toFixed(1), s.orate.toFixed(1), s.funded, s.fr.toFixed(1), s.spend.toFixed(0), s.revenue.toFixed(0), s.roi == null ? '' : s.roi.toFixed(2)].map(esc).join(',')
    const rows = ['﻿' + head.join(','), line('ALL (' + cohort + ')', overall), ...bySource.map(g => line(g.key, g))]
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `lead-report-${fileName.replace(/\.csv$/i, '') || 'import'}.csv`; a.click()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <FileUp className="w-5 h-5 text-violet-500" /> Report Import
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Upload a lead CSV, map its columns, and generate a Lead Performance / Lead Spend report. Nothing is saved to the pipeline.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Upload */}
        {!headers.length ? (
          <label className="block cursor-pointer">
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f) }} />
            <div className="border-2 border-dashed border-slate-300 hover:border-violet-400 rounded-2xl p-12 text-center transition-colors bg-white">
              <FileUp className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <p className="text-sm font-semibold text-slate-700">Click to choose a CSV file</p>
              <p className="text-xs text-slate-500 mt-1">Any vendor or GHL export — you&apos;ll map the columns next.</p>
            </div>
          </label>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-slate-800">{fileName}</span>
            <span className="text-slate-500">· {rows.length} rows · {headers.length} columns</span>
            <button onClick={reset} className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
              <X className="w-3.5 h-3.5" /> Start over
            </button>
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{error}</div>}

        {/* Column mapping */}
        {headers.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h2 className="font-semibold text-slate-800 mb-3">Map your columns</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {FIELDS.map(f => (
                <div key={f.key}>
                  <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                    {f.label} {f.required && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    value={mapping[f.key]}
                    onChange={e => { setMapping(m => ({ ...m, [f.key]: e.target.value })); setGenerated(false) }}
                    className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="">— not in my file —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-0.5">{f.hint}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-4">
              <button onClick={generate} disabled={!canGenerate}
                className="text-sm font-semibold bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-lg px-4 py-2">
                Generate report
              </button>
              <span className="text-xs text-slate-400">Mapping is remembered for files with these same columns.</span>
            </div>
          </div>
        )}

        {/* Report */}
        {generated && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                {(['all', 'purchased'] as const).map(c => (
                  <button key={c} onClick={() => setCohort(c)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${cohort === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                    {c === 'all' ? 'All leads' : 'Purchased only'}
                  </button>
                ))}
              </div>
              <button onClick={exportCsv} className="ml-auto flex items-center gap-1.5 text-sm font-semibold border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 hover:bg-slate-50">
                <Download className="w-4 h-4" /> Export CSV
              </button>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Kpi label="Leads" value={overall.n.toLocaleString()} />
              <Kpi label="Response rate" value={`${overall.rr.toFixed(1)}%`} tone={rrBand(overall.rr)} />
              <Kpi label="Funded" value={`${overall.funded} (${overall.fr.toFixed(1)}%)`} />
              <Kpi label="Lead spend" value={overall.spend > 0 ? formatCurrency(overall.spend) : '—'} />
              <Kpi label="Revenue" value={overall.revenue > 0 ? formatCurrency(overall.revenue) : '—'} />
              <Kpi label="ROI" value={overall.roi == null ? '—' : `${overall.roi.toFixed(2)}×`} tone={overall.roi == null ? undefined : overall.roi >= 1 ? 'good' : 'bad'} />
            </div>

            {/* By source */}
            <SegmentTable title="By source" rows={bySource} markPurchased={purchasedSet} />
            {/* By state */}
            {byState.length > 1 && <SegmentTable title={`By state (${cohort})`} rows={byState} />}

            <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Metrics match the Lead Performance report. <b>Spend/Revenue/ROI</b> use only rows with a lead price &gt; 0 (so both cover the same cohort).
                <b> Responded</b> = anything not in a no-response status ({[...COLD_STATUSES].join(', ')}) or opt-out ({[...OPTOUT_STATUSES].join(', ')}).
                <b> Purchased</b> sources: {PURCHASED_SOURCES.join(', ')}. Funded is detected from standard funded statuses or a Pipeline Group of &quot;Funded&quot;.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'mid' | 'bad' }) {
  const c = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : tone === 'mid' ? 'text-amber-600' : 'text-slate-800'
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-xl font-bold mt-1 tabular-nums ${c}`}>{value}</p>
    </div>
  )
}

function SegmentTable({ title, rows, markPurchased }: { title: string; rows: GroupRow[]; markPurchased?: Set<string> }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <h2 className="font-semibold text-slate-800 px-4 py-3 border-b border-slate-100">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2.5">Source</th>
              <th className="text-right px-3 py-2.5">Leads</th>
              <th className="text-right px-3 py-2.5">Resp %</th>
              <th className="text-right px-3 py-2.5">Cold %</th>
              <th className="text-right px-3 py-2.5">Funded</th>
              <th className="text-right px-3 py-2.5">Spend</th>
              <th className="text-right px-3 py-2.5">Revenue</th>
              <th className="text-right px-3 py-2.5">ROI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(g => (
              <tr key={g.key} className="hover:bg-slate-50/60">
                <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">
                  {markPurchased?.has(g.key.toLowerCase()) && <span className="text-amber-500 mr-1" title="Purchased vendor">★</span>}
                  {g.key}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{g.n}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{g.rr.toFixed(0)}%</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{g.crate.toFixed(0)}%</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{g.funded}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{g.spend > 0 ? formatCurrency(g.spend) : '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{g.revenue > 0 ? formatCurrency(g.revenue) : '—'}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${g.roi == null ? 'text-slate-400' : g.roi >= 1 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {g.roi == null ? '—' : `${g.roi.toFixed(2)}×`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
