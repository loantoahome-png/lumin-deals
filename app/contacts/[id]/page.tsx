'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Contact, Deal } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-semibold text-slate-800 tabular-nums">{value}</div>
    </div>
  )
}

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [contact, setContact] = useState<Contact | null>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const [{ data: c }, { data: d }] = await Promise.all([
      supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
      supabase.from('deals').select('*').eq('borrower_id', id).order('created_at', { ascending: false }),
    ])
    setContact((c as Contact) ?? null)
    setDeals((d as Deal[]) ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) return <div className="p-6 text-sm text-slate-400">Loading…</div>
  if (!contact) {
    return (
      <div className="p-6">
        <Link href="/contacts" className="flex items-center gap-1 text-blue-600 text-sm w-fit"><ArrowLeft className="w-4 h-4" /> Contacts</Link>
        <p className="mt-4 text-sm text-slate-500">Contact not found.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <Link href="/contacts" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 w-fit">
          <ArrowLeft className="w-4 h-4" /> Contacts
        </Link>
        <h1 className="text-xl font-bold text-slate-900">{contact.display_name || '(no name)'}</h1>
        <p className="text-sm text-slate-500 mt-0.5">{[contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}</p>
        <div className="flex flex-wrap gap-6 mt-3">
          <Stat label="Loans" value={String(contact.loan_count)} />
          <Stat label="Funded" value={String(contact.funded_count)} />
          <Stat label="Funded volume" value={formatCurrency(contact.total_funded_volume)} />
          <Stat label="Comp" value={formatCurrency(contact.total_comp)} />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">Loans ({deals.length})</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
              <th className="px-3 py-2">Loan</th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">LO</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Funded</th>
              <th className="px-3 py-2">Arive #</th>
            </tr>
          </thead>
          <tbody>
            {deals.map(d => (
              <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <Link href={`/deals/${d.id}`} className="text-blue-600 hover:text-blue-700">{d.name}</Link>
                </td>
                <td className="px-3 py-2 text-slate-500">{d.status} · {d.pipeline_group}</td>
                <td className="px-3 py-2 text-slate-500">{d.loan_officer || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</td>
                <td className="px-3 py-2 text-slate-500">{d.funded_date || '—'}</td>
                <td className="px-3 py-2 text-slate-500">{d.arive_file_no || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
