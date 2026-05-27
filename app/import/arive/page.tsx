'use client'

import { useState, useRef } from 'react'
import { Upload, FileText, X, Check, AlertTriangle, Loader2, Shield, ChevronDown, ChevronRight } from 'lucide-react'

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
  const inputRef = useRef<HTMLInputElement>(null)

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
        body: JSON.stringify({ csv: csvText, mode, createUnmatched }),
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

  // Recompute the action counts under the current mode so the bottom summary
  // reflects the user's selected mode without re-fetching.
  const recountedSummary = preview?.plans ? (() => {
    let fill = 0, overwrite = 0, unchanged = 0
    for (const p of preview.plans) {
      if (!p.matched) continue
      for (const c of p.changes) {
        if (c.action === 'fill') fill++
        else if (c.action === 'overwrite') {
          if (mode === 'overwrite') overwrite++; else unchanged++
        } else unchanged++
      }
    }
    return { fill, overwrite, unchanged }
  })() : null

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

          {/* Row plans */}
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="px-4 py-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Per-row preview</h3>
              <span className="text-[11px] text-slate-400">Click a row to see field-by-field changes</span>
            </div>
            {preview.plans?.map(p => {
              const expanded = expandedRows.has(p.rowIndex)
              const visibleChanges = mode === 'overwrite'
                ? p.changes.filter(c => c.action !== 'unchanged')
                : p.changes.filter(c => c.action === 'fill')
              const willWriteCount = visibleChanges.length
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
                  {expanded && (p.matched || p.action === 'create_new') && (
                    <div className="mt-2 ml-7 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      {p.changes.length === 0 ? (
                        <span className="text-slate-400 italic">No mappable fields had values.</span>
                      ) : (
                        p.changes.map((c, i) => {
                          const willWrite = c.action === 'fill' || (c.action === 'overwrite' && mode === 'overwrite')
                          const cls = !willWrite ? 'text-slate-400' : c.action === 'overwrite' ? 'text-amber-700' : 'text-emerald-700'
                          return (
                            <div key={i} className={`flex items-center gap-2 ${cls}`}>
                              <span className="font-mono text-[10px] uppercase text-slate-400 w-32 shrink-0 truncate">{c.field}</span>
                              <span className="text-slate-500 truncate">{fmt(c.current)}</span>
                              <span className="text-slate-300">→</span>
                              <span className={`truncate font-medium ${willWrite ? '' : 'line-through opacity-60'}`}>{fmt(c.next)}</span>
                              {!willWrite && <span className="text-[9px] uppercase text-slate-400 ml-auto">skipped</span>}
                            </div>
                          )
                        })
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
              onClick={resetAll}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
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
