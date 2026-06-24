'use client'

/**
 * Rotate tab — turn pages 90/180/270°. Lossless: pdf-lib only updates each
 * page's /Rotate value; content is untouched. Rotation is relative to any
 * rotation the page already has (fixes sideways scans).
 */

import { useState } from 'react'
import { FileText, X, Loader2, Download, RotateCw, RotateCcw } from 'lucide-react'
import {
  Dropzone, formatBytes, baseName, loadPdfLib, fileToBytes, bytesToPdfUrl, parsePageRanges,
} from './shared'

type RotateResult = { url: string; name: string; size: number; pages: number }

export default function RotateTab() {
  const [file, setFile] = useState<File | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [angle, setAngle] = useState<90 | 180 | 270>(90)
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [rangeInput, setRangeInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RotateResult | null>(null)

  function clearResult() {
    setResult(prev => { if (prev) URL.revokeObjectURL(prev.url); return null })
  }

  async function onFiles(incoming: File[]) {
    const f = incoming[0]
    if (!f) return
    clearResult()
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
    clearResult()
    setFile(null)
    setPageCount(null)
    setError(null)
  }

  async function rotate() {
    if (!file || !pageCount) return
    setBusy(true)
    setError(null)
    clearResult()
    try {
      const lib = await loadPdfLib()
      const { PDFDocument, degrees } = lib
      const doc = await PDFDocument.load(await fileToBytes(file), { ignoreEncryption: true })

      let targets: number[] // 0-based
      if (scope === 'all') {
        targets = doc.getPageIndices()
      } else {
        const pages = parsePageRanges(rangeInput, pageCount)
        if (!pages.length) {
          setError('Enter valid page numbers, e.g. "1-3, 5".')
          setBusy(false)
          return
        }
        targets = pages.map(p => p - 1)
      }

      for (const i of targets) {
        const page = doc.getPage(i)
        const cur = page.getRotation().angle || 0
        page.setRotation(degrees(((cur + angle) % 360 + 360) % 360))
      }

      doc.setProducer('Lumin Tools — PDF Rotate')
      const bytes = await doc.save({ useObjectStreams: true })
      const { url, size } = bytesToPdfUrl(bytes)
      setResult({ url, name: `${baseName(file.name)}-rotated.pdf`, size, pages: targets.length })
    } catch (e) {
      setError(`Rotate failed — ${e instanceof Error ? e.message : String(e)}.`)
    } finally {
      setBusy(false)
    }
  }

  const ANGLES: { value: 90 | 180 | 270; label: string; icon: typeof RotateCw }[] = [
    { value: 90, label: '90° right', icon: RotateCw },
    { value: 180, label: '180°', icon: RotateCw },
    { value: 270, label: '90° left', icon: RotateCcw },
  ]

  return (
    <div className="space-y-6">
      {!file ? (
        <Dropzone onFiles={onFiles} disabled={loading} hint={loading ? 'Reading PDF…' : 'One PDF — choose an angle next'} />
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
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Rotation</label>
              <div className="grid grid-cols-3 gap-2">
                {ANGLES.map(a => {
                  const active = angle === a.value
                  const Icon = a.icon
                  return (
                    <button
                      key={a.value}
                      onClick={() => setAngle(a.value)}
                      disabled={busy}
                      className={[
                        'flex items-center justify-center gap-1.5 p-3 rounded-lg border transition-all text-sm font-semibold',
                        active ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200 text-slate-900' : 'border-slate-200 bg-white hover:border-slate-300 text-slate-700',
                        busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                      ].join(' ')}
                    >
                      <Icon className="w-4 h-4 text-slate-500" /> {a.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Apply to</label>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setScope('all')}
                  disabled={busy}
                  className={[
                    'px-3 py-1.5 text-sm rounded-md border transition-colors',
                    scope === 'all' ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  All pages
                </button>
                <button
                  onClick={() => setScope('range')}
                  disabled={busy}
                  className={[
                    'px-3 py-1.5 text-sm rounded-md border transition-colors',
                    scope === 'range' ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  Specific pages
                </button>
                {scope === 'range' && (
                  <input
                    value={rangeInput}
                    disabled={busy}
                    onChange={e => setRangeInput(e.target.value)}
                    placeholder={pageCount ? `e.g. 1-3, 5, 8-${pageCount}` : 'e.g. 1-3, 5'}
                    className="flex-1 min-w-[10rem] border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                  />
                )}
              </div>
            </div>

            <div className="flex justify-end pt-1">
              {busy ? (
                <div className="flex items-center gap-2 text-sm text-slate-600 mr-auto"><Loader2 className="w-4 h-4 animate-spin" /> Rotating…</div>
              ) : (
                <button onClick={rotate} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                  <RotateCw className="w-4 h-4" /> Rotate PDF
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          <p className="font-medium">Couldn&apos;t rotate</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      )}

      {result && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Result</h3>
          <div className="flex items-center gap-3 p-2.5 border border-slate-100 rounded-lg">
            <RotateCw className="w-4 h-4 text-emerald-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-800 truncate">{result.name}</div>
              <div className="text-xs text-slate-500">{result.pages} {result.pages === 1 ? 'page' : 'pages'} rotated · {formatBytes(result.size)} · text preserved</div>
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
