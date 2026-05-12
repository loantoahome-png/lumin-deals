'use client'

import { useEffect, useState } from 'react'
import {
  ExternalLink, Plus, Pencil, Trash2, X, Check, GripVertical,
} from 'lucide-react'

// ── Default tools (industry-standard mortgage tooling, pre-populated for first-time users) ───
const DEFAULT_TOOLS: Tool[] = [
  // Lenders / Wholesale
  { id: 'rocket',     name: 'Rocket Pro TPO',         url: 'https://www.rocketprotpo.com',                category: 'Lenders',     description: 'Rocket Navigate, pricing, lock, submit' },
  { id: 'uwm',        name: 'UWM (Eagle Pro)',        url: 'https://eaglepro.uwm.com',                    category: 'Lenders',     description: 'United Wholesale Mortgage portal' },
  { id: 'pennymac',   name: 'PennyMac TPO',           url: 'https://www.gopennymac.com',                  category: 'Lenders',     description: 'PennyMac wholesale portal' },
  // LOS / CRM
  { id: 'arive',      name: 'Arive',                  url: 'https://app.arive.com',                       category: 'LOS / CRM',   description: 'Loan origination + 1003 / pricing' },
  { id: 'ghl-moe',    name: 'GHL — Moe',              url: 'https://app.luminlending.com/v2/location/PKEBK2NXDuug25VABQ61', category: 'LOS / CRM', description: "Moe's GoHighLevel location" },
  { id: 'ghl-matt',   name: 'GHL — Matt',             url: 'https://app.luminlending.com/v2/location/84fCsPjMP7RHe8P6JEe0', category: 'LOS / CRM', description: "Matt's GoHighLevel location" },
  { id: 'monday',     name: 'Monday — DEALS',         url: 'https://luminlending2.monday.com/boards/9921654433', category: 'LOS / CRM', description: 'Old Monday deals board (reference)' },
  // Pricing & Locks
  { id: 'optimal',    name: 'Optimal Blue',           url: 'https://secure.optimalblue.com',              category: 'Pricing',     description: 'Pricing engine and lock desk' },
  // Income Calculators
  { id: 'mgic-seb',    name: 'MGIC SEB Worksheets',   url: 'https://www.mgic.com/tools/seb-cash-flow-worksheets',                     category: 'Calculators', description: 'Self-employed borrower cash flow worksheets — industry gold standard' },
  { id: 'radian-seb',  name: 'Radian SEB Calculator', url: 'https://www.radian.com/what-we-do/mortgage-insurance/self-employed-borrowers', category: 'Calculators', description: 'Self-employed income analysis' },
  { id: 'enact-seb',   name: 'Enact SEB Calculator',  url: 'https://enactmi.com/training/self-employed-borrowers',                    category: 'Calculators', description: 'Self-employed borrower calculator (formerly Genworth)' },
  { id: 'fannie-1084', name: 'Fannie Form 1084',      url: 'https://singlefamily.fanniemae.com/media/22216/display',                  category: 'Calculators', description: 'Cash Flow Analysis — official Fannie Mae form' },
  { id: 'freddie-91',  name: 'Freddie Form 91',       url: 'https://sf.freddiemac.com/docs/pdf/form/form91.pdf',                       category: 'Calculators', description: 'Income Calculations — official Freddie Mac form' },
  { id: 'loanbeam',    name: 'LoanBeam',              url: 'https://loanbeam.com',                                                    category: 'Calculators', description: 'Automated tax-return income analysis (paid)' },
  // Compliance / Insurance
  { id: 'fha',        name: 'FHA Connection',         url: 'https://entp.hud.gov/clas/',                  category: 'Compliance',  description: 'HUD FHA case binders' },
  { id: 'mgic',       name: 'MGIC',                   url: 'https://www.mgic.com',                        category: 'Compliance',  description: 'Mortgage insurance quotes' },
  { id: 'radian',     name: 'Radian',                 url: 'https://www.radian.com',                      category: 'Compliance',  description: 'Mortgage insurance quotes' },
]

const STORAGE_KEY = 'lumin_tools_v1'
const MIGRATION_KEY = 'lumin_tools_migrations'
const CATEGORIES = ['Lenders', 'LOS / CRM', 'Pricing', 'Calculators', 'Compliance', 'Lead Sources', 'Other'] as const
type Category = typeof CATEGORIES[number]

type Tool = {
  id: string
  name: string
  url: string
  category: string
  description?: string
}

function loadTools(): Tool[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Tool[]
      if (Array.isArray(stored) && stored.length > 0) {
        // One-time migrations: append new default tools the user hasn't seen yet
        const migrations: string[] = (() => {
          try { return JSON.parse(localStorage.getItem(MIGRATION_KEY) || '[]') } catch { return [] }
        })()
        if (!migrations.includes('add_calculators_v1')) {
          const calculatorDefaults = DEFAULT_TOOLS.filter(t => t.category === 'Calculators')
          const storedIds = new Set(stored.map(t => t.id))
          const toAppend = calculatorDefaults.filter(d => !storedIds.has(d.id))
          if (toAppend.length > 0) {
            const merged = [...stored, ...toAppend]
            saveTools(merged)
            localStorage.setItem(MIGRATION_KEY, JSON.stringify([...migrations, 'add_calculators_v1']))
            return merged
          }
          localStorage.setItem(MIGRATION_KEY, JSON.stringify([...migrations, 'add_calculators_v1']))
        }
        return stored
      }
    }
  } catch {}
  return DEFAULT_TOOLS
}

function saveTools(tools: Tool[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tools)) } catch {}
}

function faviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
  } catch {
    return ''
  }
}

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [editing, setEditing] = useState<Tool | null>(null) // null = no modal, an object = edit, {} = create
  const [creating, setCreating] = useState(false)

  // Load from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    setTools(loadTools())
    setHydrated(true)
  }, [])

  function persistAndUpdate(next: Tool[]) {
    setTools(next)
    saveTools(next)
  }

  function handleSave(t: Tool) {
    if (creating) {
      const id = t.id || `t_${Date.now()}`
      persistAndUpdate([...tools, { ...t, id }])
    } else {
      persistAndUpdate(tools.map(x => x.id === t.id ? t : x))
    }
    setEditing(null)
    setCreating(false)
  }

  function handleDelete(id: string) {
    if (!confirm('Remove this tool?')) return
    persistAndUpdate(tools.filter(t => t.id !== id))
  }

  function resetToDefaults() {
    if (!confirm('Reset all tools to the default list? This will erase any custom tools you added.')) return
    persistAndUpdate(DEFAULT_TOOLS)
  }

  // Group by category
  const grouped: Record<string, Tool[]> = {}
  for (const t of tools) {
    const cat = t.category || 'Other'
    grouped[cat] ??= []
    grouped[cat].push(t)
  }
  // Order categories: known categories first in defined order, then anything custom
  const orderedCategories = [
    ...CATEGORIES.filter(c => grouped[c]),
    ...Object.keys(grouped).filter(c => !CATEGORIES.includes(c as Category)).sort(),
  ]

  if (!hydrated) {
    return <div className="p-6"><div className="text-sm text-slate-400">Loading tools…</div></div>
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Tools</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Quick-launch your most-used external tools. Click any tile to open in a new tab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetToDefaults}
            className="text-xs text-slate-500 hover:text-slate-800"
            title="Restore the default tool list"
          >
            Reset to defaults
          </button>
          <button
            onClick={() => { setCreating(true); setEditing({ id: '', name: '', url: '', category: 'Lenders', description: '' }) }}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> Add Tool
          </button>
        </div>
      </div>

      {tools.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <p className="text-sm text-slate-500">No tools yet. Click <strong>Add Tool</strong> to create your first one.</p>
        </div>
      ) : (
        orderedCategories.map(cat => (
          <section key={cat}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">{cat}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {grouped[cat].map(tool => (
                <ToolTile
                  key={tool.id}
                  tool={tool}
                  onEdit={() => { setEditing(tool); setCreating(false) }}
                  onDelete={() => handleDelete(tool.id)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {/* Add/Edit modal */}
      {editing && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4"
          onClick={() => { setEditing(null); setCreating(false) }}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-900">{creating ? 'Add Tool' : 'Edit Tool'}</h3>
              <button onClick={() => { setEditing(null); setCreating(false) }} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ToolForm tool={editing} onSubmit={handleSave} onCancel={() => { setEditing(null); setCreating(false) }} />
          </div>
        </div>
      )}
    </div>
  )
}

function ToolTile({ tool, onEdit, onDelete }: { tool: Tool; onEdit: () => void; onDelete: () => void }) {
  const fav = faviconUrl(tool.url)
  const initials = tool.name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase()

  return (
    <div className="group relative bg-white border border-slate-200 rounded-xl hover:border-blue-300 hover:shadow-md transition-all overflow-hidden">
      <a
        href={tool.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block p-4 pr-10"
      >
        <div className="flex items-start gap-3">
          {/* Favicon w/ initial fallback */}
          <div className="shrink-0 w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden">
            {fav ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fav}
                alt=""
                className="w-7 h-7 object-contain"
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <span className="text-xs font-semibold text-slate-500">{initials}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-900 truncate">{tool.name}</span>
              <ExternalLink className="w-3 h-3 text-slate-400 shrink-0 group-hover:text-blue-500" />
            </div>
            {tool.description && (
              <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{tool.description}</p>
            )}
            <p className="text-[10px] text-slate-400 mt-1.5 truncate">{new URL(tool.url).hostname}</p>
          </div>
        </div>
      </a>
      {/* Action buttons */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onEdit}
          className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"
          title="Edit"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
          title="Remove"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function ToolForm({ tool, onSubmit, onCancel }: { tool: Tool; onSubmit: (t: Tool) => void; onCancel: () => void }) {
  const [name, setName] = useState(tool.name)
  const [url, setUrl] = useState(tool.url)
  const [category, setCategory] = useState(tool.category || 'Other')
  const [description, setDescription] = useState(tool.description || '')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    let normalizedUrl = url.trim()
    if (!normalizedUrl) { setError('URL is required'); return }
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`
    try { new URL(normalizedUrl) } catch { setError('Invalid URL'); return }
    onSubmit({ ...tool, name: name.trim(), url: normalizedUrl, category, description: description.trim() || undefined })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="e.g. Rocket Pro TPO"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">URL</label>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://example.com"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Description (optional)</label>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Short description shown on the tile"
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          <Check className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </form>
  )
}
