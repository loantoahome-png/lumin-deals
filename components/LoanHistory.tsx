'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import { History, ExternalLink, DollarSign, Calendar, Loader2 } from 'lucide-react'

type Props = {
  currentDealId: string
  email?: string | null
  phone?: string | null
  firstName?: string | null
  lastName?: string | null
  name?: string | null
}

function normPhone(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

/**
 * Shows other deals/loans for the same person (matched by email or phone).
 * Lets you see at a glance: "this client has had 3 loans with us — 2 funded, 1 in process"
 */
export default function LoanHistory({ currentDealId, email, phone, firstName, lastName, name }: Props) {
  const [related, setRelated] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchRelated() {
      setLoading(true)
      const matchEmail = email?.trim().toLowerCase() || null
      const normalizedPhone = normPhone(phone)
      // Build a name string we can compare (first + last, or full name)
      const composedName = [firstName, lastName].filter(Boolean).join(' ').trim().toLowerCase()
        || (name?.trim().toLowerCase() ?? '')

      // No identifying info → nothing to show
      if (!matchEmail && !normalizedPhone && !composedName) {
        setRelated([])
        setLoading(false)
        return
      }

      // We over-fetch then filter client-side for accurate phone normalization
      const ors: string[] = []
      if (matchEmail) ors.push(`email.eq.${matchEmail}`)
      if (composedName.length >= 4) {
        // ilike pattern — Supabase escape: name pattern
        ors.push(`name.ilike.${composedName}`)
      }

      // First pass: email + name. Phone we filter post-fetch (since digits-only normalization needs JS).
      const { data: byEmailOrName } = ors.length > 0
        ? await supabase.from('deals').select('*').or(ors.join(',')).neq('id', currentDealId)
        : { data: [] }

      // Second pass: phone — fetch all where phone is not null, filter to last-10-digit match
      let byPhone: Deal[] = []
      if (normalizedPhone) {
        const { data } = await supabase
          .from('deals').select('*')
          .not('phone', 'is', null)
          .neq('id', currentDealId)
          .limit(2000)
        byPhone = (data as Deal[] || []).filter(d => normPhone(d.phone) === normalizedPhone)
      }

      // Combine + dedupe by id
      const map = new Map<string, Deal>()
      for (const d of (byEmailOrName as Deal[] || [])) map.set(d.id, d)
      for (const d of byPhone) map.set(d.id, d)
      const all = Array.from(map.values())

      // Sort: most recent first (funded_date desc, then created_at desc)
      all.sort((a, b) => {
        const av = a.funded_date || a.created_at
        const bv = b.funded_date || b.created_at
        return new Date(bv).getTime() - new Date(av).getTime()
      })
      setRelated(all)
      setLoading(false)
    }
    fetchRelated()
  }, [currentDealId, email, phone, firstName, lastName, name])

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          <span className="text-sm text-slate-400">Loading loan history…</span>
        </div>
      </div>
    )
  }

  if (related.length === 0) return null // hide entirely when there's nothing to show

  // Stats
  const fundedCount = related.filter(d => d.pipeline_group === 'Funded').length
  const inProcessCount = related.filter(d => d.pipeline_group === 'Loans in Process').length
  const totalFundedVolume = related
    .filter(d => d.pipeline_group === 'Funded')
    .reduce((s, d) => s + (d.loan_amount || 0), 0)

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-blue-600" />
          <h3 className="font-semibold text-slate-800 text-sm">Loan History</h3>
          <span className="text-xs text-slate-500">
            {related.length} other loan{related.length !== 1 ? 's' : ''} for this contact
          </span>
        </div>
        {totalFundedVolume > 0 && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-emerald-700 font-semibold">
              {fundedCount} funded · {formatCurrency(totalFundedVolume)} total volume
            </span>
            {inProcessCount > 0 && (
              <span className="text-blue-700 font-medium">{inProcessCount} active</span>
            )}
          </div>
        )}
      </div>
      <div className="divide-y divide-slate-100">
        {related.map(d => {
          const statusClass = STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'
          const dateLabel = d.funded_date
            ? `Funded ${new Date(d.funded_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : `Added ${new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
          return (
            <Link
              key={d.id}
              href={`/deals/${d.id}`}
              className="flex items-center gap-4 px-5 py-3 hover:bg-blue-50/40 transition group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 truncate">
                    {d.name}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusClass}`}>
                    {d.status}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  {d.loan_type && <span>{d.loan_type}</span>}
                  {d.property_address && <span className="truncate max-w-[280px]">· {d.property_address}</span>}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="flex items-center gap-1 text-sm font-semibold text-slate-800 justify-end">
                  <DollarSign className="w-3 h-3 text-slate-400" />
                  {d.loan_amount ? formatCurrency(d.loan_amount).replace('$', '') : '—'}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400 justify-end mt-0.5">
                  <Calendar className="w-2.5 h-2.5" />
                  {dateLabel}
                </div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-500 shrink-0" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
