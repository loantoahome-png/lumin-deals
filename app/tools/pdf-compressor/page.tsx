'use client'

/**
 * PDF Tools — a 100% client-side hub. Sensitive PII never leaves the browser:
 * everything (compress / merge / split / rotate) runs locally via pdfjs-dist +
 * pdf-lib. No upload, no server, no third party.
 *
 * Route kept at /tools/pdf-compressor so existing saved tool tiles keep working.
 */

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Shield, Minimize2, Layers, Scissors, RotateCw } from 'lucide-react'
import CompressTab from './CompressTab'
import MergeTab from './MergeTab'
import SplitTab from './SplitTab'
import RotateTab from './RotateTab'

type Tab = 'compress' | 'merge' | 'split' | 'rotate'

const TABS: { id: Tab; label: string; icon: typeof Minimize2 }[] = [
  { id: 'compress', label: 'Compress', icon: Minimize2 },
  { id: 'merge', label: 'Merge', icon: Layers },
  { id: 'split', label: 'Split', icon: Scissors },
  { id: 'rotate', label: 'Rotate', icon: RotateCw },
]

export default function PdfToolsPage() {
  const [tab, setTab] = useState<Tab>('compress')

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Back link */}
      <Link href="/tools" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Tools
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">PDF Tools</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Compress, merge, split, and rotate — 100% in your browser. Great for loan docs, paystubs, bank statements.
        </p>
      </div>

      {/* Security badge */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-start gap-2.5">
        <Shield className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
        <div className="text-xs text-emerald-900">
          <p className="font-semibold mb-0.5">100% private — your files never leave this browser.</p>
          <p className="text-emerald-800">
            All processing runs locally in JavaScript. No upload, no server, no third party. Safe for SSNs, paystubs, tax returns, and any other PII. Output metadata is stripped.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <div className="flex gap-1 -mb-px">
          {TABS.map(t => {
            const active = tab === t.id
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={[
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                  active ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300',
                ].join(' ')}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Active tab */}
      {tab === 'compress' && <CompressTab />}
      {tab === 'merge' && <MergeTab />}
      {tab === 'split' && <SplitTab />}
      {tab === 'rotate' && <RotateTab />}
    </div>
  )
}
