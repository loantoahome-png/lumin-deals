'use client'

/**
 * Merge tab — combine several PDFs into one, in a chosen order. Lossless:
 * pdf-lib copies the original page objects, so text/vectors/quality are kept.
 */

import { useState } from 'react'
import { FileText, X, Loader2, Download, ArrowUp, ArrowDown, Layers } from 'lucide-react'
import { Dropzone, formatBytes, baseName, loadPdfLib, fileToBytes, bytesToPdfUrl } from './shared'

type MergeResult = { url: string; name: string; size: number; pages: number }

export default function MergeTab() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MergeResult | null>(null)

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
    clearResult()
    setError(null)
  }

  function move(idx: number, dir: -1 | 1) {
    setFiles(prev => {
      const j = idx + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
    clearResult()
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
    clearResult()
  }

  function clearResult() {
    setResult(prev => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }

  async function merge() {
    if (files.length < 2) return
    setBusy(true)
    setError(null)
    clearResult()
    try {
      const { PDFDocument } = await loadPdfLib()
      const out = await PDFDocument.create()
      out.setProducer('Lumin Tools — PDF Merge')
      out.setCreator('Lumin Tools')
      for (const f of files) {
        const bytes = await fileToBytes(f)
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
        const copied = await out.copyPages(src, src.getPageIndices())
        copied.forEach(p => out.addPage(p))
      }
      const bytes = await out.save({ useObjectStreams: true })
      const { url, size } = bytesToPdfUrl(bytes)
      setResult({ url, name: 'merged.pdf', size, pages: out.getPageCount() })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Couldn't merge — ${msg}. One of the files may be password-protected or corrupt.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Dropzone onFiles={addFiles} multiple disabled={busy} hint="Add two or more PDFs — they combine top-to-bottom in this order" />

      {files.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {files.length} {files.length === 1 ? 'file' : 'files'} · merge order
            </h3>
            {!busy && <button onClick={() => { setFiles([]); clearResult() }} className="text-xs text-slate-400 hover:text-slate-700">Clear all</button>}
          </div>
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={`${f.name}:${f.size}:${i}`} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs text-slate-400 shrink-0">{i + 1}</span>
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="flex-1 truncate text-slate-700">{f.name}</span>
                <span className="text-xs text-slate-400 shrink-0">{formatBytes(f.size)}</span>
                {!busy && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:hover:text-slate-300" title="Move up">
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={i === files.length - 1} className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:hover:text-slate-300" title="Move down">
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeFile(i)} className="p-1 text-slate-300 hover:text-red-500" title="Remove">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-slate-100">
            {busy ? (
              <div className="flex items-center gap-2 text-sm text-slate-600 mr-auto">
                <Loader2 className="w-4 h-4 animate-spin" /> Merging {files.length} files…
              </div>
            ) : (
              <button
                onClick={merge}
                disabled={files.length < 2}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Layers className="w-4 h-4" /> {files.length < 2 ? 'Add 2+ files to merge' : `Merge ${files.length} PDFs`}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Merge failed</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      )}

      {result && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Result</h3>
          <div className="flex items-center gap-3 p-2.5 border border-slate-100 rounded-lg">
            <Layers className="w-4 h-4 text-emerald-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-800 truncate">{result.name}</div>
              <div className="text-xs text-slate-500">{result.pages} pages · {formatBytes(result.size)} · text preserved</div>
            </div>
            <a href={result.url} download={result.name} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shrink-0">
              <Download className="w-3.5 h-3.5" /> Download
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
