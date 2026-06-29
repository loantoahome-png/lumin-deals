'use client'

/**
 * Lender List — the approved-lenders directory as a one-view, EDITABLE contact list.
 *
 *   • Search across lender / contact / notes / email / phone.
 *   • Filter by section, by product, or to just the lenders set up in Arive.
 *   • Every column visible at once — contact info is click-to-call / click-to-email.
 *   • Edit any lender (pencil) → modal with all fields; add/delete lenders.
 *
 * Data: lib/lenders.ts is the SEED. The live, editable list is team-shared in
 * sync_state via /api/lenders (same pattern as /api/tools) — once anyone saves an
 * edit, that DB copy is authoritative for everyone. No DB migration.
 */

import { useEffect, useMemo, useState } from 'react'
import { LENDERS, LENDER_SECTIONS } from '@/lib/lenders'
import LenderEditModal, { type EditableLender } from '@/components/LenderEditModal'
import { Landmark, Search, Phone, Mail, X, Pencil, Plus } from 'lucide-react'

const PRODUCT_FILTERS = ['CONV', 'VA', 'FHA', '<580', 'Jumbo'] as const

// Muted, scannable badge colors per product type.
const PRODUCT_STYLE: Record<string, string> = {
  CONV: 'bg-blue-100 text-blue-700',
  VA: 'bg-emerald-100 text-emerald-700',
  FHA: 'bg-indigo-100 text-indigo-700',
  '<580': 'bg-amber-100 text-amber-700',
  Jumbo: 'bg-purple-100 text-purple-700',
  Agency: 'bg-sky-100 text-sky-700',
  'Non-QM 2nd': 'bg-rose-100 text-rose-700',
  HELOAN: 'bg-teal-100 text-teal-700',
  'Piggyback 2nd': 'bg-fuchsia-100 text-fuchsia-700',
}

function ariveBadge(v: string) {
  const t = v.trim().toLowerCase()
  if (t === 'yes') return { label: 'Yes', cls: 'bg-emerald-100 text-emerald-700' }
  if (t === 'no') return { label: 'No', cls: 'bg-slate-100 text-slate-500' }
  if (t === '') return { label: '—', cls: 'bg-slate-50 text-slate-300' }
  return { label: v, cls: 'bg-amber-100 text-amber-700' } // 'off' and anything odd
}

const telHref = (p: string) => 'tel:' + p.replace(/[^\d+]/g, '')
const firstEmail = (e: string) => e.split('/')[0].trim()

// Seed from the static export, with stable ids for editing.
const SEED: EditableLender[] = LENDERS.map((l, i) => ({ ...l, id: `seed-${i}` }))
const withIds = (rows: EditableLender[]): EditableLender[] =>
  rows.map((l, i) => ({ ...l, id: l.id || `l-${i}` }))

export default function LenderListPage() {
  const [lenders, setLenders] = useState<EditableLender[]>(SEED)
  const [editing, setEditing] = useState<EditableLender | null>(null)
  const [q, setQ] = useState('')
  const [section, setSection] = useState<string>('All')
  const [products, setProducts] = useState<string[]>([])
  const [ariveOnly, setAriveOnly] = useState(false)

  // Prefer the shared team list (DB). If it isn't published yet, the SEED stands.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/lenders', { cache: 'no-store' })
        const data = await res.json() as { ok: boolean; lenders: EditableLender[] | null }
        if (data.ok && Array.isArray(data.lenders) && data.lenders.length > 0) {
          setLenders(withIds(data.lenders))
        }
      } catch { /* keep the seed */ }
    })()
  }, [])

  // Write-through to the shared DB list (optimistic).
  async function persistAndUpdate(next: EditableLender[]) {
    setLenders(next)
    try {
      await fetch('/api/lenders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lenders: next }),
      })
    } catch { /* optimistic UI already updated; next save retries */ }
  }

  function handleSave(l: EditableLender) {
    const exists = lenders.some(x => x.id === l.id)
    persistAndUpdate(exists ? lenders.map(x => (x.id === l.id ? l : x)) : [...lenders, l])
    setEditing(null)
  }
  function handleDelete(l: EditableLender) {
    persistAndUpdate(lenders.filter(x => x.id !== l.id))
    setEditing(null)
  }
  function handleAdd() {
    const first = LENDER_SECTIONS[0]
    setEditing({
      id: `l_${Date.now()}`, category: first.key, categoryLabel: first.label,
      lender: '', inArive: '', contact: '', phone: '', email: '', products: [], minFico: '', comp: '', notes: '',
    })
  }

  function toggleProduct(p: string) {
    setProducts(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]))
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return lenders.filter(l => {
      if (section !== 'All' && l.category !== section) return false
      if (ariveOnly && l.inArive.trim().toLowerCase() !== 'yes') return false
      if (products.length && !products.every(p => l.products.includes(p))) return false
      if (needle) {
        const hay = `${l.lender} ${l.contact} ${l.email} ${l.phone} ${l.notes} ${l.categoryLabel}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [lenders, q, section, products, ariveOnly])

  // Group the filtered rows by section, preserving the sheet's section order.
  const groups = useMemo(() => {
    return LENDER_SECTIONS
      .map(s => ({ ...s, rows: filtered.filter(l => l.category === s.key) }))
      .filter(g => g.rows.length > 0)
  }, [filtered])

  const ariveCount = useMemo(() => filtered.filter(l => l.inArive.trim().toLowerCase() === 'yes').length, [filtered])
  const sectionsWithData = LENDER_SECTIONS.filter(s => lenders.some(l => l.category === s.key))

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Landmark className="w-5 h-5 text-blue-600" /> Lender List
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Approved wholesale &amp; correspondent lenders ·{' '}
              <span className="font-medium text-slate-600">{filtered.length}</span> shown ·{' '}
              <span className="text-emerald-600 font-medium">{ariveCount} in Arive</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 rounded-lg px-3 py-2 hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" /> Add lender
            </button>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search lender, contact, notes…"
                className="w-72 pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400"
              />
              {q && (
                <button onClick={() => setQ('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Section filter */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-16 shrink-0">Section</span>
          <div className="flex items-center gap-1 flex-wrap">
            <Chip active={section === 'All'} onClick={() => setSection('All')} accent>All</Chip>
            {sectionsWithData.map(s => (
              <Chip key={s.key} active={section === s.key} onClick={() => setSection(s.key)} accent>
                {s.label}
              </Chip>
            ))}
          </div>
        </div>

        {/* Product + Arive filters */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-16 shrink-0">Filters</span>
          <div className="flex items-center gap-1 flex-wrap">
            {PRODUCT_FILTERS.map(p => (
              <Chip key={p} active={products.includes(p)} onClick={() => toggleProduct(p)}>{p}</Chip>
            ))}
            <span className="w-px h-4 bg-slate-200 mx-1" />
            <Chip active={ariveOnly} onClick={() => setAriveOnly(v => !v)} accent>In Arive only</Chip>
            {(products.length > 0 || ariveOnly || section !== 'All') && (
              <button
                onClick={() => { setProducts([]); setAriveOnly(false); setSection('All') }}
                className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Body — one continuous table, banner row per section, sticky header */}
      <div className="flex-1 overflow-auto">
        {groups.length === 0 ? (
          <p className="text-sm text-slate-400 px-6 py-8">No lenders match these filters.</p>
        ) : (
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr className="text-[11px] uppercase tracking-wide text-slate-500 bg-slate-50">
                {['Lender', 'Arive', 'Contact', 'Phone', 'Email', 'Products', 'Min FICO', 'Comp', 'Notes', ''].map((h, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold border-b border-slate-200 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            {groups.map(g => (
              <tbody key={g.key}>
                <tr>
                  <td colSpan={10} className="bg-blue-600 text-white text-xs font-bold uppercase tracking-wider px-3 py-1.5 sticky left-0">
                    {g.label} <span className="font-normal text-blue-100 normal-case">· {g.rows.length}</span>
                  </td>
                </tr>
                {g.rows.map(l => (
                  <LenderRow key={l.id} l={l} onEdit={() => setEditing(l)} />
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>

      {editing && (
        <LenderEditModal
          lender={editing}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function Chip({ children, active, onClick, accent }: {
  children: React.ReactNode; active: boolean; onClick: () => void; accent?: boolean
}) {
  const on = accent ? 'bg-blue-600 text-white' : 'bg-slate-800 text-white'
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded-full transition ${active ? on : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
    >
      {children}
    </button>
  )
}

function LenderRow({ l, onEdit }: { l: EditableLender; onEdit: () => void }) {
  const arive = ariveBadge(l.inArive)
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50 align-top group">
      <td className="px-3 py-2 font-medium text-slate-800 border-b border-slate-100 min-w-[180px]">{l.lender}</td>
      <td className="px-3 py-2 border-b border-slate-100">
        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${arive.cls}`}>{arive.label}</span>
      </td>
      <td className="px-3 py-2 text-slate-600 border-b border-slate-100 whitespace-nowrap">{l.contact || <span className="text-slate-300">—</span>}</td>
      <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
        {l.phone
          ? <a href={telHref(l.phone)} className="text-slate-600 hover:text-blue-600 inline-flex items-center gap-1"><Phone className="w-3 h-3 text-slate-400" />{l.phone}</a>
          : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 border-b border-slate-100 whitespace-nowrap">
        {l.email
          ? <a href={`mailto:${firstEmail(l.email)}`} title={l.email} className="text-blue-600 hover:underline inline-flex items-center gap-1"><Mail className="w-3 h-3 text-slate-400" />{firstEmail(l.email)}</a>
          : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2 border-b border-slate-100">
        <div className="flex flex-wrap gap-1 min-w-[120px]">
          {l.products.length
            ? l.products.map(p => (
                <span key={p} className={`px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${PRODUCT_STYLE[p] ?? 'bg-slate-100 text-slate-600'}`}>{p}</span>
              ))
            : <span className="text-slate-300">—</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-slate-600 border-b border-slate-100 whitespace-nowrap tabular-nums">{l.minFico || <span className="text-slate-300">—</span>}</td>
      <td className="px-3 py-2 text-slate-600 border-b border-slate-100 whitespace-nowrap tabular-nums">{l.comp || <span className="text-slate-300">—</span>}</td>
      <td className="px-3 py-2 text-slate-500 border-b border-slate-100 text-[13px] leading-snug max-w-md whitespace-pre-wrap break-words">
        {l.notes || <span className="text-slate-300">—</span>}
      </td>
      <td className="px-2 py-2 border-b border-slate-100 text-right">
        <button
          onClick={onEdit}
          title="Edit lender"
          className="text-slate-400 hover:text-blue-600 opacity-60 group-hover:opacity-100 transition"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  )
}
