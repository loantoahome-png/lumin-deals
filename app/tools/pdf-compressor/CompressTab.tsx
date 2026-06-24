'use client'

/**
 * Compress tab — smart-hybrid, 100% client-side.
 * Engine lives in ./compressEngine (keeps text pages crisp, recompresses image
 * pages with MozJPEG). This file is the UI + orchestration only.
 */

import { useRef, useState } from 'react'
import {
  Download, Loader2, FileText, X, Gauge, Target, SlidersHorizontal,
  Contrast, DownloadCloud, CheckCircle2, Info, Sparkles,
} from 'lucide-react'
import {
  CancelledError, Dropzone, formatBytes, loadPdfLib, loadPdfjs, downloadUrl,
} from './shared'
import {
  compressFile, PRESETS, TARGET_CHIPS, dpiLabel,
  type Preset, type Mode, type Status, type EngineOpts, type ResultFile, type Libs,
} from './compressEngine'

export default function CompressTab() {
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<Mode>('preset')
  const [preset, setPreset] = useState<Preset>(PRESETS[1])
  const [customScale, setCustomScale] = useState(2.0)
  const [customQuality, setCustomQuality] = useState(0.72)
  const [targetMB, setTargetMB] = useState(5)
  const [grayscale, setGrayscale] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<{ current: number; total: number; page: number; pages: number; note?: string } | null>(null)
  const [results, setResults] = useState<ResultFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const cancelRef = useRef(false)

  const busy = status === 'compressing'

  function addFiles(incoming: File[]) {
    setFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}:${f.size}`))
      const merged = [...prev]
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`
        if (!seen.has(key)) { seen.add(key); merged.push(f) }
      }
      return merged
    })
    setResults([])
    setError(null)
    setCancelled(false)
    setStatus('idle')
  }

  function removeFile(idx: number) {
    setFiles(files.filter((_, i) => i !== idx))
  }

  function buildOpts(): EngineOpts {
    if (mode === 'preset') return { mode: 'preset', scale: preset.scale, quality: preset.quality, grayscale }
    if (mode === 'custom') return { mode: 'custom', scale: customScale, quality: customQuality, grayscale }
    return { mode: 'target', targetBytes: Math.max(0.2, targetMB) * 1024 * 1024, grayscale }
  }

  async function compressAll() {
    if (!files.length) return
    results.forEach(r => URL.revokeObjectURL(r.blobUrl))
    cancelRef.current = false
    setStatus('compressing')
    setError(null)
    setCancelled(false)
    setResults([])

    const opts = buildOpts()
    const out: ResultFile[] = []

    try {
      const pdfjsLib = await loadPdfjs()
      const { PDFDocument } = await loadPdfLib()
      const libs: Libs = { pdfjsLib, PDFDocument }

      for (let f = 0; f < files.length; f++) {
        if (cancelRef.current) throw new CancelledError()
        const res = await compressFile(
          files[f],
          opts,
          libs,
          (page, pages, note) => setProgress({ current: f + 1, total: files.length, page, pages, note }),
          () => cancelRef.current,
        )
        out.push(res)
        setResults([...out])
      }

      setStatus('done')
      setProgress(null)
    } catch (err) {
      setProgress(null)
      if (err instanceof CancelledError) {
        setCancelled(true)
        setResults([...out])
        setStatus(out.length ? 'done' : 'idle')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.error('PDF compression failed:', err)
      setError(msg)
      setStatus('error')
    }
  }

  function cancel() {
    cancelRef.current = true
  }

  function reset() {
    results.forEach(r => URL.revokeObjectURL(r.blobUrl))
    setFiles([])
    setResults([])
    setStatus('idle')
    setError(null)
    setCancelled(false)
    setProgress(null)
  }

  function downloadAllResults() {
    results.forEach((r, i) => setTimeout(() => downloadUrl(r.blobUrl, r.name), i * 250))
  }

  const totalOrig = results.reduce((s, r) => s + r.originalSize, 0)
  const totalNew = results.reduce((s, r) => s + r.newSize, 0)
  const totalSaved = totalOrig - totalNew
  const totalPct = totalOrig ? Math.round((totalSaved / totalOrig) * 100) : 0

  const MODES: { id: Mode; label: string; icon: typeof Gauge }[] = [
    { id: 'preset', label: 'Presets', icon: Gauge },
    { id: 'target', label: 'Target size', icon: Target },
    { id: 'custom', label: 'Custom', icon: SlidersHorizontal },
  ]

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
          {MODES.map(m => {
            const active = mode === m.id
            const Icon = m.icon
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                disabled={busy}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
                  busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                ].join(' ')}
              >
                <Icon className="w-3.5 h-3.5" /> {m.label}
              </button>
            )
          })}
        </div>

        {mode === 'preset' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PRESETS.map(p => {
              const active = preset.id === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => setPreset(p)}
                  disabled={busy}
                  className={[
                    'text-left p-3 rounded-lg border transition-all',
                    active ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 bg-white hover:border-slate-300',
                    busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  <div className="text-sm font-semibold text-slate-900">{p.label}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{p.hint}</div>
                </button>
              )
            })}
          </div>
        )}

        {mode === 'target' && (
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Maximum file size</label>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <input
                  type="number"
                  min={0.2}
                  step={0.5}
                  value={targetMB}
                  disabled={busy}
                  onChange={e => setTargetMB(Math.max(0.2, Number(e.target.value) || 0))}
                  className="w-28 border border-slate-200 rounded-lg pl-3 pr-10 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">MB</span>
              </div>
              {TARGET_CHIPS.map(mb => (
                <button
                  key={mb}
                  onClick={() => setTargetMB(mb)}
                  disabled={busy}
                  className={[
                    'px-2.5 py-1.5 text-xs rounded-md border transition-colors',
                    targetMB === mb ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  {mb} MB
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Each file is tuned to land just under this cap. Great for portals with upload limits (lenders are often 5–15 MB per file).
            </p>
          </div>
        )}

        {mode === 'custom' && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resolution</label>
                <span className="text-xs font-medium text-slate-700">{dpiLabel(customScale)}</span>
              </div>
              <input
                type="range" min={0.75} max={3} step={0.05}
                value={customScale}
                disabled={busy}
                onChange={e => setCustomScale(Number(e.target.value))}
                className="w-full accent-blue-600 disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-slate-400 mt-0.5"><span>Smaller</span><span>Sharper</span></div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Image quality</label>
                <span className="text-xs font-medium text-slate-700">{Math.round(customQuality * 100)}%</span>
              </div>
              <input
                type="range" min={0.3} max={0.95} step={0.05}
                value={customQuality}
                disabled={busy}
                onChange={e => setCustomQuality(Number(e.target.value))}
                className="w-full accent-blue-600 disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-slate-400 mt-0.5"><span>Smaller</span><span>Cleaner</span></div>
            </div>
          </div>
        )}

        <label className={['flex items-center gap-2.5 pt-1', busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'].join(' ')}>
          <input type="checkbox" checked={grayscale} disabled={busy} onChange={e => setGrayscale(e.target.checked)} className="w-4 h-4 accent-blue-600" />
          <Contrast className="w-4 h-4 text-slate-500" />
          <span className="text-sm text-slate-700">Convert to grayscale</span>
          <span className="text-[11px] text-slate-400">— big extra savings on scanned color docs</span>
        </label>
      </div>

      {/* Smart-hybrid explainer */}
      <div className="flex items-start gap-2 text-[11px] text-slate-500 px-1">
        <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-500" />
        <span>
          <strong className="text-slate-600">Smart compression:</strong> text pages stay sharp &amp; selectable — only scanned/image pages are recompressed (with MozJPEG for better quality at a smaller size). Keep the original if you need to edit those image pages.
        </span>
      </div>

      <Dropzone onFiles={addFiles} multiple disabled={busy} hint="Multiple files OK — drop more to add to the list" />

      {files.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {files.length} {files.length === 1 ? 'file' : 'files'} selected
            </h3>
            {!busy && <button onClick={() => setFiles([])} className="text-xs text-slate-400 hover:text-slate-700">Clear all</button>}
          </div>
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={`${f.name}:${f.size}:${i}`} className="flex items-center gap-2 text-sm">
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="flex-1 truncate text-slate-700">{f.name}</span>
                <span className="text-xs text-slate-400 shrink-0">{formatBytes(f.size)}</span>
                {!busy && (
                  <button onClick={() => removeFile(i)} className="text-slate-300 hover:text-red-500" title="Remove">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-slate-100">
            {busy ? (
              <>
                <div className="flex items-center gap-2 text-sm text-slate-600 mr-auto">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {progress && (
                    <span>
                      {progress.note ?? `Compressing — page ${progress.page} / ${progress.pages}…`}
                      {progress.total > 1 ? ` · file ${progress.current} of ${progress.total}` : ''}
                    </span>
                  )}
                </div>
                <button onClick={cancel} className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              </>
            ) : (
              <button onClick={compressAll} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                Compress {files.length === 1 ? 'PDF' : `${files.length} PDFs`}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Compression failed</p>
          <p className="text-xs mt-1 font-mono">{error}</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Results</h3>
            <div className="flex items-center gap-3">
              {results.length > 1 && (
                <button onClick={downloadAllResults} className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
                  <DownloadCloud className="w-3.5 h-3.5" /> Download all
                </button>
              )}
              <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-800">Start over</button>
            </div>
          </div>

          {cancelled && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-3 text-xs text-amber-800">
              Cancelled — showing the {results.length} {results.length === 1 ? 'file' : 'files'} that finished.
            </div>
          )}

          {results.length > 1 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3 flex items-center justify-between text-sm">
              <span className="text-emerald-900"><strong>{results.length} files</strong> · {formatBytes(totalOrig)} → {formatBytes(totalNew)}</span>
              <span className="font-semibold text-emerald-700">{totalPct >= 0 ? `−${totalPct}%` : `+${Math.abs(totalPct)}%`}</span>
            </div>
          )}

          <div className="space-y-2">
            {results.map((r, i) => {
              const saved = r.originalSize - r.newSize
              const pct = r.originalSize ? Math.round((saved / r.originalSize) * 100) : 0
              const grew = saved < 0
              return (
                <div key={i} className="flex items-center gap-3 p-2.5 border border-slate-100 rounded-lg">
                  {r.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.thumb} alt="" className="w-10 h-12 object-cover rounded border border-slate-200 bg-white shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{r.name}</div>
                    <div className="text-xs text-slate-500">
                      {formatBytes(r.originalSize)} → {formatBytes(r.newSize)}{' '}
                      {r.optimal ? (
                        <span className="text-slate-500 font-semibold">· no change</span>
                      ) : (
                        <span className={grew ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                          {grew ? `+${Math.abs(pct)}%` : `−${pct}%`}
                        </span>
                      )}
                      <span className="text-slate-400"> · {r.pages} {r.pages === 1 ? 'page' : 'pages'}</span>
                    </div>
                    {r.note && (
                      <div className="flex items-center gap-1 text-[11px] text-slate-400 mt-0.5">
                        {r.optimal ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <Sparkles className="w-3 h-3 text-blue-400" />}
                        {r.note}
                      </div>
                    )}
                  </div>
                  <a href={r.blobUrl} download={r.name} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shrink-0">
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
