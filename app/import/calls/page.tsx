'use client'

/**
 * Import GHL Call Report CSVs.
 *
 * Each file must be tagged with the sub-account it came from. That tag CANNOT be
 * derived from the file: "Brianne's Number" places calls in both the Moe and Matt
 * exports (2,427 and 2,056 calls in the first real pair), so the dialing number
 * identifies neither the account nor the lead owner.
 *
 * Preview writes nothing. Apply is idempotent — re-importing the same export
 * lands 0 new rows, so it's safe to re-drop a file you're unsure about.
 */

import { useState } from 'react'
import Link from 'next/link'
import { Upload, FileUp, CheckCircle2, AlertTriangle, RefreshCw, X } from 'lucide-react'

type Account = 'moe' | 'matt'
type Loaded = { name: string; csv: string; account: Account | null }

type Summary = {
  files: Array<{ name: string; account: Account; rows: number }>
  parsed: number
  duplicates_in_payload: number
  already_stored: number
  new_rows: number
  matched_to_deal: number
  unmatched: number
  range: { start: string; end: string }
}

const ACCOUNTS: Array<{ key: Account; label: string }> = [
  { key: 'moe', label: 'Moe Sefati' },
  { key: 'matt', label: 'Matt Park' },
]

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function ImportCallsPage() {
  const [files, setFiles] = useState<Loaded[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [applied, setApplied] = useState<number | null>(null)

  const addFiles = async (list: FileList | null) => {
    if (!list) return
    setErr(null); setSummary(null); setApplied(null)
    const loaded: Loaded[] = []
    for (const f of Array.from(list)) {
      loaded.push({ name: f.name, csv: await f.text(), account: null })
    }
    setFiles(prev => [...prev, ...loaded])
  }

  const setAccount = (i: number, account: Account) => {
    setFiles(prev => prev.map((f, j) => (j === i ? { ...f, account } : f)))
    setSummary(null); setApplied(null)
  }

  const removeFile = (i: number) => {
    setFiles(prev => prev.filter((_, j) => j !== i))
    setSummary(null); setApplied(null)
  }

  const allTagged = files.length > 0 && files.every(f => f.account != null)

  const run = async (mode: 'preview' | 'apply') => {
    if (!allTagged) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/import/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          files: files.map(f => ({ name: f.name, csv: f.csv, account: f.account })),
        }),
      })
      const j = await res.json()
      if (!j.ok) throw new Error(j.error || 'import failed')
      setSummary(j.summary as Summary)
      if (mode === 'apply') setApplied((j.summary as Summary).new_rows)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mb-1">
        <FileUp className="w-6 h-6 text-blue-600" />
        Import Call Report
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        In GHL: Reporting → Call report → set the date range → export. Do this once per sub-account,
        then drop the files here. Re-importing the same export is safe — it lands 0 new rows.
      </p>

      {/* Drop zone */}
      <label
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); void addFiles(e.dataTransfer.files) }}
        className="block border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition"
      >
        <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
        <div className="text-sm text-gray-700 font-medium">Drop call-report CSVs here</div>
        <div className="text-xs text-gray-500 mt-1">or click to choose files</div>
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          className="hidden"
          onChange={e => void addFiles(e.target.files)}
        />
      </label>

      {/* Files + account tagging */}
      {files.length > 0 && (
        <div className="mt-5 space-y-2">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{f.name}</div>
                <div className="text-xs text-gray-500">{Math.round(f.csv.length / 1024)} KB</div>
              </div>
              <div className="flex items-center gap-1.5">
                {ACCOUNTS.map(a => (
                  <button
                    key={a.key}
                    onClick={() => setAccount(i, a.key)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition ${
                      f.account === a.key
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <button onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-600 p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          {!allTagged && (
            <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                Tag every file with the sub-account it was exported from. It can&apos;t be detected
                automatically — the same dialing number appears in both accounts&apos; exports.
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => void run('preview')}
              disabled={!allTagged || busy}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
              Preview
            </button>
            <button
              onClick={() => void run('apply')}
              disabled={!allTagged || busy || !summary}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply import
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          <div className="font-semibold mb-1">Import failed</div>
          <div className="font-mono text-xs break-all">{err}</div>
          {err.includes('calls') && (
            <div className="mt-2">
              If the <code>calls</code> table doesn&apos;t exist yet, run <code>supabase-calls.sql</code> in the
              Supabase SQL editor first.
            </div>
          )}
        </div>
      )}

      {summary && (
        <div className="mt-5 bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 font-semibold text-gray-900">
            {applied != null ? 'Imported' : 'Preview'} · {fmtDate(summary.range.start)} → {fmtDate(summary.range.end)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-gray-100">
            {[
              ['Rows parsed', summary.parsed.toLocaleString()],
              ['New', summary.new_rows.toLocaleString()],
              ['Already stored', summary.already_stored.toLocaleString()],
              ['Matched to a deal', `${summary.matched_to_deal.toLocaleString()} (${
                summary.parsed ? Math.round((summary.matched_to_deal / (summary.matched_to_deal + summary.unmatched)) * 100) : 0
              }%)`],
            ].map(([label, val]) => (
              <div key={label} className="px-4 py-3">
                <div className="text-xs text-gray-500">{label}</div>
                <div className="text-lg font-semibold text-gray-900">{val}</div>
              </div>
            ))}
          </div>
          {summary.duplicates_in_payload > 0 && (
            <div className="px-5 py-2.5 text-xs text-gray-500 border-t border-gray-100">
              {summary.duplicates_in_payload} duplicate row(s) inside the upload collapsed to one.
            </div>
          )}
          {applied != null && (
            <div className="px-5 py-3 border-t border-gray-100 bg-green-50 text-sm text-green-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Import applied. <Link href="/calls" className="underline font-medium">View the call report →</Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
