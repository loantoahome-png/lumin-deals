'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  FileText, Upload, Trash2, Sparkles, Loader2, Copy, Check,
  Download, AlertCircle, Clock,
} from 'lucide-react'

// ── Option tables ─────────────────────────────────────────────────────────────
const PAPER_SIZES = ['Letter', 'Legal', 'A4', 'Tabloid'] as const
const MARGIN_PRESETS: Record<string, { label: string; value: string }> = {
  none:    { label: 'None',            value: '0' },
  min:     { label: 'Minimum (0.25")', value: '0.25in' },
  normal:  { label: 'Normal (0.5")',   value: '0.5in' },
  wide:    { label: 'Wide (1")',       value: '1in' },
}

const EXAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .hero { background: linear-gradient(135deg, #F37021 0%, #d85a10 100%); color: #fff; padding: 64px 48px; }
  .hero h1 { font-size: 44px; font-weight: 800; letter-spacing: -1px; }
  .hero p { font-size: 18px; opacity: .92; margin-top: 10px; }
  .body { padding: 40px 48px; }
  .rate { display: flex; align-items: baseline; gap: 12px; margin: 8px 0 24px; }
  .rate .big { font-size: 56px; font-weight: 800; color: #F37021; }
  .rate .sub { font-size: 16px; color: #64748b; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
  .card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; }
  .card .v { font-size: 24px; font-weight: 700; color: #0f172a; margin-top: 6px; }
  .foot { margin-top: 32px; padding-top: 20px; border-top: 2px solid #F37021; color: #64748b; font-size: 13px; }
  .foot strong { color: #0f172a; }
</style>
</head>
<body>
  <div class="hero">
    <h1>Refinance & Save</h1>
    <p>Lumin Lending — your home, your future</p>
  </div>
  <div class="body">
    <div class="rate">
      <span class="big">5.875%</span>
      <span class="sub">30-Year Fixed · APR 6.012%</span>
    </div>
    <div class="grid">
      <div class="card"><h3>Est. Monthly Payment</h3><div class="v">$2,104</div></div>
      <div class="card"><h3>Cash Out Available</h3><div class="v">$85,000</div></div>
      <div class="card"><h3>Loan Amount</h3><div class="v">$420,000</div></div>
      <div class="card"><h3>Close In</h3><div class="v">21 days</div></div>
    </div>
    <div class="foot">
      <strong>Matt Park · NMLS #123456</strong><br>
      (909) 927-9896 · loantoahome@gmail.com · Lumin Lending
    </div>
  </div>
</body>
</html>`

type Recent = { name: string; at: number }
const RECENTS_KEY = 'pdfConverterRecents'

export default function PdfConverterPage() {
  const [html, setHtml] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [paper, setPaper] = useState<string>('Letter')
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [marginKey, setMarginKey] = useState<string>('none')
  const [scale, setScale] = useState(100)
  const [filename, setFilename] = useState('document.pdf')
  const [printBackground, setPrintBackground] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [recents, setRecents] = useState<Recent[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  // Debounced live preview (300ms)
  useEffect(() => {
    const t = setTimeout(() => setPreviewHtml(html), 300)
    return () => clearTimeout(t)
  }, [html])

  // Load recent conversions
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENTS_KEY)
      if (raw) setRecents(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  function pushRecent(name: string) {
    setRecents(prev => {
      const next = [{ name, at: Date.now() }, ...prev].slice(0, 5)
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setHtml(String(reader.result ?? ''))
    reader.readAsText(file)
    e.target.value = '' // allow re-uploading the same file
  }

  async function copyHtml() {
    try {
      await navigator.clipboard.writeText(html)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  const generate = useCallback(async () => {
    if (!html.trim() || generating) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html,
          format: paper,
          orientation,
          margin: {
            top: MARGIN_PRESETS[marginKey].value,
            right: MARGIN_PRESETS[marginKey].value,
            bottom: MARGIN_PRESETS[marginKey].value,
            left: MARGIN_PRESETS[marginKey].value,
          },
          scale: scale / 100,            // UI percent → puppeteer fraction
          printBackground,
          filename,
        }),
      })

      if (!res.ok) {
        let msg = `Request failed (${res.status}).`
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* non-json */ }
        setError(msg)
        return
      }

      const blob = await res.blob()
      const dispo = res.headers.get('Content-Disposition') || ''
      const m = dispo.match(/filename="([^"]+)"/)
      const name = m?.[1] || (filename.endsWith('.pdf') ? filename : `${filename}.pdf`)

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      pushRecent(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }, [html, generating, paper, orientation, marginKey, scale, printBackground, filename])

  // Cmd/Ctrl+Enter to generate
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [generate])

  // Preview iframe sized to the chosen paper aspect (portrait/landscape aware).
  const portraitRatio = orientation === 'portrait' ? 8.5 / 11 : 11 / 8.5

  return (
    <div className="flex flex-col h-full overflow-auto bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-[#F37021] flex items-center justify-center">
            <FileText className="w-4 h-4 text-white" />
          </span>
          HTML → PDF Converter
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Paste or upload HTML, preview it as paper, and export a print-ready PDF. Backgrounds on by default.
        </p>
      </div>

      <div className="p-6 space-y-4">
        {/* Two panes */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left — input */}
          <div className="bg-white border border-slate-200 rounded-xl flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 flex-wrap">
              <button onClick={() => setHtml(EXAMPLE_HTML)}
                className="flex items-center gap-1.5 text-xs font-semibold text-[#F37021] bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg px-2.5 py-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Load example
              </button>
              <button onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg px-2.5 py-1.5">
                <Upload className="w-3.5 h-3.5" /> Upload .html
              </button>
              <input ref={fileRef} type="file" accept=".html,.htm,text/html" onChange={onFile} className="hidden" />
              <button onClick={copyHtml} disabled={!html}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg px-2.5 py-1.5 disabled:opacity-40">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy HTML'}
              </button>
              <button onClick={() => setHtml('')} disabled={!html}
                className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg px-2.5 py-1.5 disabled:opacity-40">
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
            </div>
            <textarea
              value={html}
              onChange={e => setHtml(e.target.value)}
              placeholder="Paste your HTML here…  (⌘/Ctrl + Enter to generate)"
              spellCheck={false}
              className="flex-1 min-h-[460px] w-full p-3 font-mono text-xs text-slate-800 resize-none focus:outline-none rounded-b-xl"
            />
          </div>

          {/* Right — live preview */}
          <div className="bg-white border border-slate-200 rounded-xl flex flex-col">
            <div className="px-3 py-2 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center justify-between">
              <span>Live preview</span>
              <span className="text-[10px] text-slate-400 normal-case">{paper} · {orientation}</span>
            </div>
            <div className="flex-1 flex items-start justify-center p-4 bg-slate-100 rounded-b-xl overflow-auto">
              <div
                className="bg-white shadow-lg shrink-0"
                style={{ width: '100%', maxWidth: 460, aspectRatio: String(portraitRatio) }}
              >
                <iframe
                  title="preview"
                  srcDoc={previewHtml || '<!DOCTYPE html><html><body style="font-family:sans-serif;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100%;margin:0;"><p>Preview appears here</p></body></html>'}
                  sandbox="allow-same-origin"
                  className="w-full h-full border-0"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
            <Control label="Paper size">
              <select value={paper} onChange={e => setPaper(e.target.value)} className={selCls}>
                {PAPER_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Control>

            <Control label="Orientation">
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                {(['portrait', 'landscape'] as const).map(o => (
                  <button key={o} onClick={() => setOrientation(o)}
                    className={`flex-1 px-2 py-2 capitalize ${orientation === o ? 'bg-[#F37021] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    {o}
                  </button>
                ))}
              </div>
            </Control>

            <Control label="Margins">
              <select value={marginKey} onChange={e => setMarginKey(e.target.value)} className={selCls}>
                {Object.entries(MARGIN_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Control>

            <Control label={`Scale — ${scale}%`}>
              <input type="range" min={50} max={150} step={5} value={scale}
                onChange={e => setScale(Number(e.target.value))}
                className="w-full accent-[#F37021] cursor-pointer" />
            </Control>

            <Control label="Filename">
              <input type="text" value={filename} onChange={e => setFilename(e.target.value)}
                placeholder="document.pdf" className={selCls} />
            </Control>

            <Control label="Background graphics">
              <button onClick={() => setPrintBackground(v => !v)}
                className={`flex items-center gap-2 w-full px-2 py-2 rounded-lg border text-xs font-semibold ${printBackground ? 'bg-orange-50 border-orange-200 text-[#F37021]' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                <span className={`w-8 h-4 rounded-full relative transition-colors ${printBackground ? 'bg-[#F37021]' : 'bg-slate-300'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${printBackground ? 'left-4' : 'left-0.5'}`} />
                </span>
                {printBackground ? 'On' : 'Off'}
              </button>
            </Control>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button onClick={generate} disabled={generating || !html.trim()}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-[#F37021] hover:bg-[#d85a10] rounded-lg shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {generating ? 'Generating…' : 'Generate PDF'}
            </button>
            <span className="text-[11px] text-slate-400">⌘/Ctrl + Enter</span>
          </div>
        </div>

        {/* Recent conversions */}
        {recents.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Recent conversions
            </h3>
            <ul className="divide-y divide-slate-100">
              {recents.map((r, i) => (
                <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-slate-700 font-medium truncate">{r.name}</span>
                  <span className="text-[11px] text-slate-400 shrink-0 ml-3">{new Date(r.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

const selCls = 'w-full text-sm border border-slate-200 rounded-lg px-2.5 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#F37021]'

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}
