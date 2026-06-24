'use client'

/**
 * Split tab — break one PDF into pieces. Lossless (pdf-lib copies page objects).
 *   • Each page → separate file
 *   • Custom range  → one PDF of the pages you list (e.g. "1-3, 7")
 *   • Every N pages  → fixed-size chunks
 */

import { useState } from 'react'
import { FileText, X, Loader2, Download, DownloadCloud, Scissors } from 'lucide-react'
import {
  Dropzone, formatBytes, baseName, loadPdfLib, fileToBytes, bytesToPdfUrl, downloadAll, parsePageRanges,
} from './shared'

type SplitMode = 'each' | 'range' | 'everyN'
type Piece = { url: string; name: string; size: number; pages: number }

export default function SplitTab() {
  const [file, setFile] = useState<File | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<SplitMode>('range')
  const [rangeInput, setRangeInput] = useState('')
  const [everyN, setEveryN] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pieces, setPieces] = useState<Piece[]>([])

  function clearPieces() {
    setPieces(prev => { prev.forEach(p => URL.revokeObjectURL(p.url)); return [] })
  }

  async function onFiles(incoming: File[]) {
    const f = incoming[0]
    if (!f) return
    clearPieces()
    setError(null)
    setFile(f)
    setPageCount(null)
    setLoading(true)
    try {
      const { PDFDocument } = await loadPdfLib()
      const doc = await PDFDocument.load(await fileToBytes(f), { ignoreEncryption: true })
      setPageCount(doc.getPageCount())
    } catch (e) {
      setError(`Couldn't open this PDF — ${e instanceof Error ? e.message : String(e)}. It may be password-protected or corrupt.`)
      setFile(null)
    } finally {
      setLoading(false)
    }
  }

  function clearAll() {
    clearPieces()
    setFile(null)
    setPageCount(null)
    setError(null)
  }

  async function split() {
    if (!file || !pageCount) return
    setBusy(true)
    setError(null)
    clearPieces()
    const base = baseName(file.name)

    try {
      const { PDFDocument } = await loadPdfLib()
      const srcBytes = await fileToBytes(file)
      const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true })

      // Build the list of page-index groups for each output file.
      let groups: number[][] = []
      if (mode === 'each') {
        groups = src.getPageIndices().map(i => [i])
      } else if (mode === 'range') {
        const pages = parsePageRanges(rangeInput, pageCount) // 1-based
        if (!pages.length) {
          setError('Enter valid page numbers, e.g. "1-3, 5, 8-10".')
          setBusy(false)
          return
        }
        groups = [pages.map(p => p - 1)]
      } else {
        const n = Math.max(1, Math.floor(everyN))
        const all = src.getPageIndices()
        for (let i = 0; i < all.length; i += n) groups.push(all.slice(i, i + n))
      }

      const out: Piece[] = []
      for (let g = 0; g < groups.length; g++) {
        const idxs = groups[g]
        const doc = await PDFDocument.create()
        doc.setProducer('Lumin Tools — PDF Split')
        const copied = await doc.copyPages(src, idxs)
        copied.forEach(p => doc.addPage(p))
        const bytes = await doc.save({ useObjectStreams: true })
        const { url, size } = bytesToPdfUrl(bytes)
        let name: string
        if (mode === 'each') name = `${base}-p${idxs[0] + 1}.pdf`
        else if (mode === 'range') name = `${base}-extract.pdf`
        else name = `${base}-part${g + 1}.pdf`
        out.push({ url, name, size, pages: idxs.length })
      }
      setPieces(out)
    } catch (e) {
      setError(`Split failed — ${e instanceof Error ? e.message : String(e)}.`)
    } finally {
      setBusy(false)
    }
  }

  const MODES: { id: SplitMode; label: string; hint: string }[] = [
    { id: 'range', label: 'Custom range', hint: 'Pull specific pages into one PDF' },
    { id: 'each', label: 'Each page', hint: 'One file per page' },
    { id: 'everyN', label: 'Every N pages', hint: 'Fixed-size chunks' },
  ]

  return (
    <div className="space-y-6">
      {!file ? (
        <Dropzone onFiles={onFiles} disabled={loading} hint={loading ? 'Reading PDF…' : 'One PDF — pick pages or chunk size next'} />
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="flex-1 truncate text-slate-700">{file.name}</span>
              <span className="text-xs text-slate-400 shrink-0">
                {formatBytes(file.size)}{pageCount != null ? ` · ${pageCount} pages` : ''}
              </span>
              <button onClick={clearAll} className="text-slate-300 hover:text-red-500" title="Remove"><X className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {MODES.map(m => {
                const active = mode === m.id
                return (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    disabled={busy}
                    className={[
                      'text-left p-3 rounded-lg border transition-all',
                      active ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 bg-white hover:border-slate-300',
                      busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                    ].join(' ')}
                  >
                    <div className="text-sm font-semibold text-slate-900">{m.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{m.hint}</div>
                  </button>
                )
              })}
            </div>

            {mode === 'range' && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Pages to extract</label>
                <input
                  value={rangeInput}
                  disabled={busy}
                  onChange={e => setRangeInput(e.target.value)}
                  placeholder={pageCount ? `e.g. 1-3, 5, 8-${pageCount}` : 'e.g. 1-3, 5, 8-10'}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
                <p className="text-[11px] text-slate-500 mt-1.5">Comma-separated pages and ranges{pageCount ? ` (1–${pageCount})` : ''}.</p>
              </div>
            )}

            {mode === 'everyN' && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Pages per file</label>
                <input
                  type="number" min={1} max={pageCount ?? undefined}
                  value={everyN}
                  disabled={busy}
                  onChange={e => setEveryN(Math.max(1, Number(e.target.value) || 1))}
                  className="w-28 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
                {pageCount != null && (
                  <p className="text-[11px] text-slate-500 mt-1.5">
                    {Math.ceil(pageCount / Math.max(1, everyN))} files of up to {Math.max(1, everyN)} {everyN === 1 ? 'page' : 'pages'} each.
                  </p>
                )}
              </div>
            )}

            {mode === 'each' && pageCount != null && (
              <p className="text-[11px] text-slate-500">Produces {pageCount} single-page PDFs.</p>
            )}

            <div className="flex justify-end pt-1">
              {busy ? (
                <div className="flex items-center gap-2 text-sm text-slate-600 mr-auto"><Loader2 className="w-4 h-4 animate-spin" /> Splitting…</div>
              ) : (
                <button onClick={split} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                  <Scissors className="w-4 h-4" /> Split PDF
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Couldn&apos;t split</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      )}

      {pieces.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{pieces.length} {pieces.length === 1 ? 'file' : 'files'}</h3>
            {pieces.length > 1 && (
              <button onClick={() => downloadAll(pieces)} className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
                <DownloadCloud className="w-3.5 h-3.5" /> Download all
              </button>
            )}
          </div>
          <div className="space-y-2">
            {pieces.map((p, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 border border-slate-100 rounded-lg">
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-800 truncate">{p.name}</div>
                  <div className="text-xs text-slate-500">{p.pages} {p.pages === 1 ? 'page' : 'pages'} · {formatBytes(p.size)}</div>
                </div>
                <a href={p.url} download={p.name} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shrink-0">
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
