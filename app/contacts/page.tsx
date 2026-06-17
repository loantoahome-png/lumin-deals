'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Contact } from '@/lib/types'
import { formatCurrency, titleCase } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw, Search, Copy, Check } from 'lucide-react'

// ── Lifecycle (FUB-style "Stage") ────────────────────────────────────────────
const LIFECYCLES = ['In Process', 'Past Client', 'Lead', 'Not Ready'] as const
type Lifecycle = (typeof LIFECYCLES)[number]
const LIFECYCLE_PILL: Record<Lifecycle, string> = {
  'In Process':  'bg-blue-100 text-blue-700',
  'Past Client': 'bg-emerald-100 text-emerald-700',
  'Lead':        'bg-sky-100 text-sky-700',
  'Not Ready':   'bg-slate-100 text-slate-500',
}

// Per-person metadata derived from their loans (not on the contact rollup).
type DealMeta = { groups: Set<string>; source: string | null }

function lifecycleOf(c: Contact, meta: DealMeta | undefined): Lifecycle {
  if (meta?.groups.has('Loans in Process')) return 'In Process'
  if (c.funded_count > 0) return 'Past Client'
  if (meta?.groups.has('Leads')) return 'Lead'
  return 'Not Ready'
}

// ── Avatar ───────────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500', 'bg-fuchsia-500', 'bg-orange-500',
]
function initialsOf(name: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return (parts[0][0] || '?').toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

// A source we don't want to surface as a label (empty or the "we don't know" bucket).
function cleanSource(s: string | null): string | null {
  const t = (s ?? '').trim()
  if (!t || t.toLowerCase() === 'unknown') return null
  return t
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [meta, setMeta] = useState<Map<string, DealMeta>>(new Map())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | Lifecycle>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const PAGE = 1000

    // Contacts (the rollup) + a slim deals projection (for source + lifecycle), in parallel.
    const loadContacts = async () => {
      const all: Contact[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('contacts').select('*')
          .order('last_loan_at', { ascending: false, nullsFirst: false })
          .range(from, from + PAGE - 1)
        if (error) { console.error('[contacts] fetch failed:', error.message); break }
        const rows = (data as Contact[]) ?? []
        all.push(...rows)
        if (rows.length < PAGE) break
      }
      return all
    }
    const loadDealMeta = async () => {
      const m = new Map<string, DealMeta>()
      const latestSourceAt = new Map<string, string>() // borrower_id → created_at of current source
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('deals').select('borrower_id, pipeline_group, source, created_at')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) { console.error('[contacts] deal-meta fetch failed:', error.message); break }
        const rows = (data ?? []) as { borrower_id: string | null; pipeline_group: string | null; source: string | null; created_at: string }[]
        for (const d of rows) {
          if (!d.borrower_id) continue
          const entry = m.get(d.borrower_id) ?? { groups: new Set<string>(), source: null }
          if (d.pipeline_group) entry.groups.add(d.pipeline_group)
          const src = cleanSource(d.source)
          if (src) {
            const prev = latestSourceAt.get(d.borrower_id)
            if (!prev || d.created_at > prev) { entry.source = src; latestSourceAt.set(d.borrower_id, d.created_at) }
          }
          m.set(d.borrower_id, entry)
        }
        if (rows.length < PAGE) break
      }
      return m
    }

    const [c, m] = await Promise.all([loadContacts(), loadDealMeta()])
    setContacts(c)
    setMeta(m)
    setSelected(new Set())
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Search first, then lifecycle tab — so the tab counts reflect the current search.
  const searched = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return contacts
    return contacts.filter(c =>
      (c.display_name ?? '').toLowerCase().includes(s) ||
      (c.email ?? '').toLowerCase().includes(s) ||
      (c.phone ?? '').includes(s))
  }, [contacts, q])

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: searched.length, 'In Process': 0, 'Past Client': 0, 'Lead': 0, 'Not Ready': 0 }
    for (const c of searched) counts[lifecycleOf(c, meta.get(c.id))]++
    return counts
  }, [searched, meta])

  const filtered = useMemo(
    () => stageFilter === 'all' ? searched : searched.filter(c => lifecycleOf(c, meta.get(c.id)) === stageFilter),
    [searched, stageFilter, meta],
  )

  const totalVolume = filtered.reduce((s, c) => s + (c.total_funded_volume || 0), 0)

  // ── Selection ──────────────────────────────────────────────────────────────
  const allVisibleSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id))
  const toggleAll = () => {
    setSelected(prev => {
      if (filtered.every(c => prev.has(c.id))) {
        const next = new Set(prev); for (const c of filtered) next.delete(c.id); return next
      }
      const next = new Set(prev); for (const c of filtered) next.add(c.id); return next
    })
  }
  const toggleOne = (id: string) => setSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const copyEmails = async () => {
    const emails = contacts.filter(c => selected.has(c.id) && c.email).map(c => c.email as string)
    if (emails.length === 0) return
    try {
      await navigator.clipboard.writeText(emails.join(', '))
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Contacts</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} {filtered.length === 1 ? 'person' : 'people'} · {formatCurrency(totalVolume)} funded volume
            </p>
          </div>
          <button onClick={fetchData} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search name, email, phone…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Lifecycle filter tabs */}
        <div className="flex items-center gap-1 mt-3 flex-wrap">
          {(['all', ...LIFECYCLES] as const).map(t => (
            <button
              key={t}
              onClick={() => setStageFilter(t)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                stageFilter === t ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {t === 'all' ? 'All' : t} <span className={stageFilter === t ? 'text-slate-300' : 'text-slate-400'}>({stageCounts[t] ?? 0})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Bulk-select bar */}
      {selected.size > 0 && (
        <div className="px-6 py-2 bg-blue-50 border-b border-blue-200 flex items-center gap-4 shrink-0">
          <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
          <button onClick={copyEmails} className="flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy emails'}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-slate-500 hover:text-slate-700 ml-auto">Clear</button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="text-sm text-slate-400 px-6 py-4">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400 px-6 py-4">No contacts match.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="pl-6 pr-2 py-2 w-10">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="rounded border-slate-300" aria-label="Select all" />
                </th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2 text-right">Loans</th>
                <th className="px-3 py-2 text-right">Funded</th>
                <th className="px-3 py-2 text-right">Funded volume</th>
                <th className="px-3 py-2 text-right pr-6">Comp</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const name = titleCase(c.display_name) || c.display_name || '(no name)'
                const sub = cleanSource(meta.get(c.id)?.source ?? null) ?? c.email ?? c.phone ?? '—'
                const stage = lifecycleOf(c, meta.get(c.id))
                const isSel = selected.has(c.id)
                // Zebra striping so each lead row is visually distinct from its neighbors.
                const rowBg = isSel ? 'bg-blue-50' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50'
                return (
                  <tr key={c.id} className={`border-b border-slate-100 ${rowBg} ${isSel ? '' : 'hover:bg-slate-100'}`}>
                    <td className="pl-6 pr-2 py-2.5">
                      <input type="checkbox" checked={isSel} onChange={() => toggleOne(c.id)} className="rounded border-slate-300" aria-label={`Select ${name}`} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className={`shrink-0 w-8 h-8 rounded-full ${avatarColor(c.id)} flex items-center justify-center text-xs font-medium text-white`}>
                          {initialsOf(name)}
                        </div>
                        <div className="min-w-0">
                          <Link href={`/contacts/${c.id}`} className="font-medium text-slate-900 hover:text-blue-700 block truncate">
                            {name}
                          </Link>
                          <span className="text-xs text-slate-400 truncate block">{sub}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${LIFECYCLE_PILL[stage]}`}>{stage}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.loan_count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.funded_count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.total_funded_volume > 0 ? formatCurrency(c.total_funded_volume) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 pr-6">{c.total_comp > 0 ? formatCurrency(c.total_comp) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
