'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Contact, Deal, STATUS_COLORS } from '@/lib/types'
import { Search, X, User, FileText } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatCurrency, titleCase } from '@/lib/utils'

type DealResult = Pick<Deal, 'id' | 'name' | 'status' | 'pipeline_group' | 'property_address' | 'loan_amount'>
type ContactResult = Pick<Contact, 'id' | 'display_name' | 'email' | 'phone' | 'loan_count'>

// PostgREST `.or()` is comma/paren-delimited — strip those from user input so a
// stray character can't break the filter (keep everything else for ilike).
function sanitize(q: string): string {
  return q.replace(/[,()]/g, ' ').trim()
}

export default function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<ContactResult[]>([])
  const [deals, setDeals] = useState<DealResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const q = sanitize(query)
    if (!q) { setContacts([]); setDeals([]); return }
    const timeout = setTimeout(async () => {
      setLoading(true)
      const [c, d] = await Promise.all([
        supabase
          .from('contacts')
          .select('id, display_name, email, phone, loan_count')
          .or(`display_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
          .order('last_loan_at', { ascending: false, nullsFirst: false })
          .limit(5),
        supabase
          .from('deals')
          .select('id, name, status, pipeline_group, property_address, loan_amount')
          .or(`name.ilike.%${q}%,property_address.ilike.%${q}%,email.ilike.%${q}%,investor.ilike.%${q}%,arive_file_no.ilike.%${q}%,investor_file_no.ilike.%${q}%`)
          .order('created_at', { ascending: false })
          .limit(6),
      ])
      setContacts((c.data as ContactResult[]) || [])
      setDeals((d.data as DealResult[]) || [])
      setLoading(false)
    }, 200)
    return () => clearTimeout(timeout)
  }, [query])

  function reset() {
    setQuery('')
    setContacts([])
    setDeals([])
    setOpen(false)
  }
  function goContact(id: string) { router.push(`/contacts/${id}`); reset() }
  function goDeal(id: string) { router.push(`/deals/${id}`); reset() }

  const hasResults = contacts.length > 0 || deals.length > 0

  return (
    <div className="relative px-3 mb-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder="Search contacts & loans…"
          className="w-full pl-8 pr-7 py-2 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        {query && (
          <button
            onClick={reset}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && query && (
        <div className="absolute top-full left-3 right-3 mt-1 bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden z-[100] max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="px-4 py-3 text-xs text-slate-400">Searching…</div>
          ) : !hasResults ? (
            <div className="px-4 py-3 text-xs text-slate-400">No matches for &quot;{query}&quot;</div>
          ) : (
            <>
              {/* ── Contacts ── */}
              {contacts.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    <User className="w-3 h-3" /> Contacts
                  </div>
                  {contacts.map(c => {
                    const sub = c.email || c.phone
                    return (
                      <button
                        key={c.id}
                        onMouseDown={() => goContact(c.id)}
                        className="w-full text-left px-4 py-2.5 hover:bg-blue-50 transition-colors border-b border-slate-100"
                      >
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {titleCase(c.display_name) || c.display_name || '(no name)'}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {sub && <span className="text-xs text-slate-500 truncate max-w-[150px]">{sub}</span>}
                          <span className="text-xs text-slate-400">{c.loan_count} {c.loan_count === 1 ? 'loan' : 'loans'}</span>
                        </div>
                      </button>
                    )
                  })}
                </>
              )}

              {/* ── Loans ── */}
              {deals.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    <FileText className="w-3 h-3" /> Loans
                  </div>
                  {deals.map(d => (
                    <button
                      key={d.id}
                      onMouseDown={() => goDeal(d.id)}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 transition-colors border-b border-slate-100"
                    >
                      <p className="text-sm font-semibold text-slate-900 truncate">{titleCase(d.name) || d.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium leading-none ${STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'}`}>
                          {d.status}
                        </span>
                        {d.loan_amount && <span className="text-xs text-slate-500">{formatCurrency(d.loan_amount)}</span>}
                        {d.property_address && <span className="text-xs text-slate-400 truncate max-w-[140px]">{d.property_address}</span>}
                      </div>
                    </button>
                  ))}
                </>
              )}

              {/* Footer — jump to the full loan pipeline for this query */}
              {deals.length > 0 && (
                <div className="px-4 py-2 bg-slate-50 border-t border-slate-100">
                  <button
                    onMouseDown={() => { router.push(`/pipeline?search=${encodeURIComponent(query)}`); reset() }}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    View all loans for &quot;{query}&quot; →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
