'use client'

/**
 * Report Import — upload one or MORE exports and get a single unified report
 * (ROI, responsiveness, funded vs expected). Each file's type is auto-detected;
 * known GHL + Arive exports are joined on Arive Loan ID (see lib/reportMerge.ts).
 * A single unrecognized CSV falls back to manual column mapping. 100% in-browser —
 * nothing is written to the deals database. Report math reuses lib/leadReport.ts.
 */

import { useState, useMemo, useRef } from 'react'
import {
  segment, groupBy, isPurchased, sourceKey, stateKey, rrBand,
  PURCHASED_SOURCES, COLD_STATUSES, OPTOUT_STATUSES,
  type LeadRow, type Segment, type GroupRow,
} from '@/lib/leadReport'
import {
  detectKind, mergeReports, KIND_LABEL,
  type ParsedFile, type ReportKind, type MergeResult,
} from '@/lib/reportMerge'
import { formatCurrency } from '@/lib/utils'
import { FileUp, Download, X, Info, CheckCircle2, AlertTriangle, Plus, Layers } from 'lucide-react'

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
  const clean = all.filter(r => r.some(v => v.trim() !== ''))
  const headers = (clean.shift() ?? []).map(h => h.trim())
  return { headers, rows: clean }
}
const parseMoney = (v: string | undefined): number | null => {
  if (v == null) return null
  const n = parseFloat(v.replace(/[$,\s]/g, ''))
  return isNaN(n) ? null : n
}
const toObjects = (headers: string[], rows: string[][]): Record<string, string>[] =>
  rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))

type UFile = ParsedFile & { kind: ReportKind }

// ── Manual-mapping fields (generic-CSV fallback only) ─────────────────────────
type FieldKey = 'source' | 'status' | 'lead_price' | 'compensation_amount' | 'loan_purpose' | 'state' | 'pipeline_group'
const FIELDS: { key: FieldKey; label: string; required: boolean; hint: string; aliases: RegExp }[] = [
  { key: 'source', label: 'Lead Source', required: true, hint: 'vendor / source name', aliases: /source|vendor|lead\s*source|channel/i },
  { key: 'status', label: 'Status', required: true, hint: 'drives response + funded metrics', aliases: /status|stage|disposition|outcome/i },
  { key: 'lead_price', label: 'Lead Price ($)', required: false, hint: 'per-lead cost → spend', aliases: /price|cost|lead\s*cost|lead\s*price|spend/i },
  { key: 'compensation_amount', label: 'Compensation ($)', required: false, hint: 'comp on funded → revenue', aliases: /comp|compensation|revenue|commission|payout|earn/i },
  { key: 'loan_purpose', label: 'Loan Purpose', required: false, hint: 'Purchase / Refinance / HELOC', aliases: /purpose|loan\s*purpose|loan\s*type/i },
  { key: 'state', label: 'State', required: false, hint: 'for the by-state breakdown', aliases: /^state$|\bstate\b|province/i },
  { key: 'pipeline_group', label: 'Pipeline Group', required: false, hint: 'a column whose value "Funded" marks funded', aliases: /pipeline|group|stage\s*group/i },
]
type Mapping = Record<FieldKey, string>
const emptyMapping = (): Mapping => ({ source: '', status: '', lead_price: '', compensation_amount: '', loan_purpose: '', state: '', pipeline_group: '' })
function guessMapping(headers: string[]): Mapping {
  const m = emptyMapping()
  for (const f of FIELDS) { const hit = headers.find(h => f.aliases.test(h)); if (hit) m[f.key] = hit }
  return m
}

const KIND_TONE: Record<ReportKind, string> = {
  'ghl-opportunities': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'arive-funded': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'ghl-contacts': 'bg-sky-50 text-sky-700 border-sky-200',
  'generic': 'bg-amber-50 text-amber-700 border-amber-200',
}

// ══════════════════════════════════════════════════════════════════════════════
export default function ReportImportPage() {
  const [files, setFiles] = useState<UFile[]>([])
  const [error, setError] = useState('')
  const [cohort, setCohort] = useState<'all' | 'purchased'>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  // generic single-CSV fallback state
  const [mapping, setMapping] = useState<Mapping>(emptyMapping())
  const [generated, setGenerated] = useState(false)

  function addFiles(list: FileList) {
    setError('')
    const incoming = Array.from(list)
    let remaining = incoming.length
    const collected: UFile[] = []
    for (const file of incoming) {
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const { headers, rows } = parseCsv(String(reader.result ?? ''))
          if (headers.length && rows.length) {
            const uf: UFile = { name: file.name, headers, rows: toObjects(headers, rows), kind: detectKind(headers) }
            collected.push(uf)
          } else setError(`No rows found in ${file.name}.`)
        } catch { setError(`Could not parse ${file.name} — is it a CSV?`) }
        if (--remaining === 0 && collected.length) {
          setFiles(prev => {
            const byName = new Map(prev.map(f => [f.name, f]))
            for (const f of collected) byName.set(f.name, f)   // replace same-name re-uploads
            return [...byName.values()]
          })
          setMapping(m => (collected[0] && collected[0].kind === 'generic' && !m.source ? guessMapping(collected[0].headers) : m))
          setGenerated(false)
        }
      }
      reader.readAsText(file)
    }
    if (inputRef.current) inputRef.current.value = ''
  }
  const removeFile = (name: string) => { setFiles(f => f.filter(x => x.name !== name)); setGenerated(false) }
  const reset = () => { setFiles([]); setError(''); setMapping(emptyMapping()); setGenerated(false) }

  const known = files.filter(f => f.kind !== 'generic')
  const smart = known.length > 0
  const merge: MergeResult | null = useMemo(() => (smart ? mergeReports(files) : null), [files, smart])
  const genericFile = files.find(f => f.kind === 'generic')

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <FileUp className="w-5 h-5 text-violet-500" /> Report Import
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Upload your GHL &amp; Arive exports together — they&apos;re auto-detected and joined into one report (ROI, responsiveness, funded vs expected). Nothing is saved to the pipeline.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Upload zone */}
        {!files.length ? (
          <label className="block cursor-pointer">
            <input ref={inputRef} type="file" accept=".csv,text/csv" multiple className="hidden"
              onChange={e => { if (e.target.files?.length) addFiles(e.target.files) }} />
            <div className="border-2 border-dashed border-slate-300 hover:border-violet-400 rounded-2xl p-12 text-center transition-colors bg-white">
              <Layers className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <p className="text-sm font-semibold text-slate-700">Click to choose one or more CSV files</p>
              <p className="text-xs text-slate-500 mt-1">GHL Opportunities + Arive Funded export → auto-joined. Any single vendor CSV → map columns.</p>
            </div>
          </label>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {files.map(f => (
                <div key={f.name} className={`inline-flex items-center gap-2 text-xs rounded-lg border px-2.5 py-1.5 ${KIND_TONE[f.kind]}`}>
                  {f.kind === 'generic' ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span className="font-semibold">{KIND_LABEL[f.kind]}</span>
                  <span className="opacity-70">· {f.name.length > 28 ? f.name.slice(0, 28) + '…' : f.name} · {f.rows.length} rows</span>
                  <button onClick={() => removeFile(f.name)} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <label className="inline-flex items-center gap-1 text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 cursor-pointer">
                <Plus className="w-3.5 h-3.5" /> Add file
                <input type="file" accept=".csv,text/csv" multiple className="hidden"
                  onChange={e => { if (e.target.files?.length) addFiles(e.target.files) }} />
              </label>
              <button onClick={reset} className="ml-auto text-xs text-slate-400 hover:text-slate-700">Start over</button>
            </div>
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{error}</div>}

        {/* Smart merged report */}
        {smart && merge && <MergedReport merge={merge} cohort={cohort} setCohort={setCohort} />}

        {/* Generic single-CSV fallback → manual mapping */}
        {!smart && genericFile && (
          <GenericMapper
            file={genericFile} mapping={mapping} setMapping={setMapping}
            generated={generated} setGenerated={setGenerated} cohort={cohort} setCohort={setCohort}
            setError={setError}
          />
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Merged multi-file report
function MergedReport({ merge, cohort, setCohort }: { merge: MergeResult; cohort: 'all' | 'purchased'; setCohort: (c: 'all' | 'purchased') => void }) {
  const { meta } = merge
  const leads = useMemo<LeadRow[]>(() => cohort === 'purchased' ? merge.leads.filter(isPurchased) : merge.leads, [merge.leads, cohort])
  const seg = useMemo<Segment>(() => segment(leads), [leads])
  const bySource = useMemo<GroupRow[]>(() => groupBy(merge.leads, sourceKey), [merge.leads])
  const byState = useMemo<GroupRow[]>(() => groupBy(leads, stateKey).slice(0, 12), [leads])
  const purchasedSet = useMemo(() => new Set(PURCHASED_SOURCES.map(s => s.toLowerCase())), [])

  // Realized uses the current cohort's segment; projected adds in-process expected comp (whole set).
  const expectedComp = useMemo(() => merge.leads.reduce((s, l) => s + (l.expected_comp ?? 0), 0), [merge.leads])
  const projRevenue = seg.revenue + expectedComp
  const projRoi = seg.spend > 0 ? projRevenue / seg.spend : null

  function exportCsv() {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const head = ['Lead Source', 'Status', 'Pipeline Group', 'Lead Price', 'Compensation (funded)', 'Expected Comp (in-process)', 'State', 'Loan Purpose', 'Borrower', 'Arive Loan ID', 'Reached Arive']
    const lines = merge.leads.map(l => [l.source, l.status, l.pipeline_group, l.lead_price ?? '', l.compensation_amount ?? '', l.expected_comp ?? '', l.state, l.loan_purpose, l.borrower ?? '', l.arive_loan_id ?? '', l.reached_arive ? 'yes' : ''].map(esc).join(','))
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lumin-merged-report.csv'; a.click()
  }

  return (
    <>
      {/* Sources / join summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-800"><Layers className="w-4 h-4 text-violet-500" /> Combining {meta.files.length} report{meta.files.length > 1 ? 's' : ''}</div>
        <div className="text-[13px] text-slate-600 leading-relaxed">
          <b>{meta.totalLeads.toLocaleString()}</b> total leads · <b>{meta.reachedArive}</b> reached Arive
          (<b>{meta.funded}</b> funded, <b>{meta.inProcess}</b> in-process). Outcomes joined on <b>Arive Loan ID</b>:
          {' '}{meta.matchedOutcomes} matched{meta.appendedOutcomes ? `, ${meta.appendedOutcomes} added from Arive` : ''}.
        </div>
        {meta.warnings.map((w, i) => (
          <div key={i} className="mt-2 flex gap-2 items-start bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{w}</span>
          </div>
        ))}
      </div>

      {/* Cohort toggle + export */}
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
          <Download className="w-4 h-4" /> Export merged CSV
        </button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Leads" value={seg.n.toLocaleString()} />
        <Kpi label="Response rate" value={`${seg.rr.toFixed(1)}%`} tone={rrBand(seg.rr)} />
        <Kpi label="Funded" value={`${seg.funded} (${seg.fr.toFixed(1)}%)`} />
        <Kpi label="Lead spend" value={seg.spend > 0 ? formatCurrency(seg.spend) : '—'} />
        <Kpi label="Revenue (funded)" value={seg.revenue > 0 ? formatCurrency(seg.revenue) : '—'} />
        <Kpi label="ROI" value={seg.roi == null ? '—' : `${seg.roi.toFixed(2)}×`} tone={seg.roi == null ? undefined : seg.roi >= 1 ? 'good' : 'bad'} />
      </div>

      {/* Realized vs projected — uses ACTUAL Arive expected comp, not an assumed average */}
      <div className="bg-white border border-violet-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800">Realized vs. projected (if in-process loans fund)</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">Projected adds the real Arive compensation on the {meta.inProcess} in-process loan{meta.inProcess === 1 ? '' : 's'} ({formatCurrency(expectedComp)}). Spend is unchanged.</p>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <CompareTile label="Revenue" current={seg.revenue > 0 ? formatCurrency(seg.revenue) : '$0'} projected={formatCurrency(projRevenue)} up={projRevenue > seg.revenue} />
          <CompareTile label="ROI" current={seg.roi == null ? '—' : `${seg.roi.toFixed(2)}×`} projected={projRoi == null ? '—' : `${projRoi.toFixed(2)}×`} up={projRoi != null && (seg.roi == null || projRoi > seg.roi)} />
          <CompareTile label="Funded loans" current={String(seg.funded)} projected={String(seg.funded + meta.inProcess)} up={meta.inProcess > 0} />
        </div>
      </div>

      {/* Breakdowns */}
      <SegmentTable title="By source" rows={bySource} markPurchased={purchasedSet} />
      {byState.length > 1 && <SegmentTable title={`By state (${cohort})`} rows={byState} />}

      <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          <b>Spend/Revenue/ROI</b> use only leads with a lead price &gt; 0 (so both cover the same cohort). <b>Revenue</b> is realized (funded) compensation from the Arive export; the projection adds real expected comp on in-process loans.
          <b> Responded</b> = anything not in a no-response status ({[...COLD_STATUSES].join(', ')}) or opt-out ({[...OPTOUT_STATUSES].join(', ')}).
          <b> Purchased</b> sources: {PURCHASED_SOURCES.join(', ')}.
        </span>
      </p>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Generic single-CSV fallback — manual column mapping
function GenericMapper({ file, mapping, setMapping, generated, setGenerated, cohort, setCohort, setError }: {
  file: UFile; mapping: Mapping; setMapping: (m: Mapping | ((p: Mapping) => Mapping)) => void
  generated: boolean; setGenerated: (b: boolean) => void; cohort: 'all' | 'purchased'; setCohort: (c: 'all' | 'purchased') => void
  setError: (s: string) => void
}) {
  const cell = (row: Record<string, string>, field: FieldKey): string | undefined => {
    const h = mapping[field]; return h ? row[h] : undefined
  }
  const leadRows = useMemo<LeadRow[]>(() => file.rows.map(r => ({
    loan_officer: null,
    source: (cell(r, 'source') ?? '').trim() || null,
    status: (cell(r, 'status') ?? '').trim(),
    pipeline_group: (cell(r, 'pipeline_group') ?? '').trim(),
    state: (cell(r, 'state') ?? '').trim() || null,
    loan_purpose: (cell(r, 'loan_purpose') ?? '').trim() || null,
    lead_price: parseMoney(cell(r, 'lead_price')),
    compensation_amount: parseMoney(cell(r, 'compensation_amount')),
  })), [file, mapping])

  const canGenerate = !!mapping.source && !!mapping.status
  const cohortRows = useMemo(() => cohort === 'purchased' ? leadRows.filter(isPurchased) : leadRows, [leadRows, cohort])
  const overall = useMemo<Segment>(() => segment(cohortRows), [cohortRows])
  const bySource = useMemo<GroupRow[]>(() => groupBy(leadRows, sourceKey), [leadRows])
  const purchasedSet = useMemo(() => new Set(PURCHASED_SOURCES.map(s => s.toLowerCase())), [])

  return (
    <>
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[13px] text-amber-800 flex gap-2 items-start">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span><b>{file.name}</b> isn&apos;t a recognized GHL/Arive export — map its columns manually below. (Upload a GHL Opportunities + Arive Funded export instead to auto-join with ROI.)</span>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">Map your columns</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {FIELDS.map(f => (
            <div key={f.key}>
              <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">{f.label} {f.required && <span className="text-red-500">*</span>}</label>
              <select value={mapping[f.key]} onChange={e => { const v = e.target.value; setMapping(m => ({ ...m, [f.key]: v })); setGenerated(false) }}
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500">
                <option value="">— not in my file —</option>
                {file.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
              <p className="text-[11px] text-slate-400 mt-0.5">{f.hint}</p>
            </div>
          ))}
        </div>
        <button onClick={() => { if (!canGenerate) { setError('Map at least Lead Source and Status.'); return } setError(''); setGenerated(true) }}
          disabled={!canGenerate} className="mt-4 text-sm font-semibold bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-lg px-4 py-2">
          Generate report
        </button>
      </div>

      {generated && (
        <>
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5 w-fit">
            {(['all', 'purchased'] as const).map(c => (
              <button key={c} onClick={() => setCohort(c)}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${cohort === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                {c === 'all' ? 'All leads' : 'Purchased only'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Kpi label="Leads" value={overall.n.toLocaleString()} />
            <Kpi label="Response rate" value={`${overall.rr.toFixed(1)}%`} tone={rrBand(overall.rr)} />
            <Kpi label="Funded" value={`${overall.funded} (${overall.fr.toFixed(1)}%)`} />
            <Kpi label="Lead spend" value={overall.spend > 0 ? formatCurrency(overall.spend) : '—'} />
            <Kpi label="Revenue" value={overall.revenue > 0 ? formatCurrency(overall.revenue) : '—'} />
            <Kpi label="ROI" value={overall.roi == null ? '—' : `${overall.roi.toFixed(2)}×`} tone={overall.roi == null ? undefined : overall.roi >= 1 ? 'good' : 'bad'} />
          </div>
          <SegmentTable title="By source" rows={bySource} markPurchased={purchasedSet} />
        </>
      )}
    </>
  )
}

// ── shared presentational bits ────────────────────────────────────────────────
function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'mid' | 'bad' }) {
  const c = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : tone === 'mid' ? 'text-amber-600' : 'text-slate-800'
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-xl font-bold mt-1 tabular-nums ${c}`}>{value}</p>
    </div>
  )
}
function CompareTile({ label, current, projected, up }: { label: string; current: string; projected: string; up?: boolean }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="flex items-baseline gap-2 mt-1 flex-wrap">
        <span className="text-sm text-slate-500 tabular-nums">{current}</span>
        <span className="text-slate-300">→</span>
        <span className={`text-xl font-bold tabular-nums ${up ? 'text-emerald-600' : 'text-slate-800'}`}>{projected}</span>
      </div>
      <p className="text-[10px] text-slate-400 mt-0.5">current → projected</p>
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
