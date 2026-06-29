'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { UserPlus, X, Star, Loader2 } from 'lucide-react'
import type { CoborrowerLite } from '@/lib/types'

type ContactHit = { id: string; display_name: string | null; email: string | null; phone: string | null }

/**
 * Manage co-borrowers (deal_contacts role='co') for a deal: list, link an existing
 * contact or create a new one, remove, and promote a co-borrower to primary.
 */
export default function CoborrowerManager({
  dealId, primaryId, onPrimaryChange,
}: {
  dealId: string
  primaryId: string | null
  onPrimaryChange?: (newPrimaryId: string) => void
}) {
  const [list, setList] = useState<CoborrowerLite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<ContactHit[]>([])
  const [nc, setNc] = useState({ name: '', email: '', phone: '' })

  async function refresh() {
    try {
      const res = await fetch(`/api/deals/${dealId}/coborrowers`)
      const data = await res.json()
      if (data.ok) setList(data.coborrowers as CoborrowerLite[])
    } finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [dealId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Contact search (name/email). Sanitize input so PostgREST's or() filter can't break.
  useEffect(() => {
    const safe = q.replace(/[,()*%]/g, ' ').trim()
    if (!safe) { setResults([]); return }
    let active = true
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('contacts')
        .select('id, display_name, email, phone')
        .or(`display_name.ilike.%${safe}%,email.ilike.%${safe}%`)
        .limit(8)
      if (active) {
        const taken = new Set([primaryId, ...list.map(c => c.contact_id)].filter(Boolean) as string[])
        setResults(((data ?? []) as ContactHit[]).filter(c => !taken.has(c.id)))
      }
    }, 250)
    return () => { active = false; clearTimeout(t) }
  }, [q, primaryId, list])

  async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/deals/${dealId}/coborrowers`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) setList(data.coborrowers as CoborrowerLite[])
      else alert(data.error || 'failed')
      return data.ok as boolean
    } finally { setBusy(false) }
  }

  async function linkExisting(contactId: string) {
    if (await send('POST', { action: 'link', contactId })) resetAdd()
  }
  async function createAndLink() {
    if (!nc.name.trim() && !nc.email.trim() && !nc.phone.trim()) return
    if (await send('POST', { action: 'link', newContact: nc })) resetAdd()
  }
  async function promote(contactId: string) {
    if (!confirm('Make this co-borrower the PRIMARY? The current primary becomes a co-borrower.')) return
    if (await send('POST', { action: 'promote', contactId })) onPrimaryChange?.(contactId)
  }
  function resetAdd() { setAdding(false); setQ(''); setResults([]); setNc({ name: '', email: '', phone: '' }) }

  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Co-borrowers</span>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)}
            className="text-[11px] font-medium text-blue-600 hover:text-blue-700 inline-flex items-center gap-1">
            <UserPlus className="w-3 h-3" /> Link co-borrower
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</p>
      ) : list.length === 0 && !adding ? (
        <p className="text-xs text-slate-400">No co-borrowers.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map(c => (
            <li key={c.contact_id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
              <a href={`/contacts/${c.contact_id}`} className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-slate-800 truncate">{c.name || '(no name)'}</span>
                {c.email && <span className="block text-[11px] text-slate-500 truncate">{c.email}</span>}
              </a>
              <button type="button" disabled={busy} title="Make primary" onClick={() => promote(c.contact_id)}
                className="text-slate-400 hover:text-amber-600 disabled:opacity-40"><Star className="w-3.5 h-3.5" /></button>
              <button type="button" disabled={busy} title="Remove" onClick={() => send('DELETE', { contactId: c.contact_id })}
                className="text-slate-400 hover:text-red-600 disabled:opacity-40"><X className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-2 rounded-lg border border-slate-200 p-2.5 space-y-2">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search existing contacts (name or email)…"
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
          {results.length > 0 && (
            <ul className="max-h-40 overflow-auto rounded-md border border-slate-100 divide-y divide-slate-100">
              {results.map(r => (
                <li key={r.id}>
                  <button type="button" disabled={busy} onClick={() => linkExisting(r.id)}
                    className="w-full text-left px-2 py-1.5 hover:bg-blue-50 disabled:opacity-40">
                    <span className="block text-xs font-medium text-slate-800 truncate">{r.display_name || '(no name)'}</span>
                    {r.email && <span className="block text-[11px] text-slate-500 truncate">{r.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="pt-1 border-t border-slate-100">
            <p className="text-[11px] text-slate-400 mb-1">…or create a new contact</p>
            <div className="grid grid-cols-1 gap-1.5">
              <input value={nc.name} onChange={e => setNc({ ...nc, name: e.target.value })} placeholder="Name"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
              <input value={nc.email} onChange={e => setNc({ ...nc, email: e.target.value })} placeholder="Email"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
              <input value={nc.phone} onChange={e => setNc({ ...nc, phone: e.target.value })} placeholder="Phone"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={resetAdd} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
            <button type="button" disabled={busy} onClick={createAndLink}
              className="text-xs font-semibold text-white bg-blue-600 rounded-md px-2.5 py-1 hover:bg-blue-700 disabled:opacity-40">
              {busy ? 'Saving…' : 'Create + link'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
