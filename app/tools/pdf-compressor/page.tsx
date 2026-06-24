'use client'

/**
 * PDF Compressor — 100% client-side.
 *
 * Sensitive PII never leaves the browser:
 *   • PDF parsed in-browser via pdfjs-dist
 *   • Each page rendered to canvas (optionally desaturated to grayscale)
 *   • Canvas re-encoded as JPEG at a chosen / auto-tuned quality
 *   • New PDF rebuilt with pdf-lib embedding the JPEGs (original metadata dropped)
 *   • Download served from a Blob URL — no server, no upload, no third party
 *
 * Modes:
 *   • Preset      — Aggressive / Recommended / High Quality
 *   • Target size — auto-tunes quality (then resolution) to land under an MB cap
 *   • Custom      — manual resolution (DPI) + JPEG quality sliders
 *
 * Safety: if a rebuilt PDF ends up LARGER than the source (already-optimized
 * text PDFs), the original bytes are kept instead — the tool never hands back a
 * bigger file.
 */

import { useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Upload, Download, Shield, Loader2, FileText, X,
  Gauge, Target, SlidersHorizontal, Contrast, DownloadCloud, CheckCircle2, Info,
} from 'lucide-react'

type Preset = { id: string; label: string; scale: number; quality: number; hint: string }
type Mode = 'preset' | 'target' | 'custom'

const PRESETS: Preset[] = [
  { id: 'aggressive', label: 'Aggressive',   scale: 1.0, quality: 0.50, hint: 'Smallest file — text still readable, images softer' },
  { id: 'balanced',   label: 'Recommended',  scale: 1.5, quality: 0.70, hint: 'Best size/quality balance — works for most loan docs' },
  { id: 'high',       label: 'High Quality', scale: 2.0, quality: 0.85, hint: 'Larger file — looks nearly identical to original' },
]

// Target-size search space. Quality is searched high→low; if even the lowest
// quality overshoots, resolution steps down and the search repeats.
const TARGET_QUALITIES = [0.32, 0.42, 0.52, 0.62, 0.74, 0.86]
const TARGET_SCALES = [1.5, 1.25, 1.0, 0.85]
const TARGET_CHIPS = [2, 5, 10, 15, 25] // common lender upload caps (MB)

type Status = 'idle' | 'compressing' | 'done' | 'error'

type ResultFile = {
  name: string
  originalSize: number
  newSize: number
  blobUrl: string
  pages: number
  thumb?: string
  note?: string
  optimal: boolean // true = rebuild was bigger, original kept
}

type EngineOpts =
  | { mode: 'preset' | 'custom'; scale: number; quality: number; grayscale: boolean }
  | { mode: 'target'; targetBytes: number; grayscale: boolean }

type Libs = { pdfjsLib: any; PDFDocument: any } // eslint-disable-line @typescript-eslint/no-explicit-any

class CancelledError extends Error {}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

// Approximate output DPI. A PDF point is 1/72in, so scale 1 ≈ 72 DPI.
function scaleToDpi(scale: number): number {
  return Math.round(72 * scale)
}

function dpiLabel(scale: number): string {
  const dpi = scaleToDpi(scale)
  if (scale <= 1.0) return `${dpi} DPI · screen`
  if (scale < 1.75) return `${dpi} DPI · standard`
  if (scale < 2.25) return `${dpi} DPI · print`
  return `${dpi} DPI · high detail`
}

// In-place RGB → grayscale (Rec. 601 luma). Shrinks scanned color docs a lot.
function toGrayscale(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
    d[i] = d[i + 1] = d[i + 2] = y
  }
  ctx.putImageData(img, 0, 0)
}

// Small page-1 preview so the user can eyeball quality before downloading.
function makeThumb(src: HTMLCanvasElement): string {
  const maxW = 150
  const w = Math.min(maxW, src.width || maxW)
  const h = Math.max(1, Math.round(w * ((src.height || 1) / (src.width || 1))))
  const t = document.createElement('canvas')
  t.width = w
  t.height = h
  const tctx = t.getContext('2d')!
  tctx.fillStyle = '#ffffff'
  tctx.fillRect(0, 0, w, h)
  tctx.drawImage(src, 0, 0, w, h)
  return t.toDataURL('image/jpeg', 0.7)
}

/**
 * Compress one file, fully in-browser. Returns the result + a kept-original
 * fallback when the rebuild would be larger than the source.
 */
async function compressFile(
  file: File,
  opts: EngineOpts,
  libs: Libs,
  onProgress: (page: number, pages: number, note?: string) => void,
  shouldCancel: () => boolean,
): Promise<ResultFile> {
  const { pdfjsLib, PDFDocument } = libs

  const arrayBuf = await file.arrayBuffer()
  // Copy the source bytes BEFORE handing the buffer to pdfjs (it may detach it),
  // so the keep-original fallback always has clean bytes to fall back to.
  const originalBytes = new Uint8Array(arrayBuf.slice(0))

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) }).promise
  const numPages: number = pdf.numPages

  // Render one page to a fresh canvas at the given scale (grayscale applied here).
  async function renderCanvas(pageNum: number, scale: number) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // pdfjs typings: canvasContext is the 2D context, viewport supplies geometry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport, canvas } as any).promise
    if (opts.grayscale) toGrayscale(ctx, canvas.width, canvas.height)
    // Page size in PDF points (scale-independent) so the rebuilt page keeps geometry.
    return { canvas, wPt: viewport.width / scale, hPt: viewport.height / scale }
  }

  function encode(canvas: HTMLCanvasElement, q: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        async b => b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Canvas toBlob returned null')),
        'image/jpeg',
        q,
      )
    })
  }

  type PageImage = { bytes: Uint8Array; wPt: number; hPt: number }
  let pageImages: PageImage[] = []
  let thumb: string | undefined
  let note: string | undefined

  if (opts.mode === 'target') {
    // Render each page once per scale, encode at every candidate quality, then
    // pick the highest global quality whose total fits under the target.
    const overhead = 1.04 // pdf container/object-stream headroom
    let fitted = false

    for (let si = 0; si < TARGET_SCALES.length && !fitted; si++) {
      const scale = TARGET_SCALES[si]
      const perQ: Uint8Array[][] = TARGET_QUALITIES.map(() => [])
      const dims: { wPt: number; hPt: number }[] = []

      for (let p = 1; p <= numPages; p++) {
        if (shouldCancel()) throw new CancelledError()
        onProgress(p, numPages, `Targeting ${formatBytes(opts.targetBytes)} — analyzing page ${p}/${numPages}`)
        const { canvas, wPt, hPt } = await renderCanvas(p, scale)
        dims.push({ wPt, hPt })
        if (p === 1 && si === 0) thumb = makeThumb(canvas)
        for (let qi = 0; qi < TARGET_QUALITIES.length; qi++) {
          perQ[qi].push(await encode(canvas, TARGET_QUALITIES[qi]))
        }
        canvas.width = 0
        canvas.height = 0
      }

      let chosenQi = -1
      for (let qi = TARGET_QUALITIES.length - 1; qi >= 0; qi--) {
        const total = perQ[qi].reduce((s, b) => s + b.byteLength, 0) * overhead
        if (total <= opts.targetBytes) { chosenQi = qi; break }
      }

      if (chosenQi >= 0) {
        pageImages = perQ[chosenQi].map((bytes, i) => ({ bytes, wPt: dims[i].wPt, hPt: dims[i].hPt }))
        note = `Hit target — ${Math.round(TARGET_QUALITIES[chosenQi] * 100)}% quality` + (scale < 1.5 ? `, ${scaleToDpi(scale)} DPI` : '')
        fitted = true
      } else if (si === TARGET_SCALES.length - 1) {
        // Exhausted the search — hand back the smallest we could make.
        pageImages = perQ[0].map((bytes, i) => ({ bytes, wPt: dims[i].wPt, hPt: dims[i].hPt }))
        note = `Couldn't reach ${formatBytes(opts.targetBytes)} — this is the smallest at readable quality`
      }
      // otherwise: drop to the next-smaller resolution and try again
    }
  } else {
    // Preset / Custom: one fixed scale + quality, page by page (low memory).
    for (let p = 1; p <= numPages; p++) {
      if (shouldCancel()) throw new CancelledError()
      onProgress(p, numPages)
      const { canvas, wPt, hPt } = await renderCanvas(p, opts.scale)
      if (p === 1) thumb = makeThumb(canvas)
      const bytes = await encode(canvas, opts.quality)
      pageImages.push({ bytes, wPt, hPt })
      canvas.width = 0
      canvas.height = 0
    }
  }

  // Rebuild the PDF from the JPEG pages. A fresh document carries none of the
  // source metadata; we stamp only a neutral producer string.
  const newPdf = await PDFDocument.create()
  newPdf.setProducer('Lumin Tools — PDF Compressor')
  newPdf.setCreator('Lumin Tools')
  for (const pg of pageImages) {
    const jpg = await newPdf.embedJpg(pg.bytes)
    const np = newPdf.addPage([pg.wPt, pg.hPt])
    np.drawImage(jpg, { x: 0, y: 0, width: pg.wPt, height: pg.hPt })
  }
  const newBytes: Uint8Array = await newPdf.save({ useObjectStreams: true })

  // Never hand back a bigger file than the source.
  let finalBytes = newBytes
  let optimal = false
  if (newBytes.byteLength >= file.size) {
    finalBytes = originalBytes
    optimal = true
    note = 'Already well-compressed — kept your original (smaller) file'
  }

  // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing across runtimes.
  const buf = new ArrayBuffer(finalBytes.byteLength)
  new Uint8Array(buf).set(finalBytes)
  const blob = new Blob([buf], { type: 'application/pdf' })

  return {
    name: file.name.replace(/\.pdf$/i, '') + (optimal ? '.pdf' : '-compressed.pdf'),
    originalSize: file.size,
    newSize: optimal ? file.size : blob.size,
    blobUrl: URL.createObjectURL(blob),
    pages: numPages,
    thumb,
    note,
    optimal,
  }
}

export default function PdfCompressorPage() {
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<Mode>('preset')
  const [preset, setPreset] = useState<Preset>(PRESETS[1])
  const [customScale, setCustomScale] = useState(1.5)
  const [customQuality, setCustomQuality] = useState(0.7)
  const [targetMB, setTargetMB] = useState(5)
  const [grayscale, setGrayscale] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<{ current: number; total: number; page: number; pages: number; note?: string } | null>(null)
  const [results, setResults] = useState<ResultFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)

  const busy = status === 'compressing'

  function addFiles(incoming: FileList | File[]) {
    const pdfs = Array.from(incoming).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (!pdfs.length) return
    setFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}:${f.size}`))
      const merged = [...prev]
      for (const f of pdfs) {
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

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files)
    if (inputRef.current) inputRef.current.value = '' // allow re-picking the same file
  }

  function onDropFiles(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
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
    // Free any previous result blobs before a new run.
    results.forEach(r => URL.revokeObjectURL(r.blobUrl))
    cancelRef.current = false
    setStatus('compressing')
    setError(null)
    setCancelled(false)
    setResults([])

    const opts = buildOpts()
    const out: ResultFile[] = []

    try {
      // Dynamic imports keep pdf-lib + pdfjs out of the SSR bundle.
      const pdfjsLib = await import('pdfjs-dist')
      const { PDFDocument } = await import('pdf-lib')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
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
        setResults([...out]) // show finished files as they land
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
    if (inputRef.current) inputRef.current.value = ''
  }

  function downloadAll() {
    // No zip dependency — trigger each blob download in sequence.
    results.forEach((r, i) => {
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = r.blobUrl
        a.download = r.name
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 250)
    })
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
            All processing runs locally in JavaScript. No upload, no server, no third party. Safe for SSNs, paystubs, tax returns, and any other PII. Original document metadata is stripped from the output.
          </p>
        </div>
      </div>

      {/* Compression controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        {/* Mode tabs */}
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

        {/* Preset mode */}
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

        {/* Target-size mode */}
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

        {/* Custom mode */}
        {mode === 'custom' && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resolution</label>
                <span className="text-xs font-medium text-slate-700">{dpiLabel(customScale)}</span>
              </div>
              <input
                type="range"
                min={0.75} max={2.5} step={0.05}
                value={customScale}
                disabled={busy}
                onChange={e => setCustomScale(Number(e.target.value))}
                className="w-full accent-blue-600 disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
                <span>Smaller</span><span>Sharper</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Image quality</label>
                <span className="text-xs font-medium text-slate-700">{Math.round(customQuality * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.3} max={0.95} step={0.05}
                value={customQuality}
                disabled={busy}
                onChange={e => setCustomQuality(Number(e.target.value))}
                className="w-full accent-blue-600 disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
                <span>Smaller</span><span>Cleaner</span>
              </div>
            </div>
          </div>
        )}

        {/* Grayscale toggle (applies to every mode) */}
        <label className={['flex items-center gap-2.5 pt-1', busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'].join(' ')}>
          <input
            type="checkbox"
            checked={grayscale}
            disabled={busy}
            onChange={e => setGrayscale(e.target.checked)}
            className="w-4 h-4 accent-blue-600"
          />
          <Contrast className="w-4 h-4 text-slate-500" />
          <span className="text-sm text-slate-700">Convert to grayscale</span>
          <span className="text-[11px] text-slate-400">— big extra savings on scanned color docs</span>
        </label>
      </div>

      {/* Honest note about rasterization */}
      <div className="flex items-start gap-2 text-[11px] text-slate-500 px-1">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
        <span>Pages are flattened to images, so the output isn&apos;t text-selectable. Ideal for uploading and sharing — keep the original if you need to copy text or edit it.</span>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDropFiles}
        className={[
          'border-2 border-dashed rounded-xl p-8 text-center transition-colors',
          dragging ? 'border-blue-400 bg-blue-50' : 'bg-white border-slate-300 hover:border-blue-400',
        ].join(' ')}
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
          <div className="text-xs text-slate-400">Multiple files OK — drop more to add to the list</div>
        </label>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {files.length} {files.length === 1 ? 'file' : 'files'} selected
            </h3>
            {!busy && (
              <button onClick={() => setFiles([])} className="text-xs text-slate-400 hover:text-slate-700">Clear all</button>
            )}
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
                <button onClick={cancel} className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                  Cancel
                </button>
              </>
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
            <div className="flex items-center gap-3">
              {results.length > 1 && (
                <button onClick={downloadAll} className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
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

          {/* Summary */}
          {results.length > 1 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3 flex items-center justify-between text-sm">
              <span className="text-emerald-900">
                <strong>{results.length} files</strong> · {formatBytes(totalOrig)} → {formatBytes(totalNew)}
              </span>
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
                        {r.optimal && <CheckCircle2 className="w-3 h-3 text-emerald-500" />}
                        {r.note}
                      </div>
                    )}
                  </div>
                  <a
                    href={r.blobUrl}
                    download={r.name}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shrink-0"
                  >
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
