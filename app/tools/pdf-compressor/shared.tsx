'use client'

/**
 * Shared helpers for the in-browser PDF Tools hub.
 * Everything runs client-side — no upload, no server.
 */

import { useId, useRef, useState } from 'react'
import { Upload } from 'lucide-react'

export class CancelledError extends Error {}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

// Dynamic imports keep pdf-lib + pdfjs out of the SSR bundle.
export async function loadPdfLib() {
  return await import('pdf-lib')
}

export async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  return pdfjsLib
}

export async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

// Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing across runtimes.
export function bytesToPdfUrl(bytes: Uint8Array): { url: string; size: number } {
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf], { type: 'application/pdf' })
  return { url: URL.createObjectURL(blob), size: blob.size }
}

export function downloadUrl(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// No zip dependency — trigger each blob download in sequence.
export function downloadAll(items: { url: string; name: string }[]) {
  items.forEach((it, i) => setTimeout(() => downloadUrl(it.url, it.name), i * 250))
}

/**
 * Parse a page-range string like "1-3, 5, 8-10" into sorted, unique, 1-based
 * page numbers clamped to [1, maxPage]. Invalid tokens are ignored.
 */
export function parsePageRanges(input: string, maxPage: number): number[] {
  const out = new Set<number>()
  for (const part of input.split(',')) {
    const p = part.trim()
    if (!p) continue
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      let a = parseInt(m[1], 10)
      let b = parseInt(m[2], 10)
      if (a > b) [a, b] = [b, a]
      for (let i = a; i <= b; i++) if (i >= 1 && i <= maxPage) out.add(i)
    } else if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10)
      if (n >= 1 && n <= maxPage) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

export function Dropzone({
  onFiles,
  multiple = false,
  disabled = false,
  hint,
}: {
  onFiles: (files: File[]) => void
  multiple?: boolean
  disabled?: boolean
  hint?: string
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()

  function take(list: FileList | null) {
    if (!list) return
    const pdfs = Array.from(list).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length) onFiles(pdfs)
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!disabled && !dragging) setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); if (!disabled) take(e.dataTransfer.files) }}
      className={[
        'border-2 border-dashed rounded-xl p-8 text-center transition-colors',
        disabled ? 'opacity-50' : dragging ? 'border-blue-400 bg-blue-50' : 'bg-white border-slate-300 hover:border-blue-400',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        disabled={disabled}
        onChange={e => { take(e.target.files); if (inputRef.current) inputRef.current.value = '' }}
        className="hidden"
        id={id}
      />
      <label htmlFor={id} className={(disabled ? 'cursor-not-allowed' : 'cursor-pointer') + ' inline-flex flex-col items-center gap-2'}>
        <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
          <Upload className="w-5 h-5 text-blue-600" />
        </div>
        <div className="text-sm font-medium text-slate-700">
          Drop PDF{multiple ? 's' : ''} here, or <span className="text-blue-600 underline">browse files</span>
        </div>
        {hint && <div className="text-xs text-slate-400">{hint}</div>}
      </label>
    </div>
  )
}
