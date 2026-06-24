/**
 * Smart-hybrid PDF compression engine — 100% client-side.
 *
 * Per page, the engine decides:
 *   • KEEP    — text/vector pages are copied as-is via pdf-lib (crisp, still
 *               selectable, usually smaller than any rasterized version)
 *   • RASTER  — scanned / image-heavy pages are rendered and re-encoded as JPEG
 *               using MozJPEG (better quality-per-byte), with the browser's
 *               native JPEG encoder as a fallback if the WASM module can't load.
 *
 * This keeps quality high (text never gets blurred into an image) while
 * compressing the parts that actually benefit. If the rebuilt file ends up
 * larger than the source, the original bytes are kept instead.
 */

import { CancelledError, formatBytes } from './shared'

export type Preset = { id: string; label: string; scale: number; quality: number; hint: string }
export type Mode = 'preset' | 'target' | 'custom'

// Resolution bumped vs the old presets (old "Recommended" was only ~108 DPI).
// A PDF point is 1/72in, so scale 1 ≈ 72 DPI.
export const PRESETS: Preset[] = [
  { id: 'aggressive', label: 'Aggressive',   scale: 1.5, quality: 0.55, hint: 'Smallest file — 108 DPI, images softer' },
  { id: 'balanced',   label: 'Recommended',  scale: 2.0, quality: 0.72, hint: 'Crisp & compact — 144 DPI, great for most loan docs' },
  { id: 'high',       label: 'High Quality', scale: 2.5, quality: 0.85, hint: 'Sharpest — 180 DPI, looks like the original' },
]

export const TARGET_QUALITIES = [0.32, 0.42, 0.52, 0.62, 0.74, 0.86]
export const TARGET_SCALES = [2.0, 1.5, 1.25, 1.0]
export const TARGET_CHIPS = [2, 5, 10, 15, 25] // common lender upload caps (MB)

// Only swap a kept (vector) page for a rasterized one when raster is clearly
// smaller — biases toward keeping text crisp.
const RASTER_GAIN = 0.9

export type Status = 'idle' | 'compressing' | 'done' | 'error'

export type ResultFile = {
  name: string
  originalSize: number
  newSize: number
  blobUrl: string
  pages: number
  keptPages: number
  rasterPages: number
  usedMozjpeg: boolean
  thumb?: string
  note?: string
  optimal: boolean
}

export type EngineOpts =
  | { mode: 'preset' | 'custom'; scale: number; quality: number; grayscale: boolean }
  | { mode: 'target'; targetBytes: number; grayscale: boolean }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Libs = { pdfjsLib: any; PDFDocument: any }

export function scaleToDpi(scale: number): number {
  return Math.round(72 * scale)
}

export function dpiLabel(scale: number): string {
  const dpi = scaleToDpi(scale)
  if (scale <= 1.0) return `${dpi} DPI · screen`
  if (scale < 1.75) return `${dpi} DPI · standard`
  if (scale < 2.25) return `${dpi} DPI · print`
  return `${dpi} DPI · high detail`
}

// ── MozJPEG encoder (lazy, cached). undefined = untried, null = unavailable ──
const MOZ_GRAYSCALE = 1 // MozJpegColorSpace.GRAYSCALE
const MOZ_YCBCR = 3 // MozJpegColorSpace.YCbCr
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mozEncode: ((data: ImageData, opts?: any) => Promise<ArrayBuffer>) | null | undefined

async function getMozEncode() {
  if (mozEncode !== undefined) return mozEncode
  try {
    const mod = await import('@jsquash/jpeg')
    mozEncode = mod.encode
  } catch {
    mozEncode = null
  }
  return mozEncode
}

function toGrayscale(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
    d[i] = d[i + 1] = d[i + 2] = y
  }
  ctx.putImageData(img, 0, 0)
}

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

export async function compressFile(
  file: File,
  opts: EngineOpts,
  libs: Libs,
  onProgress: (page: number, pages: number, note?: string) => void,
  shouldCancel: () => boolean,
): Promise<ResultFile> {
  const { pdfjsLib, PDFDocument } = libs

  const arrayBuf = await file.arrayBuffer()
  // Copy source bytes BEFORE handing the buffer to pdfjs (it may detach it).
  const originalBytes = new Uint8Array(arrayBuf.slice(0))

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) }).promise
  const numPages: number = pdf.numPages
  // pdf-lib copy of the source, used to keep (copyPages) vector/text pages.
  const src = await PDFDocument.load(originalBytes, { ignoreEncryption: true })

  // ── per-page helpers ──
  async function pageHasImage(pageNum: number): Promise<boolean> {
    try {
      const page = await pdf.getPage(pageNum)
      const ol = await page.getOperatorList()
      const OPS = pdfjsLib.OPS
      const imgOps = [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintJpegXObject,
      ].filter((x: number | undefined) => x !== undefined)
      const set = new Set<number>(imgOps)
      return ol.fnArray.some((fn: number) => set.has(fn))
    } catch {
      return true // on failure, treat as image → rasterize (still produces output)
    }
  }

  async function renderCanvas(pageNum: number, scale: number, applyGray: boolean) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport, canvas } as any).promise
    if (applyGray) toGrayscale(ctx, canvas.width, canvas.height)
    return { canvas, ctx, wPt: viewport.width / scale, hPt: viewport.height / scale }
  }

  // Encode a canvas to JPEG bytes; prefer MozJPEG, fall back to native toBlob.
  async function encodeJpeg(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    quality: number,
    grayscale: boolean,
  ): Promise<{ bytes: Uint8Array; moz: boolean }> {
    const enc = await getMozEncode()
    if (enc) {
      try {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const buf = await enc(img, {
          quality: Math.max(1, Math.min(100, Math.round(quality * 100))),
          color_space: grayscale ? MOZ_GRAYSCALE : MOZ_YCBCR,
          optimize_coding: true,
        })
        return { bytes: new Uint8Array(buf), moz: true }
      } catch {
        mozEncode = null // hard failure — stop trying for the rest of this run
      }
    }
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas toBlob returned null'))), 'image/jpeg', quality),
    )
    return { bytes: new Uint8Array(await blob.arrayBuffer()), moz: false }
  }

  async function measurePageBytes(idx: number): Promise<number> {
    const tmp = await PDFDocument.create()
    const [pg] = await tmp.copyPages(src, [idx])
    tmp.addPage(pg)
    const b = await tmp.save({ useObjectStreams: true })
    return b.byteLength
  }

  async function keepPage(out: PDFDocumentLike, idx: number) {
    const [pg] = await out.copyPages(src, [idx])
    out.addPage(pg)
  }

  // ── build the output ──
  const out = await PDFDocument.create()
  out.setProducer('Lumin Tools — PDF Compressor')
  out.setCreator('Lumin Tools')

  let keptPages = 0
  let rasterPages = 0
  let usedMoz = false
  let thumb: string | undefined
  let note: string | undefined

  if (opts.mode === 'target') {
    const cls: boolean[] = []
    for (let p = 1; p <= numPages; p++) cls[p - 1] = await pageHasImage(p)

    const overhead = 1.05
    let trueFit = false
    let built = false

    for (let si = 0; si < TARGET_SCALES.length && !built; si++) {
      const scale = TARGET_SCALES[si]
      const imagePages: { p: number; perQ: Uint8Array[]; wPt: number; hPt: number }[] = []
      let keptEstimate = 0

      for (let p = 1; p <= numPages; p++) {
        if (shouldCancel()) throw new CancelledError()
        onProgress(p, numPages, `Targeting ${formatBytes(opts.targetBytes)} — analyzing page ${p}/${numPages}`)
        if (!cls[p - 1]) {
          keptEstimate += await measurePageBytes(p - 1)
          if (p === 1 && si === 0) {
            const { canvas } = await renderCanvas(p, 0.5, false)
            thumb = makeThumb(canvas)
            canvas.width = 0; canvas.height = 0
          }
          continue
        }
        const { canvas, ctx, wPt, hPt } = await renderCanvas(p, scale, opts.grayscale)
        if (p === 1 && si === 0) thumb = makeThumb(canvas)
        const perQ: Uint8Array[] = []
        for (const q of TARGET_QUALITIES) {
          const { bytes, moz } = await encodeJpeg(canvas, ctx, q, opts.grayscale)
          usedMoz = usedMoz || moz
          perQ.push(bytes)
        }
        canvas.width = 0; canvas.height = 0
        imagePages.push({ p, perQ, wPt, hPt })
      }

      // Choose the highest quality whose estimated total fits under the target.
      let qi = -1
      for (let i = TARGET_QUALITIES.length - 1; i >= 0; i--) {
        const total = (keptEstimate + imagePages.reduce((s, ip) => s + ip.perQ[i].byteLength, 0)) * overhead
        if (total <= opts.targetBytes) { qi = i; break }
      }
      if (qi < 0 && si < TARGET_SCALES.length - 1) continue // try a smaller resolution
      if (qi < 0) qi = 0
      else trueFit = true

      const imgByP = new Map(imagePages.map(ip => [ip.p, ip]))
      for (let p = 1; p <= numPages; p++) {
        if (!cls[p - 1]) {
          await keepPage(out, p - 1)
          keptPages++
        } else {
          const ip = imgByP.get(p)!
          const jpg = await out.embedJpg(ip.perQ[qi])
          const np = out.addPage([ip.wPt, ip.hPt])
          np.drawImage(jpg, { x: 0, y: 0, width: ip.wPt, height: ip.hPt })
          rasterPages++
        }
      }
      note = trueFit
        ? `Hit target — ${Math.round(TARGET_QUALITIES[qi] * 100)}% quality`
        : `Couldn't reach ${formatBytes(opts.targetBytes)} — smallest at readable quality`
      built = true
    }
  } else {
    for (let p = 1; p <= numPages; p++) {
      if (shouldCancel()) throw new CancelledError()
      onProgress(p, numPages)

      if (!(await pageHasImage(p))) {
        await keepPage(out, p - 1)
        keptPages++
        if (p === 1) {
          const { canvas } = await renderCanvas(p, 0.5, false)
          thumb = makeThumb(canvas)
          canvas.width = 0; canvas.height = 0
        }
        continue
      }

      const { canvas, ctx, wPt, hPt } = await renderCanvas(p, opts.scale, opts.grayscale)
      if (p === 1) thumb = makeThumb(canvas)
      const { bytes, moz } = await encodeJpeg(canvas, ctx, opts.quality, opts.grayscale)
      usedMoz = usedMoz || moz
      const keptBytes = await measurePageBytes(p - 1)
      canvas.width = 0; canvas.height = 0

      if (bytes.byteLength < keptBytes * RASTER_GAIN) {
        const jpg = await out.embedJpg(bytes)
        const np = out.addPage([wPt, hPt])
        np.drawImage(jpg, { x: 0, y: 0, width: wPt, height: hPt })
        rasterPages++
      } else {
        await keepPage(out, p - 1)
        keptPages++
      }
    }
  }

  const newBytes: Uint8Array = await out.save({ useObjectStreams: true })

  // Never hand back a bigger file than the source.
  let finalBytes = newBytes
  let optimal = false
  if (newBytes.byteLength >= file.size) {
    finalBytes = originalBytes
    optimal = true
    note = 'Already well-compressed — kept your original (smaller) file'
  } else if (!note) {
    // Compose a hybrid summary so the user can see what happened.
    if (keptPages > 0 && rasterPages > 0) {
      note = `${keptPages} text page${keptPages === 1 ? '' : 's'} kept sharp · ${rasterPages} image page${rasterPages === 1 ? '' : 's'} recompressed${usedMoz ? ' (MozJPEG)' : ''}`
    } else if (rasterPages > 0 && keptPages === 0) {
      note = `${rasterPages} page${rasterPages === 1 ? '' : 's'} recompressed${usedMoz ? ' with MozJPEG' : ''}`
    } else {
      note = 'All pages kept sharp & selectable — no quality loss'
    }
  }

  const buf = new ArrayBuffer(finalBytes.byteLength)
  new Uint8Array(buf).set(finalBytes)
  const blob = new Blob([buf], { type: 'application/pdf' })

  return {
    name: file.name.replace(/\.pdf$/i, '') + (optimal ? '.pdf' : '-compressed.pdf'),
    originalSize: file.size,
    newSize: optimal ? file.size : blob.size,
    blobUrl: URL.createObjectURL(blob),
    pages: numPages,
    keptPages,
    rasterPages,
    usedMozjpeg: usedMoz,
    thumb,
    note,
    optimal,
  }
}

// Minimal structural type for the pdf-lib document we pass around.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PDFDocumentLike = any
