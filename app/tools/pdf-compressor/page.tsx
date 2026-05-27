'use client'

/**
 * PDF Compressor — 100% client-side.
 *
 * Sensitive PII never leaves the browser:
 *   • PDF parsed in-browser via pdfjs-dist
 *   • Each page rendered to canvas
 *   • Canvas re-encoded as JPEG at user-chosen quality
 *   • New PDF rebuilt with pdf-lib embedding the JPEGs
 *   • Download served from a Blob URL — no server, no upload, no third party
 */

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Upload, Download, Shield, Loader2, FileText, X } from 'lucide-react'

type Preset = { id: string; label: string; scale: number; quality: number; hint: string }

const PRESETS: Preset[] = [
  { id: 'aggressive', label: 'Aggressive',   scale: 1.0, quality: 0.50, hint: 'Smallest file — text still readable, images softer' },
  { id: 'balanced',   label: 'Recommended',  scale: 1.5, quality: 0.70, hint: 'Best size/quality balance — works for most loan docs' },
  { id: 'high',       label: 'High Quality', scale: 2.0, quality: 0.85, hint: 'Larger file — looks nearly identical to original' },
]

type Status = 'idle' | 'compressing' | 'done' | 'error'

type ResultFile = {
  name: string
  originalSize: number
  blobUrl: string
  newSize: number
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

export default function PdfCompressorPage() {
  const [files, setFiles] = useState<File[]>([])
  const [preset, setPreset] = useState<Preset>(PRESETS[1])
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<{ current: number; total: number; page: number; pages: number } | null>(null)
  const [results, setResults] = useState<ResultFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files || []).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    setFiles(list)
    setResults([])
    setError(null)
    setStatus('idle')
  }

  function onDropFiles(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const list = Array.from(e.dataTransfer.files || []).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (list.length) {
      setFiles(list)
      setResults([])
      setError(null)
      setStatus('idle')
    }
  }

  function removeFile(idx: number) {
    setFiles(files.filter((_, i) => i !== idx))
  }

  async function compressAll() {
    if (!files.length) return
    setStatus('compressing')
    setError(null)
    setResults([])

    try {
      // Dynamic imports keep pdf-lib + pdfjs out of the SSR bundle.
      const pdfjsLib = await import('pdfjs-dist')
      const { PDFDocument } = await import('pdf-lib')

      // Worker (copied to /public/pdf.worker.min.mjs at build prep)
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

      const out: ResultFile[] = []

      for (let f = 0; f < files.length; f++) {
        const file = files[f]
        const arrayBuf = await file.arrayBuffer()

        // pdfjs accepts Uint8Array — copy to detach from the original ArrayBuffer.
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) })
        const pdfDoc = await loadingTask.promise

        const newPdf = await PDFDocument.create()

        for (let p = 1; p <= pdfDoc.numPages; p++) {
          setProgress({ current: f + 1, total: files.length, page: p, pages: pdfDoc.numPages })

          const page = await pdfDoc.getPage(p)
          const viewport = page.getViewport({ scale: preset.scale })

          // Render to canvas
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          const ctx = canvas.getContext('2d', { alpha: false })!
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)

          // pdfjs typings: canvasContext is the 2D context, viewport supplies geometry
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.render({ canvasContext: ctx as any, viewport, canvas } as any).promise

          // Canvas → JPEG blob
          const jpegBlob: Blob = await new Promise((resolve, reject) => {
            canvas.toBlob(
              b => b ? resolve(b) : reject(new Error('Canvas toBlob returned null')),
              'image/jpeg',
              preset.quality,
            )
          })
          const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer())

          const jpgImage = await newPdf.embedJpg(jpegBytes)
          // Preserve original aspect by using the pdfjs viewport dimensions divided back by scale
          const w = viewport.width / preset.scale
          const h = viewport.height / preset.scale
          const newPage = newPdf.addPage([w, h])
          newPage.drawImage(jpgImage, { x: 0, y: 0, width: w, height: h })

          // Help the GC free canvas memory between pages
          canvas.width = 0
          canvas.height = 0
        }

        const newPdfBytes = await newPdf.save({ useObjectStreams: true })
        // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing across runtimes.
        const buf = new ArrayBuffer(newPdfBytes.byteLength)
        new Uint8Array(buf).set(newPdfBytes)
        const blob = new Blob([buf], { type: 'application/pdf' })
        const blobUrl = URL.createObjectURL(blob)

        out.push({
          name: file.name.replace(/\.pdf$/i, '') + '-compressed.pdf',
          originalSize: file.size,
          newSize: blob.size,
          blobUrl,
        })
      }

      setResults(out)
      setStatus('done')
      setProgress(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('PDF compression failed:', err)
      setError(msg)
      setStatus('error')
      setProgress(null)
    }
  }

  function reset() {
    // Revoke blob URLs to free memory
    results.forEach(r => URL.revokeObjectURL(r.blobUrl))
    setFiles([])
    setResults([])
    setStatus('idle')
    setError(null)
    setProgress(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const totalOrig = results.reduce((s, r) => s + r.originalSize, 0)
  const totalNew = results.reduce((s, r) => s + r.newSize, 0)
  const totalSaved = totalOrig - totalNew
  const totalPct = totalOrig ? Math.round((totalSaved / totalOrig) * 100) : 0

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Back link */}
      <Link href="/tools" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Tools
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">PDF Compressor</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Shrink PDF file size — 100% in your browser. Great for loan docs, paystubs, bank statements.
        </p>
      </div>

      {/* Security badge */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-start gap-2.5">
        <Shield className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
        <div className="text-xs text-emerald-900">
          <p className="font-semibold mb-0.5">100% private — your files never leave this browser.</p>
          <p className="text-emerald-800">
            All processing runs locally in JavaScript. No upload, no server, no third party. Safe for SSNs, paystubs, tax returns, and any other PII.
          </p>
        </div>
      </div>

      {/* Quality preset */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Compression Level</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {PRESETS.map(p => {
            const active = preset.id === p.id
            return (
              <button
                key={p.id}
                onClick={() => setPreset(p)}
                disabled={status === 'compressing'}
                className={[
                  'text-left p-3 rounded-lg border transition-all',
                  active
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                    : 'border-slate-200 bg-white hover:border-slate-300',
                  status === 'compressing' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                ].join(' ')}
              >
                <div className="text-sm font-semibold text-slate-900">{p.label}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{p.hint}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={onDropFiles}
        className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors"
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={onPickFiles}
          className="hidden"
          id="pdf-input"
        />
        <label htmlFor="pdf-input" className="cursor-pointer inline-flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
            <Upload className="w-5 h-5 text-blue-600" />
          </div>
          <div className="text-sm font-medium text-slate-700">
            Drop PDFs here, or <span className="text-blue-600 underline">browse files</span>
          </div>
          <div className="text-xs text-slate-400">Multiple files OK — they&apos;ll be processed one by one</div>
        </label>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            {files.length} {files.length === 1 ? 'file' : 'files'} selected
          </h3>
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="flex-1 truncate text-slate-700">{f.name}</span>
                <span className="text-xs text-slate-400 shrink-0">{formatBytes(f.size)}</span>
                {status !== 'compressing' && (
                  <button
                    onClick={() => removeFile(i)}
                    className="text-slate-300 hover:text-red-500"
                    title="Remove"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-slate-100">
            {status === 'compressing' ? (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="w-4 h-4 animate-spin" />
                {progress && (
                  <span>
                    Compressing file {progress.current} of {progress.total} — page {progress.page} / {progress.pages}…
                  </span>
                )}
              </div>
            ) : (
              <button
                onClick={compressAll}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                Compress {files.length === 1 ? 'PDF' : `${files.length} PDFs`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Compression failed</p>
          <p className="text-xs mt-1 font-mono">{error}</p>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Results</h3>
            <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-800">
              Start over
            </button>
          </div>

          {/* Summary */}
          {results.length > 1 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3 flex items-center justify-between text-sm">
              <span className="text-emerald-900">
                <strong>{results.length} files</strong> · {formatBytes(totalOrig)} → {formatBytes(totalNew)}
              </span>
              <span className="font-semibold text-emerald-700">−{totalPct}%</span>
            </div>
          )}

          <div className="space-y-2">
            {results.map((r, i) => {
              const saved = r.originalSize - r.newSize
              const pct = r.originalSize ? Math.round((saved / r.originalSize) * 100) : 0
              const grew = saved < 0
              return (
                <div key={i} className="flex items-center gap-3 p-2.5 border border-slate-100 rounded-lg">
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{r.name}</div>
                    <div className="text-xs text-slate-500">
                      {formatBytes(r.originalSize)} → {formatBytes(r.newSize)}{' '}
                      <span className={grew ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                        {grew ? `+${Math.abs(pct)}%` : `−${pct}%`}
                      </span>
                    </div>
                  </div>
                  <a
                    href={r.blobUrl}
                    download={r.name}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                </div>
              )
            })}
          </div>

          {results.some(r => r.newSize > r.originalSize) && (
            <p className="text-[11px] text-amber-700 mt-3">
              Note: some files got bigger. This happens when the original PDF was already heavily compressed text — try a more aggressive preset, or keep the original.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
