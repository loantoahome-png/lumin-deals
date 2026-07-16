'use client'

import { useState, useRef } from 'react'
import { Upload, FileText, X, Check, AlertTriangle, Loader2, Shield, ChevronDown, ChevronRight, Download, Search } from 'lucide-react'

type FieldChange = {
  field: string
  current: unknown
  next: unknown
  action: 'fill' | 'overwrite' | 'unchanged'
}
type RowPlan = {
  rowIndex: number
  borrower: string
  arive_file_no: string | null
  matched: boolean
  matchedVia?: 'arive_file_no' | 'email' | 'phone' | 'name' | 'name_firstlast'
  dealId?: string
  reason?: string
  changes: FieldChange[]
  action?: 'update' | 'create_loan' | 'create_new'
  coborrower?: { name: string | null; email: string | null; phone: string | null }
  dedupWarning?: string
}
type Summary = {
  total_rows: number
  matched: number
  unmatched: number
  will_create?: number
  fields_to_fill: number
  fields_to_overwrite: number
  fields_unchanged: number
}
type ApiResp = {
  ok: boolean
  mode?: string
  summary?: Summary
  plans?: RowPlan[]
  updated?: number
  created?: number
  fields_written?: number
  errors?: Array<{ rowIndex: number; borrower: string; error: string }>
  error?: string
}

type Mode = 'fill_blanks' | 'overwrite'

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return v.toString()
  return String(v)
}

// Fields worth shielding from overwrite (real dashboard-semantic risk).
const PROTECTABLE: { field: string; label: string }[] = [
  { field: 'status',           label: 'Status / stage' },
  { field: 'loan_officer',     label: 'Loan officer' },
  { field: 'occupancy',        label: 'Occupancy' },
  { field: 'lead_source_agg',  label: 'Lead source' },
  { field: 'phone',            label: 'Phone' },
  { field: 'email',            label: 'Email' },
  { field: 'property_address', label: 'Property address' },
]
// Overwrites on these are materially consequential — emphasized in the diff.
const CONSEQUENTIAL = new Set(['status', 'loan_officer', 'occupancy'])

// Will this field change actually be WRITTEN, given the apply mode + shields?
function fieldWrites(c: FieldChange, mode: Mode, protectedFields: Set<string>): boolean {
  if (c.action === 'fill') return true
  if (c.action === 'overwrite') return mode === 'overwrite' && !protectedFields.has(c.field)
  return false
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Build + download a CSV of every field that will be / was written.
function downloadChangeLog(resp: ApiResp, mode: Mode, protectedFields: Set<string>, filename: string) {
  const rows: string[][] = [['borrower', 'arive_file_no', 'deal_id', 'field', 'old_value', 'new_value', 'action']]
  for (const p of resp.plans ?? []) {
    for (const c of p.changes) {
      if (!fieldWrites(c, mode, protectedFields)) continue
      rows.push([p.borrower, p.arive_file_no ?? '', p.dealId ?? '', c.field, fmt(c.current), fmt(c.next), c.action])
    }
  }
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export default function AriveImportPage() {
  const [csvText, setCsvText]       = useState<string>('')
  const [fileName, setFileName]     = useState<string>('')
  const [mode, setMode]             = useState<Mode>('fill_blanks')
  const [preview, setPreview]       = useState<ApiResp | null>(null)
  const [committing, setCommitting] = useState(false)
  const [committed, setCommitted]   = useState<ApiResp | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const [error, setError]           = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)
  const [createUnmatched, setCreateUnmatched] = useState(false)
  const [protectedFields, setProtectedFields] = useState<Set<string>>(new Set())
  const [rowFilter, setRowFilter] = useState<'all' | 'overwrites' | 'new' | 'unmatched' | 'warnings'>('all')
  const [rowSearch, setRowSearch] = useState('')
  const [hideNoChange, setHideNoChange] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  function toggleProtected(field: string) {
    setProtectedFields(prev => {
      const next = new Set(prev)
      if (next.has(field)) next.delete(field); else next.add(field)
      return next
    })
  }

  async function runPreview(text: string, createUnm: boolean) {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/import/arive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text, mode: 'preview', createUnmatched: createUnm }),
      })
      const data: ApiResp = await res.json()
      if (!data.ok) { setError(data.error || 'preview failed'); return }
      setPreview(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleFile(f: File) {
    const text = await f.text()
    setCsvText(text)
    setFileName(f.name)
    setPreview(null); setCommitted(null); setError(null)
    await runPreview(text, createUnmatched)
  }

  async function commit() {
    if (!csvText) return
    setCommitting(true); setError(null)
    try {
      const res = await fetch('/api/import/arive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, mode, createUnmatched, protectedFields: [...protectedFields] }),
      })
      const data: ApiResp = await res.json()
      if (!data.ok) { setError(data.error || 'commit failed'); setCommitting(false); return }
      setCommitted(data)
    } catch (e) {
      setError(String(e))
    } finally {
      setCommitting(false)
    }
  }

  function resetAll() {
    setCsvText(''); setFileName(''); setPreview(null); setCommitted(null); setError(null)
    setExpandedRows(new Set())
    if (inputRef.current) inputRef.current.value = ''
  }

  function toggleRow(i: number) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  // Recompute the write counts under the current mode + field shields so the
  // summary reflects the user's selections without re-fetching.
  const recountedSummary = preview?.plans ? (() => {
    let fill = 0, overwrite = 0
    for (const p of preview.plans) {
      if (!p.matched) continue
      for (const c of p.changes) {
        if (c.action === 'fill') fill++
        else if (c.action === 'overwrite' && mode === 'overwrite' && !protectedFields.has(c.field)) overwrite++
      }
    }
    return { fill, overwrite }
  })() : null

  // Potential overwrites per field (before shields) — the "by field" table.
  const overwritesByField: [string, number][] = preview?.plans ? (() => {
    const m = new Map<string, number>()
    for (const p of preview.plans) {
      if (!p.matched) continue
      for (const c of p.changes) if (c.action === 'overwrite') m.set(c.field, (m.get(c.field) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  })() : []

  // Rows to show after search + filter + hide-no-change.
  const totalRows = preview?.plans?.length ?? 0
  const visiblePlans = (preview?.plans ?? []).filter(p => {
    if (rowSearch.trim()) {
      const q = rowSearch.trim().toLowerCase()
      if (!`${p.borrower} ${p.arive_file_no ?? ''}`.toLowerCase().includes(q)) return false
    }
    const writes = p.changes.filter(c => fieldWrites(c, mode, protectedFields)).length
    const hasOverwrite = p.changes.some(c => c.action === 'overwrite' && mode === 'overwrite' && !protectedFields.has(c.field))
    if (rowFilter === 'overwrites') return hasOverwrite
    if (rowFilter === 'new')        return p.action === 'create_new' || p.action === 'create_loan'
    if (rowFilter === 'unmatched')  return !p.matched
    if (rowFilter === 'warnings')   return !!p.dedupWarning
    // 'all': optionally hide matched no-op rows (nothing written, no warning).
    if (hideNoChange && p.matched && p.action !== 'create_new' && p.action !== 'create_loan' && !p.dedupWarning && writes === 0) return false
    return true
  })

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Import from Arive</h1>
        <p className="text-slate-500 text-sm mt-1">
          Upload an Arive CSV export — the dashboard will match each row to a deal and fill missing fields.
          Matches by Arive Loan #, then email, then phone, then borrower name.
        </p>
      </div>

      {/* Security note */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-start gap-2.5">
        <Shield className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
        <div className="text-xs text-emerald-900">
          <p className="font-semibold">Safe by default.</p>
          <p className="text-emerald-800 mt-0.5">
            &ldquo;Fill blanks only&rdquo; never overwrites hand-entered data — it only writes to fields currently empty.
            You&apos;ll see a complete preview before anything is saved.
          </p>
        </div>
      </div>

      {/* File picker */}
      {!preview && !committed && (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f) }}
          className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-12 text-center hover:border-blue-400 transition-colors"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            className="hidden"
            id="arive-csv"
          />
          <label htmlFor="arive-csv" className="cursor-pointer inline-flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
              <Upload className="w-5 h-5 text-blue-600" />
            </div>
            <div className="text-sm font-medium text-slate-700">
              Drop the Arive CSV here, or <span className="text-blue-600 underline">browse</span>
            </div>
            <div className="text-xs text-slate-400">In Arive: Pipeline → Export</div>
          </label>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" /> Parsing CSV and matching to existing deals…
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Failed</p>
          <p className="text-xs mt-1 font-mono">{error}</p>
        </div>
      )}

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      {preview && !committed && (
        <>
          {/* Summary bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <FileText className="w-4 h-4 text-slate-400" />
                <span className="font-medium">{fileName}</span>
                <button onClick={resetAll} className="text-slate-400 hover:text-slate-700 ml-2"><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
              <Metric label="Rows in CSV"     value={preview.summary?.total_rows ?? 0} />
              <Metric label="Matched"          value={preview.summary?.matched ?? 0} tone="emerald" />
              <Metric label="Unmatched"        value={preview.summary?.unmatched ?? 0} tone={preview.summary?.unmatched ? 'amber' : undefined} />
              <Metric label="Will create new"  value={preview.summary?.will_create ?? 0} tone={preview.summary?.will_create ? 'indigo' : undefined} />
              <Metric label="Will fill blanks" value={recountedSummary?.fill ?? 0} tone="blue" />
              <Metric label="Will overwrite"   value={recountedSummary?.overwrite ?? 0} tone={mode === 'overwrite' && recountedSummary?.overwrite ? 'amber' : undefined} />
            </div>
          </div>

          {/* Mode toggle */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Apply mode</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <ModeOption active={mode === 'fill_blanks'} onClick={() => setMode('fill_blanks')}
                title="Fill blanks only (recommended)"
                desc="Only writes to dashboard fields that are currently empty. Never overwrites manual edits or values from GHL."
              />
              <ModeOption active={mode === 'overwrite'} onClick={() => setMode('overwrite')}
                title="Overwrite from Arive"
                desc="Replaces any dashboard field where Arive has a value. Use when Arive is more current (e.g. after a rate change or milestone update)."
              />
            </div>
            <label className="mt-3 flex items-start gap-2 cursor-pointer rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={createUnmatched}
                onChange={e => { setCreateUnmatched(e.target.checked); if (csvText) runPreview(csvText, e.target.checked) }}
                className="mt-0.5 rounded accent-indigo-600"
              />
              <span className="text-sm">
                <span className="font-medium text-slate-800">Create new deals for unmatched rows</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Adds a brand-new deal for each row that doesn&apos;t match any existing deal (e.g. a funded loan that was never in the dashboard).
                  Only applies to true no-matches — <strong>ambiguous</strong> rows (multiple possible matches) are never auto-created.
                </span>
              </span>
            </label>
          </div>

          {/* Protect specific fields from overwrite (surgical override) — overwrite mode only */}
          {mode === 'overwrite' && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-slate-400" /> Protect from overwrite
              </h3>
              <p className="text-[11px] text-slate-500 mb-2.5">
                Keep your dashboard value for these fields — Arive can still fill them when blank, but won&apos;t replace an existing value. The number is how many rows would otherwise overwrite.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PROTECTABLE.map(({ field, label }) => {
                  const on = protectedFields.has(field)
                  const cnt = overwritesByField.find(([f]) => f === field)?.[1] ?? 0
                  return (
                    <button key={field} onClick={() => toggleProtected(field)}
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:border-blue-300'}`}>
                      {on ? '🛡 ' : ''}{label}{cnt > 0 && <span className={`ml-1.5 tabular-nums ${on ? 'text-blue-100' : 'text-amber-600'}`}>{cnt}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Overwrites by field — quiet reference so systemic changes are visible */}
          {mode === 'overwrite' && overwritesByField.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Overwrites by field</h3>
              <div className="flex flex-wrap gap-1.5">
                {overwritesByField.map(([field, count]) => {
                  const shielded = protectedFields.has(field)
                  return (
                    <span key={field} title={shielded ? 'Protected — will not overwrite' : undefined}
                      className={`text-[11px] font-medium px-2 py-1 rounded-lg border inline-flex items-center gap-1.5 ${shielded ? 'bg-slate-50 border-slate-200 text-slate-400 line-through' : CONSEQUENTIAL.has(field) ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                      <span className="font-mono uppercase text-[10px]">{field}</span>
                      <span className="tabular-nums font-bold">{count}</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Row plans */}
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="px-4 py-2.5 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Per-row preview</h3>
                <span className="text-[11px] text-slate-400 tabular-nums">Showing {visiblePlans.length} of {totalRows} · click a row for field-by-field</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
                  <input value={rowSearch} onChange={e => setRowSearch(e.target.value)} placeholder="Search borrower / Arive #"
                    className="pl-7 pr-2 py-1 text-xs border border-slate-200 rounded-lg w-52 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="flex bg-slate-100 rounded-lg p-0.5 gap-0.5">
                  {([['all', 'All'], ['overwrites', 'Overwrites'], ['new', 'New loans'], ['unmatched', 'Unmatched'], ['warnings', 'Warnings']] as const).map(([key, label]) => (
                    <button key={key} onClick={() => setRowFilter(key)}
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded ${rowFilter === key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer ml-auto">
                  <input type="checkbox" checked={hideNoChange} onChange={e => setHideNoChange(e.target.checked)} className="rounded accent-blue-600" />
                  Hide unchanged rows
                </label>
              </div>
            </div>
            {visiblePlans.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-slate-400">No rows match this filter/search.</div>
            )}
            {visiblePlans.map(p => {
              const expanded = expandedRows.has(p.rowIndex)
              const willWriteCount = p.changes.filter(c => fieldWrites(c, mode, protectedFields)).length
              return (
                <div key={p.rowIndex} className="px-4 py-2.5">
                  <button
                    onClick={() => toggleRow(p.rowIndex)}
                    className="w-full flex items-center gap-3 text-left"
                  >
                    {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                    {p.action === 'create_new' ? (
                      <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded"
                        title="No existing deal matched — this row will be created as a brand-new deal">
                        will create · new deal
                      </span>
                    ) : p.matched && p.action === 'create_loan' ? (
                      <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded"
                        title="This borrower already has a deal with a different Arive file # — this row will be added as a NEW loan card linked to them">
                        new loan · same borrower
                      </span>
                    ) : p.matched ? (
                      <span className="text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                        matched · {p.matchedVia}
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                        unmatched{p.reason ? ` · ${p.reason}` : ''}
                      </span>
                    )}
                    <span className="font-medium text-slate-800 text-sm flex-1 truncate">{p.borrower}</span>
                    {p.arive_file_no && <span className="text-[11px] text-slate-400 font-mono">#{p.arive_file_no}</span>}
                    <span className="text-[11px] text-slate-500 tabular-nums">
                      {p.action === 'create_new'
                        ? `${willWriteCount} field${willWriteCount === 1 ? '' : 's'}`
                        : willWriteCount > 0 ? `${willWriteCount} change${willWriteCount === 1 ? '' : 's'}` : (p.matched ? 'no change' : '—')}
                    </span>
                  </button>
                  {(p.coborrower || p.dedupWarning) && (
                    <div className="mt-1 ml-7 flex flex-wrap items-center gap-1.5">
                      {p.coborrower && (
                        <span className="text-[10px] font-medium bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">
                          + co-borrower: {p.coborrower.name || p.coborrower.email || p.coborrower.phone}
                        </span>
                      )}
                      {p.dedupWarning && (
                        <span className="text-[10px] font-medium bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title={p.dedupWarning}>
                          ⚠ {p.dedupWarning}
                        </span>
                      )}
                    </div>
                  )}
                  {expanded && (p.matched || p.action === 'create_new') && (
                    <div className="mt-2 ml-7 text-xs">
                      {p.changes.length === 0 ? (
                        <span className="text-slate-400 italic">No mappable fields had values.</span>
                      ) : (
                        <div className="rounded-lg border border-slate-200 overflow-hidden">
                          {/* Header labels which value is which — the whole point of the diff */}
                          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 border-b border-slate-200 text-[9px] font-bold uppercase tracking-wide text-slate-400">
                            <span className="w-28 shrink-0">Field</span>
                            <span className="flex-1 truncate">Dashboard now</span>
                            <span className="w-4 shrink-0 text-center">→</span>
                            <span className="flex-1 truncate">Arive value</span>
                            <span className="w-16 shrink-0 text-right">Result</span>
                          </div>
                          {p.changes.map((c, i) => {
                            const ariveWins = fieldWrites(c, mode, protectedFields)
                            const isOverwrite = c.action === 'overwrite'
                            const isProtected = isOverwrite && mode === 'overwrite' && protectedFields.has(c.field)
                            const dashBlank = c.current == null || c.current === ''
                            const consequential = CONSEQUENTIAL.has(c.field) && ariveWins && isOverwrite
                            return (
                              <div key={i} className={`flex items-center gap-2 px-2.5 py-1 border-b border-slate-100 last:border-0 ${consequential ? 'bg-amber-50/70' : ''}`}>
                                {/* Field — bold/amber when a consequential field is being overwritten */}
                                <span className={`font-mono text-[10px] uppercase w-28 shrink-0 truncate ${consequential ? 'text-amber-700 font-bold' : 'text-slate-400'}`} title={c.field}>{c.field}</span>
                                {/* Dashboard value — bold when kept, muted when Arive overrides it */}
                                <span className={`flex-1 truncate ${!ariveWins && !dashBlank ? 'text-slate-800 font-semibold' : 'text-slate-400'}`}>{fmt(c.current)}</span>
                                <span className="w-4 shrink-0 text-center text-slate-300">→</span>
                                {/* Arive value — bold+colored when it wins, struck through when not */}
                                <span className={`flex-1 truncate ${ariveWins ? `font-semibold ${isOverwrite ? 'text-amber-700' : 'text-emerald-700'}` : 'text-slate-300 line-through'}`}>{fmt(c.next)}</span>
                                {/* Result — exactly what happens to this field */}
                                <span className="w-16 shrink-0 text-right text-[9px] font-bold uppercase">
                                  {ariveWins
                                    ? (isOverwrite ? <span className="text-amber-700">overwrite</span> : <span className="text-emerald-700">fill</span>)
                                    : isProtected ? <span className="text-blue-600">protected</span>
                                    : <span className="text-slate-400">keep</span>}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Apply */}
          <div className="sticky bottom-4 z-10 flex justify-end gap-2">
            <button
              onClick={() => downloadChangeLog(preview, mode, protectedFields, 'arive-import-plan.csv')}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 shadow-sm"
              title="Download a CSV of every field this import will write (deal, field, old → new)"
            >
              <Download className="w-4 h-4" /> Download plan
            </button>
            <button
              onClick={resetAll}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-sm"
            >
              Cancel
            </button>
            <button
              onClick={commit}
              disabled={committing || ((preview.summary?.matched ?? 0) + (preview.summary?.will_create ?? 0)) === 0}
              className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 flex items-center gap-2 shadow-lg"
            >
              {committing && <Loader2 className="w-4 h-4 animate-spin" />}
              <Check className="w-4 h-4" />
              {committing
                ? 'Applying…'
                : (() => {
                    const m = preview.summary?.matched ?? 0
                    const c = preview.summary?.will_create ?? 0
                    return `Apply to ${m + c} deal${m + c === 1 ? '' : 's'}${c > 0 ? ` (${c} new)` : ''}`
                  })()}
            </button>
          </div>
        </>
      )}

      {/* ── After commit ─────────────────────────────────────────────────── */}
      {committed && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <Check className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-slate-900">Import complete</h3>
              <p className="text-sm text-slate-600 mt-0.5">
                Updated <strong>{committed.updated ?? 0}</strong> deal{committed.updated === 1 ? '' : 's'}
                {(committed.created ?? 0) > 0 && <> · created <strong>{committed.created}</strong> new loan{committed.created === 1 ? '' : 's'}</>} ·
                wrote <strong>{committed.fields_written ?? 0}</strong> field{committed.fields_written === 1 ? '' : 's'} ·
                mode: <strong>{committed.mode}</strong>
                {committed.summary?.unmatched ? <> · <span className="text-amber-700">{committed.summary.unmatched} unmatched (skipped)</span></> : null}
              </p>
              {committed.errors && committed.errors.length > 0 && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded p-2 text-xs">
                  <p className="font-medium text-red-800 mb-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Errors:</p>
                  {committed.errors.map((e, i) => (
                    <p key={i} className="text-red-700 font-mono">{e.borrower}: {e.error}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={resetAll} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
              Import another CSV
            </button>
            <button
              onClick={() => downloadChangeLog(committed, mode, protectedFields, 'arive-import-changelog.csv')}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
              title="Download a CSV of every field that was written (deal, field, old → new)"
            >
              <Download className="w-4 h-4" /> Download change log
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'emerald' | 'amber' | 'blue' | 'indigo' }) {
  const bg = tone === 'emerald' ? 'bg-emerald-50 border-emerald-200'
           : tone === 'amber'   ? 'bg-amber-50 border-amber-200'
           : tone === 'blue'    ? 'bg-blue-50 border-blue-200'
           : tone === 'indigo'  ? 'bg-indigo-50 border-indigo-200'
           :                      'bg-slate-50 border-slate-200'
  const text = tone === 'emerald' ? 'text-emerald-700'
             : tone === 'amber'   ? 'text-amber-700'
             : tone === 'blue'    ? 'text-blue-700'
             : tone === 'indigo'  ? 'text-indigo-700'
             :                      'text-slate-700'
  return (
    <div className={`border rounded-lg px-3 py-1.5 ${bg}`}>
      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold leading-none mb-0.5">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${text}`}>{value}</p>
    </div>
  )
}

function ModeOption({ active, onClick, title, desc }: {
  active: boolean
  onClick: () => void
  title: string
  desc: string
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 rounded-lg border transition-all ${
        active
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="text-[11px] text-slate-600 mt-0.5 leading-snug">{desc}</div>
    </button>
  )
}
