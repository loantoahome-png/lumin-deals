'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Contact } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw, Search } from 'lucide-react'

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    const all: Contact[] = []
    const PAGE = 1000
    let from = 0
    for (;;) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .order('last_loan_at', { ascending: false, nullsFirst: false })
        .range(from, from + PAGE - 1)
      if (error) { console.error('[contacts] fetch failed:', error.message); break }
      const rows = (data as Contact[]) ?? []
      all.push(...rows)
      if (rows.length < PAGE) break
      from += PAGE
    }
    setContacts(all)
    setLoading(false)
  }, [])

  useEffect(() => { fetchContacts() }, [fetchContacts])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return contacts
    return contacts.filter(c =>
      (c.display_name ?? '').toLowerCase().includes(s) ||
      (c.email ?? '').toLowerCase().includes(s) ||
      (c.phone ?? '').includes(s))
  }, [contacts, q])

  const totalVolume = filtered.reduce((s, c) => s + (c.total_funded_volume || 0), 0)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Contacts</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} {filtered.length === 1 ? 'person' : 'people'} · {formatCurrency(totalVolume)} funded volume
            </p>
          </div>
          <button onClick={fetchContacts} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" title="Refresh">
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
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400">
            No contacts yet. The identity resolver populates this every 30 min (or POST to
            <code className="mx-1 px-1 bg-slate-100 rounded">/api/resolve-identities?apply=true</code>).
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2 text-right">Loans</th>
                <th className="px-3 py-2 text-right">Funded</th>
                <th className="px-3 py-2 text-right">Funded volume</th>
                <th className="px-3 py-2 text-right">Comp</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link href={`/contacts/${c.id}`} className="font-medium text-blue-600 hover:text-blue-700">
                      {c.display_name || '(no name)'}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{c.email || c.phone || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.loan_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.funded_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.total_funded_volume > 0 ? formatCurrency(c.total_funded_volume) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{c.total_comp > 0 ? formatCurrency(c.total_comp) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
